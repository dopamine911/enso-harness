/**
 * Tiny helpers every provider wire shares (#63, PR #64 review): narrowing for unknown
 * JSON wire payloads, and base-URL hygiene.
 *
 * ⚠ Providers import THIS module (like `sources.ts` and `sse.ts`), never each other — the
 * shared-util relationship is what keeps the later provider-package split mechanical.
 */

/** Narrow an unknown wire value to a plain object, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Narrow an unknown wire value to a string, or undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Strip trailing slashes so endpoint concatenation never emits a double slash. */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
