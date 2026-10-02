import { EnsoThreadDeletePreview } from '@enso/core'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { describeFailedResponse } from './stored-threads.ts'

/** The thread a delete is for, and the `fetch` that reaches its server: a pane's, or Settings' (#578). */
export interface DeleteTarget {
  readonly threadId: string
  readonly fetch: FetchLike
}

/**
 * Deleting a thread from the page (#571): the header's Delete, behind a confirmation, is one
 * `DELETE /api/threads/:id`. The server removes the session file, the thread's tree and its
 * snapshot store, and answers in plain words when it will not:
 *
 * - 204: deleted — the page leaves the thread (`chat-screen.tsx`).
 * - 422: the tree holds work, named by the reason. Forceable: the dialog shows the server's words
 *   as they are — they already say "the tree holds work — …", so no status and no label of the
 *   page's — and offers "Delete anyway": the same call with `?force=1`, confirming the work shown
 *   by `If-Match: "<sha256 hex of that text>"` (PR #572 review). A forced delete whose text is stale
 *   (a run wrote more since) is refused 422 again, with the list as it is now.
 * - 409 (a run, a move or a restore holds the thread), 404 (no such thread), or no answer at
 *   all: never forceable, so the dialog closes and its caller says the reason (`onRefused`) — the
 *   header as a warning on the thread, as a refused restore is (`fork-thread.ts`).
 */

/** What a delete came to: gone, refused for the work its tree holds (forceable), or refused. */
export type DeleteOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'holds-work'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/** The status the server refuses a delete with when only `?force=1` would take the tree's work. */
const HOLDS_WORK = 422

/**
 * `DELETE` the thread. `confirmedWork` is the holds-work text the dialog showed, when the
 * user chose to take that work with it: sent as `?force=1` with its digest in `If-Match`, so the
 * server deletes only the work that was shown. The outcome says what the dialog does next.
 */
export async function deleteThread(target: DeleteTarget, confirmedWork: string | undefined): Promise<DeleteOutcome> {
  const force = confirmedWork !== undefined
  const route = `/api/threads/${encodeURIComponent(target.threadId)}${force ? '?force=1' : ''}`
  try {
    const headers: Record<string, string> = force ? { 'If-Match': await workTag(confirmedWork) } : {}
    const response = await target.fetch(route, { method: 'DELETE', headers })
    if (response.ok) return { kind: 'deleted' }
    if (response.status === HOLDS_WORK) {
      // Whole, not bounded to a line's length: the reason is the list of what force would destroy.
      const words = (await response.text()).trim()
      return { kind: 'holds-work', reason: words.length === 0 ? String(HOLDS_WORK) : words }
    }
    return { kind: 'refused', reason: await describeFailedResponse(response) }
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The entity tag a forced delete confirms `work` by: its UTF-8 sha256, lowercase hex, quoted. */
async function workTag(work: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(work)))
  return `"${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}"`
}

/** What the dialog knows before a delete is sent: the server's preview, or why it could not say. */
export type DeletePreviewRead =
  | { readonly kind: 'read'; readonly preview: EnsoThreadDeletePreview }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * `GET /api/threads/:id/delete-preview`: what a delete would take — the tree, whether it holds work,
 * and the forks that keep its snapshots. Read-only. A refusal (404, 410), no answer, or a payload off
 * its schema is a reason to show; the dialog still offers a plain Delete, whose answer is authoritative.
 */
export async function readDeletePreview(target: DeleteTarget): Promise<DeletePreviewRead> {
  try {
    const response = await target.fetch(`/api/threads/${encodeURIComponent(target.threadId)}/delete-preview`)
    if (!response.ok) return { kind: 'failed', reason: await describeFailedResponse(response) }
    const payload: unknown = await response.json()
    if (!Check(EnsoThreadDeletePreview, payload))
      return { kind: 'failed', reason: "the server's delete preview did not match its schema" }
    return { kind: 'read', preview: payload }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
