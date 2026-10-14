import { expect, test } from 'bun:test'
import { agreesWith, hiddenAfter, hiddenBefore, hiddenRows, linesOf, parsePatch, splitRows } from '../diff-rows.ts'

/**
 * #452: git's unified diff, read the way git writes it, and laid out side by side the way a reader
 * pairs an edit — each removed run beside the added run after it.
 */

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@ export function app() {',
  ' keep one',
  '-old two',
  '-old three',
  '+new two',
  ' keep four',
  '+added five',
  '@@ -20,2 +21,2 @@',
  '-last',
  '\\ No newline at end of file',
  '+last!',
  '\\ No newline at end of file',
  '',
].join('\n')

test('hunks are read with their headers, and every line numbered on its own side', () => {
  const [first, second] = parsePatch(PATCH)
  expect(first?.header).toBe('@@ -1,4 +1,5 @@ export function app() {')
  expect(first?.lines.map((line) => [line.kind, line.oldNumber, line.newNumber, line.text])).toEqual([
    ['context', 1, 1, 'keep one'],
    ['removed', 2, null, 'old two'],
    ['removed', 3, null, 'old three'],
    ['added', null, 2, 'new two'],
    ['context', 4, 3, 'keep four'],
    ['added', null, 4, 'added five'],
  ])
  expect(second?.lines.map((line) => [line.kind, line.text, line.noNewline])).toEqual([
    ['removed', 'last', true],
    ['added', 'last!', true],
  ])
})

test("a type change's two parts are two hunks: the second part's headers are not lines", () => {
  const typeChange = [
    'diff --git a/link.md b/link.md',
    'deleted file mode 100644',
    '--- a/link.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-a file',
    'diff --git a/link.md b/link.md',
    'new file mode 120000',
    '--- /dev/null',
    '+++ b/link.md',
    '@@ -0,0 +1 @@',
    '+README.md',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  expect(parsePatch(typeChange).map((hunk) => hunk.lines.map((line) => [line.kind, line.text]))).toEqual([
    [['removed', 'a file']],
    [['added', 'README.md']],
  ])
})

test('the header lines above the first hunk are not lines of either file', () => {
  expect(parsePatch(PATCH).flatMap((hunk) => hunk.lines.map((line) => line.text))).not.toContain('a/src/app.ts')
})

test('an edit is paired row by row; the longer run continues against an empty cell', () => {
  const [first] = parsePatch(PATCH)
  if (first === undefined) throw new Error('expected a hunk')
  const rows = splitRows(first).map((row) => [row.left?.text ?? null, row.right?.text ?? null])
  expect(rows).toEqual([
    ['keep one', 'keep one'],
    ['old two', 'new two'],
    ['old three', null],
    ['keep four', 'keep four'],
    [null, 'added five'],
  ])
})

test('a removed line after added ones starts a new edit, not the same row', () => {
  const [hunk] = parsePatch(['@@ -1,2 +1,2 @@', '-a', '+b', '-c', '+d'].join('\n'))
  if (hunk === undefined) throw new Error('expected a hunk')
  expect(splitRows(hunk).map((row) => [row.left?.text, row.right?.text])).toEqual([
    ['a', 'b'],
    ['c', 'd'],
  ])
})

test('the unchanged lines git left out are counted before each hunk', () => {
  const [first, second] = parsePatch(PATCH)
  if (first === undefined || second === undefined) throw new Error('expected two hunks')
  expect(hiddenBefore(first, undefined).count).toBe(0)
  // The first hunk covers old lines 1–4; the second starts at 20.
  expect(hiddenBefore(second, first).count).toBe(15)
  const [newFile] = parsePatch(['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'))
  if (newFile === undefined) throw new Error('expected a hunk')
  expect(hiddenBefore(newFile, undefined).count).toBe(0)
  // #461: without context (`diff.context = 0`) git numbers an empty side from the line before it —
  // an insertion after old line 2 leaves lines 1 and 2 out, not 1 alone.
  const [insertion] = parsePatch(['@@ -2,0 +3 @@', '+NEW'].join('\n'))
  if (insertion === undefined) throw new Error('expected a hunk')
  expect(hiddenBefore(insertion, undefined)).toEqual({ oldStart: 1, newStart: 1, count: 2 })
})

/** Two one-line edits in a 15-line file whose new side is two lines longer (#461). */
const TWO_EDITS = [
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  '+two and a half',
  ' three',
  '@@ -10,3 +11,4 @@',
  ' ten',
  '-eleven',
  '+ELEVEN',
  '+eleven and a half',
  ' twelve',
].join('\n')

const TWO_EDITS_NEW = linesOf(
  [
    'one',
    'TWO',
    'two and a half',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'ELEVEN',
    'eleven and a half',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    '',
  ].join('\n'),
)

// #461: the lines the counts stand for, from the file read whole.
test('a hidden run is the file’s own lines, numbered on both sides; the run after the last hunk runs to the end', () => {
  const [first, second] = parsePatch(TWO_EDITS)
  if (first === undefined || second === undefined) throw new Error('expected two hunks')
  const run = hiddenBefore(second, first)
  expect(run).toEqual({ oldStart: 4, newStart: 5, count: 6 })
  const rows = hiddenRows(run, TWO_EDITS_NEW, 'new')
  expect(rows.map((row) => [row.left?.oldNumber, row.right?.newNumber, row.left?.text])).toEqual([
    [4, 5, 'four'],
    [5, 6, 'five'],
    [6, 7, 'six'],
    [7, 8, 'seven'],
    [8, 9, 'eight'],
    [9, 10, 'nine'],
  ])
  expect(rows.every((row) => row.left === row.right && row.left?.kind === 'context')).toBe(true)
  // The second hunk ends at old 12, new 14; the file has 17 new lines, so 15–17 are left — old 13–15.
  const after = hiddenAfter(second, TWO_EDITS_NEW, 'new')
  expect(after).toEqual({ oldStart: 13, newStart: 15, count: 3 })
  expect(hiddenRows(after, TWO_EDITS_NEW, 'new').map((row) => row.right?.text)).toEqual([
    'thirteen',
    'fourteen',
    'fifteen',
  ])
})

test('a file read after its patch is held to it: a line the patch shows that the file no longer has is caught', () => {
  const hunks = parsePatch(PATCH)
  const oldLines = ['keep one', 'old two', 'old three', 'keep four', ...Array.from({ length: 15 }, () => 'x'), 'last']
  expect(agreesWith(hunks, oldLines, 'old')).toBe(true)
  expect(agreesWith(hunks, oldLines.with(3, 'keep four, edited since'), 'old')).toBe(false)
  // A file too short for a line the patch shows does not agree either.
  expect(agreesWith(hunks, oldLines.slice(0, 10), 'old')).toBe(false)
})

test("a file's lines: a final newline opens no extra line, a CRLF line's \\r is not part of it, an empty file has none", () => {
  expect(linesOf('a\nb\n')).toEqual(['a', 'b'])
  expect(linesOf('a\nb')).toEqual(['a', 'b'])
  expect(linesOf('a\r\nb\r\n')).toEqual(['a', 'b'])
  expect(linesOf('')).toEqual([])
})

test('a patch with no hunk — a mode change — has none', () => {
  expect(parsePatch('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual([])
})
