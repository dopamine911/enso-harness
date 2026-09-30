import { expect, test } from 'bun:test'
import { literalConstant } from '../scripts/docs/source-constants.ts'

/**
 * A docs page quotes a constant another zone owns by reading its source (#482). What matters is
 * that the value read is the value the program runs with, and that anything else is refused, never
 * approximated: a wrong number on a page is worse than no page.
 */

const SOURCE = `
const MB = 1024 * 1024
/** A bracket in a comment ] can't end the array. */
export const LIMITS = { bytes: 5 * MB, count: 20, label: 'at most ]' } as const
const LEVELS = ['low', "high"] as const satisfies readonly string[]
export const WORDS = new Set([...[]])
export const NAMED = { LEVELS, strict: true, none: null, negative: -(2) }
export const TEMPLATE = \`plain\`
export const CALLED = String(1)
function inner() { const HIDDEN = 1; return HIDDEN }
export const LOOP = AGAIN
const AGAIN = LOOP
`

test('a constant is read as the program would compute it: arithmetic over other constants, nested literals, wrappers looked through', () => {
  expect(literalConstant('limits.ts', SOURCE, 'LIMITS')).toEqual({ bytes: 5_242_880, count: 20, label: 'at most ]' })
  expect(literalConstant('limits.ts', SOURCE, 'NAMED')).toEqual({
    LEVELS: ['low', 'high'],
    strict: true,
    none: null,
    negative: -2,
  })
  expect(literalConstant('limits.ts', SOURCE, 'TEMPLATE')).toBe('plain')
})

test('what is not a literal is refused by file, line and constant, never approximated', () => {
  expect(() => literalConstant('limits.ts', SOURCE, 'CALLED')).toThrow('limits.ts:9: CALLED is not a literal here')
  expect(() => literalConstant('limits.ts', SOURCE, 'WORDS')).toThrow('WORDS is not a literal here')
  // Only top-level constants: a local inside a function is not the file's value.
  expect(() => literalConstant('limits.ts', SOURCE, 'HIDDEN')).toThrow('limits.ts has no top-level const HIDDEN')
  expect(() => literalConstant('limits.ts', SOURCE, 'LOOP')).toThrow('LOOP → AGAIN → LOOP refers to itself')
})
