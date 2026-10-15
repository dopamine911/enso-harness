import { useEffect } from 'react'
import { usePageBehindCheck } from './page-behind-check.ts'
import { PAGE_HEALTH_TIMING, pageFault, reportPageFault, serverAnswers } from './page-health.ts'
import { isFixtureMode } from './page-mode.ts'
import { getThreadStores, threadListStore } from './thread-stores.ts'

/**
 * A thread's live view lost, followed up from the page (#914): the status bar says
 * "not receiving updates — reconnecting…" from the moment a follow goes silent or ends
 * (`FollowConnection.liveView`), and this check decides when that becomes "Reload to catch up".
 *
 * ⚠ RECONNECTING IS GETTING THE SERVER BACK, NOT THE FOLLOW. A follow has no cursor to resume from
 * (`server/follow.ts`, `resume/cold-then-live`): one opened again would carry the thread from now
 * on, and what it did meanwhile — the deltas, the tool calls, the question asked and answered —
 * would be missing from the transcript with nothing to say so. A reload reads the whole thread
 * again. So the check asks the server whether it answers, every `probeMs`:
 *
 *   - a silent follow that is heard from again was only slow: live again, nothing missed;
 *   - the server answers while a follow is gone or silent: the way back is a reload, now — a
 *     silent follow is abandoned (it would only hold a socket), and the page's banner says so;
 *   - the server has not answered for `reconnectMs`: the same, so the page does not wait forever
 *     on a server that may not come back by itself.
 *
 * Page-wide, like `page-behind-check.ts`: one server, one question. ⚠ Never reloaded automatically
 * (#919): a reload could interrupt someone mid-answer.
 */

/** One page thread whose live view is not live, as the check sees it. */
interface LostThread {
  readonly threadId: string
  readonly since: number
}

/** The page's threads that are not receiving their updates now. */
function lostThreads(): LostThread[] {
  return threadListStore.get().flatMap(({ threadId }) => {
    const view = getThreadStores(threadId).connection.liveView.get()
    return view.state === 'live' ? [] : [{ threadId, since: view.since }]
  })
}

/**
 * One read of the lost threads, `lostAt` being when the check first found one: whether the page
 * gives up on them — the server answers again, or has not for `reconnectMs` — and, if so, the fault
 * it says. ⚠ The page's side is read AFTER the answer: a silent follow heard from meanwhile is live.
 */
async function giveUp(lostAt: number): Promise<{ lost: LostThread[]; error: string } | undefined> {
  const answers = await serverAnswers()
  const lost = lostThreads()
  const waited = Date.now() - lostAt
  const [first] = lost
  if (first === undefined || (!answers && waited < PAGE_HEALTH_TIMING.reconnectMs)) return undefined
  const seconds = Math.round((Date.now() - first.since) / 1000)
  const error = answers
    ? `no update from the server for ${seconds}s; it answers again, and a follow cannot catch up on what it missed`
    : `no update from the server for ${seconds}s, and it has not answered for ${Math.round(waited / 1000)}s`
  return { lost, error }
}

/** The check's loop: a read every `probeMs` until the page gives up on a lost view or it is stopped; returns the stop. */
function startLiveViewCheck(): () => void {
  let stopped = false
  /** When the check first found a thread lost, while it still finds one; undefined otherwise. */
  let lostAt: number | undefined
  const check = async (): Promise<void> => {
    if (stopped || pageFault.get()?.trigger === 'lost') return
    lostAt = lostThreads().length === 0 ? undefined : (lostAt ?? Date.now())
    const given = lostAt === undefined ? undefined : await giveUp(lostAt)
    if (stopped) return
    if (given !== undefined) {
      for (const { threadId } of given.lost) getThreadStores(threadId).connection.abandon()
      reportPageFault({ trigger: 'lost', threadId: given.lost[0]?.threadId, error: given.error })
      return
    }
    timer = setTimeout(() => void check(), PAGE_HEALTH_TIMING.probeMs)
  }
  let timer = setTimeout(() => void check(), PAGE_HEALTH_TIMING.probeMs)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** Asks the server back every `probeMs` while a thread's live view is lost; mounted once, by the page. */
export function usePageLiveViewCheck(): void {
  useEffect(() => (isFixtureMode ? undefined : startLiveViewCheck()), [])
}

/** The page's two checks against the server (#919, #914): mounted once, by the page. */
export function usePageChecks(): void {
  usePageBehindCheck()
  usePageLiveViewCheck()
}
