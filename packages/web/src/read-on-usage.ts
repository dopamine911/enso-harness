import { useEffect, useState } from 'react'
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
 * `read` must be stable — a module-level function — or every render would subscribe again.
 */
export function useReadOnUsage<Outcome>(read: (threadId: string) => Promise<Outcome>, reading: Outcome): Outcome {
  const stores = useThreadStores()
  const [outcome, setOutcome] = useState<Outcome>(reading)
  useEffect(() => {
    let mounted = true
    const readLatest = latestWins(() => read(stores.threadId))
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
  }, [stores, read])
  return outcome
}
