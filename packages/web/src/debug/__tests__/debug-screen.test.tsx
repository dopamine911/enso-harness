import { afterAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ensureDom, releaseDom } from '../../__tests__/dom-environment.ts'
import type { FetchLike } from '../../browser-logging.ts'
import { DebugScreen } from '../debug-screen.tsx'

// ⚠ Loaded by a DYNAMIC import, for the reason `log-tail-screen.test.tsx` gives: react-dom/client
// probes the DOM when its module evaluates, and a static import would see none.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The debug page by its URL (#144 slices 3–4): `?thread=<id>` is that thread's timeline,
 * `?stats` is the day's stats, no `thread` is the day's tail, and a `thread` that cannot be a
 * thread id is the tail with the mistake said above it. The server behind all of them is a
 * fetch that never answers — the routing is the question here, and the screens have their
 * own tests.
 */
afterAll(releaseDom)

const THREAD_ID = 'thread-01ABCDEF'

/** A server that never answers: every screen mounts and waits, which is all this test looks at. */
const silentFetch: FetchLike = () => new Promise<Response>(() => undefined)

const flush = (work: () => Promise<void>): Promise<void> => act(work)

interface MountedDebug {
  /** The page's text, in document order — so "above" is "earlier in it". */
  readonly text: string
  /** What the page said about the thread in the URL, or undefined when it said nothing. */
  readonly notice: string | undefined
  readonly unmount: () => Promise<void>
}

async function mountDebug(search: string): Promise<MountedDebug> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<DebugScreen search={search} fetch={silentFetch} />)
  })
  return {
    text: container.textContent ?? '',
    notice: container.querySelector('[role="alert"] [data-slot="alert-description"]')?.textContent ?? undefined,
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

test('?thread=<a thread id> mounts that thread’s timeline', async () => {
  const page = await mountDebug(`?thread=${THREAD_ID}`)
  expect(page.text).toContain(`thread ${THREAD_ID}`)
  expect(page.text).toContain('open in chat')
  expect(page.text).not.toContain('enso · logs')
  await page.unmount()
})

test('no thread mounts the day’s tail, with nothing said above it', async () => {
  const page = await mountDebug('?log=debug')
  expect(page.text).toContain('enso · logs')
  expect(page.notice).toBeUndefined()
  await page.unmount()
})

test('?stats mounts the day’s stats', async () => {
  const page = await mountDebug('?stats')
  expect(page.text).toContain('enso · day')
  expect(page.text).not.toContain('enso · logs')
  await page.unmount()
})

// The narrower question wins: a timeline link that carries a stale `?stats` still names one thread.
test('?stats&thread=<id> mounts the timeline, not the stats', async () => {
  const page = await mountDebug(`?stats&thread=${THREAD_ID}`)
  expect(page.text).toContain(`thread ${THREAD_ID}`)
  expect(page.text).not.toContain('enso · day')
  await page.unmount()
})

// A mistyped id is not silently the whole day: the page says what it could not read and
// shows the tail it fell back to. ⚠ It says what THIS page did — the chat page's "opened a
// new thread" is something an observation surface cannot do (PR #336 review).
test('⚠ a malformed thread mounts the tail and says why, in this page’s own words', async () => {
  const page = await mountDebug('?thread=not%20a%20thread')
  expect(page.text).toContain('enso · logs')
  expect(page.text).toContain('the thread in the URL')
  expect(page.notice).toBe("?thread=not a thread is not a thread id — showing the day's log instead")
  expect(page.text).not.toContain('opened a new thread')
  await page.unmount()
})

// ⚠ THE STATS VIEW IS A FALLBACK TOO. `?stats&thread=<mistake>` used to mount the stats with
// nothing said, swallowing the one mistake a reader typed (PR #336 review): the notice is
// above the stats, and says it is the stats it fell back to.
test('⚠ ?stats with a malformed thread mounts the stats with the notice above them', async () => {
  const page = await mountDebug('?stats&thread=not%20a%20thread')
  expect(page.text).toContain('enso · day')
  expect(page.text).not.toContain('enso · logs')
  expect(page.notice).toBe("?thread=not a thread is not a thread id — showing the day's stats instead")
  expect(page.text).not.toContain('opened a new thread')
  expect(page.text.indexOf('the thread in the URL')).toBeLessThan(page.text.indexOf('enso · day'))
  await page.unmount()
})
