import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectFlows, type FlowModel, ROOT } from './flow-tags.ts'
import { commentsIn, type SourceComment } from './source-comments.ts'

/**
 * The comments a pull request has to answer for (#482): every comment whose own lines it changed,
 * and every comment on a declaration it changed, found from `git diff` and the TypeScript syntax tree
 * (`source-comments.ts`). The CI reviewer reads this list (`.claude/pr-review.md`) and checks each one
 * against the code as changed.
 *
 * WHY A LIST, AND WHY HERE. The gates prove a comment is attached, and that the test it names exists;
 * nothing proves the words still describe the code. A person or a model can check that, but only if
 * told WHICH comments a diff put at risk: on a large diff a reviewer skims, and the stale comment is
 * the one beside a line that changed for another reason. So the selection is computed, not left to
 * the reviewer, and it is the same selection locally (`bun scripts/docs/touched-comments.ts --base
 * main`) and in CI.
 *
 * A declaration CHANGED when any line of it is in the diff, a deletion counted at the line it
 * happened next to. A comment inside a function body counts against that function (its owner).
 */

export interface LineRange {
  /** 1-based, inclusive. */
  readonly from: number
  readonly to: number
}

export interface TouchedComment {
  readonly file: string
  readonly comment: SourceComment
  /** Its own text changed, or only the declaration it documents did. */
  readonly why: 'comment changed' | 'declaration changed'
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const
const SKIPPED = ['node_modules/', 'dist-types/', '/dist/'] as const

const isSource = (file: string): boolean =>
  SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
  !file.endsWith('.d.ts') &&
  !SKIPPED.some((skipped) => file.includes(skipped))

/** The new-side line range an `@@ -a,b +c,d @@` header names; a pure deletion is the line it follows. */
function hunkRange(header: string): LineRange | undefined {
  const added = header.split(' ').find((part) => part.startsWith('+'))
  if (added === undefined) return undefined
  const [start = '', count = '1'] = added.slice(1).split(',')
  const from = Number(start)
  const length = Number(count)
  if (!Number.isInteger(from) || !Number.isInteger(length)) return undefined
  return length === 0 ? { from: Math.max(1, from), to: from + 1 } : { from, to: from + length - 1 }
}

/** Per changed source file, the new-side lines `git diff -U0` says changed. A deleted file has none. */
export function changedLines(diff: string): Map<string, LineRange[]> {
  const changes = new Map<string, LineRange[]>()
  let file: string | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      file = path.startsWith('b/') && isSource(path.slice(2)) ? path.slice(2) : undefined
      if (file !== undefined) changes.set(file, [])
    } else if (file !== undefined && line.startsWith('@@ ')) {
      const range = hunkRange(line)
      if (range !== undefined) changes.get(file)?.push(range)
    }
  }
  return changes
}

const overlaps = (ranges: readonly LineRange[], from: number, to: number): boolean =>
  ranges.some((range) => range.from <= to && from <= range.to)

/** The lines any comment in the file occupies: a change there is a change to words, not to code. */
function commentLines(comments: readonly SourceComment[]): Set<number> {
  const lines = new Set<number>()
  for (const comment of comments) for (let line = comment.line; line <= comment.end; line += 1) lines.add(line)
  return lines
}

/**
 * Whether a changed line inside `from`…`to` is CODE. ⚠ Comment lines don't count (dry run on PR #488):
 * tagging a function inserts a comment into its body, and counting that as "the code changed" put
 * 78 of 81 entries at the top of the list for the one reason that made them least likely stale.
 */
function codeChanged(ranges: readonly LineRange[], words: ReadonlySet<number>, from: number, to: number): boolean {
  for (const range of ranges) {
    for (let line = Math.max(range.from, from); line <= Math.min(range.to, to); line += 1) {
      if (!words.has(line)) return true
    }
  }
  return false
}

/** Every comment the changes put at risk, file by file, in file order. `read` returns a file's current text. */
export function touchedComments(
  changes: ReadonlyMap<string, readonly LineRange[]>,
  read: (file: string) => string | undefined,
): TouchedComment[] {
  const touched: TouchedComment[] = []
  for (const [file, ranges] of [...changes].sort(([left], [right]) => left.localeCompare(right))) {
    const source = read(file)
    if (source === undefined || ranges.length === 0) continue
    const comments = commentsIn(file, source)
    const words = commentLines(comments)
    for (const comment of comments) {
      if (overlaps(ranges, comment.line, comment.end)) touched.push({ file, comment, why: 'comment changed' })
      else if (comment.owner !== undefined && codeChanged(ranges, words, comment.owner.line, comment.owner.end)) {
        touched.push({ file, comment, why: 'declaration changed' })
      }
    }
  }
  return touched
}

