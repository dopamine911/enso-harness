import { expect, test } from 'bun:test'
import { headerDecision } from '../scripts/docs/decisions.ts'

/**
 * WHAT COUNTS AS A DECISION HEADER, AND WHICH SENTENCE IS THE DECISION (#170, #832).
 *
 * `docs/reference/decisions.md` publishes one row per source file whose leading comment cites an
 * issue, with that comment's first complete sentence as the decision. A header read wrong
 * publishes a wrong claim about why the code is the way it is, so these pin the reader on the
 * shapes the repository writes and the ones it must refuse to guess at.
 */

test('a block header yields its issues once each, ascending, and its first complete sentence', () => {
  const source = [
    '/**',
    ' * Owns the queue (#12, #3). Retries live in',
    ' * the caller (#12).',
    ' */',
    'export {}',
  ].join('\n')
  expect(headerDecision(source)).toEqual({
    issues: [3, 12],
    decision: 'Owns the queue (#12, #3).',
    unclassified: false,
  })
})

test('a run of line comments is one header, joined across lines', () => {
  const source = ['// The thread registry is the only writer', '// (#40). Readers go through it.', 'const x = 1'].join(
    '\n',
  )
  expect(headerDecision(source)?.decision).toBe('The thread registry is the only writer (#40).')
})

test('a sentence ends at `.`, `!` or `?` followed by space or the end, carrying its closing quotes', () => {
  // A dot inside a name or a version is not the end of a sentence.
  expect(headerDecision('/** Pins `a.b` at v1.2 for now (#1). Later. */')?.decision).toBe(
    'Pins `a.b` at v1.2 for now (#1).',
  )
  // The closing quote or bracket after the stop belongs to the sentence it ends.
  expect(headerDecision('/** It says "stop." (#2) Then more. */')?.decision).toBe('It says "stop."')
  expect(headerDecision('/** Why not (#3)? Because. */')?.decision).toBe('Why not (#3)?')
  // A stop at the very end of the header ends a sentence too.
  expect(headerDecision('/** Only this (#4)! */')?.decision).toBe('Only this (#4)!')
})

test('a header that cites an issue but never finishes a sentence is UNCLASSIFIED, by its start line', () => {
  const source = ['import x from "y"', '', '/**', ' * Owns the queue (#7)', ' */'].join('\n')
  expect(headerDecision(source)).toEqual({
    issues: [7],
    decision: 'UNCLASSIFIED — leading header at line 3 has no complete sentence',
    unclassified: true,
  })
})

test('only the FIRST comment is the header, and it must start within the first 80 lines', () => {
  // A plain header hides a later comment's issue: implementation comments are not decisions.
  expect(headerDecision('/** A plain header. */\n/** Fixes the race (#9). */')).toBeUndefined()
  expect(headerDecision('const a = 1\n')).toBeUndefined()
  const blank = (count: number): string => '\n'.repeat(count)
  expect(headerDecision(`${blank(79)}// Starts on line 80 (#5).`)?.decision).toBe('Starts on line 80 (#5).')
  expect(headerDecision(`${blank(80)}// Starts on line 81 (#5).`)).toBeUndefined()
})

test('a block comment that never closes is read to the end of the file', () => {
  expect(headerDecision('/* Unclosed (#6).\n * still the header (#8)')).toEqual({
    issues: [6, 8],
    decision: 'Unclosed (#6).',
    unclassified: false,
  })
})
