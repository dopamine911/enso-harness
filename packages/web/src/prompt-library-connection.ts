import {
  EnsoLibraryPrompt,
  EnsoLibraryPromptListing,
  type EnsoLibraryPromptWrite,
  type EnsoSystemPromptDraft,
  EnsoSystemPromptPreview,
} from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'

/**
 * The prompt library's reads (#443): `GET /api/prompts` and `GET /api/prompts/:id`, validated with
 * the wire's own schemas, as `commands-connection.ts` reads the palette's list. The route writes no
 * record for a read, so the Start dialog asks on every open: a file edited elsewhere is what it shows.
 *
 * A failure is data, never a throw: the dialog says it beside the field it concerns and still
 * starts with pi's default — never silently, since the reason is on screen.
 */

export type LibraryListing =
  | { readonly kind: 'loaded'; readonly listing: EnsoLibraryPromptListing }
  | { readonly kind: 'unavailable'; readonly detail: string }

export type LibraryPromptRead =
  /** `etag`: the version read — what a later replace or delete of it names (`If-Match`). */
  | { readonly kind: 'loaded'; readonly prompt: EnsoLibraryPrompt; readonly etag: string }
  | { readonly kind: 'unavailable'; readonly detail: string }

/**
 * What a write or delete expects on disk (#443), sent as its precondition: no file (`create`), the
 * version read (`replace`, with its etag), or whatever is there (`overwrite` — a person's "mine wins").
 */
export type LibraryPrecondition =
  | { readonly kind: 'create' }
  | { readonly kind: 'replace'; readonly etag: string }
  | { readonly kind: 'overwrite' }

/** The disk did not hold what the precondition expected (412): nothing was written or removed. */
export type LibraryConflict = { readonly kind: 'conflict'; readonly detail: string }

/** A read's failure: what the dialog shows beside the field, and the status when the server answered. */
type Unavailable = { readonly kind: 'unavailable'; readonly detail: string; readonly status?: number }

/** A checked read: the payload, and the `ETag` the response carried. */
type CheckedRead<Payload> =
  | { readonly kind: 'loaded'; readonly payload: Payload; readonly etag: string | null }
  | Unavailable

/** A non-2xx as the words the dialog shows: the server's reason is written for a person. */
async function failureOf(response: Response): Promise<string> {
  const body = (await response.text()).trim()
  return body.length > 0 ? body : `the server answered ${response.status}`
}

