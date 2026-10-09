import { expect, test } from 'bun:test'
import { istanbulFileCoverage, parseLcov } from '../coverage-istanbul.ts'

/**
 * The LCOV → Istanbul mapping fallow scores CRAP from (#826). fallow matches an `(anonymous_N)`
 * entry to its own function by start position and scores the share of hit statements inside the
 * entry's span, so the positions and spans are what this pins.
 */

const SOURCE = [
  'export function doubled(values: number[]): number[] {',
  '  return values.map((value) => value * 2)',
  '}',
  '',
  'class Counter {',
  '  count(): number {',
  '    return 1',
  '  }',
  '}',
  '',
  'const never = (): number => {',
  '  return 0',
  '}',
  '',
  'const unlisted = (): void => {}',
].join('\n')

const LCOV = [
  'TN:',
  'SF:fixture.ts',
  'FNF:0',
  'FNH:0',
  'DA:1,3',
  'DA:2,3',
  'DA:6,0',
  'DA:7,0',
  'DA:11,1',
  'DA:12,0',
  'end_of_record',
  'SF:types.ts',
  'end_of_record',
  '',
].join('\n')

interface Span {
  readonly start: { readonly line: number; readonly column: number }
  readonly end: { readonly line: number; readonly column: number }
}

const at = (startLine: number, startColumn: number, endLine: number, endColumn: number): Span => ({
  start: { line: startLine, column: startColumn },
  end: { line: endLine, column: endColumn },
})

test('parseLcov keeps each record’s DA hits by line, and a record with none', () => {
  const [fixture, types] = parseLcov(LCOV)
  expect(fixture?.path).toBe('fixture.ts')
  expect([...(fixture?.lines ?? [])]).toEqual([
    [1, 3],
    [2, 3],
    [6, 0],
    [7, 0],
    [11, 1],
    [12, 0],
  ])
  expect(types).toEqual({ path: 'types.ts', lines: new Map() })
})

test('one statement per DA line from its first non-blank character; one anonymous function per AST span, counted from its first DA line', () => {
  const lines = parseLcov(LCOV)[0]?.lines ?? new Map<number, number>()
  const coverage = istanbulFileCoverage('/repo/fixture.ts', SOURCE, lines)
  expect(coverage.path).toBe('/repo/fixture.ts')
  expect(coverage.statementMap).toEqual({
    0: at(1, 0, 1, 53),
    1: at(2, 2, 2, 41),
    2: at(6, 2, 6, 19),
    3: at(7, 4, 7, 12),
    4: at(11, 0, 11, 29),
    5: at(12, 2, 12, 10),
  })
  expect(coverage.s).toEqual({ 0: 3, 1: 3, 2: 0, 3: 0, 4: 1, 5: 0 })
  expect(coverage.fnMap).toEqual({
    // The span starts at `export`, so the declaration line's statement lies inside it.
    0: { name: '(anonymous_0)', decl: at(1, 16, 1, 23), loc: at(1, 0, 3, 1), line: 1 },
    // A one-line callback holds no whole statement: fallow scores it from `f`, its line's count.
    1: { name: '(anonymous_1)', decl: at(2, 20, 2, 40), loc: at(2, 20, 2, 40), line: 2 },
    2: { name: '(anonymous_2)', decl: at(6, 2, 6, 7), loc: at(6, 2, 8, 3), line: 6 },
    // `const never =` ran when the module loaded; the body's statement, the one inside the span, did not.
    3: { name: '(anonymous_3)', decl: at(11, 14, 13, 1), loc: at(11, 14, 13, 1), line: 11 },
  })
  // `unlisted` has no DA line, so it has no entry and fallow keeps its estimate.
  expect(coverage.f).toEqual({ 0: 3, 1: 3, 2: 0, 3: 1 })
  expect(coverage.branchMap).toEqual({})
})
