import { isEnsoThreadId } from '@enso/core'

/**
 * The thread a page URL names (#142): `?thread=<id>`. The URL is the source of truth for
 * the active pane, so a reload shows the thread you were in, back/forward walk the threads
 * you switched between, and a thread has a link.
 *
 * The query form, not a path: the dev server serves one page and a path would need a
 * fallback route; `?debug`, `?log` and `?fixture` already live in the query, and every
 * write here keeps them. A thread id IS pi's session id (#95), so the value is checked
 * with the same `isEnsoThreadId` the server checks it with — a malformed one is not a
 * thread, and the page says so rather than showing nothing.
 */
const THREAD_QUERY_PARAMETER = 'thread'

export type ThreadUrl =
  /** The URL names a thread; adopt it from `/history` before showing anything. */
  | { readonly kind: 'resume'; readonly threadId: string }
  /** No thread named — a fresh page — or one that cannot be a thread id, with why. */
  | { readonly kind: 'fresh'; readonly notice?: string }

/**
 * What the page did INSTEAD when the id was not one — the notice's second half. The chat page
 * opens a new thread; the debug page falls back to the day's tail, and a notice that said it
 * "opened a new thread" there told the reader the page did something it cannot do (PR #336
 * review). The page that knows what it fell back to says so.
 *
 * @invariant resume/url-names-thread The URL names the thread; the latest navigation wins.
 * A thread id resumes, none is fresh, a malformed one is fresh AND said; `urlForThread` keeps
 * every other parameter. The boot resumes with `pop` (no history written), a rail click pushes
 * (`chat-screen.tsx`, `BOOT` and `navigate`), and two guards drop a late answer whole:
 * `createResumeRequests` (last click wins) and the page's `epoch` (a navigation since).
 */
export function readThreadUrl(search: string, fellBackTo = 'opened a new thread instead'): ThreadUrl {
  const named = new URLSearchParams(search).get(THREAD_QUERY_PARAMETER)
  if (named === null || named === '') return { kind: 'fresh' }
  // Checked as `unknown`: the guard narrows to `string`, which would leave `named` as `never` below.
  const candidate: unknown = named
  if (isEnsoThreadId(candidate)) return { kind: 'resume', threadId: candidate }
  return {
    kind: 'fresh',
    notice: `?thread=${named.slice(0, 40)} is not a thread id — ${fellBackTo}`,
  }
}

/** The same URL with `thread` set to `threadId` — every other parameter kept, in its order. */
export function urlForThread(search: string, threadId: string): string {
  const parameters = new URLSearchParams(search)
  parameters.set(THREAD_QUERY_PARAMETER, threadId)
  return `?${parameters.toString()}`
}
