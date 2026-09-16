import { expect, test } from 'bun:test'
import { codeOffenders } from './gate-support.ts'

/**
 * The allowlist is the leak inventory (#162 workstream 4): a row hides a file's matches, and a
 * row for a file with no matches is drift and is reported. Pinned over real files, so the
 * three outcomes are the contract and not a fixture's shape: `ZEN_LOG_ROOT` is declared in
 * `packages/core/src/log.ts` and nowhere else under `packages/core/src`.
 */
const scan = {
  roots: ['packages/core/src'],
  lineMatches: (line: string): boolean => line.includes('export const ZEN_LOG_ROOT'),
}

test('a match in a file that is not allowlisted is an offender, named by line', () => {
  const offenders = codeOffenders(scan)
  expect(offenders).toHaveLength(1)
  expect(offenders[0]).toMatch(/^packages\/core\/src\/log\.ts:\d+$/)
})

test('an allowlisted file with a match is silent — that is what the row is for', () => {
  expect(codeOffenders({ ...scan, allowed: ['packages/core/src/log.ts'] })).toEqual([])
})

test('⚠ an allowlisted file the walk never visits is reported too: a renamed or deleted file is the same drift', () => {
  expect(
    codeOffenders({ ...scan, allowed: ['packages/core/src/log.ts', 'packages/core/src/no-such-file.ts'] }),
  ).toEqual(['packages/core/src/no-such-file.ts (allowlisted, matches nothing)'])
})

test('⚠ an allowlisted file with NO match is reported: the row outlived its leak', () => {
  expect(codeOffenders({ ...scan, allowed: ['packages/core/src/log.ts', 'packages/core/src/config.ts'] })).toEqual([
    'packages/core/src/config.ts (allowlisted, matches nothing)',
  ])
})
