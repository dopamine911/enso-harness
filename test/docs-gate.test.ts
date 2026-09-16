import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractDeclaration } from '../scripts/docs/extract-declaration.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The docs cannot drift (#168, goals §3.3): a page either quotes source and is checked
 * against it, or is generated from source and is diffed against it.
 *
 * ⚠ Enforcement, not a unit test — the shape of the other gates. Two markers:
 *
 *   `<!-- source: <path>#<Symbol> -->` on the line above a ```` ```ts ```` fence: the fence
 *   must equal that top-level declaration, with its doc comment, character for character.
 *   A symbol that no longer exists is an offender that names the page, so a rename fails
 *   the docs before it fails a reader.
 *
 *   `<!-- generated: <script> -->` on a page's first line: the page must equal the
 *   script's stdout. Regenerate with `bun <script> > <page>`.
 *
 *   `<!-- generated-block: <script> -->` … `<!-- /generated-block -->` inside a hand-written
 *   page: the lines between must equal the script's stdout (#162 workstream 11 — the seams
 *   table lives in architecture.md and is read off the seam pages). Refresh with
 *   `bun scripts/docs/refresh-fences.ts <page>`, which handles both marker kinds.
 *
 * And one rule for `docs/seams/`: every ```` ```ts ```` fence carries a `source:` marker.
 * Prose may surround a fence; prose may not restate what a fence says, and a fence with no
 * source is prose wearing a code font.
 *
 * The allowlist is EMPTY and stays so. A page that cannot keep its fences equal to the
 * source is describing a different program.
 */

const DOCS_ROOT = join(REPOSITORY_ROOT, 'docs')
/** Where every fence must be sourced. Other docs are checked only where they carry a marker. */
const SOURCED_FENCE_DIRECTORIES = ['docs/seams'] as const
const SOURCE_MARKER = /^<!--\s*source:\s*(\S+?)#(\w+)\s*-->$/
const GENERATED_MARKER = /^<!--\s*generated:\s*(\S+)\s*-->$/
const BLOCK_OPEN = /^<!--\s*generated-block:\s*(\S+)\s*-->$/
const BLOCK_CLOSE = /^<!--\s*\/generated-block\s*-->$/
const TS_FENCE_OPEN = /^```(?:ts|typescript)\s*$/
const FENCE_CLOSE = /^```\s*$/

function markdownFiles(directory: string): string[] {
  const found: string[] = []
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) found.push(...markdownFiles(path))
    else if (dirent.name.endsWith('.md')) found.push(path)
  }
  return found
}

interface Fence {
  readonly openLine: number
  readonly body: string
  readonly source: { path: string; symbol: string } | undefined
}

/**
 * Every ```` ```ts ```` fence in a page, with the `source:` marker directly above it when there
 * is one. An unclosed fence is an offender, not the end of the scan: the page after it is
 * unreadable as markdown, and a fence the scan cannot see is a fence it cannot check.
 */
function fencesOf(page: string, lines: readonly string[], offenders: string[]): Fence[] {
  const fences: Fence[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!TS_FENCE_OPEN.test(lines[lineIndex] ?? '')) continue
    const closeIndex = lines.findIndex((line, index) => index > lineIndex && FENCE_CLOSE.test(line))
    if (closeIndex === -1) {
      offenders.push(`${page}:${lineIndex + 1}: ts fence is never closed`)
      break
    }
    const marker = SOURCE_MARKER.exec(lines[lineIndex - 1] ?? '')
    fences.push({
      openLine: lineIndex + 1,
      body: lines.slice(lineIndex + 1, closeIndex).join('\n'),
      source: marker ? { path: marker[1] ?? '', symbol: marker[2] ?? '' } : undefined,
    })
    lineIndex = closeIndex
  }
  return fences
}

