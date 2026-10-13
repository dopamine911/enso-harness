import { useEffect, useEffectEvent, useState } from 'react'

/** A read not landed yet. */
export type Loading = { readonly kind: 'loading' }

const LOADING: Loading = { kind: 'loading' }

/**
 * A read made afresh each time `active` turns true, and again when `key` changes while it is:
 * `loading` until it lands, and a read a later one overtook is dropped. While `active` is false the
 * last read stays (#883: only the pane on screen asks). `settled`: a read that holds needs no
 * other — the session's models once loaded.
 */
export function useFreshRead<T>(
  active: boolean,
  key: string,
  read: () => Promise<T>,
  settled: (value: Loading | T) => boolean = (): boolean => false,
): Loading | T {
  const [value, setValue] = useState<Loading | T>(LOADING)
  const done = settled(value)
  const readNow = useEffectEvent(read)
  useEffect(() => {
    if (!active || done) return
    let current = true
    setValue(LOADING)
    void readNow().then((next) => {
      if (current) setValue(next)
    })
    return (): void => {
      current = false
    }
  }, [active, done, key])
  return value
}
