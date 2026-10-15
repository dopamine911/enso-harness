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
  /** Change rows between refreshes — what the page heard of them since (#911). A change that changes no row wakes nobody. */
  readonly update: (change: (rows: readonly Row[]) => readonly Row[]) => void
}

/** What a refresh's rows are corrected by as they land, fixed as the refresh starts (#911). */
export type CorrectFetched<Row> = () => (rows: readonly Row[]) => readonly Row[]

/**
 * `what` names the list in the schema refusal: "the server's {what} did not match its schema".
 * `correctFetched` is asked as each refresh STARTS, and its answer applied to that refresh's rows:
 * what the page heard while the request was out is newer than the rows it brings back (#911).
 */
export function createListingStore<Schema extends TSchema>(
  schema: Schema,
  what: string,
  fetchList: () => Promise<unknown>,
  correctFetched: CorrectFetched<Static<Schema>> = () => (rows) => rows,
): ListingStore<Static<Schema>> {
  const store = createStore<ListingState<Static<Schema>>>({ rows: [], error: undefined })
  return {
    get: store.get,
    subscribe: store.subscribe,
    refresh: async () => {
      const correct = correctFetched()
      try {
        const listed = await fetchList()
        if (!(Array.isArray(listed) && listed.every((row) => Check(schema, row)))) {
          throw new Error(`the server's ${what} did not match its schema`)
        }
        store.set({ rows: correct(listed), error: undefined })
      } catch (error) {
        store.set({ rows: store.get().rows, error: error instanceof Error ? error.message : String(error) })
      }
    },
    update: (change) => {
      const current = store.get()
      const rows = change(current.rows)
      if (rows.length === current.rows.length && rows.every((row, index) => row === current.rows[index])) return
      store.set({ ...current, rows })
    },
  }
}
