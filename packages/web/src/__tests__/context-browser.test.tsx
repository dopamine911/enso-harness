import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import type { EnsoContextRequest, EnsoContextRequestDetail } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import { ContextBrowser, type ContextBrowserFocus, type ContextBrowserRequest } from '../context-browser.tsx'
import { ThreadStoresContext } from '../store.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'
import { waitUntil } from './wait-until.ts'

/**
 * #361 phase 3: the Context Browser, mounted — it reads the request it is asked for, and a focus
 * (a brief's line) opens that element's category and picks its row, whose content the element
 * view beside the list shows.
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

test("a focus opens its element's category and picks its row; the element view shows the call's arguments beside its result", async () => {
  const stores = mintThread()
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    asked.push(requestedUrl(input))
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
  const row = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>('li li button')].find((button) =>
      button.textContent?.includes('bash ls -la'),
    )
  await waitUntil(() => row() !== undefined)
  expect(asked).toEqual([`/api/threads/${stores.threadId}/context/2`])
  expect(row()?.getAttribute('aria-pressed')).toBe('true')
  const view = container.querySelector('aside[aria-label="element"]')?.textContent ?? ''
  expect(view).toContain('ls -la')
  expect(view).toContain('a b')
  // The other category stays closed: the focus opens where it points, not everything.
  const system = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
    button.textContent?.includes('system prompt'),
  )
  expect(system?.getAttribute('aria-expanded')).toBe('false')
  await flush(async () => root.unmount())
  container.remove()
})

// A live thread re-reads the detail on every usage move, and each read is a new payload: the
// focus must stay the focus the reader already had — not re-open a category they closed, nor scroll.
test('a re-read keeps the reader where they are: a focused category they closed stays closed, and nothing scrolls again', async () => {
  const stores = mintThread()
  const asked: string[] = []
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    asked.push(requestedUrl(input))
    return Promise.resolve(Response.json({ ...DETAIL, threadId: stores.threadId }))
  }) as typeof fetch
  const scrolled: Element[] = []
  const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function recordScroll(
    this: Element,
  ): void {
    scrolled.push(this)
  })
  try {
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
    const category = (): HTMLButtonElement | undefined =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
        button.textContent?.includes('tool results'),
      )
    await waitUntil(() => category()?.getAttribute('aria-expanded') === 'true')
    expect(scrolled).toHaveLength(1)
    await flush(async () => {
      category()?.click()
    })
    expect(category()?.getAttribute('aria-expanded')).toBe('false')
    // A turn lands: the usage moves, the detail is read again.
    await flush(async () => {
      stores.usage.set({ cost: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, context: null })
    })
    await waitUntil(() => asked.length === 2)
    await flush(() => new Promise((resolve) => setTimeout(resolve, 40)))
    expect(asked).toHaveLength(2)
    expect(category()?.getAttribute('aria-expanded')).toBe('false')
    expect(scrolled).toHaveLength(1)
    await flush(async () => root.unmount())
    container.remove()
  } finally {
    scroll.mockRestore()
  }
})

// The trend picks a turn — every category closed — and then a file operation focuses a row of
// that same turn: the row mounts a render after the focus arrives, and must still be scrolled to.
test('a focus that arrives on an open request whose category is closed opens it and scrolls to the row', async () => {
  const stores = mintThread()
  globalThis.fetch = ((_input: string | URL | Request): Promise<Response> =>
    Promise.resolve(Response.json({ ...DETAIL, threadId: stores.threadId }))) as typeof fetch
  const scrolled: Element[] = []
  const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function recordScroll(
    this: Element,
  ): void {
    scrolled.push(this)
  })
  try {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const render = (focus: ContextBrowserFocus | undefined): Promise<void> =>
      flush(async () => {
        root.render(
          <ThreadStoresContext.Provider value={stores}>
            <ContextBrowser
              requests={[REQUEST]}
              next={MAKEUP}
              request={2}
              onRequest={(): void => undefined}
              focus={focus}
            />
          </ThreadStoresContext.Provider>,
        )
      })
    const category = (): HTMLButtonElement | undefined =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((button) =>
        button.textContent?.includes('tool results'),
      )
    await render(undefined)
    await waitUntil(() => category() !== undefined)
    expect(category()?.getAttribute('aria-expanded')).toBe('false')
    await render({ request: 2, key: 'e4#0' })
    await waitUntil(() => scrolled.length > 0)
    expect(category()?.getAttribute('aria-expanded')).toBe('true')
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0]?.textContent).toContain('bash ls -la')
    await flush(async () => root.unmount())
    container.remove()
  } finally {
    scroll.mockRestore()
  }
})

// A read that failed is that request's answer, not the next one's: asking for another request
// reads again, and says so, until it is answered.
test("a failed read is not shown as another request's while that one is read", async () => {
  const stores = mintThread()
  const pending = Promise.withResolvers<Response>()
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> =>
    requestedUrl(input).endsWith('/context/2')
      ? Promise.resolve(new Response('boom', { status: 500 }))
      : pending.promise) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = (request: ContextBrowserRequest): Promise<void> =>
    flush(async () => {
      root.render(
        <ThreadStoresContext.Provider value={stores}>
          <ContextBrowser
            requests={[REQUEST]}
            next={MAKEUP}
            request={request}
            onRequest={(): void => undefined}
            focus={undefined}
          />
        </ThreadStoresContext.Provider>,
      )
    })
  await render(2)
  await waitUntil(() => container.textContent?.includes('no detail') === true)
  await render('next')
  expect(container.textContent).not.toContain('no detail')
  expect(container.textContent).toContain("reading the request's context…")
  pending.resolve(Response.json({ ...DETAIL, request: 'next', threadId: stores.threadId }))
  await flush(async () => root.unmount())
  container.remove()
})

// The arrows step through the branch's requests and stop at its ends; a pick is the reader's, not
// the request's — it survives a step to a request that does not hold it, which says so, and shows
// again on the way back (PR #406 review).
test('the arrows step between requests and stop at the ends; a pick the opened request lacks is said, and kept', async () => {
  const stores = mintThread()
  const first: EnsoContextRequest = { ...REQUEST, turn: 1 }
  const detailOf = (request: ContextBrowserRequest): EnsoContextRequestDetail => ({
    ...DETAIL,
    threadId: stores.threadId,
    request,
    // Request 1 predates the bash call: its result is not in that context.
    elements: request === 1 ? DETAIL.elements.filter((element) => element.key !== 'e4#0') : DETAIL.elements,
  })
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const which = requestedUrl(input).split('/context/')[1] ?? 'next'
    return Promise.resolve(Response.json(detailOf(which === 'next' ? 'next' : Number(which))))
  }) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const asked: ContextBrowserRequest[] = []
  const render = (request: ContextBrowserRequest): Promise<void> =>
    flush(async () => {
      root.render(
        <ThreadStoresContext.Provider value={stores}>
          <ContextBrowser
            requests={[first, REQUEST]}
            next={MAKEUP}
            request={request}
            onRequest={(chosen: ContextBrowserRequest): void => {
              asked.push(chosen)
            }}
            focus={undefined}
          />
        </ThreadStoresContext.Provider>,
      )
    })
  const arrow = (label: string): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const view = (): string => container.querySelector('aside[aria-label="element"]')?.textContent ?? ''
  const button = (selector: string, text: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>(selector)].find((candidate) =>
      candidate.textContent?.includes(text),
    )

  // The first request: nothing earlier; later is request 2.
  await render(1)
  expect(arrow('earlier request')?.disabled).toBe(true)
  await flush(async () => arrow('later request')?.click())
  // The next request: nothing later; earlier is the last request, 2.
  await render('next')
  expect(arrow('later request')?.disabled).toBe(true)
  await flush(async () => arrow('earlier request')?.click())
  expect(asked).toEqual([2, 2])

  // Pick the bash result in request 2, then open request 1, which does not hold it.
  await render(2)
  await waitUntil(() => button('button[aria-expanded]', 'tool results') !== undefined)
  expect(button('button[aria-expanded]', 'tool results')).toBeDefined()
  await flush(async () => button('button[aria-expanded]', 'tool results')?.click())
  await flush(async () => button('li li button', 'bash ls -la')?.click())
  expect(view()).toContain('a b')
  await render(1)
  await waitUntil(() => view().includes('isn’t in this request'))
  expect(view()).toContain('The element you had open isn’t in this request')
  expect(view()).not.toContain('a b')
  await render(2)
  await waitUntil(() => view().includes('a b'))
  expect(view()).toContain('a b')
  await flush(async () => root.unmount())
  container.remove()
})
