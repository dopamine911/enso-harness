import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoContextRequest, EnsoThreadContext } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { ThreadStoresContext } from '../store.ts'
import type * as ThreadContextModule from '../thread-context.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'
import { waitUntil } from './wait-until.ts'

/**
 * #361: the trend's pick is the page's — the Context Browser opens it and File Activity counts up
 * to it — including when a change of granularity moves it to another request (#362 review).
 */

ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ThreadContextView }: typeof ThreadContextModule = await import('../thread-context.tsx')
afterEach(() => clearThreadsForTest())
afterAll(releaseDom)

const flush = (work: () => Promise<void>): Promise<void> => act(work)

const MAKEUP = { system: 10, tools: 0, user: 2, injected: 0, assistant: 5, toolResults: 3 }
const request = (turn: number, prompt: number): EnsoContextRequest => ({
  turn,
  prompt,
  at: `2026-09-24T10:00:0${turn}.000Z`,
  model: 'claude-test',
  estimated: MAKEUP,
  actual: { prompt: 20, output: 5, cacheRead: 0 },
  brief: { prompt: `prompt ${prompt}`, added: [], moreAdded: 0, reply: '', toolCalls: [] },
})

test("picking a turn, then bars per prompt, moves the page to that prompt's last request", async () => {
  const stores = mintThread()
  const context: EnsoThreadContext = {
    threadId: stores.threadId,
    live: false,
    usage: null,
    next: MAKEUP,
    events: [],
    files: [],
    systemPrompt: null,
    // Prompt 1 took two requests; prompt 2 one.
    requests: [request(1, 1), request(2, 1), request(3, 2)],
  }
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const which = requestedUrl(input).split('/context/')[1] ?? 'next'
    return Promise.resolve(
      Response.json({
        threadId: stores.threadId,
        request: which === 'next' ? 'next' : Number(which),
        elements: [],
        left: [],
      }),
    )
  }) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(async () => {
    root.render(
      <ThreadStoresContext.Provider value={stores}>
        <ThreadContextView outcome={{ kind: 'read', payload: context }} />
      </ThreadStoresContext.Provider>,
    )
  })
  const click = async (button: HTMLButtonElement | null | undefined): Promise<void> => {
    if (button === null || button === undefined) throw new Error('expected the button')
    await flush(async () => {
      button.click()
    })
  }
  const browserRequest = (): string | undefined =>
    container.querySelector<HTMLSelectElement>('section[aria-label="Context Browser"] select')?.value
  const filesUpTo = (): string =>
    container.querySelector('section[aria-label="File Activity"] header')?.textContent ?? ''
  // Pick turn 1's bar — each bar is a button named for its request.
  await click(container.querySelector<HTMLButtonElement>('button[aria-label^="request 1,"]'))
  await waitUntil(() => browserRequest() === '1')
  expect(browserRequest()).toBe('1')
  expect(filesUpTo()).toContain('up to turn 1')
  // Per prompt, turn 1 is in prompt 1's bar — its last request, turn 2: the page follows.
  const perPrompt = [...container.querySelectorAll<HTMLButtonElement>('fieldset[aria-label="bar per"] button')].find(
    (button) => button.textContent === 'Prompts',
  )
  await click(perPrompt)
  await waitUntil(() => browserRequest() === '2')
  expect(browserRequest()).toBe('2')
  expect(filesUpTo()).toContain('up to turn 2')
  await flush(async () => root.unmount())
  container.remove()
})
