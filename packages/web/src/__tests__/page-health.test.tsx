import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { EnsoBrowserLogBatch, type EnsoStoredThread } from '@enso/core'
import { reset } from '@logtape/logtape'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { Check } from 'typebox/value'
import { configureBrowserLogging, type LogShipper } from '../browser-logging.ts'
import { createFollowConnection } from '../follow-connection.ts'
import { usePageBehindCheck } from '../page-behind-check.ts'
import { PageFaultBanner, PaneBoundary } from '../page-fault.tsx'
import {
  clearPageFaultForTest,
  PAGE_FAULT_WORDS,
  pageFault,
  setPageHealthTimingForTest,
  watchPageFaults,
} from '../page-health.ts'
import { reloadKeepingDrafts } from '../page-reload.ts'
import { ThreadPane } from '../thread-pane.tsx'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { createScriptedFetch, requestedUrl, type ScriptedFetch, SNAPSHOT_IDLE } from './scripted-server.ts'
import { waitUntil } from './wait-until.ts'

// ⚠ Loaded after the DOM, as every mounting file does (`dom-environment.ts` says why).
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * A page that has fallen behind, or partly failed (#919): each trigger raises the one banner and
 * leaves a log line with the error, the thread and the page. Mounted, over the scripted server, with
 * the thresholds shortened — the defaults are ~10 s each.
 */

const PAGE_ID = 'page-919'
let shipper: LogShipper | undefined
const shipped: EnsoBrowserLogBatch[] = []

beforeEach(async () => {
  shipped.length = 0
  const logging = await configureBrowserLogging({
    level: 'info',
    page: PAGE_ID,
    fetch: (_input, init) => {
      const batch: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      if (!Check(EnsoBrowserLogBatch, batch)) throw new Error('the page shipped a batch off its schema')
      shipped.push(batch)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  shipper = logging.shipper
  setPageHealthTimingForTest({ pollMs: 30, applySlackMs: 60, staleMs: 250, stallMs: 150 })
})

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  clearThreadsForTest()
  clearPageFaultForTest()
  setPageHealthTimingForTest()
  globalThis.sessionStorage.clear()
  await reset()
})
afterAll(releaseDom)

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
const tick = (): Promise<void> => sleep(20)

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(node)
    await tick()
  })
  return container
}

const banner = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-page-fault]')

/** The page's fault lines as the server would get them: shipped, with the page id on the batch. */
function shippedFaults(): Array<{ page: string; properties: Record<string, unknown> }> {
  shipper?.flush()
  return shipped.flatMap((batch) =>
    batch.records
      .filter((record) => record.logger === 'enso.browser.page')
      .map((record) => ({ page: batch.page, properties: record.properties })),
  )
}

/** Every shipped line of one logger, as the server would get it. */
function shippedLines(logger: string): Array<{ level: string; message: string; properties: Record<string, unknown> }> {
  shipper?.flush()
  return shipped.flatMap((batch) =>
    batch.records
      .filter((record) => record.logger === logger)
      .map(({ level, message, properties }) => ({ level, message, properties })),
  )
}

function BehindCheck(): null {
  usePageBehindCheck()
  return null
}

/** A started thread's pane over `server`, with the page's banner and server check beside it. */
async function mountPage(server: ScriptedFetch): Promise<{ container: HTMLElement; stores: ThreadStores }> {
  globalThis.fetch = server.fetch
  const stores = mintThread(server.fetch)
  stores.launch.set(false)
  const container = await mount(
    <>
      <PageFaultBanner />
      <BehindCheck />
      <ThreadPane threadId={stores.threadId} active debugOpen={false} />
    </>,
  )
  await act(async () => {
    server.frame({ ...SNAPSHOT_IDLE, threadId: stores.threadId })
    await tick()
  })
  return { container, stores }
}

function listed(threadId: string, messageCount: number, busy: boolean): EnsoStoredThread {
  return {
    threadId,
    projectId: 'p-launch',
    lastActivityAt: new Date(Date.UTC(2026, 9, 13, 18, 34, messageCount)).toISOString(),
    messageCount,
    busy,
    waiting: false,
  }
}

