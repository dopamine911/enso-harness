import { expect, test } from 'bun:test'
import { hiddenBefore, parsePatch, splitRows } from '../diff-rows.ts'

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
  expect(hiddenBefore(first, undefined)).toBe(0)
  // The first hunk covers old lines 1–4; the second starts at 20.
  expect(hiddenBefore(second, first)).toBe(15)
  const [newFile] = parsePatch(['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'))
  if (newFile === undefined) throw new Error('expected a hunk')
  expect(hiddenBefore(newFile, undefined)).toBe(0)
})

test('a patch with no hunk — a mode change — has none', () => {
  expect(parsePatch('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual([])
})
