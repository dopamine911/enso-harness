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

/**
 * The unchanged lines git left out before `hunk` — between the previous hunk (or the file's start)
 * and this one, on the old side. 0 when the hunks touch.
 */
export function hiddenBefore(hunk: DiffHunk, previous: DiffHunk | undefined): number {
  if (previous === undefined) return Math.max(0, hunk.oldStart - 1)
  const previousEnd = previous.oldStart + previous.lines.filter((line) => line.kind !== 'added').length
  return Math.max(0, hunk.oldStart - previousEnd)
}
