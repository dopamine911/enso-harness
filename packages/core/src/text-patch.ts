/**
 * A unified diff of two texts, in git's hunk format (#753): what the project page draws when it asks
 * the operator to approve a config tier, with the reader the Diff view already uses (`diff-rows.ts`
 * `parsePatch`), so a change to approve reads as a thread's changes do. Lines are compared whole,
 * with three lines of context, and a text with no final newline marks its last line as git does
 * (`\ No newline at end of file`) — so adding or dropping that newline is a change shown, never lost.
 *
 * ⚠ SIZED FOR CONFIG FILES. The common head and tail are cut first, so a small edit compares only
 * what lies between; a middle too large to compare line by line (`MAX_COMPARED_CELLS`) is shown as
 * all removed, then all added — coarser, never wrong.
 */

/** The most cells the line-by-line comparison fills: a few hundred lines changed on each side. */
const MAX_COMPARED_CELLS = 1_000_000

/** Lines of unchanged text kept around a change. */
const CONTEXT_LINES = 3

interface TextLine {
  readonly text: string
  /** The text's last line, with no newline after it. */
  readonly noNewline: boolean
}

type Edit =
  | { readonly kind: 'context'; readonly line: TextLine }
  | { readonly kind: 'removed'; readonly line: TextLine }
  | { readonly kind: 'added'; readonly line: TextLine }

function linesOf(text: string): TextLine[] {
  if (text.length === 0) return []
  const parts = text.split('\n')
  const endsWithNewline = parts.at(-1) === ''
  if (endsWithNewline) parts.pop()
  return parts.map((part, index) => ({ text: part, noNewline: !endsWithNewline && index === parts.length - 1 }))
}

const sameLine = (left: TextLine | undefined, right: TextLine | undefined): boolean =>
  left !== undefined && right !== undefined && left.text === right.text && left.noNewline === right.noNewline

/**
 * The longest-common-subsequence table of two line lists: cell `oldIndex * (after.length + 1) +
 * newIndex` is the longest common run of `before[oldIndex..]` and `after[newIndex..]`.
 */
function commonRuns(before: readonly TextLine[], after: readonly TextLine[]): Uint32Array {
  const width = after.length + 1
  const common = new Uint32Array((before.length + 1) * width)
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      common[oldIndex * width + newIndex] = sameLine(before[oldIndex], after[newIndex])
        ? (common[(oldIndex + 1) * width + newIndex + 1] ?? 0) + 1
        : Math.max(common[(oldIndex + 1) * width + newIndex] ?? 0, common[oldIndex * width + newIndex + 1] ?? 0)
    }
  }
  return common
}

/** The middle's edits: a longest common subsequence of its lines, or all removed then all added when too large. */
function middleEdits(before: readonly TextLine[], after: readonly TextLine[]): Edit[] {
  const width = after.length + 1
  if (before.length === 0 || after.length === 0 || (before.length + 1) * width > MAX_COMPARED_CELLS) {
    return [
      ...before.map((line): Edit => ({ kind: 'removed', line })),
      ...after.map((line): Edit => ({ kind: 'added', line })),
    ]
  }
  const common = commonRuns(before, after)
  const edits: Edit[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < before.length || newIndex < after.length) {
    const oldLine = before[oldIndex]
    const newLine = after[newIndex]
    // Drop the old line when doing so keeps at least as long a common run as taking the new one.
    const dropOld = (common[(oldIndex + 1) * width + newIndex] ?? 0) >= (common[oldIndex * width + newIndex + 1] ?? 0)
    if (oldLine !== undefined && sameLine(oldLine, newLine)) {
      edits.push({ kind: 'context', line: oldLine })
      oldIndex += 1
      newIndex += 1
    } else if (oldLine !== undefined && (newLine === undefined || dropOld)) {
      edits.push({ kind: 'removed', line: oldLine })
      oldIndex += 1
    } else if (newLine !== undefined) {
      edits.push({ kind: 'added', line: newLine })
      newIndex += 1
    }
  }
  return edits
}

/** Every line's edit, the common head and tail as context around the compared middle. */
function editsOf(before: readonly TextLine[], after: readonly TextLine[]): Edit[] {
  let head = 0
  while (head < before.length && head < after.length && sameLine(before[head], after[head])) head += 1
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    sameLine(before[before.length - 1 - tail], after[after.length - 1 - tail])
  )
    tail += 1
  const context = (lines: readonly TextLine[]): Edit[] => lines.map((line) => ({ kind: 'context', line }))
  return [
    ...context(before.slice(0, head)),
    ...middleEdits(before.slice(head, before.length - tail), after.slice(head, after.length - tail)),
    ...context(before.slice(before.length - tail)),
  ]
}

const MARK: Readonly<Record<Edit['kind'], string>> = { context: ' ', removed: '-', added: '+' }

/** One hunk, `edits[start..end)`: its header, then each line, and git's marker after a last line without its newline. */
function hunkText(edits: readonly Edit[], start: number, end: number): string {
  let oldLine = 1
  let newLine = 1
  for (const edit of edits.slice(0, start)) {
    if (edit.kind !== 'added') oldLine += 1
    if (edit.kind !== 'removed') newLine += 1
  }
  const lines = edits.slice(start, end)
  const oldCount = lines.filter((edit) => edit.kind !== 'added').length
  const newCount = lines.filter((edit) => edit.kind !== 'removed').length
  // git names a side with no lines by the line before it: 0 for an empty file.
  const header = `@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`
  const body = lines.flatMap((edit) => {
    const text = `${MARK[edit.kind]}${edit.line.text}`
    return edit.line.noNewline ? [text, '\\ No newline at end of file'] : [text]
  })
  return [header, ...body].join('\n')
}

/**
 * The unified diff from `before` to `after`: its hunks, each change with up to three lines of
 * context and hunks closer than that merged; `''` when the texts are the same.
 *
 * @group Project settings
 */
export function unifiedPatch(before: string, after: string): string {
  const edits = editsOf(linesOf(before), linesOf(after))
  const changed = edits.flatMap((edit, editIndex) => (edit.kind === 'context' ? [] : [editIndex]))
  const first = changed[0]
  if (first === undefined) return ''
  const ranges: [number, number][] = []
  let start = Math.max(0, first - CONTEXT_LINES)
  let end = first + 1
  for (const changedIndex of changed.slice(1)) {
    if (changedIndex - end > 2 * CONTEXT_LINES) {
      ranges.push([start, Math.min(edits.length, end + CONTEXT_LINES)])
      start = changedIndex - CONTEXT_LINES
    }
    end = changedIndex + 1
  }
  ranges.push([start, Math.min(edits.length, end + CONTEXT_LINES)])
  return `${ranges.map(([from, to]) => hunkText(edits, from, to)).join('\n')}\n`
}
