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
  | { readonly kind: 'loaded'; readonly prompt: EnsoLibraryPrompt }
  | { readonly kind: 'unavailable'; readonly detail: string }

/** A read's failure: what the dialog shows beside the field. */
type Unavailable = { readonly kind: 'unavailable'; readonly detail: string }

/** A non-2xx as the words the dialog shows: the server's reason is written for a person. */
async function failureOf(response: Response): Promise<string> {
  const body = (await response.text()).trim()
  return body.length > 0 ? body : `the server answered ${response.status}`
}

/** A JSON body sent with `method`. */
function sending(method: 'PUT' | 'POST', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/** One request, its payload checked against `schema`; `what` names the payload when it does not match. */
async function readChecked<Schema extends TSchema>(
  request: string | { readonly path: string; readonly init: RequestInit },
  schema: Schema,
  what: string,
  fetchImpl: FetchLike,
): Promise<{ readonly kind: 'loaded'; readonly payload: Static<Schema> } | Unavailable> {
  try {
    const response =
      typeof request === 'string' ? await fetchImpl(request) : await fetchImpl(request.path, request.init)
    if (!response.ok) return { kind: 'unavailable', detail: await failureOf(response) }
    const payload: unknown = await response.json()
    if (!Check(schema, payload)) return { kind: 'unavailable', detail: `the server's ${what} did not match its schema` }
    return { kind: 'loaded', payload }
  } catch (failure: unknown) {
    return { kind: 'unavailable', detail: failure instanceof Error ? failure.message : String(failure) }
  }
}

/** The library's prompts and refused files. */
export async function fetchPromptLibrary(fetchImpl: FetchLike = fetch): Promise<LibraryListing> {
  const read = await readChecked('/api/prompts', EnsoLibraryPromptListing, 'prompt listing', fetchImpl)
  return read.kind === 'loaded' ? { kind: 'loaded', listing: read.payload } : read
}

/** One library prompt, body included. */
export async function fetchLibraryPrompt(id: string, fetchImpl: FetchLike = fetch): Promise<LibraryPromptRead> {
  const read = await readChecked(`/api/prompts/${encodeURIComponent(id)}`, EnsoLibraryPrompt, 'prompt', fetchImpl)
  return read.kind === 'loaded' ? { kind: 'loaded', prompt: read.payload } : read
}

/** Write a prompt whole under `id` — created or replaced — and answer it as the server read it back. */
export async function writeLibraryPrompt(
  id: string,
  fields: EnsoLibraryPromptWrite,
  fetchImpl: FetchLike = fetch,
): Promise<LibraryPromptRead> {
  const path = `/api/prompts/${encodeURIComponent(id)}`
  const read = await readChecked({ path, init: sending('PUT', fields) }, EnsoLibraryPrompt, 'prompt', fetchImpl)
  return read.kind === 'loaded' ? { kind: 'loaded', prompt: read.payload } : read
}

/** Delete a prompt's file; the server's reason when it did not. */
export async function deleteLibraryPrompt(
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ readonly kind: 'deleted' } | Unavailable> {
  try {
    const response = await fetchImpl(`/api/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return response.ok ? { kind: 'deleted' } : { kind: 'unavailable', detail: await failureOf(response) }
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
  return read.kind === 'loaded' ? { kind: 'loaded', preview: read.payload } : read
}
