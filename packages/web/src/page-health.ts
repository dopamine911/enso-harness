import { ensoLogger } from '@enso/core'
import { pageLeaving } from './page-leaving.ts'
import { createStore, type Store } from './store.ts'

/**
 * Whether this page can still be believed (#919): it has fallen behind the server, or part of it
 * failed, while the rest keeps running.
 *
 * #915's tab froze its transcript and status at a `write` for 20 minutes and 23 tool calls, a
 * permission question open behind it, while the composer, the queue and the rail kept working —
 * and nothing said so: the follow was alive (keepalives kept arriving), the stall was AFTER the
 * stream, and the page reported none of its own errors. Four triggers now say it, each from
 * outside the part it watches:
 *
 *   behind     — the server's listing moved for a thread on this page and the page applied
 *                nothing for {@link PAGE_HEALTH_TIMING}`.staleMs` (`page-behind-check.ts`);
 *   stalled    — a chunk handed to the chat client and not taken back for `stallMs`, or a
 *                client that stopped taking them (`follow-connection.ts`);
 *   render     — a pane's error boundary caught a throw (`page-fault-boundary.tsx`);
 *   error / rejection — `window`'s `error` and `unhandledrejection` ({@link watchPageFaults}).
 *
 * Every one is LOGGED, through the page's logger — the shipper puts the page id on it and the
 * server's line carries it (`logs-route.ts`) — with the thread it concerns. The FIRST one is kept
 * and shown as the page's one banner, with Reload; the status bar stops claiming the run works
 * while it shows. ⚠ Never reloaded automatically: a reload could interrupt someone mid-answer.
 * It latches: a page that was this far wrong once is not trusted again until it reloads.
 */

/** What made this page say it may be out of date. */
export type PageFaultTrigger = 'behind' | 'stalled' | 'render' | 'error' | 'rejection'

export interface PageFault {
  readonly trigger: PageFaultTrigger
  /** The error, or what was seen, as one line. */
  readonly error: string
  /** The thread it concerns; for a page-wide error, the thread on screen when it happened. */
  readonly threadId: string | undefined
  /** The pane whose boundary caught it — `render` only. */
  readonly pane?: string
  readonly stack?: string
}

/**
 * The thresholds, in one place: ~10 s each, as #919 asks, and the server check's read every 5 s.
 * ⚠ Mutable only through {@link setPageHealthTimingForTest}: the mounted tests cannot wait 10 s.
 */
export const PAGE_HEALTH_TIMING = {
  /** How often the server's listing is read while a thread on this page is followed. */
  pollMs: 5000,
  /**
   * A page that applies an event a moment before a read whose listing does not have it yet must
   * not look silent at the next read: the page's applying and the server's write are not one instant.
   */
  applySlackMs: 1000,
  /** How long the server may be ahead of a thread with the page applying nothing. */
  staleMs: 10_000,
  /** How long one chunk may sit with the chat client before the page calls it stalled. */
  stallMs: 10_000,
}

const DEFAULT_TIMING = { ...PAGE_HEALTH_TIMING }

/** Test seam: shorter thresholds; called with nothing, the defaults again. Never called from production code. */
export function setPageHealthTimingForTest(timing: Partial<typeof PAGE_HEALTH_TIMING> = DEFAULT_TIMING): void {
  Object.assign(PAGE_HEALTH_TIMING, timing)
}

const log = ensoLogger('browser', 'page')
const fault = createStore<PageFault | undefined>(undefined)

/** The fault the banner shows: the first one since the page loaded; undefined while none. */
export const pageFault: Store<PageFault | undefined> = fault

/** The banner's words (#919), one place for the page and its tests. */
export const PAGE_FAULT_WORDS = {
  banner: 'This page has fallen behind the server (or part of it failed). What you see may be out of date.',
  reload: 'Reload',
} as const

/** Record a fault — always — and show it, unless one is already shown. */
export function reportPageFault(reported: PageFault): void {
  log.error('this page may be out of date ({trigger}): {error}', {
    trigger: reported.trigger,
    error: reported.error,
    ...(reported.threadId === undefined ? {} : { threadId: reported.threadId }),
    ...(reported.pane === undefined ? {} : { pane: reported.pane }),
    ...(reported.stack === undefined ? {} : { stack: reported.stack }),
  })
  if (fault.get() === undefined) fault.set(reported)
}

/** Test seam: the page healthy again. Never called from production code. */
export function clearPageFaultForTest(): void {
  fault.set(undefined)
}

/** An error, a rejection's reason, anything thrown, as one line and its stack. */
export function describeThrown(thrown: unknown): { error: string; stack?: string } {
  if (thrown instanceof Error) {
    return {
      error: `${thrown.name}: ${thrown.message}`,
      ...(thrown.stack === undefined ? {} : { stack: thrown.stack }),
    }
  }
  return { error: String(thrown) }
}

/**
 * The page's own failures (#919): a throw nothing caught and a promise nobody awaited, reported
 * with the thread on screen. Before this they reached the browser console and nothing else.
 * Installed once by `main.tsx`; returns the uninstall.
 */
export function watchPageFaults(target: Window, threadOnScreen: () => string | undefined): () => void {
  const onError = (event: ErrorEvent): void => {
    if (pageLeaving()) return
    // Chrome's "ResizeObserver loop …" is an `error` event with no error behind it: a layout that
    // took two passes, harmless, and routine under the transcript's virtualiser.
    if (event.error == null && event.message.startsWith('ResizeObserver loop')) return
    const thrown = event.error == null ? { error: event.message } : describeThrown(event.error)
    reportPageFault({ trigger: 'error', threadId: threadOnScreen(), ...thrown })
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    // An aborted request is the page's own doing (a released follow, a superseded read).
    if (pageLeaving() || (event.reason instanceof Error && event.reason.name === 'AbortError')) return
    reportPageFault({ trigger: 'rejection', threadId: threadOnScreen(), ...describeThrown(event.reason) })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
