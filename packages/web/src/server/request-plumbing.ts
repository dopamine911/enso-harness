import type { IncomingMessage, ServerResponse } from 'node:http'
import { ensoLogger, isEnsoThreadId } from '@enso/core'
import type { Static, TSchema } from 'typebox'
import { SessionDirectoryRefused } from '../host/agent-host.ts'
import { ThreadDeleted } from '../host/thread-delete.ts'
import { readClosedBody } from './follow.ts'
import { ProjectUnavailable } from './projects.ts'
import type { WriteCondition } from './prompt-library.ts'

/**
 * The request plumbing every route group shares (#810): reading a body under its cap, the write
 * preconditions, answering JSON or a refusal, decoding a thread id, and the answer-or-fail rule
 * for a handler that awaits.
 */

const log = ensoLogger('server', 'http')

/** A dialog answer is an id and a short value — kilobytes, not megabytes. */
export const MAX_DIALOG_BODY_BYTES = 64 * 1024
/** A library prompt is a system prompt at most — a few hundred kilobytes is already most of a context window. */
const MAX_PROMPT_BODY_BYTES = 512 * 1024

/** A route that reads no body: the thread's id and the response are the whole request (#174). */
export type ThreadResponder = (threadId: string, response: ServerResponse) => void | Promise<void>

/** A row of the thread route table (`thread-routes.ts`, #174): the id decoded, the request, the response. */
export type ThreadRouteHandler = (
  threadId: string,
  request: IncomingMessage,
  response: ServerResponse,
  /** The row's own match: its first capture is the id, any further ones the route's to read. */
  match: RegExpExecArray,
) => void | Promise<void>
/** A body that outgrew its route's cap: the read stopped, nothing was buffered past it. */
class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the request body is larger than ${maxBytes} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * A request's body as text. With `maxBytes`, the read STOPS at the cap — the listener comes
 * off, the stream is paused, what was buffered is dropped, the promise rejects — rather than
 * buffering an arbitrary body first and refusing it after (#68: a prompt may carry images,
 * and the cap is many megabytes). ⚠ The socket is NOT destroyed here: the response shares
 * it, and destroying first is how a 413 never reaches the client. The caller answers, then
 * tears the connection down (`endAndClose`). Counted in bytes as they arrive.
 */
function readBody(request: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const chunks: Buffer[] = []
  let received = 0
  const onEnd = (): void => resolve(Buffer.concat(chunks).toString('utf8'))
  const onData = (chunk: Buffer): void => {
    received += chunk.length
    if (received > maxBytes) {
      request.off('data', onData).off('end', onEnd).off('error', reject)
      request.pause()
      chunks.length = 0
      reject(new BodyTooLargeError(maxBytes))
      return
    }
    chunks.push(chunk)
  }
  request.on('data', onData).on('end', onEnd).on('error', reject)
  return promise
}

/**
 * Answer, then drop the connection: the request body was never read to its end, so this
 * socket cannot carry another request. The header says so; the destroy makes it so, once
 * the answer has been flushed.
 */
export function endAndClose(request: IncomingMessage, response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' })
  response.end(text, () => request.destroy())
}

/** A route's read cap and the sentence a body over it is refused with. */
interface BodyCap {
  readonly maxBytes: number
  readonly capText: string
}

/**
 * The read-cap rule, once (#265): the body up to `maxBytes`, or `undefined` once the 413 has
 * been written. A body over the cap is the one case that MUST tear the connection down —
 * `readBody` stopped mid-stream, so the socket cannot carry another request — and `capText`
 * is the sentence that says which cap was hit. Anything else the read throws is the caller's
 * to answer: the three JSON routes go through `readJsonBody` below, which turns it into a
 * 400; the browser-logs route calls THIS function directly and lets a read failure reach
 * `answerOrFail`'s 500, because that route parses downstream and has no body to quote.
 */
export async function readCappedBody(
  request: IncomingMessage,
  response: ServerResponse,
  cap: BodyCap,
): Promise<string | undefined> {
  try {
    return await readBody(request, cap.maxBytes)
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error
    endAndClose(request, response, 413, cap.capText)
    return undefined
  }
}

/**
 * A capped body through its reader, or `undefined` once the refusal has been written: the
 * cap's 413 from `readCappedBody`, and a 400 carrying the message for everything else — a
 * socket that failed mid-read and a body the reader rejects are both "the caller's body is
 * not usable", answered with the reason rather than a 500 that says nothing.
 */
export async function readJsonBody<T>(
  request: IncomingMessage,
  response: ServerResponse,
  cap: BodyCap & { readonly parse: (text: string) => T },
): Promise<T | undefined> {
  try {
    const text = await readCappedBody(request, response, cap)
    return text === undefined ? undefined : cap.parse(text)
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain' })
    response.end((error as Error).message)
    return undefined
  }
}

/**
 * A body that must be exactly `schema`: `readJsonBody` over `readClosedBody`, the read every
 * closed write here makes (a project registration, a project's settings, a permission check, the
 * permission policy). `name` names the body in a malformed one's 400; `requirement` says what a
 * well-formed one holds.
 */
export function readClosedJsonBody<Schema extends TSchema>(
  request: IncomingMessage,
  response: ServerResponse,
  body: BodyCap & { readonly schema: Schema; readonly name: string; readonly requirement: string },
): Promise<Static<Schema> | undefined> {
  return readJsonBody(request, response, {
    ...body,
    parse: (raw: string) => readClosedBody(raw, body.schema, body.name, body.requirement),
  })
}

