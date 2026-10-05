import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import { createStore, type Store } from './store.ts'

/**
 * A list the server hands the page and the rail shows — stored threads (#95), projects (#395).
 *
 * Page-level, not per thread.
 *
 * ⚠ Refreshed on demand, never streamed: page load, and whenever the page knows the list moved
 * (a run settled; a project was registered). The same rule as the debug drawer (#86): a listing
 * puts no traffic in the trace it describes.
 *
 * ⚠ A failed listing is STATE, not a log line: an empty list and a listing that could not be
 * fetched must not look the same (#29's rule, applied to a list). The rail shows the error where
 * the rows would be; the last good rows are kept beneath it.
 */
export interface ListingState<Row> {
  readonly rows: readonly Row[]
  /** Why the last refresh produced nothing — a down server, a payload off its schema. */
  readonly error: string | undefined
}

export interface ListingStore<Row> extends Store<ListingState<Row>> {
  readonly refresh: () => Promise<void>
}

/** `what` names the list in the schema refusal: "the server's {what} did not match its schema". */
export function createListingStore<Schema extends TSchema>(
  schema: Schema,
  what: string,
  fetchList: () => Promise<unknown>,
): ListingStore<Static<Schema>> {
  const store = createStore<ListingState<Static<Schema>>>({ rows: [], error: undefined })
  return {
    get: store.get,
    subscribe: store.subscribe,
    refresh: async () => {
      try {
        const listed = await fetchList()
        if (!(Array.isArray(listed) && listed.every((row) => Check(schema, row)))) {
          throw new Error(`the server's ${what} did not match its schema`)
        }
        store.set({ rows: listed, error: undefined })
      } catch (error) {
        store.set({ rows: store.get().rows, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
