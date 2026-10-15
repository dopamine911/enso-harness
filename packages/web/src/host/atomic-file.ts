import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * The file plumbing Settings' saves share — the permission policy (#474), `config.json` and
 * `secrets.env` (#933): a file's bytes and `ETag`, and whether it is still what the page read. The
 * write itself is `replaceFileText` (`@enso/core/paths`), shared with the Web tools allowlist (#924).
 */

/**
 * What a write expects on disk: the server's `WriteCondition` (#443), stated here because the host
 * imports only core. `absent` — no file; `matches` — the version read; `present` — whatever is there.
 */
export type WriteCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'matches'; readonly etag: string }
  | { readonly kind: 'present' }

/** A strong entity tag for the file's bytes, quoted as HTTP writes one (the prompt library's). */
export function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`
}

/** A Node file-system error's `code`, or `undefined` for anything else. */
export function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** The file's bytes, or `undefined` when there is none. */
export function bytesOf(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Why the file at `path` is not what `condition` expects, or `undefined` when it is. */
export function conflictOf(path: string, condition: WriteCondition): string | undefined {
  const bytes = bytesOf(path)
  if (condition.kind === 'absent') return bytes === undefined ? undefined : `${path} already exists`
  if (bytes === undefined) return `${path} is no longer there: it was deleted since it was opened`
  if (condition.kind === 'matches' && etagOf(bytes) !== condition.etag) {
    return `${path} changed on disk since it was opened — reload to see the version there now`
  }
  return undefined
}
