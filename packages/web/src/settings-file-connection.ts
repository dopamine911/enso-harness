import type { Static, TSchema } from 'typebox'
import type { FetchLike } from './browser-logging.ts'
import { sendChecked, type Unavailable } from './permissions-connection.ts'

/**
 * How Settings' `config.json` sections call their routes (Security #933, Projects & threads #934):
 * read the section with the file's `ETag`, and save it whole under that `ETag`. A failure is data,
 * never a throw: the section says it in the server's words.
 */

export type SettingsFileRead<Read> = { readonly kind: 'loaded'; readonly settings: Read } | Unavailable

export type SettingsFileSave<Read> =
  | { readonly kind: 'saved'; readonly settings: Read }
  /** 412: the file changed on disk since it was read; nothing was written. */
  | { readonly kind: 'conflict'; readonly detail: string }
  /** 422: the file is unreadable, or the result would be; nothing was written. */
  | { readonly kind: 'refused'; readonly detail: string }
  | Unavailable

export async function fetchSettingsFile<Schema extends TSchema>(
  fetchImpl: FetchLike,
  path: string,
  settings: readonly [Schema, string],
): Promise<SettingsFileRead<Static<Schema>>> {
  const sent = await sendChecked(fetchImpl, path, undefined, settings)
  return sent.kind === 'ok' ? { kind: 'loaded', settings: sent.payload } : { kind: 'unavailable', detail: sent.detail }
}

/** Save `write`, if the disk still holds the version `etag` names; none — no file — creates it. */
export async function saveSettingsFile<Schema extends TSchema>(
  fetchImpl: FetchLike,
  path: string,
  { write, etag }: { readonly write: unknown; readonly etag: string | undefined },
  settings: readonly [Schema, string],
): Promise<SettingsFileSave<Static<Schema>>> {
  const precondition = etag === undefined ? { 'If-None-Match': '*' } : { 'If-Match': etag }
  const sent = await sendChecked(
    fetchImpl,
    path,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', ...precondition }, body: JSON.stringify(write) },
    settings,
  )
  if (sent.kind === 'ok') return { kind: 'saved', settings: sent.payload }
  if (sent.kind === 'answered' && sent.status === 412) return { kind: 'conflict', detail: sent.detail }
  if (sent.kind === 'answered' && sent.status === 422) return { kind: 'refused', detail: sent.detail }
  return { kind: 'unavailable', detail: sent.detail }
}

/** A setting saved beside the file (the judge's key, the trust default): the answer, or why not. */
export async function saveSideSetting<Schema extends TSchema>(
  fetchImpl: FetchLike,
  path: string,
  write: unknown,
  answer: readonly [Schema, string],
): Promise<({ readonly kind: 'saved' } & Static<Schema>) | Unavailable> {
  const sent = await sendChecked(
    fetchImpl,
    path,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write) },
    answer,
  )
  return sent.kind === 'ok' ? { kind: 'saved', ...sent.payload } : { kind: 'unavailable', detail: sent.detail }
}
