/**
 * A unified diff as the Diff view draws it (#452): git's patch for one file, parsed into hunks,
 * and each hunk laid out side by side — the old file on the left, the new on the right.
 *
 * ⚠ GIT'S OWN FORMAT, AND ONLY THAT. The patch comes from `git diff` (`@enso/core/git`), so this
 * reads what git writes: header lines until the first `@@`, then hunks whose lines start with ` `,
 * `-` or `+`, and git's `\ No newline at end of file` marker, which belongs to the line above it.
 * Anything else inside a hunk is not a line of either file and is skipped.
 *
 * ⚠ PAIRED THE WAY A READER PAIRS THEM. Inside a hunk, a run of removed lines followed by a run of
 * added lines is one edit: the Nth removed line sits beside the Nth added one, and the longer run
 * continues against an empty cell. A context line sits on both sides at its own two numbers.
 *
 * The unchanged lines git left out — before each hunk, and after the last — are runs numbered from
 * the hunks themselves (`hiddenBefore`, `hiddenAfter`), shown from the file read whole (#461,
 * `changed-file.ts`) and only while it agrees with the patch (`agreesWith`).
 */

/** One line of a hunk: kept on both sides, removed from the old file, or added to the new one. */
export interface DiffLine {
  readonly kind: 'context' | 'removed' | 'added'
  readonly text: string
  /** Its number in the old file; `null` for an added line. */
  readonly oldNumber: number | null
  /** Its number in the new file; `null` for a removed line. */
  readonly newNumber: number | null
  /** git's `\ No newline at end of file` followed it. */
  readonly noNewline: boolean
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ …` line as git wrote it, function context included. */
  readonly header: string
  readonly oldStart: number
  readonly newStart: number
  readonly lines: readonly DiffLine[]
}

/** One row of the split view: the old side, the new side, either empty where the other has more. */
export interface SplitRow {
  readonly left: DiffLine | null
  readonly right: DiffLine | null
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const LINE_KINDS: Readonly<Record<string, DiffLine['kind']>> = { ' ': 'context', '-': 'removed', '+': 'added' }

/** A hunk being read: its header, and the next line number on each side. */
interface OpenHunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
  nextOld: number
  nextNew: number
}

/** The line a hunk body line is, numbered from where the hunk has got to; undefined for none. */
function hunkLine(hunk: OpenHunk, line: string): DiffLine | undefined {
  const kind = LINE_KINDS[line[0] ?? '']
  if (kind === undefined) return undefined
  const oldNumber = kind === 'added' ? null : hunk.nextOld
  const newNumber = kind === 'removed' ? null : hunk.nextNew
  if (oldNumber !== null) hunk.nextOld += 1
  if (newNumber !== null) hunk.nextNew += 1
  return { kind, text: line.slice(1), oldNumber, newNumber, noNewline: false }
}

/**
 * git's patch for one file, as hunks; a patch with none (a mode change, an empty file) has none. A
 * type change is two parts, the old file's deletion and the new one's creation: a second
 * `diff --git` header ends the hunk before it, so its `---`/`+++` lines are never read as lines.
 */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: OpenHunk[] = []
  let open: OpenHunk | undefined
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      const oldStart = Number(header[1])
      const newStart = Number(header[2])
      open = { header: line, oldStart, newStart, lines: [], nextOld: oldStart, nextNew: newStart }
      hunks.push(open)
    } else if (line.startsWith('diff --git ')) {
      open = undefined
    } else if (open !== undefined && line.startsWith('\\')) {
      // `\ No newline at end of file` marks the line before it.
      const last = open.lines.at(-1)
      if (last !== undefined) open.lines[open.lines.length - 1] = { ...last, noNewline: true }
    } else if (open !== undefined) {
      const parsed = hunkLine(open, line)
      if (parsed !== undefined) open.lines.push(parsed)
    }
  }
  return hunks.map(({ header, oldStart, newStart, lines }) => ({ header, oldStart, newStart, lines }))
}

/** A hunk side by side: context on both sides, each removed run beside the added run after it. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = (): void => {
    for (let rowIndex = 0; rowIndex < Math.max(removed.length, added.length); rowIndex += 1) {
      rows.push({ left: removed[rowIndex] ?? null, right: added[rowIndex] ?? null })
    }
    removed = []
    added = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'removed') {
      // A removed line after added ones starts a new edit.
      if (added.length > 0) flush()
      removed.push(line)
    } else if (line.kind === 'added') {
      added.push(line)
    } else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

/** Which file a number or a text is of: the old one, at the baseline, or the new one. */
export type Side = 'old' | 'new'

/**
 * A run of unchanged lines git left out of the patch (#461): its first line's number on each side,
 * and how many. The lines are the same on both sides; only their numbers differ.
 */
export interface HiddenRun {
  readonly oldStart: number
  readonly newStart: number
  readonly count: number
}

/**
 * A side of a hunk as line numbers: its first line and the one after its last. git numbers a side
 * with no lines (`-2,0`) from the line BEFORE where they would be, so its first is the next one.
 */
function spanOf(start: number, count: number): { readonly first: number; readonly end: number } {
  const first = count === 0 ? start + 1 : start
  return { first, end: first + count }
}

/** A hunk's two sides as line numbers. */
function spans(hunk: DiffHunk): Readonly<Record<Side, { readonly first: number; readonly end: number }>> {
  const added = hunk.lines.filter((line) => line.kind === 'added').length
  const removed = hunk.lines.filter((line) => line.kind === 'removed').length
  return {
    old: spanOf(hunk.oldStart, hunk.lines.length - added),
    new: spanOf(hunk.newStart, hunk.lines.length - removed),
  }
}

/**
 * The unchanged lines git left out before `hunk` — between the previous hunk (or the file's start)
 * and this one. A count of 0 when the hunks touch.
 */
export function hiddenBefore(hunk: DiffHunk, previous: DiffHunk | undefined): HiddenRun {
  const here = spans(hunk)
  const after = previous === undefined ? { old: { end: 1 }, new: { end: 1 } } : spans(previous)
  return { oldStart: after.old.end, newStart: after.new.end, count: Math.max(0, here.old.first - after.old.end) }
}

/** The unchanged lines after the last hunk, to the end of the file whose `lines` are `side`'s. */
export function hiddenAfter(last: DiffHunk, lines: readonly string[], side: Side): HiddenRun {
  const after = spans(last)
  return { oldStart: after.old.end, newStart: after.new.end, count: Math.max(0, lines.length + 1 - after[side].end) }
}

/**
 * A file's text as its lines: line N at index N − 1, and none in an empty file. A final newline ends
 * the last line rather than opening another, and a line's `\r` is dropped — git's patch shows a
 * CRLF file's lines without it when an attribute normalises them, and with it otherwise, so neither
 * side keeps it to compare.
 */
export function linesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines.map((line) => line.replace(/\r$/, ''))
}

/**
 * Whether `lines` are the file the hunks were cut from on `side`: the hunks show at least one line
 * of that side, and every one they show is the file's line at its number. A side they show none of
 * cannot be held to them — a deleted file's new side, or the old side of a type change's second
 * part — and is not that file. A file read after the patch, and changed between, is not either —
 * and its lines would be shown under the wrong numbers. ⚠ Only the lines the hunks show are held:
 * an edit inside a hidden run passes (`sameHiddenLines` holds those).
 */
export function agreesWith(hunks: readonly DiffHunk[], lines: readonly string[], side: Side): boolean {
  let shown = false
  const held = hunks.every((hunk) =>
    hunk.lines.every((line) => {
      const number = side === 'old' ? line.oldNumber : line.newNumber
      if (number === null) return true
      shown = true
      return lines[number - 1] === line.text.replace(/\r$/, '')
    }),
  )
  return shown && held
}

/**
 * Whether the old file's `oldLines` and the new one's `newLines` hold the same unchanged lines git
 * left out — every run before a hunk, and the run after the last, as long and line for line the
 * same. In the patch they are; a side edited inside a run since (`e` → `E`, no line added) is not.
 */
export function sameHiddenLines(
  hunks: readonly DiffHunk[],
  oldLines: readonly string[],
  newLines: readonly string[],
): boolean {
  const last = hunks.at(-1)
  if (last === undefined) return true
  const afterOld = hiddenAfter(last, oldLines, 'old')
  if (afterOld.count !== hiddenAfter(last, newLines, 'new').count) return false
  const runs = [...hunks.map((hunk, hunkIndex) => hiddenBefore(hunk, hunks[hunkIndex - 1])), afterOld]
  return runs.every((run) =>
    Array.from({ length: run.count }, (_, offset) => offset).every(
      (offset) => oldLines[run.oldStart + offset - 1] === newLines[run.newStart + offset - 1],
    ),
  )
}

/** A hidden run's rows, each line on both sides at its two numbers, its text from `side`'s `lines`. */
export function hiddenRows(run: HiddenRun, lines: readonly string[], side: Side): SplitRow[] {
  const first = side === 'old' ? run.oldStart : run.newStart
  return Array.from({ length: run.count }, (_, offset) => {
    const line: DiffLine = {
      kind: 'context',
      text: lines[first + offset - 1] ?? '',
      oldNumber: run.oldStart + offset,
      newNumber: run.newStart + offset,
      noNewline: false,
    }
    return { left: line, right: line }
  })
}
