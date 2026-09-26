import { EnsoStoredThread, EnsoThreadHistory } from '@enso/core'
import { Check } from 'typebox/value'
import { createListingStore, type ListingStore } from './listing-store.ts'

/**
 * The sessions a user can come back to (#95): pi's session files in this server's projects, as
 * the server lists them — the rail's rows under each project (#395). Refreshed on load and after a
 * run settles, when a session file appears or grows (`listing-store.ts` has the rules).
 */
export type StoredThreadsStore = ListingStore<EnsoStoredThread>

export function createStoredThreadsStore(
  fetchStoredThreads: () => Promise<unknown> = fetchStoredThreadList,
): StoredThreadsStore {
  return createListingStore(EnsoStoredThread, 'session listing', fetchStoredThreads)
}

/**
 * A failed response's body as one readable line: its first line, bounded.
 *
 * The dev proxy answers a dead API with Bun's whole HTML error page (#103 receipt, step 8), and
 * quoting it verbatim filled the rail and squeezed the live list out of view — the moment the
 * operator most needed to see which thread they were on. Shared with the debug pane's fetchers,
 * which had the same page in their session column.
 */
export const FAILURE_DETAIL_MAX_LENGTH = 120
export function boundedFailureDetail(body: string): string {
  const line = body.split('\n', 1)[0]?.trim() ?? ''
  return line.length > FAILURE_DETAIL_MAX_LENGTH ? `${line.slice(0, FAILURE_DETAIL_MAX_LENGTH)}…` : line
}

/** The status and the bounded body, as one line. */
export async function describeFailedResponse(response: Response): Promise<string> {
  const detail = boundedFailureDetail(await response.text())
  return detail.length === 0 ? String(response.status) : `${response.status} ${detail}`
}

async function fetchStoredThreadList(): Promise<unknown> {
  const response = await fetch('/api/stored-threads')
  if (!response.ok) throw new Error(await describeFailedResponse(response))
  return response.json()
}

/** A stored thread's history, for `adoptThread`; a non-2xx throws with the status in the message. */
export async function fetchThreadHistory(threadId: string): Promise<EnsoThreadHistory> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/history`)
  if (!response.ok) throw new Error(await describeFailedResponse(response))
  const payload: unknown = await response.json()
  if (!Check(EnsoThreadHistory, payload)) throw new Error("the server's history payload did not match its schema")
  return payload
}

/**
 * The rail's resume clicks, with the LAST click winning — not the first response (PR #104
 * review).
 *
 * Two previous threads clicked before the first history arrives would otherwise both apply, so
 * response timing chose the active thread and, with it, where the next prompt went. A
 * superseded response is dropped whole: not applied, its failure not shown. The fetcher is
 * injected so the race is testable with controlled resolution order.
 *
 * Each request carries its own `intent` — what the caller meant by it — and gets it back
 * with the outcome (PR #143 review): a shared "how did the latest one happen" slot is wrong
 * the moment two requests overlap, and the boot's resume and a rail click can.
 */
export function createResumeRequests<TIntent>(
  fetchHistory: (threadId: string) => Promise<EnsoThreadHistory>,
  onHistory: (history: EnsoThreadHistory, intent: TIntent) => void,
  onFailure: (message: string, intent: TIntent) => void,
): (threadId: string, intent: TIntent) => void {
  let latest: string | undefined
  return (threadId: string, intent: TIntent) => {
    latest = threadId
    fetchHistory(threadId).then(
      (history) => {
        if (latest !== threadId) return
        latest = undefined
        onHistory(history, intent)
      },
      (failure: unknown) => {
        if (latest !== threadId) return
        latest = undefined
        onFailure(failure instanceof Error ? failure.message : String(failure), intent)
      },
    )
  }
}

/**
 * The rail's second list: stored sessions this page has NOT already got open.
 *
 * The thread id is pi's session id, so "already open here" is a set lookup — the payoff of one
 * identity.
 */
export function storedThreadsNotOnThisPage(
  stored: readonly EnsoStoredThread[],
  pageThreadIds: ReadonlySet<string>,
): EnsoStoredThread[] {
  return stored.filter((thread) => !pageThreadIds.has(thread.threadId))
}
