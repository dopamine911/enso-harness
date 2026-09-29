import { EnsoLibraryPrompt, EnsoLibraryPromptListing } from '@enso/core'
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

/** A non-2xx as the words the dialog shows: the server's reason is written for a person. */
async function failureOf(response: Response): Promise<string> {
  const body = (await response.text()).trim()
  return body.length > 0 ? body : `the server answered ${response.status}`
}

function unreachable(failure: unknown): { kind: 'unavailable'; detail: string } {
  return { kind: 'unavailable', detail: failure instanceof Error ? failure.message : String(failure) }
}

/** The library's prompts and refused files. */
export async function fetchPromptLibrary(fetchImpl: FetchLike = fetch): Promise<LibraryListing> {
  try {
    const response = await fetchImpl('/api/prompts')
    if (!response.ok) return { kind: 'unavailable', detail: await failureOf(response) }
    const payload: unknown = await response.json()
    if (!Check(EnsoLibraryPromptListing, payload)) {
      return { kind: 'unavailable', detail: "the server's prompt listing did not match its schema" }
    }
    return { kind: 'loaded', listing: payload }
  } catch (failure: unknown) {
    return unreachable(failure)
  }
}

/** One library prompt, body included. */
export async function fetchLibraryPrompt(id: string, fetchImpl: FetchLike = fetch): Promise<LibraryPromptRead> {
  try {
    const response = await fetchImpl(`/api/prompts/${encodeURIComponent(id)}`)
    if (!response.ok) return { kind: 'unavailable', detail: await failureOf(response) }
    const payload: unknown = await response.json()
    if (!Check(EnsoLibraryPrompt, payload)) {
      return { kind: 'unavailable', detail: "the server's prompt did not match its schema" }
    }
    return { kind: 'loaded', prompt: payload }
  } catch (failure: unknown) {
    return unreachable(failure)
  }
}
