import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ThreadStores } from './thread-stores.ts'

/**
 * The smallest external store React can subscribe to: one value, replaced whole, and a
 * listener set.
 *
 * Every per-thread store (mode, stats, notifications, …) is one of these with domain methods on
 * top — see `thread-stores.ts` for why they are instances rather than module state (#90 PR 3: a
 * page holds several threads, and each needs its own).
 *
 * A leaf module on purpose: the domain modules import `useThreadStores` from here, and
 * `thread-stores.ts` imports the domain factories, so the type import above is the only
 * edge back — a type, erased, no cycle at runtime.
 */
export interface Store<T> {
  readonly get: () => T
  readonly subscribe: (listener: () => void) => () => void
}

export interface WritableStore<T> extends Store<T> {
  readonly set: (next: T) => void
}

export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** `useSyncExternalStore` over a `Store` — the store's own methods are stable, so no memo. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** The stores of the thread a component is rendering inside — provided by the thread's pane. */
export const ThreadStoresContext = createContext<ThreadStores | null>(null)

export function useThreadStores(): ThreadStores {
  const stores = useContext(ThreadStoresContext)
  if (stores === null)
    throw new Error(
      'useThreadStores: no ThreadStoresContext above this component — it must render inside a thread pane',
    )
  return stores
}
