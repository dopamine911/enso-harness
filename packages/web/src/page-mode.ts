import type { EnsoThreadHistory } from '@enso/core'
import { fixtureFetch } from './fixture-conversation.ts'
import { adoptThread, mintThread, type ThreadStores } from './thread-stores.ts'

/**
 * The page's URL switches (#31, #86): `?fixture` and `?debug`, read once at load, and the two ways a
 * thread enters the page, both through the page's network (#404).
 */

/**
 * `?fixture` swaps the live server connection for the scripted conversation in
 * `fixture-conversation.ts` — the styling dev loop (#31). Everything downstream of the
 * connection (the hook, the parts pipeline, every component below) is identical on both
 * paths, which is the point: the fixture styles the SAME renderers the live page uses.
 */
// ⚠ `typeof window` guard: this module is imported by the coverage manifest under `bun
// test`, where no DOM exists — fixture mode is a browser concern, so headless is never
// fixture mode. The ENTRY (main.tsx) stays the only module that touches the DOM freely.
export const isFixtureMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('fixture')
/**
 * The network every thread on this page talks through — the page's own, or on the fixture page a
 * fetch that refuses (#404): the transport swap covers only TanStack's send, and a prompt sent
 * mid-reply, Stop or a mode change reached the real server and ran a real model. Every thread
 * the page mints or adopts goes through these two, so none is left on the real network.
 */
const PAGE_FETCH = isFixtureMode ? fixtureFetch : undefined
export const mintPageThread = (projectId?: string, threadId?: string): ThreadStores => {
  const stores = mintThread(PAGE_FETCH, projectId, threadId)
  // The fixture's scripted chat has no session to start (#877): its threads open on the composer,
  // where every send replays the next turn.
  if (isFixtureMode) stores.launch.set(false)
  return stores
}
export const adoptPageThread = (history: EnsoThreadHistory, initialDraft?: string): ThreadStores =>
  adoptThread(history, PAGE_FETCH, initialDraft)
/** `?debug` opens the session debug drawer (#86) — same switch shape as `?fixture`. */
export const isDebugMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')