test('⚠ the server listing moving on while the page applies nothing raises the banner, and the bar stops claiming work', async () => {
  const rows: EnsoStoredThread[] = []
  const server = createScriptedFetch({ storedThreads: rows })
  const { container, stores } = await mountPage(server)
  rows.push(listed(stores.threadId, 2, false))
  // Reads that find the row as it was: nothing is behind.
  await act(() => sleep(150))
  expect(banner(container)).toBeNull()
  // The server moves on — 23 tool calls later, still running — and no frame reaches the page.
  rows[0] = listed(stores.threadId, 48, true)
  await waitUntil(() => banner(container) !== null)
  expect(banner(container)?.textContent).toContain(PAGE_FAULT_WORDS.banner)
  expect(banner(container)?.dataset.pageFault).toBe('behind')
  expect(container.querySelector('#thread-status')?.textContent).toContain('out of date')
  expect(shippedFaults()).toEqual([
    {
      page: PAGE_ID,
      properties: expect.objectContaining({
        trigger: 'behind',
        threadId: stores.threadId,
        error: expect.stringContaining('48 messages, running'),
      }),
    },
  ])
})

test('a listing that moves with the page applying as it goes raises nothing', async () => {
  const rows: EnsoStoredThread[] = []
  const server = createScriptedFetch({ storedThreads: rows })
  const { container, stores } = await mountPage(server)
  rows.push(listed(stores.threadId, 2, false))
  for (let count = 3; count < 30; count += 1) {
    rows[0] = listed(stores.threadId, count, true)
    await act(async () => {
      server.frame({ type: 'status', live: true, busy: true, generation: 1 })
      await tick()
    })
  }
  expect(pageFault.get()).toBeUndefined()
  expect(banner(container)).toBeNull()
})

test('⚠ a listing read slower than the slack, straddling the run’s last change the page applied at once, raises nothing', async () => {
  const rows: EnsoStoredThread[] = []
  const server = createScriptedFetch({ storedThreads: rows })
  const readStarted: Array<() => void> = []
  // The server answers as of the request, and the answer takes longer than `applySlackMs` to arrive.
  const slow: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!requestedUrl(input).endsWith('/api/stored-threads')) return server.fetch(input, init)
      const answer = await server.fetch(input, init)
      for (const started of readStarted.splice(0)) started()
      await sleep(150)
      return answer
    },
    { preconnect: server.fetch.preconnect },
  )
  const { container, stores } = await mountPage({ ...server, fetch: slow })
  rows.push(listed(stores.threadId, 2, true))
  await act(() => sleep(400))
  // While a read is out, the run's last change lands on the server and the page applies it.
  const { promise: inFlight, resolve } = Promise.withResolvers<void>()
  readStarted.push(resolve)
  await inFlight
  await act(async () => {
    rows[0] = listed(stores.threadId, 3, false)
    server.frame({ type: 'status', live: true, busy: false, generation: 1 })
    await tick()
  })
  // Then the thread is quiet, past `staleMs` and several reads.
  await act(() => sleep(800))
  expect(pageFault.get()).toBeUndefined()
  expect(banner(container)).toBeNull()
})

test('a check whose reads fail says so once, and once more when they succeed again', async () => {
  const rows: EnsoStoredThread[] = []
  const server = createScriptedFetch({ storedThreads: rows })
  let failing = true
  const flaky: typeof fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      failing && requestedUrl(input).endsWith('/api/stored-threads')
        ? Promise.resolve(new Response('the listing broke', { status: 503 }))
        : server.fetch(input, init),
    { preconnect: server.fetch.preconnect },
  )
  const { stores } = await mountPage({ ...server, fetch: flaky })
  rows.push(listed(stores.threadId, 2, false))
  await act(() => sleep(200))
  failing = false
  await act(() => sleep(100))
  expect(shippedLines('enso.browser.page.check').map(({ level, message }) => [level, message])).toEqual([
    ['warning', expect.stringContaining('the server check cannot read the listing')],
    ['info', 'the server check reads the listing again'],
  ])
  expect(pageFault.get()).toBeUndefined()
})

function Throws(): React.ReactNode {
  throw new Error('a part this page cannot draw')
}

test('⚠ a throw drawing a pane is that pane’s alone: its boundary says so, the banner shows, the rest stays usable', async () => {
  let clicked = 0
  // React reports a caught throw on the console too; the boundary's record is what is asserted.
  const quiet = spyOn(console, 'error').mockImplementation(() => undefined)
  const container = await mount(
    <>
      <PageFaultBanner />
      <PaneBoundary pane="transcript" threadId="t-render">
        <Throws />
      </PaneBoundary>
      <button type="button" data-composer="" onClick={() => (clicked += 1)}>
        send
      </button>
    </>,
  ).finally(() => quiet.mockRestore())
  const failed = container.querySelector('[data-pane-failed="transcript"]')
  expect(failed?.textContent).toContain('a part this page cannot draw')
  expect(banner(container)?.dataset.pageFault).toBe('render')
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-composer]')?.click()
    await tick()
  })
  expect(clicked).toBe(1)
  expect(shippedFaults()).toEqual([
    {
      page: PAGE_ID,
      properties: expect.objectContaining({
        trigger: 'render',
        pane: 'transcript',
        threadId: 't-render',
        error: 'Error: a part this page cannot draw',
      }),
    },
  ])
})

