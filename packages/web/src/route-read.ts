import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'

/**
 * One GET of a JSON route whose answer has a schema, in the three ways it can go — a failure is
 * words, never a throw (#45 phase 2 folded the thread timeline's and the stats drawer's copies).
 *
 * A non-2xx other than 404 is reported with its status and body VERBATIM: the reader is
 * debugging, and the body is the server's own words about what went wrong. A payload that misses
 * its schema is reported too — never quietly rendered as nothing. A 404 is `absent`, which each
 * caller words for itself: a thread with no live session, a thread nothing has run in.
 */
export type RouteRead<Payload> =
  | { readonly kind: 'read'; readonly payload: Payload }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly problem: string }

/** `what` names the payload in the schema-miss sentence: "the server's events payload …". */
export async function readSchemaRoute<Schema extends TSchema>(
  route: string,
  schema: Schema,
  what: string,
  fetchImpl: FetchLike,
): Promise<RouteRead<Static<Schema>>> {
  try {
    const response = await fetchImpl(route)
    if (response.status === 404) return { kind: 'absent' }
    if (!response.ok) return { kind: 'failed', problem: `${response.status} ${await response.text()}`.trim() }
    const payload: unknown = await response.json()
    if (!Check(schema, payload))
      return { kind: 'failed', problem: `the server's ${what} payload did not match its schema` }
    return { kind: 'read', payload }
  } catch (error) {
    return { kind: 'failed', problem: error instanceof Error ? error.message : String(error) }
  }
}
