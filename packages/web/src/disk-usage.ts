import type { EnsoDiskUsage } from '@enso/core'

/** Decimal units, as `du --si` and file managers say them: a kilobyte is 1000 bytes. */
const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const

/**
 * A byte count as a person reads it (#578): one decimal place below 10 of a unit, whole numbers
 * above — `512 B`, `1.3 kB`, `412 MB`, `1.3 GB`. Bytes are whole, so they never take a decimal.
 */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (unit < UNITS.length - 1 && Math.round(value) >= 1000) {
    value /= 1000
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} B`
  // Rounding 9.96 to one place reads 10.0: say it whole, as every value from 10 up is.
  const tenths = Math.round(value * 10) / 10
  return tenths < 10 ? `${tenths.toFixed(1)} ${UNITS[unit]}` : `${Math.round(value)} ${UNITS[unit]}`
}

/**
 * A size as words (#578): `412 MB`, `at least 412 MB`, or why it could not be read — an unread
 * size has no number to say, and is never 0.
 */
export function describeSize(size: EnsoDiskUsage): string {
  if (size.kind === 'measured') return formatBytes(size.bytes)
  if (size.kind === 'partial') return `at least ${formatBytes(size.bytes)}`
  return `size could not be read (${size.reason})`
}
