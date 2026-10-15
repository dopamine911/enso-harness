import { type EnsoRunStatesFrame, EnsoStoredThread, EnsoThreadHistory } from '@enso/core'
import { Check } from 'typebox/value'
import { createListingStore, type ListingStore } from './listing-store.ts'

/**
 * The sessions a user can come back to (#95): pi's session files in this server's projects, as
 * the server lists them — the rail's rows under each project (#395). Refreshed on load and after a
 * run settles, when a session file appears or grows (`listing-store.ts` has the rules).
 *
 * A row's `busy` and `waiting` are as of the listing, unless the page watches the server's run
 * states (#911, `GET /api/run-states`): each frame it hears sets them at once, and a listing that
 * was out while a frame came is corrected by it — the frame is the newer word.
 */
export interface StoredThreadsStore extends ListingStore<EnsoStoredThread> {
  readonly applyRunStates: (frame: EnsoRunStatesFrame) => void
}

/** A thread's run as a frame said it, and how many frames had been heard by then. */
interface HeardRun {
  readonly busy: boolean
  readonly waiting: boolean
  readonly at: number
  /** The frame said `waiting` without reading a question: a take's `run-state`, before any could open. */
  readonly waitingUnread: boolean
  /** The frame count at the last frame that said this thread was not busy; undefined when none was heard. */
  readonly idleAt: number | undefined
}

export function createStoredThreadsStore(
  fetchStoredThreads: () => Promise<unknown> = fetchStoredThreadList,
): StoredThreadsStore {
  const heard = new Map<string, HeardRun>()
  let frames = 0
  /** The frame count at the last `run-states`: a thread it did not name was held by no run then. */
  let wholeAt = 0
  /**
   * `row` as the frames after the `since`-th say it; the same object when they say nothing new.
   * ⚠ A `run-state`'s `waiting` is read at a build, a take, a release or a drop — at a take, before
   * any question could open — and a question opening mid-run sends no frame. So when the frame was
   * a take and no frame since the listing was asked said the thread was idle, a listing that says
   * waiting is kept: it may have seen a question open in the run that take began. A `run-states`
   * snapshot reads the open questions, so its `waiting` is not overridden (PR #995 review).
   */
  const corrected = (row: EnsoStoredThread, since: number): EnsoStoredThread => {
    const said =
      heard.get(row.threadId) ??
      (wholeAt > since
        ? { busy: false, waiting: false, at: wholeAt, waitingUnread: false, idleAt: wholeAt }
        : undefined)
    if (said === undefined || said.at <= since) return row
    const listingSawThisRun = said.waitingUnread && (said.idleAt === undefined || said.idleAt <= since)
    const waiting = listingSawThisRun ? row.waiting || said.waiting : said.waiting
    if (row.busy === said.busy && row.waiting === waiting) return row
    return { ...row, busy: said.busy, waiting }
  }
  const listing = createListingStore(EnsoStoredThread, 'session listing', fetchStoredThreads, () => {
    const since = frames
    return (rows) => rows.map((row) => corrected(row, since))
  })
  return {
    ...listing,
    applyRunStates: (frame) => {
      frames += 1
      if (frame.type === 'run-states') {
        heard.clear()
        wholeAt = frames
        for (const { threadId, busy, waiting } of frame.threads) {
          heard.set(threadId, { busy, waiting, at: frames, waitingUnread: false, idleAt: busy ? undefined : frames })
        }
      } else {
        const { busy, waiting } = frame
        const idleAt = busy ? heard.get(frame.threadId)?.idleAt : frames
        heard.set(frame.threadId, { busy, waiting, at: frames, waitingUnread: busy, idleAt })
      }
      listing.update((rows) => rows.map((row) => corrected(row, frames - 1)))
    },
  }
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

/** `…/history`, or with `before` the page before that message (#739) — the one spelling of the route's address. */
export function threadHistoryUrl(threadId: string, before?: string): string {
  const page = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
  return `/api/threads/${encodeURIComponent(threadId)}/history${page}`
}

/**
 * A stored thread's history, for `adoptThread` — its last page, or with `before` the page before
 * that message (#739). `undefined` when the server holds nothing under the id — its 404, an id
 * nobody has used yet (#378); any other non-2xx throws with the status in the message, a 403
 * naming where a thread outside the projects is stored among them.
 */
export async function fetchThreadHistory(
  threadId: string,
  fetchImpl: (input: string) => Promise<Response> = fetch,
  before?: string,
): Promise<EnsoThreadHistory | undefined> {
  const response = await fetchImpl(threadHistoryUrl(threadId, before))
  if (response.status === 404) return undefined
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
 * with the outcome: a shared "how did the latest one happen" slot is wrong
 * the moment two requests overlap, and the boot's resume and a rail click can.
 *
 * Three outcomes, not two (#378): a history, a failure, or ABSENT — the server holds nothing under
 * the id. Absent is not a failure: what it means is the caller's, by where the id came from. The
 * URL's own thread before its first prompt is absent after a server restart, and is started; a
 * rail row that is absent went stale, and is said.
 */
export function createResumeRequests<TIntent>(
  fetchHistory: (threadId: string) => Promise<EnsoThreadHistory | undefined>,
  onHistory: (history: EnsoThreadHistory, intent: TIntent) => void,
  onFailure: (message: string, intent: TIntent) => void,
  onAbsent: (threadId: string, intent: TIntent) => void,
): (threadId: string, intent: TIntent) => void {
  let latest: string | undefined
  return (threadId: string, intent: TIntent) => {
    latest = threadId
    fetchHistory(threadId).then(
      (history) => {
        if (latest !== threadId) return
        latest = undefined
        if (history === undefined) onAbsent(threadId, intent)
        else onHistory(history, intent)
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
