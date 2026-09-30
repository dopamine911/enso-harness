import { expect, test } from 'bun:test'
import { changedLines, renderTouched, touchedComments } from '../scripts/docs/touched-comments.ts'

/**
 * WHICH COMMENTS A DIFF PUTS AT RISK (#482).
 *
 * ⚠ Enforcement for the CI reviewer's input: `.claude/pr-review.md` tells the reviewer to check every
 * comment `touched-comments.ts` lists. A comment the selection drops is a comment nobody checks, so
 * each rule here is a way a stale comment would otherwise slip past review.
 */

const DIFF = [
  'diff --git a/src/rules.ts b/src/rules.ts',
  '--- a/src/rules.ts',
  '+++ b/src/rules.ts',
  '@@ -4 +4 @@ export function changed(): number {',
  '@@ -11,0 +10,0 @@ export function trimmed(): number {',
  '@@ -18 +18 @@',
  '@@ -21,0 +23 @@ export function tagged(): number {',
  'diff --git a/docs/page.md b/docs/page.md',
  '--- a/docs/page.md',
  '+++ b/docs/page.md',
  '@@ -1 +1 @@',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  'diff --git a/types/emitted.d.ts b/types/emitted.d.ts',
  '--- a/types/emitted.d.ts',
  '+++ b/types/emitted.d.ts',
  '@@ -1 +1 @@',
].join('\n')

const SOURCE = [
  '/** Returns one; the body below changed and this comment did not. */',
  'export function changed(): number {',
  '  const value = 1',
  '  return value',
  '}',
  '',
  '/** Its body lost a line: a deletion inside it still counts. */',
  'export function trimmed(): number {',
  '  const first = 1',
  '  const second = 2',
  '  return first',
  '  // A note inside the body, about the function.',
  '}',
  '',
  '/** Untouched: nothing in it or around it changed. */',
  'export const untouched = 3',
  '',
  '/** Reworded by this diff, over a declaration that did not change. */',
  'export const reworded = 4',
  '',
  '/** Its body gained only a comment: the code under this one did not change. */',
  'export function tagged(): number {',
  '  // A note this diff added, the only changed line in the function.',
  '  return 5',
  '}',
].join('\n')

const changes = changedLines(DIFF)
const touched = touchedComments(changes, (file) => (file === 'src/rules.ts' ? SOURCE : undefined))
const whyFor = (text: string): string | undefined =>
  touched.find((entry) => entry.comment.lines.some((line) => line.includes(text)))?.why

test('the changed lines are read per source file; prose, declaration output and a deleted file carry none', () => {
  expect([...changes.keys()]).toEqual(['src/rules.ts'])
  expect(changes.get('src/rules.ts')).toEqual([
    { from: 4, to: 4 },
    // A pure deletion after line 10: counted at the lines it sat between.
    { from: 10, to: 11 },
    { from: 18, to: 18 },
    { from: 23, to: 23 },
  ])
})

test('⚠ code changed under an unchanged comment puts that comment at risk, a note in the body included', () => {
  expect(whyFor('the body below changed')).toBe('declaration changed')
  expect(whyFor('a deletion inside it')).toBe('declaration changed')
  expect(whyFor('A note inside the body')).toBe('declaration changed')
})

test('a comment the diff rewrote is listed too, and one nothing touched is not', () => {
  expect(whyFor('Reworded by this diff')).toBe('comment changed')
  expect(whyFor('Untouched')).toBeUndefined()
})

test('⚠ a comment added to a body is a change to words, not code: the other comments on that declaration are not at risk (PR #488 dry run)', () => {
  expect(whyFor('the only changed line')).toBe('comment changed')
  expect(whyFor('gained only a comment')).toBeUndefined()
})

test('⚠ the most likely stale comes first: code changed under a comment before a comment the diff rewrote', () => {
  const page = renderTouched(touched, { flows: [], invariants: [], pins: [], diagrams: [], problems: [] }, 'main')
  expect(page.indexOf('the body below changed')).toBeLessThan(page.indexOf('Reworded by this diff'))
})
