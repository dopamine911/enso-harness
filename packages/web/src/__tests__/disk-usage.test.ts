import { expect, test } from 'bun:test'
import { describeSize, formatBytes } from '../disk-usage.ts'

// #578: decimal units, one place below 10 of a unit, whole from 10 up — and a value that rounds
// up to the next unit is said in it, never as `1000 kB` or `10.0 MB`.
test.each([
  [0, '0 B'],
  [999, '999 B'],
  [1000, '1.0 kB'],
  [1300, '1.3 kB'],
  [9949, '9.9 kB'],
  [9960, '10 kB'],
  [999_499, '999 kB'],
  [999_600, '1.0 MB'],
  [412_000_000, '412 MB'],
  [1_300_000_000, '1.3 GB'],
  [5_000_000_000_000_000, '5000 TB'],
])('formatBytes(%p) is %p', (bytes, said) => {
  expect(formatBytes(bytes)).toBe(said)
})

test('a partial size is said as at least its bytes; an unreadable one by its reason, never as 0', () => {
  expect(describeSize({ kind: 'partial', bytes: 412_000_000, reason: 'timed out' })).toBe('at least 412 MB')
  expect(describeSize({ kind: 'unreadable', reason: 'EACCES' })).toBe('size could not be read (EACCES)')
})
