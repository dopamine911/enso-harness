import { type EnsoStoredThread, ensoLogger } from '@enso/core'
import { useEffect } from 'react'
import { PAGE_HEALTH_TIMING, pageFault, reportPageFault } from './page-health.ts'
import { isFixtureMode } from './page-mode.ts'
import { createStoredThreadsStore } from './stored-threads.ts'
import { getThreadStores, threadListStore } from './thread-stores.ts'

/**
 * The page checked against the server, from OUTSIDE the event pipeline (#919): whatever broke
 * between the wire and the screen, the server's listing still says what the thread did.
 *
 * `/api/stored-threads` has, per thread, its message count, its last message's time, and whether
 * it runs or waits on the person — each of which only moves with an event the follow carries. A
 * row that moved while the page applied NOTHING (`FollowConnection.appliedAt`) means the page is
 * not keeping up; one that stays so for `staleMs` is the banner.
 *
 * ⚠ Its own read, not the rail's store: the rail's listing is refreshed when the page knows it
 * moved (`listing-store.ts`), and a read every few seconds there would re-render every row for
 * nothing. This one reads while a thread on the page is followed and the page is visible, and stops
 * once the page has said it is behind.
 */

/** The check's own record: its reads failing, and reading again — the listing it reads has no UI. */
const log = ensoLogger('browser', 'page', 'check')

/** One followed thread as the check reads it: when the page last applied it. */
interface FollowedThread {
  readonly threadId: string
  readonly appliedAt: number
}

/** What the check found: the thread the server is ahead on, and how. */
interface BehindFinding {
  readonly threadId: string
  readonly detail: string
}

interface Watched {
  readonly signature: string
  /** When this read was ASKED: the listing is the server as of then, or later. */
  readonly readAt: number
  /** When a read first found the row moved with the page silent; undefined while it keeps up. */
  readonly aheadSince: number | undefined
}

/**
 * One thread at one read: its row now against what the last read saw. Ahead from the first read
 * that found the row moved with the page silent since before the last read, until the page applies
 * anything after that.
 */
function watchedNow(before: Watched | undefined, row: EnsoStoredThread, appliedAt: number, now: number): Watched {
  const signature = `${row.messageCount}|${row.lastActivityAt}|${row.busy}|${row.waiting}`
  const movedUnseen =
    before !== undefined &&
    before.signature !== signature &&
    appliedAt < before.readAt - PAGE_HEALTH_TIMING.applySlackMs
  let aheadSince = before?.aheadSince
  if (aheadSince !== undefined && appliedAt > aheadSince) aheadSince = undefined
  if (aheadSince === undefined && movedUnseen) aheadSince = now
  return { signature, readAt: now, aheadSince }
}

/** What the finding says: where the server is, and how long the page has applied nothing. */
function aheadDetail(row: EnsoStoredThread, appliedAt: number, now: number): string {
  let state = row.busy ? 'running' : 'idle'
  if (row.waiting) state = 'waiting on you'
  const silent = Math.round((now - appliedAt) / 1000)
  return `the server's listing moved on (${row.messageCount} messages, ${state}) while this page applied nothing for ${silent}s`
}

/**
 * The check, as a fold over reads: each read's rows, the time it was asked, and the page's threads
 * in, the first thread the server has been ahead on for `staleMs` out. A thread not followed, or not
 * listed (a draft the server holds nothing of), is not watched — and forgotten, so a follow that
 * reopens starts clean.
 */
function createBehindCheck(): (
  now: number,
  followed: readonly FollowedThread[],
  rows: readonly EnsoStoredThread[],
) => BehindFinding | undefined {
  let watched = new Map<string, Watched>()
  return (now, followed, rows) => {
    const byId = new Map(rows.map((row) => [row.threadId, row]))
    const next = new Map<string, Watched>()
    let finding: BehindFinding | undefined
    for (const { threadId, appliedAt } of followed) {
      const row = byId.get(threadId)
      if (row === undefined) continue
      const current = watchedNow(watched.get(threadId), row, appliedAt, now)
      next.set(threadId, current)
      if (finding !== undefined || current.aheadSince === undefined) continue
      if (now - current.aheadSince < PAGE_HEALTH_TIMING.staleMs) continue
      finding = { threadId, detail: aheadDetail(row, appliedAt, now) }
    }
    watched = next
    return finding
  }
}

/** The page's followed threads, with when each last applied its follow, as of now. */
function followedThreads(): FollowedThread[] {
  return threadListStore.get().flatMap(({ threadId }) => {
    const appliedAt = getThreadStores(threadId).connection.appliedAt()
    return appliedAt === undefined ? [] : [{ threadId, appliedAt }]
  })
}

/** Reads the server's listing every `pollMs` and says the first thread it is ahead on; mounted once, by the page. */
export function usePageBehindCheck(): void {
  useEffect(() => {
    if (isFixtureMode) return
    const check = createBehindCheck()
    const listing = createStoredThreadsStore()
    let stopped = false
    /** The last read failed: its failure is logged once, and its recovery once. */
    let failing = false
    const read = async (): Promise<void> => {
      if (stopped || pageFault.get() !== undefined) return
      if (document.visibilityState === 'visible' && followedThreads().length > 0) {
        // ⚠ The read's time is when it was ASKED: the listing is the server as of then, or later. A
        // time taken at the answer would count what the page applied while a slow read was out as
        // applied before it, and a run's last change landing then would look unseen ever after.
        const requestedAt = Date.now()
        await listing.refresh()
        // The page's side is read AFTER the server's: what it applied while the read was out counts.
        const { rows, error } = listing.get()
        if ((error !== undefined) !== failing) {
          failing = error !== undefined
          if (failing) log.warn('the server check cannot read the listing: {error}', { error })
          else log.info('the server check reads the listing again')
        }
        const finding = error === undefined ? check(requestedAt, followedThreads(), rows) : undefined
        if (finding !== undefined) {
          reportPageFault({ trigger: 'behind', threadId: finding.threadId, error: finding.detail })
          return
        }
      }
      if (!stopped) timer = setTimeout(() => void read(), PAGE_HEALTH_TIMING.pollMs)
    }
    let timer = setTimeout(() => void read(), PAGE_HEALTH_TIMING.pollMs)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])
}
