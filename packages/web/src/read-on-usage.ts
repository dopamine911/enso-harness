import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { useThreadStores } from './store.ts'
import { latestWins } from './thread-debug.tsx'

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
 */
export function useReadOnUsage<Outcome>(
  read: (threadId: string, fetchImpl: FetchLike) => Promise<Outcome>,
  reading: Outcome,
  moment: string = '',
): Outcome {
  const stores = useThreadStores()
  const initial = useRef(reading)
  // The answer is kept with the question it answers: when the question changes (a new `read`, or
  // a new thread's stores) the render below falls back to `reading` at once, rather than showing
  // the last question's answer for a frame and resetting in an effect.
  const [answered, setAnswered] = useState<{ stores: unknown; read: unknown; outcome: Outcome } | undefined>(undefined)
  useEffect(() => {
    let mounted = true
    const readLatest = latestWins(() => read(stores.threadId, stores.fetch))
    const refresh = (): void => {
      void readLatest().then((latest) => {
        if (mounted && latest !== undefined) setAnswered({ stores, read, outcome: latest })
      })
    }
    refresh()
    const unsubscribe = stores.usage.subscribe(refresh)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [stores, read, moment])
  return answered !== undefined && answered.stores === stores && answered.read === read
    ? answered.outcome
    : initial.current
}