function sourcedFenceOffenders(page: string, lines: readonly string[], fenceMustBeSourced: boolean): string[] {
  const offenders: string[] = []
  for (const fence of fencesOf(page, lines, offenders)) {
    if (fence.source === undefined) {
      if (fenceMustBeSourced) offenders.push(`${page}:${fence.openLine}: ts fence without a <!-- source: --> marker`)
      continue
    }
    const sourcePath = join(REPOSITORY_ROOT, fence.source.path)
    if (!existsSync(sourcePath)) {
      offenders.push(`${page}:${fence.openLine}: source ${fence.source.path} does not exist`)
      continue
    }
    const declaration = extractDeclaration(readFileSync(sourcePath, 'utf8'), fence.source.symbol)
    if (declaration === undefined) {
      offenders.push(`${page}:${fence.openLine}: ${fence.source.path} declares no top-level \`${fence.source.symbol}\``)
      continue
    }
    if (declaration.text.trim() !== fence.body.trim()) {
      offenders.push(
        `${page}:${fence.openLine}: fence differs from ${fence.source.path}#${fence.source.symbol} (${fence.source.path}:${declaration.startLine}-${declaration.endLine})`,
      )
    }
  }
  return offenders
}

/** The script's stdout, or the offender line when it cannot be produced. */
function generatorOutput(page: string, line: number, script: string): { text: string } | { offender: string } {
  if (!existsSync(join(REPOSITORY_ROOT, script)))
    return { offender: `${page}:${line}: generator ${script} does not exist` }
  const generated = Bun.spawnSync(['bun', script], { cwd: REPOSITORY_ROOT })
  if (generated.exitCode !== 0) {
    return {
      offender: `${page}:${line}: ${script} exited ${generated.exitCode}: ${generated.stderr.toString().trim()}`,
    }
  }
  return { text: generated.stdout.toString() }
}

function generatedOffenders(page: string, text: string): string[] {
  const lines = text.split('\n')
  const marker = GENERATED_MARKER.exec(lines[0] ?? '')
  if (marker) {
    const output = generatorOutput(page, 1, marker[1] ?? '')
    if ('offender' in output) return [output.offender]
    return output.text.trim() === text.trim() ? [] : [`${page}: differs from \`bun ${marker[1] ?? ''}\` — regenerate`]
  }
  const offenders: string[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const open = BLOCK_OPEN.exec(lines[lineIndex] ?? '')
    if (!open) continue
    const script = open[1] ?? ''
    const closeIndex = lines.findIndex((candidate, index) => index > lineIndex && BLOCK_CLOSE.test(candidate))
    if (closeIndex === -1) {
      offenders.push(`${page}:${lineIndex + 1}: generated-block for ${script} is never closed`)
      break
    }
    const output = generatorOutput(page, lineIndex + 1, script)
    if ('offender' in output) offenders.push(output.offender)
    else if (
      output.text.trim() !==
      lines
        .slice(lineIndex + 1, closeIndex)
        .join('\n')
        .trim()
    ) {
      offenders.push(`${page}:${lineIndex + 1}: block differs from \`bun ${script}\` — refresh`)
    }
    lineIndex = closeIndex
  }
  return offenders
}

test('⚠ every sourced fence equals its declaration; every seam-page fence is sourced (#168)', () => {
  const offenders: string[] = []
  for (const path of markdownFiles(DOCS_ROOT)) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    const lines = readFileSync(path, 'utf8').split('\n')
    const mustSource = SOURCED_FENCE_DIRECTORIES.some((directory) => page.startsWith(`${directory}/`))
    offenders.push(...sourcedFenceOffenders(page, lines, mustSource))
  }
  expect(offenders).toEqual([])
})

test('⚠ every generated page, and every generated block, equals its generator (#168)', () => {
  const offenders: string[] = []
  for (const path of markdownFiles(DOCS_ROOT)) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    offenders.push(...generatedOffenders(page, readFileSync(path, 'utf8')))
  }
  expect(offenders).toEqual([])
})

/**
 * The paths `docs/architecture.md` → *Package structure* names, resolved by indentation (two
 * spaces per level; several names on one line are siblings; a `*` is a glob and is not checked).
 */
