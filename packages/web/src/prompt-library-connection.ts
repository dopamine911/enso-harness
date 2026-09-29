import { EnsoLibraryPrompt, EnsoLibraryPromptListing } from '@enso/core'
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

/** One GET, its payload checked against `schema`; `what` names the payload when it does not match. */
async function readChecked<Schema extends TSchema>(
  path: string,
  schema: Schema,
  what: string,
  fetchImpl: FetchLike,
): Promise<{ readonly kind: 'loaded'; readonly payload: Static<Schema> } | Unavailable> {
  try {
    const response = await fetchImpl(path)
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
