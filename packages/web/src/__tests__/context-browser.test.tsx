import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoContextRequest, EnsoContextRequestDetail } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { ContextBrowser } from '../context-browser.tsx'
import { ThreadStoresContext } from '../store.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * #361 phase 3: the Context Browser, mounted — it reads the request it is asked for, and a focus
 * (a brief's line) opens that element's category and row, where its content is.
 */

ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
afterEach(() => clearThreadsForTest())
afterAll(releaseDom)

const MAKEUP = { system: 10, tools: 0, user: 2, injected: 0, assistant: 5, toolResults: 3 }

const REQUEST: EnsoContextRequest = {
  turn: 2,
  prompt: 1,
  at: '2026-09-24T10:00:00.000Z',
  model: 'claude-test',
  estimated: MAKEUP,
  actual: { prompt: 30, output: 5, cacheRead: 0 },
  brief: { prompt: 'list', added: [], moreAdded: 0, reply: '', toolCalls: [] },
}

const DETAIL: EnsoContextRequestDetail = {
  threadId: 'placeholder',
  request: 2,
  elements: [
    {
      key: 'e1#0:section:preamble',
      category: 'system',
      label: 'preamble',
      tokens: 10,
      entered: false,
      body: { kind: 'text', text: 'You are pi.', images: [] },
    },
    {
      key: 'e4#0',
      category: 'toolResults',
      label: 'bash ls -la',
      at: '2026-09-24T10:00:00.000Z',
      tokens: 3,
      entered: true,
      body: {
        kind: 'toolResult',
        toolName: 'bash',
        arguments: { command: 'ls -la' },
        isError: false,
        text: 'a b',
        images: [],
      },
    },
  ],
  left: [],
}

const flush = (work: () => Promise<void>): Promise<void> => act(work)

test("a focus opens its element's category and row; the row shows the call's arguments beside its result", async () => {
  const stores = mintThread()
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    asked.push(String(input))
    return Promise.resolve(Response.json({ ...DETAIL, threadId: stores.threadId }))
  }) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(async () => {
    root.render(
      <ThreadStoresContext.Provider value={stores}>
        <ContextBrowser
          requests={[REQUEST]}
          next={MAKEUP}
          request={2}
          onRequest={(): void => undefined}
          focus={{ request: 2, key: 'e4#0' }}
        />
      </ThreadStoresContext.Provider>,
    )
  })
  const deadline = Date.now() + 2000
  const row = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>('li li button')].find((button) =>
      button.textContent?.includes('bash ls -la'),
    )
  while (row() === undefined && Date.now() < deadline)
    await flush(() => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(asked).toEqual([`/api/threads/${stores.threadId}/context/2`])
  expect(row()?.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('ls -la')
  expect(container.textContent).toContain('a b')
  // The other category stays closed: the focus opens where it points, not everything.
  const system = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
    button.textContent?.includes('system prompt'),
  )
  expect(system?.getAttribute('aria-expanded')).toBe('false')
  await flush(async () => root.unmount())
  container.remove()
})