/** A JSON body sent with `method`, and any precondition headers. */
function sending(method: 'PUT' | 'POST', body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

/** A precondition as HTTP says it (RFC 9110 §13.1): `If-None-Match: *`, or `If-Match` with the etag or `*`. */
function preconditionHeaders(precondition: LibraryPrecondition): Record<string, string> {
  if (precondition.kind === 'create') return { 'If-None-Match': '*' }
  return { 'If-Match': precondition.kind === 'replace' ? precondition.etag : '*' }
}

/** One request, its payload checked against `schema`; `what` names the payload when it does not match. */
async function readChecked<Schema extends TSchema>(
  request: string | { readonly path: string; readonly init: RequestInit },
  schema: Schema,
  what: string,
  fetchImpl: FetchLike,
): Promise<CheckedRead<Static<Schema>>> {
  try {
    const response =
      typeof request === 'string' ? await fetchImpl(request) : await fetchImpl(request.path, request.init)
    if (!response.ok) return { kind: 'unavailable', detail: await failureOf(response), status: response.status }
    const payload: unknown = await response.json()
    if (!Check(schema, payload)) return { kind: 'unavailable', detail: `the server's ${what} did not match its schema` }
    return { kind: 'loaded', payload, etag: response.headers.get('ETag') }
  } catch (failure: unknown) {
    return { kind: 'unavailable', detail: failure instanceof Error ? failure.message : String(failure) }
  }
}

/** A prompt as read or written: loaded only with the ETag a later replace of it will need; a 412 is a conflict. */
function promptOf(read: CheckedRead<EnsoLibraryPrompt>): LibraryPromptRead | LibraryConflict {
  if (read.kind === 'unavailable') {
    return read.status === 412
      ? { kind: 'conflict', detail: read.detail }
      : { kind: 'unavailable', detail: read.detail }
  }
  if (read.etag === null) return { kind: 'unavailable', detail: 'the server answered the prompt without its ETag' }
  return { kind: 'loaded', prompt: read.payload, etag: read.etag }
}

/** The library's prompts and refused files. */
export async function fetchPromptLibrary(fetchImpl: FetchLike = fetch): Promise<LibraryListing> {
  const read = await readChecked('/api/prompts', EnsoLibraryPromptListing, 'prompt listing', fetchImpl)
  return read.kind === 'loaded'
    ? { kind: 'loaded', listing: read.payload }
    : { kind: 'unavailable', detail: read.detail }
}

/** One library prompt, body included, and the ETag of the version read. */
export async function fetchLibraryPrompt(id: string, fetchImpl: FetchLike = fetch): Promise<LibraryPromptRead> {
  const read = promptOf(
    await readChecked(`/api/prompts/${encodeURIComponent(id)}`, EnsoLibraryPrompt, 'prompt', fetchImpl),
  )
  return read.kind === 'conflict' ? { kind: 'unavailable', detail: read.detail } : read
}

/** Write a prompt whole under `id`, under `precondition`, and answer it as the server read it back. */
export async function writeLibraryPrompt(
  id: string,
  fields: EnsoLibraryPromptWrite,
  precondition: LibraryPrecondition,
  fetchImpl: FetchLike = fetch,
): Promise<LibraryPromptRead | LibraryConflict> {
  const request = {
    path: `/api/prompts/${encodeURIComponent(id)}`,
    init: sending('PUT', fields, preconditionHeaders(precondition)),
  }
  return promptOf(await readChecked(request, EnsoLibraryPrompt, 'prompt', fetchImpl))
}

/** Delete a prompt's file under `precondition` (never `create`); the server's reason when it did not. */
export async function deleteLibraryPrompt(
  id: string,
  precondition: Exclude<LibraryPrecondition, { kind: 'create' }>,
  fetchImpl: FetchLike = fetch,
): Promise<{ readonly kind: 'deleted' } | Unavailable | LibraryConflict> {
  try {
    const response = await fetchImpl(`/api/prompts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: preconditionHeaders(precondition),
    })
    if (response.ok) return { kind: 'deleted' }
    const detail = await failureOf(response)
    return response.status === 412 ? { kind: 'conflict', detail } : { kind: 'unavailable', detail }
  } catch (failure: unknown) {
    return { kind: 'unavailable', detail: failure instanceof Error ? failure.message : String(failure) }
  }
}

export type SystemPromptPreviewRead =
  | { readonly kind: 'loaded'; readonly preview: EnsoSystemPromptPreview }
  | { readonly kind: 'unavailable'; readonly detail: string }

/**
 * The system prompt `threadId`'s next request would carry: with a saved prompt (`promptId`), with
 * an unsaved draft, or pi's default when neither is given.
 */
export async function fetchSystemPromptPreview(
  threadId: string,
  candidate: { readonly promptId: string } | { readonly draft: EnsoSystemPromptDraft } | null,
  fetchImpl: FetchLike = fetch,
): Promise<SystemPromptPreviewRead> {
  const base = `/api/threads/${encodeURIComponent(threadId)}/system-prompt`
  const read =
    candidate !== null && 'draft' in candidate
      ? await readChecked(
          { path: base, init: sending('POST', candidate.draft) },
          EnsoSystemPromptPreview,
          'preview',
          fetchImpl,
        )
      : await readChecked(
          candidate === null ? base : `${base}?prompt=${encodeURIComponent(candidate.promptId)}`,
          EnsoSystemPromptPreview,
          'preview',
          fetchImpl,
        )
  return read.kind === 'loaded'
    ? { kind: 'loaded', preview: read.payload }
    : { kind: 'unavailable', detail: read.detail }
}
