import { expect, test } from 'bun:test'
import { unifiedPatch } from '../text-patch.ts'

/**
 * The diff the project page asks an approval over (#753), in git's hunk format: what it shows must be
 * every change, a dropped final newline included, or a change is approved unseen.
 */

test('no change is no patch; a file from nothing is all added', () => {
  expect(unifiedPatch('{}\n', '{}\n')).toBe('')
  expect(unifiedPatch('', '{\n}\n')).toBe('@@ -0,0 +1,2 @@\n+{\n+}\n')
})

test('⚠ changes far apart are separate hunks with three lines of context, and a dropped final newline is shown', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n'
  const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
  expect(unifiedPatch(before, after)).toBe(
    [
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      ' e',
      '@@ -7,4 +7,4 @@',
      ' g',
      ' h',
      ' i',
      '-j',
      '+j',
      '\\ No newline at end of file',
      '',
    ].join('\n'),
  )
})