function architectureTreePaths(text: string): string[] {
  const start = text.indexOf('## Package structure')
  const open = text.indexOf('```\n', start)
  const close = text.indexOf('\n```', open + 4)
  if (start < 0 || open < 0 || close < 0) throw new Error('architecture.md has no Package structure tree')
  // Each stack level is the directory a deeper line nests under. A line naming several
  // siblings (`skills/ prompts/ themes/`) pushes no directory: a child under it would have
  // no unambiguous parent, so such a child is refused rather than resolved against the first.
  const stack: (string | undefined)[] = []
  const paths: string[] = []
  for (const line of text.slice(open + 4, close).split('\n')) {
    const names = (line.split('#')[0] ?? '').trim()
    if (names === '') continue
    const depth = ((/^ */.exec(line)?.[0].length ?? 0) / 2) | 0
    stack.length = depth
    if (stack.some((segment) => segment === undefined)) {
      throw new Error(`architecture.md tree: "${names}" nests under a line that names several siblings`)
    }
    const parent = stack.join('')
    const siblings = names.split(/\s+/)
    for (const name of siblings) {
      if (!name.includes('*')) paths.push(parent + name)
    }
    stack.push(siblings.length === 1 ? siblings[0] : undefined)
  }
  return paths
}

/** A path git ignores is not in a checkout — CI has no `.zen/` — so its absence is not drift. */
function isGitIgnored(path: string): boolean {
  return Bun.spawnSync(['git', 'check-ignore', '-q', path], { cwd: REPOSITORY_ROOT }).exitCode === 0
}

test('⚠ every path the architecture tree names exists, or is gitignored (#162 workstream 11)', () => {
  const text = readFileSync(join(DOCS_ROOT, 'architecture.md'), 'utf8')
  // the root line is the repository itself
  const paths = architectureTreePaths(text).map((path) => path.replace(/^zen-harness\//, ''))
  expect(paths.length).toBeGreaterThan(20)
  const missing = paths.filter((path) => !(existsSync(join(REPOSITORY_ROOT, path)) || isGitIgnored(path)))
  expect(missing).toEqual([])
})

/**
 * Relative links in a page — `](./x.md)`, `](../y/z.json)` and the bare `](docs/x.md)` README
 * uses — with the line they sit on. Skipped: URLs with a scheme, absolute paths, `#anchor`-only.
 */
function relativeLinks(text: string): { target: string; line: number }[] {
  const links: { target: string; line: number }[] = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] ?? ''
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue
      links.push({ target, line: index + 1 })
    }
  })
  return links
}

test('⚠ every relative link under docs/ and in README resolves to a file (#162 workstream 11)', () => {
  const offenders: string[] = []
  for (const path of [...markdownFiles(DOCS_ROOT), join(REPOSITORY_ROOT, 'README.md')]) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    for (const link of relativeLinks(readFileSync(path, 'utf8'))) {
      if (!existsSync(join(path, '..', link.target))) offenders.push(`${page}:${link.line}: ${link.target}`)
    }
  }
  expect(offenders).toEqual([])
})

test('the extractor takes the doc comment, the whole statement, and nothing after it', () => {
  const source = [
    '/** Above. */',
    'export const First = Type.Object({',
    "  kind: Type.Literal('first'), // a ) in a comment",
    '  text: Type.String({ description: "a } in a string" }),',
    '})',
    'export type First = Static<typeof First>',
    '',
    '/**',
    " * Two lines, with the repo's apostrophe.",
    ' */',
    'export type Union =',
    "  | 'a'",
    "  | 'b'",
    'export function after(): void {}',
    'export const Templated = Type.String({',
    '  description: `a template that spans lines',
    '  with an unbalanced { brace and a ( paren',
    '  * and a star-led line that is template text, not a comment',
    '  before it closes`,',
    '})',
    'export const Last = 1',
  ].join('\n')
  expect(extractDeclaration(source, 'First')?.text).toBe(source.split('\n').slice(0, 5).join('\n'))
  expect(extractDeclaration(source, 'Union')?.text).toBe(source.split('\n').slice(7, 13).join('\n'))
  expect(extractDeclaration(source, 'after')?.startLine).toBe(14)
  // A template literal's interior is not code: its braces and its `*`-led line count nothing
  // (PR #169 review), so the statement ends at `})`, not inside the template or past `Last`.
  expect(extractDeclaration(source, 'Templated')?.text).toBe(source.split('\n').slice(14, 20).join('\n'))
  expect(extractDeclaration(source, 'Missing')).toBeUndefined()
  // A template nested in a template's `${…}` is refused, never scanned as code (PR #169 review, round 2).
  const nested = [`export const Nested = \`outer $${'{`inner`}'}`, '  still outer`', 'export const After = 1'].join(
    '\n',
  )
  expect(() => extractDeclaration(nested, 'Nested')).toThrow(/nested in another/)
})
