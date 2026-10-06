import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoContextRequestDetail, EnsoModelObservation, EnsoThreadContext } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { ThreadStoresContext } from '../store.ts'
import type * as ThreadContextModule from '../thread-context.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'
import { waitUntil } from './wait-until.ts'

/**
 * #361 phase 5: `/context`'s dialog, mounted — it reads nothing while closed, and once open shows
 * the composition and the browser, not the tab's other cards (those stay on the Context tab).
 */

// ⚠ A DOM before react-dom/client and Radix evaluate; the dialog is a Radix portal.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ThreadContextDialog }: typeof ThreadContextModule = await import('../thread-context.tsx')
afterEach(() => clearThreadsForTest())
afterAll(releaseDom)

const MAKEUP = { system: 10, tools: 0, user: 2, injected: 0, assistant: 5, toolResults: 3 }

const flush = (work: () => Promise<void>): Promise<void> => act(work)

/** What the follow says of a live session: its model (`stores.model`), the mark of a thread that can answer (#659). */
const LIVE_MODEL: EnsoModelObservation = {
  kind: 'model',
  model: { provider: 'fake', id: 'fake-1', name: 'Fake One' },
  thinkingLevel: 'off',
  availableThinkingLevels: ['off'],
}

test('closed, the dialog reads nothing; open, it shows Now and the Context Browser — and only them', async () => {
  const stores = mintThread()
  stores.model.applyObservation(LIVE_MODEL)
  const context: EnsoThreadContext = {
    threadId: stores.threadId,
    live: false,
    usage: null,
    next: MAKEUP,
    events: [],
    files: [],
    systemPrompt: null,
    requests: [],
  }
  const detail: EnsoContextRequestDetail = { threadId: stores.threadId, request: 'next', elements: [], left: [] }
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const url = requestedUrl(input)
    asked.push(url)
    return Promise.resolve(Response.json(url.endsWith('/context') ? context : detail))
  }) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = (open: boolean): Promise<void> =>
    flush(async () => {
      root.render(
        <ThreadStoresContext.Provider value={stores}>
          <ThreadContextDialog open={open} onClose={(): void => undefined} returnFocus={(): void => undefined} />
        </ThreadStoresContext.Provider>,
      )
    })
  await render(false)
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(asked).toEqual([])
  expect(document.querySelector('[role="dialog"]')).toBeNull()

  await render(true)
  const cards = (): string[] =>
    [...document.querySelectorAll('[role="dialog"] section[aria-label]')].map(
      (section) => section.getAttribute('aria-label') ?? '',
    )
  await waitUntil(() => cards().length >= 2)
  expect(cards()).toEqual(['Now', 'Context Browser'])
  expect(asked[0]).toBe(`/api/threads/${stores.threadId}/context`)
  await flush(async () => root.unmount())
  container.remove()
})

// ⚠ #659, from an arena run: the analysis views asked a never-run thread anyway — each answer a 404
// and a console error — to say only that nothing had run. They ask once the thread can answer.
test('⚠ on a thread nothing has run in, the dialog asks nothing and says so; once it is live, it reads', async () => {
  const stores = mintThread()
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    asked.push(requestedUrl(input))
    return Promise.resolve(new Response('no thread', { status: 404 }))
  }) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(async () => {
    root.render(
      <ThreadStoresContext.Provider value={stores}>
        <ThreadContextDialog open={true} onClose={(): void => undefined} returnFocus={(): void => undefined} />
      </ThreadStoresContext.Provider>,
    )
  })
  await waitUntil(() => document.querySelector('[role="dialog"]')?.textContent?.includes('nothing has run') ?? false)
  expect(asked).toEqual([])

  await flush(async () => {
    stores.model.applyObservation(LIVE_MODEL)
  })
  await waitUntil(() => asked.length > 0)
  expect(asked[0]).toBe(`/api/threads/${stores.threadId}/context`)
  await flush(async () => root.unmount())
  container.remove()
})