test('an unhandled rejection and an uncaught error each leave a line naming the thread on screen; the banner shows the first', async () => {
  const container = await mount(<PageFaultBanner />)
  const unwatch = watchPageFaults(window, () => 't-screen')
  await act(async () => {
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new TypeError('nobody awaited this') })
    window.dispatchEvent(rejection)
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('nothing caught this'), message: 'x' }))
    // Chrome's harmless layout notice is no fault.
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }),
    )
    await tick()
  })
  unwatch()
  expect(banner(container)?.dataset.pageFault).toBe('rejection')
  expect(shippedFaults()).toEqual([
    {
      page: PAGE_ID,
      properties: expect.objectContaining({
        trigger: 'rejection',
        threadId: 't-screen',
        error: 'TypeError: nobody awaited this',
      }),
    },
    {
      page: PAGE_ID,
      properties: expect.objectContaining({
        trigger: 'error',
        threadId: 't-screen',
        error: 'RangeError: nothing caught this',
      }),
    },
  ])
})

test('an error event with no error object — another origin’s "Script error." — is logged, and raises no banner', async () => {
  const container = await mount(<PageFaultBanner />)
  const unwatch = watchPageFaults(window, () => 't-screen')
  await act(async () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
    await tick()
  })
  unwatch()
  expect(pageFault.get()).toBeUndefined()
  expect(banner(container)).toBeNull()
  expect(shippedLines('enso.browser.page')).toEqual([
    {
      level: 'warning',
      message: expect.stringContaining('no error object'),
      properties: expect.objectContaining({ error: 'Script error.' }),
    },
  ])
})

test('a thrown value that is not an Error but is not nullish (`throw "boom"`) still raises the banner', async () => {
  const container = await mount(<PageFaultBanner />)
  const unwatch = watchPageFaults(window, () => 't-screen')
  await act(async () => {
    window.dispatchEvent(new ErrorEvent('error', { error: 'boom', message: 'Uncaught boom' }))
    await tick()
  })
  unwatch()
  expect(banner(container)?.dataset.pageFault).toBe('error')
  expect(shippedFaults()).toEqual([
    {
      page: PAGE_ID,
      properties: expect.objectContaining({ trigger: 'error', threadId: 't-screen', error: 'boom' }),
    },
  ])
})

test('⚠ a chunk handed to the client and never taken back is a stall: the banner, and a line naming the chunk and the thread', async () => {
  const container = await mount(<PageFaultBanner />)
  const server = createScriptedFetch()
  const connection = createFollowConnection({ threadId: 't-stall', fetch: server.fetch })
  const chunks = connection.subscribe()[Symbol.asyncIterator]()
  // The client takes the first chunk and never asks for the next.
  const first = chunks.next()
  await tick()
  server.frame({ ...SNAPSHOT_IDLE, threadId: 't-stall' })
  await first
  await waitUntil(() => banner(container) !== null)
  expect(banner(container)?.dataset.pageFault).toBe('stalled')
  expect(shippedFaults()).toEqual([
    {
      page: PAGE_ID,
      properties: expect.objectContaining({
        trigger: 'stalled',
        threadId: 't-stall',
        error: expect.stringMatching(/^a \S+ chunk handed to the chat client \d+s ago was never taken back$/),
      }),
    },
  ])
  connection.close()
  await chunks.return?.(undefined)
})

test('a client that throws on a chunk stops the subscription and raises the banner at once', async () => {
  const container = await mount(<PageFaultBanner />)
  const server = createScriptedFetch()
  const connection = createFollowConnection({ threadId: 't-throw', fetch: server.fetch })
  const chunks = connection.subscribe()[Symbol.asyncIterator]()
  const first = chunks.next()
  await tick()
  server.frame({ ...SNAPSHOT_IDLE, threadId: 't-throw' })
  await first
  await act(async () => {
    await chunks.throw?.(new TypeError('the stream processor broke')).catch(() => undefined)
    await tick()
  })
  expect(banner(container)?.dataset.pageFault).toBe('stalled')
  expect(shippedFaults()).toContainEqual({
    page: PAGE_ID,
    properties: expect.objectContaining({ trigger: 'stalled', threadId: 't-throw' }),
  })
  connection.close()
})

