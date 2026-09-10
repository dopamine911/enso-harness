import { expect, test } from 'bun:test'
import type { ZenLogLine } from '../../packages/core/src/index.ts'
import { matches, parseArguments, UsageError } from '../zen-logs.ts'

/**
 * The reader's own logic (#132, `bun run logs`): the flags, and what a line must be to print.
 */

test('flags: defaults, every flag, and the local-day --date', () => {
  const defaults = parseArguments([])
  expect(defaults).toMatchObject({
    follow: false,
    json: false,
    color: false,
    level: 2,
    thread: undefined,
    process: undefined,
    sinceMs: undefined,
  })

  const all = parseArguments([
    '--follow',
    '--json',
    '--color',
    '--level',
    'debug',
    '--thread',
    '6923e6',
    '--process',
    'pi',
    '--since',
    '10m',
  ])
  expect(all).toMatchObject({
    follow: true,
    json: true,
    color: true,
    level: 1,
    thread: '6923e6',
    process: 'pi',
    sinceMs: 600_000,
  })

  expect(parseArguments(['-f', '--level', 'WARN'])).toMatchObject({ follow: true, level: 3 })
  expect(parseArguments(['--since', '30s']).sinceMs).toBe(30_000)
  expect(parseArguments(['--since', '2h']).sinceMs).toBe(7_200_000)
  expect(parseArguments(['--since', '1d']).sinceMs).toBe(86_400_000)
  expect(parseArguments(['--file', 'zen-bundle.md']).file).toBe('zen-bundle.md')

  // The file is named by the local day, so the date is read as local noon — never a day off at a zone boundary.
  const dated = parseArguments(['--date', '2026-09-08']).date
  expect([dated.getFullYear(), dated.getMonth() + 1, dated.getDate()]).toEqual([2026, 9, 8])
})

test('a flag the reader cannot take is a UsageError naming the problem, never a silent default', () => {
  expect(() => parseArguments(['--level', 'loud'])).toThrow(UsageError)
  expect(() => parseArguments(['--since', 'soon'])).toThrow(/30s, 10m, 2h, 1d/)
  expect(() => parseArguments(['--date', 'yesterday'])).toThrow(/YYYY-MM-DD/)
  expect(() => parseArguments(['--thread'])).toThrow(/needs a value/)
  expect(() => parseArguments(['--verbose'])).toThrow(/unknown flag --verbose/)
  expect(() => parseArguments(['--file', 'b.md', '--follow'])).toThrow(/cannot be followed/)
})

const line = (overrides: Partial<ZenLogLine> = {}): ZenLogLine => ({
  '@timestamp': '2026-09-09T23:41:26.174Z',
  level: 'WARN',
  message: '{toolName} denied: {reason}',
  logger: 'zen.extension.guards',
  properties: { process: 'server', threadId: '6923e620-856a-4132-a9c8-1a2ff7d271f9', toolName: 'write' },
  ...overrides,
})

test('a line prints when it clears the level, is after --since, and matches the thread prefix and process', () => {
  const at = Date.parse('2026-09-09T23:41:26.174Z')
  expect(matches(parseArguments([]), line(), 0)).toBe(true)
  // Level is a floor: WARN clears info; DEBUG does not; --level trace admits everything.
  expect(matches(parseArguments([]), line({ level: 'DEBUG' }), 0)).toBe(false)
  expect(matches(parseArguments(['--level', 'trace']), line({ level: 'TRACE' }), 0)).toBe(true)
  // --since is a cutoff on the record's own time.
  expect(matches(parseArguments([]), line(), at + 1)).toBe(false)
  expect(matches(parseArguments([]), line(), at)).toBe(true)
  // Thread by prefix; process exactly.
  expect(matches(parseArguments(['--thread', '6923e6']), line(), 0)).toBe(true)
  expect(matches(parseArguments(['--thread', '6923e620-856a']), line(), 0)).toBe(true)
  expect(matches(parseArguments(['--thread', 'other']), line(), 0)).toBe(false)
  expect(matches(parseArguments(['--process', 'server']), line(), 0)).toBe(true)
  expect(matches(parseArguments(['--process', 'pi']), line(), 0)).toBe(false)
  // A record with no thread never matches a thread filter, and always matches none.
  expect(matches(parseArguments(['--thread', '6923']), line({ properties: { process: 'server' } }), 0)).toBe(false)
  const { properties: _dropped, ...withoutProperties } = line()
  expect(matches(parseArguments([]), withoutProperties, 0)).toBe(true)
})