/** The invariant ids a comment itself states: its `@invariant <id> …` lines. */
function statedInvariants(comment: SourceComment): string[] {
  return comment.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('@invariant '))
    .map((line) => line.slice('@invariant '.length).trim().split(' ')[0] ?? '')
}

/**
 * The invariants THIS comment states, each with the tests that pin it by `file:line` of the `@pins`
 * line. Only the stating comment carries them: every comment on a long function repeating the same
 * block is what filled the list on PR #488.
 */
function invariantsIn(model: FlowModel, comment: SourceComment): string[] {
  return statedInvariants(comment).map((id) => {
    const pins = model.pins.filter((pin) => pin.invariants.includes(id))
    const unpinned = model.invariants.find((invariant) => invariant.id === id)?.unpinned
    const pinned =
      pins.length > 0
        ? pins.map((pin) => `\`${pin.file}:${pin.line}\` (${pin.title})`).join('; ')
        : `no test (\`@unpinned\`: ${unpinned ?? 'none given'})`
    return `\`${id}\`, pinned by ${pinned}`
  })
}

/**
 * How likely a comment is to be wrong now, most likely first: the code changed and the comment did
 * not (its author may never have looked at it), an invariant before a plain comment, and a comment
 * the diff rewrote last, since someone was just reading it.
 */
function risk(entry: TouchedComment, invariants: readonly string[]): number {
  const unrevised = entry.why === 'declaration changed' ? 0 : 2
  return unrevised + (invariants.length > 0 ? 0 : 1)
}

/** Characters of quoted comment text before the rest are listed by location only, so the list stays readable. */
const QUOTE_BUDGET = 60_000

/** The list as the reviewer reads it: most at risk first, each quoted whole while the budget lasts. */
export function renderTouched(touched: readonly TouchedComment[], model: FlowModel, base: string): string {
  const header = [
    '# Comments on code this pull request changes',
    '',
    `Built by \`scripts/docs/touched-comments.ts\` from \`git diff ${base}...HEAD\` (#482). Line numbers are the pull`,
    "request's own. A comment is listed when its own lines changed, or when CODE in the declaration it documents",
    'changed (comment lines added to a body do not count). Most at risk first: code changed under an unchanged',
    'comment, then invariants, then comments the diff itself rewrote.',
    '',
  ]
  if (touched.length === 0) return [...header, 'None: this diff changes no commented declaration.', ''].join('\n')
  const entries = touched
    .map((entry) => {
      const invariants = invariantsIn(model, entry.comment)
      return { ...entry, invariants, risk: risk(entry, invariants) }
    })
    .sort((left, right) => left.risk - right.risk)
  let budget = QUOTE_BUDGET
  const quoted: string[] = []
  const listed: string[] = []
  for (const { file, comment, why, invariants } of entries) {
    const owner =
      comment.owner === undefined
        ? 'no declaration'
        : `\`${comment.owner.symbol}\` (lines ${comment.owner.line}–${comment.owner.end})`
    const title = `\`${file}\`:${comment.line}–${comment.end}, on ${owner}: ${why}`
    const section = [
      `## ${title}`,
      '',
      ...comment.lines.map((line) => `> ${line}`.trimEnd()),
      '',
      ...invariants.map((invariant) => `- invariant ${invariant}`),
      '',
    ].join('\n')
    if (section.length > budget) {
      listed.push(`- ${title}`, ...invariants.map((invariant) => `  - invariant ${invariant}`))
      continue
    }
    budget -= section.length
    quoted.push(section)
  }
  const rest =
    listed.length === 0
      ? []
      : [
          '## Also changed, not quoted (the list reached its size limit)',
          '',
          'Read these in the files:',
          '',
          ...listed,
          '',
        ]
  return [...header, ...quoted, ...rest].join('\n')
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

if (import.meta.main) {
  const base = option('--base') ?? 'main'
  const diff = spawnSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', `${base}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (diff.status !== 0) {
    process.stderr.write(`touched-comments: git diff ${base}...HEAD failed: ${diff.stderr}`)
    process.exit(1)
  }
  const read = (file: string): string | undefined =>
    existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : undefined
  const page = renderTouched(touchedComments(changedLines(diff.stdout), read), collectFlows(), base)
  const outputPath = option('--out')
  if (outputPath === undefined) process.stdout.write(page)
  else writeFileSync(outputPath, page)
}
