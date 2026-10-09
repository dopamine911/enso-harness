/**
 * The browser suite listens for the page's own announcements (#737): every thread's status bar
 * dispatches `enso:thread-status` (core's `ENSO_UI_EVENTS`, `EnsoThreadStatusEvent`) on mount and
 * at each change, after the commit, so a wait that returns on the event finds the page already
 * saying what the event says. The suite waited on words and controls instead — the stop button's
 * absence for "the run ended", an option button for "the card is up" — which is the sampling the
 * arena gave up in the same issue (`packages/arena/src/recorder.ts`, `actions.ts`).
 *
 * The shape is the arena's: an init script, installed before the page's own, keeps every
 * announcement in order on `window`; a test marks the log before its move, and a wait reads what
 * came since, then each announcement as it arrives. ⚠ MARK BEFORE THE MOVE: a model-free run
 * opens and settles in a few milliseconds, inside the round trip of the click that started it, so
 * a listener added after the click has already missed both words (the arena's #693 blind spot).
 *
 * Only a shown pane's word counts: every mounted pane keeps its bar (#472), and an off-screen one
 * announces too.
 */
import { ENSO_UI_EVENTS, EnsoThreadStatusEvent } from '@enso/core'
import type { Page } from '@playwright/test'
import { Check } from 'typebox/value'

/** The `window` property the init script keeps the page's announcements in, oldest first. */
const ANNOUNCEMENTS_KEY = '__ensoThreadStatusAnnouncements'

/**
 * Keep every `enso:thread-status` the page dispatches, from its first script on. Install it before
 * the first `goto`: the bar announces once on mount, and a listener added later misses that word.
 * An init script runs again on every navigation, so the log starts empty on each document.
 */
export async function recordThreadStatus(page: Page): Promise<void> {
  await page.addInitScript(
    ({ eventName, key }) => {
      const announcements: unknown[] = []
      Object.assign(window, { [key]: announcements })
      document.addEventListener(eventName, (event) => {
        if (event instanceof CustomEvent) announcements.push(event.detail)
      })
    },
    { eventName: ENSO_UI_EVENTS.threadStatus, key: ANNOUNCEMENTS_KEY },
  )
}

/** Where the log stands now: the mark a wait counts "since" from. Taken before the move it waits on. */
export async function markThreadStatus(page: Page): Promise<number> {
  return (await announcementsFrom(page, -1)).length
}

/**
 * The page's whole log once it holds more than `known` announcements: at once if it already does,
 * else on the next one. ⚠ Woken by the event itself, never by a timer: the init script's listener
 * was added first, so by the time this one runs the new announcement is in the log.
 */
function announcementsFrom(page: Page, known: number): Promise<unknown[]> {
  return page.evaluate(
    ({ eventName, key, known: count }) =>
      new Promise<unknown[]>((resolve, reject) => {
        const log = (window as unknown as Record<string, unknown[] | undefined>)[key]
        if (log === undefined) {
          reject(new Error('the page has no announcement log: call recordThreadStatus before goto'))
          return
        }
        if (log.length > count) {
          resolve([...log])
          return
        }
        document.addEventListener(eventName, () => resolve([...log]), { once: true })
      }),
    { eventName: ENSO_UI_EVENTS.threadStatus, key: ANNOUNCEMENTS_KEY, known },
  )
}

/** The shown pane's announcements, each checked against core's schema: a malformed `detail` is a failure, not a skip. */
function shownAnnouncements(logged: readonly unknown[]): EnsoThreadStatusEvent[] {
  return logged.filter((detail): detail is EnsoThreadStatusEvent => {
    if (!Check(EnsoThreadStatusEvent, detail))
      throw new Error(`a malformed enso:thread-status detail: ${JSON.stringify(detail)}`)
    return detail.shown
  })
}

/**
 * What a wait is for: given the shown pane's announcements since the mark and the last one before
 * it (the state the move was made from), the announcement that ends the wait, if one has come.
 */
type Accept = (
  since: readonly EnsoThreadStatusEvent[],
  before: EnsoThreadStatusEvent | undefined,
) => EnsoThreadStatusEvent | undefined

/** The log since `mark`, then each announcement as it comes, until `accept` finds the one it waits for. */
async function waitForAnnouncement(page: Page, mark: number, accept: Accept): Promise<EnsoThreadStatusEvent> {
  let known = mark
  for (;;) {
    const entries = await announcementsFrom(page, known)
    known = entries.length
    const accepted = accept(shownAnnouncements(entries.slice(mark)), shownAnnouncements(entries.slice(0, mark)).at(-1))
    if (accepted !== undefined) return accepted
  }
}

/**
 * The run started at the mark has ended: the shown pane says `idle`, or `disconnected` (returned,
 * so the caller's check names it, instead of a wait to the limit). The arena's rule (#648): `idle`
 * counts once a `running` came after the mark, or at once when the move was made from a state
 * other than `idle` — answering a card, whose run may settle before a `running` is announced.
 */
export function waitForRunToEnd(page: Page, mark: number): Promise<EnsoThreadStatusEvent> {
  return waitForAnnouncement(page, mark, (since, before) => {
    let busy = before !== undefined && before.status !== 'idle'
    for (const announcement of since) {
      if (announcement.status === 'disconnected') return announcement
      if (announcement.status === 'idle' && busy) return announcement
      busy = announcement.status !== 'idle'
    }
    return undefined
  })
}

/** A run started after the mark: the shown pane says `running`. */
export function waitForRunToStart(page: Page, mark: number): Promise<EnsoThreadStatusEvent> {
  return waitForAnnouncement(page, mark, (since) => since.find((announcement) => announcement.status === 'running'))
}

/**
 * A card came up after the mark: the shown pane says `question`, for a question other than the one
 * open at the mark (#693: the card just answered is not the next one; its id tells them apart).
 */
export function waitForQuestion(page: Page, mark: number): Promise<EnsoThreadStatusEvent> {
  return waitForAnnouncement(page, mark, (since, before) =>
    since.find(
      (announcement) => announcement.status === 'question' && announcement.question?.id !== before?.question?.id,
    ),
  )
}

/** The pane of `threadId` became the shown one after the mark: a rail switch landed. */
export function waitForShownThread(page: Page, mark: number, threadId: string): Promise<EnsoThreadStatusEvent> {
  return waitForAnnouncement(page, mark, (since) => since.find((announcement) => announcement.threadId === threadId))
}
