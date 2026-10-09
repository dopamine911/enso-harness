import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { useThreadStores } from './store.ts'
import { latestWins } from './thread-debug.tsx'
/**
 * The pace of the status bar's reads that walk the project's tree, `/git` and `/tree` (#739): at
 * most one per 5 s per pane. Unpaced, each settled tool result cost 14–18 ms on a small project
 * and 83–93 ms (240 ms of git CPU) on a large one.
 */
export const TREE_READ_INTERVAL_MS = 5000

/** A refresh asked for now, or held for the end of the window; and the window's end, cancelled. */
interface PacedRefresh {
  ask: () => void
  cancel: () => void
}

/**
 * `run` at most once per `intervalMs`, leading and trailing (#739): the first ask runs at once and
 * opens the window; asks inside the window are folded into ONE run at its end, which opens the next
 * window. ⚠ The trailing run is the point: the last change of a burst lands after the leading read
 * went out, and dropping it would leave the readout one change behind until the next one. An
 * interval of 0 runs every ask.
 */
function paced(run: () => void, intervalMs: number): PacedRefresh {
  if (intervalMs <= 0) return { ask: run, cancel: () => undefined }
  // The open window's end; undefined while no window is open.
  let windowEnd: ReturnType<typeof setTimeout> | undefined
  let held = false
  const open = (): void => {
    held = false
    run()
    windowEnd = setTimeout(close, intervalMs)
  }
  const close = (): void => {
    windowEnd = undefined
    if (held) open()
  }
  return {
    ask: () => {
      if (windowEnd === undefined) open()
      else held = true
    },
    // A cancelled pacer starts clean: nothing held, no window open.
    cancel: () => {
      clearTimeout(windowEnd)
      windowEnd = undefined
      held = false
    },
  }
}

/**
 * A thread's route, read on mount and again whenever the thread's usage moves (#45, #361) — the
 * Stats and Context views' one refresh rule. `stores.usage` is the status bar's `session-usage`,
 * the one signal that a turn, a run, a compaction or a model change just landed, so the view
 * reads exactly when there is something new and never on a timer. A SUBSCRIPTION, not a render
 * dependency. Two reads can be in flight (a turn lands while the first is out); only the latest
 * one issued is shown.
 *
 * `read` is handed the thread's own `fetch` (`ThreadStores.fetch`): a thread's reads go where its
 * other requests go — the project header on them, and nothing on the network from a fixture page
 * (#404).
 *
 * `read` must be stable — a module-level function, or memoised — or every render would subscribe
 * again. `reading` is where an outcome starts, not an input: it is held, so a caller may write it
 * inline (#362 review). A CHANGE of `read` is a new question (the Context Browser asks for another request): the
 * outcome goes back to `reading` until it is answered, so a failure of the last question is not
 * shown as this one's.
 *
 * `moment` is another reason to read again (#453: the status bar's git readout asks when a tool
 * result settles). A new moment asks the SAME question, so the last answer stays on screen until
 * the next one lands — only a new `read` goes back to `reading`.
 *
 * `minimumIntervalMs` paces the RE-reads, usage and moments alike (#739): at most one per interval,
 * the last ask of a burst read at the window's end (`paced`). The status bar's `/git` and `/tree`
 * pass `TREE_READ_INTERVAL_MS` — a run settles a tool result every few hundred milliseconds, and
 * each read walks the project's files. A new question (mount, `read`, the thread) reads at once and
 * opens no window: the first change after it is read at once too, so a single edit shows as it lands.
 */
export function useReadOnUsage<Outcome>(
  read: (threadId: string, fetchImpl: FetchLike) => Promise<Outcome>,
  reading: Outcome,
  moment: string = '',
  minimumIntervalMs: number = 0,
): Outcome {
  const stores = useThreadStores()
  const initial = useRef(reading)
  // The current question's paced refresh, for the moment effect below; and the moment it last read
  // at, so the question's own first read is not followed by a second one for the same moment.
  const askAgain = useRef<(() => void) | undefined>(undefined)
  const momentRead = useRef(moment)
  // The answer is kept with the question it answers: when the question changes (a new `read`, or
  // a new thread's stores) the render below falls back to `reading` at once, rather than showing
  // the last question's answer for a frame and resetting in an effect.
  const [answered, setAnswered] = useState<{ stores: unknown; read: unknown; outcome: Outcome } | undefined>(undefined)
  useEffect(() => {
    let mounted = true
    const readLatest = latestWins(() => read(stores.threadId, stores.fetch))
    const readNow = (): void => {
      void readLatest().then((latest) => {
        if (mounted && latest !== undefined) setAnswered({ stores, read, outcome: latest })
      })
    }
    const refresh = paced(readNow, minimumIntervalMs)
    askAgain.current = refresh.ask
    readNow()
    const unsubscribe = stores.usage.subscribe(refresh.ask)
    return () => {
      mounted = false
      unsubscribe()
      refresh.cancel()
    }
  }, [stores, read, minimumIntervalMs])
  useEffect(() => {
    if (momentRead.current === moment) return
    momentRead.current = moment
    askAgain.current?.()
  }, [moment])
  return answered !== undefined && answered.stores === stores && answered.read === read
    ? answered.outcome
    : initial.current
}
