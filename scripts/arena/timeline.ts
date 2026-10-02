import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isEnsoThreadId } from '../../packages/core/src/thread-inspection.ts'

/**
 * The arena run's shared timeline (#556): one JSON line per thing that happened — a screenshot,
 * an action the agent took through the UI, a browser error, a note, Enso's process ending — each
 * stamped with the wall clock, the run's elapsed time, the page's URL and the thread that URL
 * names. It is the join between the Playwright evidence and Enso's: a screenshot's thread id is
 * the id `bun scripts/enso-thread.ts`, the log bundle and the session file are keyed by.
 *
 * ⚠ WRITTEN A LINE AT A TIME, SYNCHRONOUSLY. The recorder is outside Enso's process so that
 * evidence survives Enso's crash; the timeline must also survive the RECORDER's, so nothing is
 * buffered: every event is on disk before the next one is taken.
 */

/** Where the page was when an event happened. Absent for an event with no page (Enso's exit). */
export interface ArenaPagePlace {
  readonly url: string
  /** The thread the URL names (`?thread=`, #142), or absent on a fresh page. */
  readonly threadId?: string
}

/** Why a screenshot was taken. `sample` is the periodic one; the rest are event captures. */
export type ArenaShotCause =
  | 'sample'
  | 'action-failed'
  | 'console-error'
  | 'page-error'
  | 'dialog'
  | 'navigation'
  | 'page-crash'
  | 'enso-exit'
  | 'requested'
  | 'final'

/** A note the agent wrote: a wish, a piece of friction, or its end-of-run retrospective. */
export type ArenaNoteKind = 'wish' | 'friction' | 'retrospective'

export type ArenaEventBody =
  | { readonly kind: 'run-start'; readonly scenario: string; readonly project: string; readonly ensoCommit?: string }
  | { readonly kind: 'screenshot'; readonly cause: ArenaShotCause; readonly path: string }
  | {
      readonly kind: 'action'
      readonly action: string
      /** The action as the agent sent it, with any typed text redacted. */
      readonly detail: string
      readonly outcome: 'ok' | 'failed'
      readonly error?: string
      readonly durationMs: number
    }
  | { readonly kind: 'navigation' }
  | { readonly kind: 'console-error'; readonly text: string }
  | { readonly kind: 'page-error'; readonly text: string }
  | { readonly kind: 'request-failed'; readonly request: string; readonly failure: string }
  | { readonly kind: 'dialog'; readonly dialog: string; readonly message: string }
  | { readonly kind: 'page-crash' }
  | { readonly kind: 'enso-exit'; readonly exit: string }
  | { readonly kind: 'enso-start' }
  | { readonly kind: 'trace-chunk'; readonly path: string }
  | {
      readonly kind: 'note'
      readonly note: ArenaNoteKind
      readonly trying: string
      readonly happened: string
      readonly wanted?: string
    }
  | { readonly kind: 'run-stop'; readonly reason: string }

/** One timeline line: the body, when it happened, and where the page was. */
export type ArenaEvent = ArenaEventBody & {
  /** Wall clock, ISO 8601. */
  readonly at: string
  /** Milliseconds since the run started, from the monotonic clock: the order when two `at`s tie. */
  readonly elapsedMs: number
  readonly page?: ArenaPagePlace
}

/**
 * The page place a URL gives: the URL and, when it names one, its thread. The page reads
 * `?thread=` the same way (`packages/web/src/thread-url.ts#readThreadUrl`), and checks it with the
 * same `isEnsoThreadId`; a script may not import the web package, so the two lines are restated.
 */
export function pagePlace(url: string): ArenaPagePlace {
  let named: unknown
  try {
    named = new URL(url).searchParams.get('thread')
  } catch {
    return { url }
  }
  return isEnsoThreadId(named) ? { url, threadId: named } : { url }
}

/** A timeline writer over one file: `record` stamps an event and appends it before returning. */
export interface ArenaTimeline {
  readonly path: string
  record(body: ArenaEventBody, page?: ArenaPagePlace): ArenaEvent
}

/** The clocks a timeline stamps with — `Date` and `performance` in a run, fixed ones in a test. */
export interface ArenaClock {
  readonly wallNow: () => Date
  readonly monotonicNow: () => number
}

const SYSTEM_CLOCK: ArenaClock = { wallNow: () => new Date(), monotonicNow: () => performance.now() }

/** A timeline appending to `path`; elapsed time counts from this call. */
export function openTimeline(path: string, clock: ArenaClock = SYSTEM_CLOCK): ArenaTimeline {
  const startedAt = clock.monotonicNow()
  return {
    path,
    record(body: ArenaEventBody, page?: ArenaPagePlace): ArenaEvent {
      const event: ArenaEvent = {
        ...body,
        at: clock.wallNow().toISOString(),
        elapsedMs: Math.round(clock.monotonicNow() - startedAt),
        ...(page === undefined ? {} : { page }),
      }
      appendFileSync(path, `${JSON.stringify(event)}\n`)
      return event
    },
  }
}

/**
 * Every event a timeline file holds, oldest first. A torn last line — the recorder killed
 * mid-write — is skipped, not fatal: the rest of the run is still evidence.
 */
export function readTimeline(path: string): ArenaEvent[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line): ArenaEvent[] => {
      try {
        return [JSON.parse(line) as ArenaEvent]
      } catch {
        return []
      }
    })
}
