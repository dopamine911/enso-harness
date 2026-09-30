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

/**
 * A thread analysis as a view holds it (#45, #361): still reading, read, or why not. The Stats and
 * Context views read their routes this one way.
 */
export type AnalysisOutcome<Payload> = { readonly kind: 'reading' } | SettledRead<Payload>

/** A read that has come back: its payload, or why not. */
type SettledRead<Payload> =
  | { readonly kind: 'read'; readonly payload: Payload }
  | { readonly kind: 'failed'; readonly problem: string }

/** Where every analysis view starts. */
export const ANALYSIS_READING = { kind: 'reading' } as const

/**
 * `GET /api/threads/:threadId/<analysis>` — `stats`, `context`, `eval`. A 404 is a thread nothing has run
 * in yet: held neither live nor on disk.
 */
export async function readThreadAnalysis<Schema extends TSchema>(
  threadId: string,
  analysis: string,
  schema: Schema,
  fetchImpl: FetchLike = fetch,
): Promise<AnalysisOutcome<Static<Schema>>> {
  const read = await readThreadRoute(threadId, analysis, schema, fetchImpl)
  return read.kind === 'none' ? { kind: 'failed', problem: 'nothing has run in this thread yet' } : read
}

/**
 * A thread read a readout holds (#452, #453): nothing yet — or a thread nothing has run in, which
 * is not a failure to show — the payload, or why not. The git readout and the Diff view.
 */
export type ThreadReadOutcome<Payload> = { readonly kind: 'none' } | SettledRead<Payload>

/** Where a thread read starts, and what a 404 is. */
export const THREAD_READ_NONE = { kind: 'none' } as const

/** `GET /api/threads/:threadId/<route>`, a 404 held as nothing to show. */
export async function readThreadRoute<Schema extends TSchema>(
  threadId: string,
  route: string,
  schema: Schema,
  fetchImpl: FetchLike,
): Promise<ThreadReadOutcome<Static<Schema>>> {
  const read = await readSchemaRoute(`/api/threads/${encodeURIComponent(threadId)}/${route}`, schema, route, fetchImpl)
  return read.kind === 'absent' ? THREAD_READ_NONE : read
}
