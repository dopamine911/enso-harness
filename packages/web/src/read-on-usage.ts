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
  const [outcome, setOutcome] = useState<Outcome>(reading)
  const initial = useRef(reading)
  const asked = useRef<{ stores: unknown; read: unknown } | undefined>(undefined)
  useEffect(() => {
    if (asked.current?.stores !== stores || asked.current.read !== read) setOutcome(initial.current)
    asked.current = { stores, read }
    let mounted = true
    const readLatest = latestWins(() => read(stores.threadId, stores.fetch))
    const refresh = (): void => {
      void readLatest().then((latest) => {
        if (mounted && latest !== undefined) setOutcome(latest)
      })
    }
    refresh()
    const unsubscribe = stores.usage.subscribe(refresh)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [stores, read, moment])
  return outcome
}
