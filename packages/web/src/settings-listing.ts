import { useCallback, useEffect, useState } from 'react'
import type { Static, TSchema } from 'typebox'
import type { FetchLike } from './browser-logging.ts'
import { checkedPayload } from './stored-threads.ts'

/**
 * A listing a Settings section reads from the server — Storage's trees (#578), Providers' (#904):
 * still out, read, or why not.
 */
export type ListingRead<Listing> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly listing: Listing }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * The page's `fetch`, read at call time and called as a function. ⚠ Never `globalThis.fetch`
 * itself as a default: the dialog calls `target.fetch(…)`, and a browser's `fetch` refuses any
 * `this` but the window ("Illegal invocation") — the delete failed live while every scripted test
 * passed. Module-level, so the effect that reads the listing sees one function across renders.
 */
const pageFetch: FetchLike = (input, init) => fetch(input, init)

/** One listing's route, its schema, and the words for an answer that misses it. */
export interface ListingRoute<Schema extends TSchema> {
  readonly route: string
  readonly schema: Schema
  readonly mismatch: string
}

/** `GET` the route, checked against its schema; a failure is words, never a throw. */
async function readListing<Schema extends TSchema>(
  fetchImpl: FetchLike,
  { route, schema, mismatch }: ListingRoute<Schema>,
): Promise<ListingRead<Static<Schema>>> {
  try {
    return { kind: 'read', listing: await checkedPayload(await fetchImpl(route), schema, mismatch) }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** A listing as its section holds it, the `fetch` it was read with, and how to read it again or replace it. */
export interface ListingState<Listing> {
  readonly read: ListingRead<Listing>
  readonly fetchNow: FetchLike
  readonly reload: () => void
  readonly replace: (listing: Listing) => void
}

/**
 * The listing, read when the caller mounts and again on `reload`; a read answered after the caller
 * unmounted or reloaded is dropped. `replace` takes a listing the server answered otherwise. `at`
 * is a module constant, so the effect reads it once per mount and reload.
 */
export function useListing<Schema extends TSchema>(
  fetchImpl: FetchLike | undefined,
  at: ListingRoute<Schema>,
): ListingState<Static<Schema>> {
  const fetchNow = fetchImpl ?? pageFetch
  const [read, setRead] = useState<ListingRead<Static<Schema>>>({ kind: 'loading' })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let current = true
    void readListing(fetchNow, at).then((next) => {
      if (current) setRead(next)
    })
    return (): void => {
      current = false
    }
  }, [fetchNow, at, generation])
  const reload = useCallback(() => setGeneration((count) => count + 1), [])
  const replace = useCallback((listing: Static<Schema>) => setRead({ kind: 'read', listing }), [])
  return { read, fetchNow, reload, replace }
}