test('⚠ a follow the server closed applies nothing: appliedAt is undefined once the client has taken its end', async () => {
  const server = createScriptedFetch()
  const connection = createFollowConnection({ threadId: 't-closed', fetch: server.fetch })
  const chunks = connection.subscribe()[Symbol.asyncIterator]()
  const first = chunks.next()
  await tick()
  server.frame({ ...SNAPSHOT_IDLE, threadId: 't-closed' })
  await first
  expect(connection.appliedAt()).toBeNumber()
  server.closeFollow()
  // The client takes every chunk to the follow's end, and asks once more.
  let taken = await chunks.next()
  while (taken.done !== true) taken = await chunks.next()
  expect(connection.appliedAt()).toBeUndefined()
  connection.close()
})

test('⚠ the chunks a closed follow drains apply nothing: appliedAt stays undefined between them', async () => {
  const server = createScriptedFetch()
  const connection = createFollowConnection({ threadId: 't-drain', fetch: server.fetch })
  const chunks = connection.subscribe()[Symbol.asyncIterator]()
  const first = chunks.next()
  await tick()
  server.frame({ ...SNAPSHOT_IDLE, threadId: 't-drain' })
  await first
  // A run open when the server closes: `followClosed` queues its RUN_ERROR, then the follow's end.
  const release = server.holdPrompt()
  const sending = connection.send(
    [{ id: 'u1', role: 'user', parts: [{ type: 'text', content: 'hello' }] }],
    undefined,
    undefined,
    { threadId: 't-drain', runId: 'r1', clientTools: [], forwardedProps: {} },
  )
  await tick()
  server.closeFollow()
  let taken = await chunks.next()
  while (taken.done !== true && taken.value.type !== 'RUN_ERROR') taken = await chunks.next()
  expect(taken.done).toBe(false)
  // Taking the RUN_ERROR back resumes the drain; the follow's end is still being handed over.
  taken = await chunks.next()
  expect(taken.done).toBe(false)
  expect(connection.appliedAt()).toBeUndefined()
  while (taken.done !== true) taken = await chunks.next()
  release()
  await sending.catch(() => undefined)
  connection.close()
})

test('a frame off the wire schema applies nothing: appliedAt does not move for it', async () => {
  const server = createScriptedFetch()
  const connection = createFollowConnection({ threadId: 't-skew', fetch: server.fetch })
  // The client takes every chunk as it comes, as TanStack does.
  const draining = (async () => {
    for await (const _chunk of connection.subscribe()) await Promise.resolve()
  })()
  await tick()
  server.frame({ ...SNAPSHOT_IDLE, threadId: 't-skew' })
  await tick()
  const applied = connection.appliedAt()
  expect(applied).toBeNumber()
  await sleep(30)
  // A newer server's frame this page cannot read: dropped, as a version skew drops it.
  server.rawFrame('{"type":"from-a-newer-server","threadId":"t-skew"}')
  await tick()
  expect(connection.appliedAt()).toBe(applied)
  connection.close()
  await draining.catch(() => undefined)
})

test('Reload’s kept drafts in a shape this page did not write open no composer with them', async () => {
  globalThis.sessionStorage.setItem('enso.reload-drafts', JSON.stringify({ 't-odd': { text: 42, files: 'none' } }))
  const server = createScriptedFetch()
  globalThis.fetch = server.fetch
  const stores = mintThread(server.fetch, undefined, 't-odd')
  stores.launch.set(false)
  const container = await mount(<ThreadPane threadId={stores.threadId} active debugOpen={false} />)
  expect(container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.value).toBe('')
})

test('⚠ Reload keeps the composer’s draft: the thread’s composer opens holding it after the reload', async () => {
  const server = createScriptedFetch()
  globalThis.fetch = server.fetch
  const before = mintThread(server.fetch)
  before.launch.set(false)
  const first = await mount(<ThreadPane threadId={before.threadId} active debugOpen={false} />)
  const field = first.querySelector<HTMLTextAreaElement>('textarea[name="message"]')
  if (field === null) throw new Error('expected the composer')
  await act(async () => {
    Reflect.set(HTMLTextAreaElement.prototype, 'value', 'half a thought, mid-answer', field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
  let reloads = 0
  await reloadKeepingDrafts(() => {
    reloads += 1
  })
  expect(reloads).toBe(1)
  // The reload: the page is gone, then the same thread comes back from the URL.
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  clearThreadsForTest()
  const after = mintThread(server.fetch, undefined, before.threadId)
  after.launch.set(false)
  const second = await mount(<ThreadPane threadId={after.threadId} active debugOpen={false} />)
  expect(second.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.value).toBe(
    'half a thought, mid-answer',
  )
})
