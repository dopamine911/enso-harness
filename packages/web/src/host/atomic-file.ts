import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, type Stats, statSync, utimesSync, writeFileSync } from 'node:fs'
import { realpathOrSelf } from '@enso/core/paths'

/**
 * The file plumbing Settings' saves share — the permission policy (#474), `config.json` and
 * `secrets.env` (#933): a file's bytes and `ETag`, whether it is still what the page read, and an
 * atomic replace, so a reader sees the old file or the new one, never neither.
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

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Write `text` to the file behind `path` (a link is followed, and survives) in one step: a
 * temporary file beside it, renamed over it. `mode` is the new file's permission bits; it applies
 * because the temporary file is always newly created (`wx`), so the file is never readable wider
 * for a moment — `secrets.env` is written `0600` so. Without it, the process umask decides.
 *
 * ⚠ THE MODIFICATION TIME MUST MOVE. The permission engine reloads a policy only when the file's
 * `mtimeMs` differs from the one it last read (`config/policy-loader.ts`), and Linux stamps it from
 * a coarse clock — one tick is milliseconds. A write landing in the same tick as the last one (a
 * reset just after a hand edit) kept the OLD policy in force, silently. Found by
 * `agent-host.test.ts`'s reset test.
 */
export function writeAtomically(path: string, text: string, mode?: number): void {
  const target = realpathOrSelf(path)
  const previous = statOrUndefined(target)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode })
  try {
    renameSync(temporary, target)
  } catch (error: unknown) {
    rmSync(temporary, { force: true })
    throw error
  }
  if (previous === undefined) return
  const written = statSync(target)
  if (written.mtimeMs > previous.mtimeMs) return
  utimesSync(target, written.atime, (previous.mtimeMs + 1) / 1000)
}
