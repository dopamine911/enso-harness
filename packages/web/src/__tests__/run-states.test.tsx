import { afterAll, expect, test } from 'bun:test'
import type { EnsoProject, EnsoRunStatesFrame, EnsoStoredThread } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type * as PageListingsModule from '../page-listings.ts'
import type * as ThreadsRailModule from '../threads-rail.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ThreadsRail }: typeof ThreadsRailModule = await import('../threads-rail.tsx')
const { usePageListings }: typeof PageListingsModule = await import('../page-listings.ts')

/**
 * A run the page has NOT opened ends on the rail at the server's word (#911): the stored row's dot
 * and its closed project's signal (#876) clear on the one `run-state` frame that releases the thread
 * — not on a listing read again, which nothing here does. Mounted over the page's own listings hook,
 * with the server's routes answered by hand and the run-states stream written frame by frame.
 */

afterAll(releaseDom)

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const APP: EnsoProject = { projectId: 'p-app', title: 'app', path: '/code/app', status: 'ok', launch: false }

function stored(threadId: string, projectId: string, extra: Partial<EnsoStoredThread>): EnsoStoredThread {
  return {
    threadId,
    projectId,
    title: threadId,
    lastActivityAt: new Date().toISOString(),
    messageCount: 2,
    busy: false,
    waiting: false,
    ...extra,
  }
}

const noop = (): void => {
  // Nothing here is clicked.
}

/** The rail as the page feeds it: its listings, a stored row for each thread it has not opened. */
function Rail(): React.ReactNode {
  const { threads, stored: listed, projects } = usePageListings()
  return (
    <ThreadsRail
      projects={projects.rows}
      threads={threads}
      activeThreadId={undefined}
      earlier={listed.rows}
      earlierError={listed.error}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onOpenProject={noop}
      onRemoveProject={noop}
      onProjectSettings={noop}
      onPage={noop}
      projectNotice={undefined}
    />
  )
}

test('⚠ a stored row and its closed project clear on the frame that releases the thread, with no listing read again; nothing left running, the stream closes (#911)', async () => {
  const encoder = new TextEncoder()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let streamSignal: AbortSignal | undefined
  let listings = 0
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestedUrl(input)
      if (url === '/api/stored-threads') {
        listings += 1
        return Promise.resolve(
          Response.json([
            stored('works', 'p-launch', { busy: true }),
            stored('asks', 'p-app', { busy: true, waiting: true }),
          ]),
        )
      }
      if (url === '/api/projects') return Promise.resolve(Response.json([LAUNCH, APP]))
      if (url === '/api/run-states') {
        streamSignal = init?.signal ?? undefined
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            stream = controller
          },
        })
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
      }
      return Promise.resolve(new Response('not scripted', { status: 404 }))
    },
    { preconnect: original.preconnect },
  )
  const send = async (frame: EnsoRunStatesFrame): Promise<void> => {
    await act(async () => {
      stream?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      await tick()
    })
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Rail />)
    await tick()
  })
  const row = (threadId: string): HTMLElement | null => container.querySelector(`button[data-thread-id="${threadId}"]`)
  const header = (name: string): HTMLElement | null =>
    container.querySelector(`section[aria-label="${name}"] button[aria-expanded]`)
  try {
    // The listing says both run: the launch project open on its row, the app closed on its question.
    expect(row('works')?.textContent).toContain('running')
    expect(header('app')?.getAttribute('aria-expanded')).toBe('false')
    expect(header('app')?.textContent).toContain('1 waiting on you')
    // A row not open here runs: the page watches the server's run states.
    expect(stream).toBeDefined()
    await send({
      type: 'run-states',
      threads: [
        { threadId: 'works', busy: true, waiting: false },
        { threadId: 'asks', busy: true, waiting: true },
      ],
    })
    expect(row('works')?.textContent).toContain('running')

    await send({ type: 'run-state', threadId: 'works', busy: false, waiting: false })
    expect(row('works')?.textContent).not.toContain('running')
    expect(header('app')?.textContent).toContain('1 waiting on you')

    await send({ type: 'run-state', threadId: 'asks', busy: false, waiting: false })
    expect(header('app')?.textContent).toBe('app')
    expect(listings).toBe(1)
    // Nothing not open here runs any more: the stream gives its connection back.
    expect(streamSignal?.aborted).toBe(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = original
  }
})
