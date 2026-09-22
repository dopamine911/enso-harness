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

async function mountDebug(search: string): Promise<{ text: string; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<DebugScreen search={search} fetch={silentFetch} />)
  })
  return {
    text: container.textContent ?? '',
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
  expect(page.text).not.toContain('the thread in the URL')
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
// shows the tail it fell back to.
test('⚠ a malformed thread mounts the tail and says why', async () => {
  const page = await mountDebug('?thread=not%20a%20thread')
  expect(page.text).toContain('enso · logs')
  expect(page.text).toContain('the thread in the URL')
  expect(page.text).toContain('?thread=not a thread is not a thread id')
  await page.unmount()
})
