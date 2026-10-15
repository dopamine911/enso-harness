import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoThreadContext } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { ThreadStoresContext } from '../store.ts'
import { ThreadContextView } from '../thread-context.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client evaluates; `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

afterEach(() => clearThreadsForTest())
afterAll(releaseDom)

/** React's `act` with async work — typed so its Promise overload is the one seen. */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const FIRST_REQUEST: EnsoThreadContext = {
  threadId: 't1',
  live: true,
  usage: null,
  next: { system: 800, tools: 2700, user: 10, injected: 0, assistant: 0, toolResults: 0 },
  events: [],
  files: [],
  systemPrompt: null,
  requests: [],
}

/**
 * PR #996 review: the Trend's Change mode draws no in-flight bar — there is no bar before it to
 * change from — so with no request counted yet it drew an empty plot. With no bars, the plot
 * draws the request in flight whole, whichever mode is chosen. MOUNTED: the mode is a click.
 */
test('⚠ in Change mode, the first request in flight still draws its bar', async () => {
  const AT = 1_700_000_000_000
  const live = { runSince: AT - 1000, request: { startedAt: AT - 1000, thinking: 400, text: 0, tool: 0 }, now: AT }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await flush(async () => {
    root.render(
      <ThreadStoresContext.Provider value={mintThread()}>
        <ThreadContextView outcome={{ kind: 'read', payload: FIRST_REQUEST }} live={live} />
      </ThreadStoresContext.Provider>,
    )
  })
  const change = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change')
  expect(change).toBeDefined()
  await flush(async () => {
    change?.click()
  })
  expect(change?.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('[data-in-flight]')).not.toBeNull()
  await flush(async () => {
    root.unmount()
  })
  container.remove()
})