/**
 * A refused outcome, answered (#265): the status the decision carries and its reason AS the
 * body, in `text/plain` — five routes wrote this pair by hand. The route logs first, in its
 * own words: the record names the object that was refused (a prompt, a dialog id, a mode),
 * which is what makes the log searchable, and the browser-logs route deliberately writes no
 * record at all.
 */
export function refuseWith(
  response: ServerResponse,
  outcome: { readonly status: number; readonly reason: string },
): void {
  response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
  response.end(outcome.reason)
}

/** A strong entity tag as the library quotes one: a file's sha256, hex. */
export const PROMPT_ETAG = /^"[0-9a-f]{64}"$/

/** What a conditional write names in its refusals: a library prompt (#443), or the permission policy (#474). */
type WriteSubject = 'prompt' | 'permission policy'

/** Why a write or delete does not say what it expects: the one line `refuseWith` sends. */
function missingPrecondition(what: 'write' | 'delete', subject: WriteSubject): string {
  return what === 'write'
    ? `a ${subject} write states what it expects on disk: \`If-None-Match: *\` to create, \`If-Match: <ETag>\` to replace the version it read, \`If-Match: *\` to replace whatever is there`
    : `a ${subject} delete states the version it removes: \`If-Match: <ETag>\`, or \`If-Match: *\` for whatever is there`
}

/**
 * The precondition a library write or delete states (#443) — and a permission-policy save (#474):
 * `If-None-Match: *` (create — no file there), `If-Match: "<etag>"` (the version a read answered),
 * `If-Match: *` (whatever is there). ⚠ NONE IS A 428, never an unconditional write: without it a
 * stale page or a script overwrites a file it never read, a refused one included. Both headers, a
 * list, or a weak tag are a 400.
 */
export function writeConditionOf(
  request: IncomingMessage,
  what: 'write' | 'delete',
  subject: WriteSubject,
): WriteCondition | { readonly status: 400 | 428; readonly reason: string } {
  const none = request.headers['if-none-match']?.trim()
  const match = request.headers['if-match']?.trim()
  if (none !== undefined && match !== undefined) {
    return { status: 400, reason: `a ${subject} request takes \`If-None-Match\` or \`If-Match\`, not both` }
  }
  if (none !== undefined) {
    return none === '*' ? { kind: 'absent' } : { status: 400, reason: '`If-None-Match` takes only `*`: create' }
  }
  if (match === undefined) return { status: 428, reason: missingPrecondition(what, subject) }
  if (match === '*') return { kind: 'present' }
  return PROMPT_ETAG.test(match)
    ? { kind: 'matches', etag: match }
    : { status: 400, reason: `\`If-Match\` takes \`*\` or the one ETag a read of this ${subject} answered` }
}

/** A body that carries a prompt's text — a library write or a draft — under the prompt cap. */
export function readPromptSizedBody<T>(
  request: IncomingMessage,
  response: ServerResponse,
  parse: (text: string) => T,
): Promise<T | undefined> {
  return readJsonBody(request, response, {
    maxBytes: MAX_PROMPT_BODY_BYTES,
    capText: `a prompt is at most ${MAX_PROMPT_BODY_BYTES} bytes`,
    parse,
  })
}

/** A 200 with `body` as JSON. */
export function answerJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * ⚠ `decodeURIComponent` THROWS on a malformed escape (`/api/threads/%`), and a throw in the
 * request listener has nothing above it — it took the whole dev server down, every live
 * session with it, from one hand-typed URL (PR #87 review, reproduced). A bad id is the
 * caller's problem: 400 written here, `undefined` returned, and the server stays up.
 *
 * Since #95 the id is also pi's session id, which pi puts in a FILENAME — so a decoded id
 * that is not thread-id shaped (`isEnsoThreadId`: `../x`, spaces, anything a filesystem could
 * read) is the same 400. Nothing downstream ever sees an id that failed here.
 */
export function decodeThreadId(rawSegment: string, response: ServerResponse): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawSegment)
  } catch {
    decoded = ''
  }
  if (isEnsoThreadId(decoded)) return decoded
  response.writeHead(400, { 'Content-Type': 'text/plain' })
  response.end('malformed thread id')
  return undefined
}

/**
 * ⚠ The dispatcher is synchronous and a throw in the request listener has nothing above
 * it (PR #87). Every handler that awaits (the thread routes, the listing, the browser log) runs
 * through here: a rejection is reported and answered as a 500 whose text names no route (it
 * answers every one of them; PR #393 review), and the server stays up.
 *
 * The one exception is a refusal the SERVER decided while building a thread (#395): the thread's
 * project is gone, its directory deleted, or its session is in a directory not served. Any route
 * that builds can meet one, so it is answered here, once — 409 with the reason, not a fault
 * (PR #399 review: a refusal is not a fault, and must not read as one).
 */
export function answerOrFail(work: Promise<void>, response: ServerResponse): void {
  work.catch((error: unknown) => {
    if (
      error instanceof ProjectUnavailable ||
      error instanceof SessionDirectoryRefused ||
      error instanceof ThreadDeleted
    ) {
      log.warn('a thread could not be built where it belongs: {reason}', { reason: error.message })
      if (response.headersSent) response.end()
      else refuseWith(response, { status: 409, reason: error.message })
      return
    }
    log.error('a handler failed: {error}', { error })
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end('the request failed — see the server log')
  })
}
