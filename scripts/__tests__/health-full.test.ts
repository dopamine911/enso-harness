import { expect, test } from 'bun:test'
import { crapLine, duplicationOf } from '../health-full.ts'

/**
 * `bun run health:full` (#825) reads fallow's JSON checked: a changed shape throws rather than
 * reporting a zero, and the CRAP line counts only real scores at or over the threshold (#838).
 */

test('the duplication headline: the percentage to two places and the clone groups', () => {
  expect(duplicationOf({ stats: { duplication_percentage: 3.14159, clone_groups: 12, other: 'kept out' } })).toBe(
    '3.14% · 12 groups',
  )
  expect(duplicationOf({ stats: { duplication_percentage: 0, clone_groups: 0 } })).toBe('0.00% · 0 groups')
})

test('⚠ a dupes JSON without its stats, or with stats that are not numbers, throws rather than reading as zero', () => {
  const missing = /fallow's dupes JSON has no `stats`/
  expect(() => duplicationOf({})).toThrow(missing)
  expect(() => duplicationOf({ stats: null })).toThrow(missing)
  expect(() => duplicationOf({ stats: '3%' })).toThrow(missing)
  expect(() => duplicationOf({ stats: { duplication_percentage: 3 } })).toThrow(missing)
  expect(() => duplicationOf({ stats: { clone_groups: 3 } })).toThrow(missing)
  const notNumbers = /fallow's dupes `stats` are not numbers/
  expect(() => duplicationOf({ stats: { duplication_percentage: '3', clone_groups: 1 } })).toThrow(notNumbers)
  expect(() => duplicationOf({ stats: { duplication_percentage: 3, clone_groups: null } })).toThrow(notNumbers)
})

test('the CRAP line counts findings at or over 30, measured apart from estimated', () => {
  const findings = [
    { crap: 30, coverage_source: 'istanbul' },
    { crap: 110, coverage_source: 'estimated' },
    { crap: 72.5, coverage_source: 'istanbul' },
    { crap: 29.9, coverage_source: 'istanbul' },
    // A finding over the cyclomatic or cognitive limit only carries no CRAP score at all.
    { cyclomatic: 40 },
    { crap: '99', coverage_source: 'istanbul' },
    { crap: null },
    null,
    'crap',
  ]
  expect(crapLine(findings)).toBe(
    "CRAP at or over 30: 3 functions, 2 scored from measured coverage and 1 from fallow's estimate.",
  )
  expect(crapLine([])).toBe(
    "CRAP at or over 30: 0 functions, 0 scored from measured coverage and 0 from fallow's estimate.",
  )
})
