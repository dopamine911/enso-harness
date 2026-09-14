import { isZenThreadId } from '@zen/core'

/**
 * The thread a page URL names (#142): `?thread=<id>`. The URL is the source of truth for
 * the active pane, so a reload shows the thread you were in, back/forward walk the threads
 * you switched between, and a thread has a link.
 *
 * The query form, not a path: the dev server serves one page and a path would need a
 * fallback route; `?debug`, `?log` and `?fixture` already live in the query, and every
 * write here keeps them. A thread id IS pi's session id (#95), so the value is checked
 * with the same `isZenThreadId` the server checks it with — a malformed one is not a
 * thread, and the page says so rather than showing nothing.
 */
export const THREAD_QUERY_PARAMETER = 'thread'

export type ThreadUrl =
  /** The URL names a thread; adopt it from `/history` before showing anything. */
  | { readonly kind: 'resume'; readonly threadId: string }
  /** No thread named — a fresh page — or one that cannot be a thread id, with why. */
  | { readonly kind: 'fresh'; readonly notice?: string }

export function readThreadUrl(search: string): ThreadUrl {
  const named: unknown = new URLSearchParams(search).get(THREAD_QUERY_PARAMETER)
  if (named === null || named === '') return { kind: 'fresh' }
  if (isZenThreadId(named)) return { kind: 'resume', threadId: named }
  return {
    kind: 'fresh',
    notice: `?thread=${String(named).slice(0, 40)} is not a thread id — opened a new thread instead`,
  }
}

/** The same URL with `thread` set to `threadId` — every other parameter kept, in its order. */
export function urlForThread(search: string, threadId: string): string {
  const parameters = new URLSearchParams(search)
  parameters.set(THREAD_QUERY_PARAMETER, threadId)
  return `?${parameters.toString()}`
}
