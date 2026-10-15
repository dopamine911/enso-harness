import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { THREAD_STATUS_WORDS, type EnsoFollowFrame, type EnsoObservation } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { usePageLiveViewCheck } from '../live-view-check.ts'
import { PageFaultBanner } from '../page-fault.tsx'
import { clearPageFaultForTest, pageFault, setPageHealthTimingForTest } from '../page-health.ts'
import { setRunStatusTimingForTest } from '../run-status.ts'
import { useStore } from '../store.ts'
import { ThreadPane } from '../thread-pane.tsx'
import {
  clearThreadsForTest,
  mintThread,
  nameThreadSummary,
  type ThreadStores,
  threadListStore,
} from '../thread-stores.ts'
import { ThreadsRail } from '../threads-rail.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { createScriptedFetch, type ScriptedFetch, SNAPSHOT_LIVE } from './scripted-server.ts'
import { waitUntil } from './wait-until.ts'

// ⚠ Loaded after the DOM, as every mounting file does (`dom-environment.ts` says why).
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The run and page status (#914), mounted and driven by a scripted stream: the five states — the
 * live view lost, working (on what, for how long), waiting on you, possibly stuck, stopped (how) —
 * and the rail row of a thread off screen. The thresholds are shortened: the defaults are 15 s of
 * silence and three minutes without output.
 */

const SILENT_MS = 200

beforeEach(() => {
  setPageHealthTimingForTest({ silentMs: SILENT_MS, probeMs: 40, reconnectMs: 5000 })
  setRunStatusTimingForTest({ stuckMs: 400, tickMs: 20 })
})

const mounted: Array<{ root: Root; container: HTMLElement }> = []
/** The keepalive pumps a test started, as their stops. */
const pumps: Array<() => void> = []

afterEach(async () => {
  for (const stop of pumps.splice(0)) stop()
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  clearThreadsForTest()
  clearPageFaultForTest()
  setPageHealthTimingForTest()
  setRunStatusTimingForTest()
})
afterAll(async () => {
  globalThis.fetch = originalFetch
  await releaseDom()
})

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
const noop = (): void => undefined

/** Whether the server answers the page's live-view check — the page's own `fetch` (`live-view-check.ts`). */
let reachable = false
// Restored in `afterAll`: test files share one process, and a later one must get the real `fetch`.
const originalFetch = globalThis.fetch
globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
  reachable ? Promise.resolve(new Response('{}')) : Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch

function LiveViewCheck(): null {
  usePageLiveViewCheck()
  return null
}

/** The rail over the page's threads, as the page lists them. */
function Rail({ activeThreadId }: { activeThreadId: string }): React.ReactNode {
  const threads = useStore(threadListStore)
  return (
    <ThreadsRail
      projects={[]}
      threads={threads}
      activeThreadId={activeThreadId}
      earlier={[]}
      earlierError={undefined}
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

interface Thread {
  readonly stores: ThreadStores
  readonly server: ScriptedFetch
  /** Frames onto this thread's follow, React's work flushed after. */
  readonly settle: (...frames: EnsoFollowFrame[]) => Promise<void>
  /** The server's keepalive every 50 ms until the test stops it; returns the stop. */
  readonly keepAlive: () => () => void
}

/** A started thread on its own scripted server, named so its rail row is not a draft's. */
function thread(name: string): Thread {
  const server = createScriptedFetch()
  const stores = mintThread(server.fetch)
  stores.launch.set(false)
  nameThreadSummary(stores.threadId, name)
  return {
    stores,
    server,
    settle: async (...frames) => {
      await act(async () => {
        for (const frame of frames) server.frame(frame)
        await sleep(30)
      })
    },
    keepAlive: () => {
      const pump = setInterval(() => server.keepalive(), 50)
      const stop = (): void => clearInterval(pump)
      pumps.push(stop)
      return stop
    },
  }
}

/** The page: the banner, the live-view check, the rail, and each thread's pane — the first on screen. */
async function mountPage(...threads: Thread[]): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const [shown] = threads
  await act(async () => {
    root.render(
      <>
        <PageFaultBanner />
        <LiveViewCheck />
        <Rail activeThreadId={shown?.stores.threadId ?? ''} />
        {threads.map(({ stores }) => (
          <ThreadPane
            key={stores.threadId}
            threadId={stores.threadId}
            active={stores === shown?.stores}
            debugOpen={false}
          />
        ))}
      </>,
    )
    await sleep(20)
  })
  return container
}

let seq = 0
const observed = (observation: EnsoObservation): EnsoFollowFrame => {
  seq += 1
  return { type: 'observation', seq, observation }
}
const busy = (generation: number): EnsoFollowFrame => ({ ...SNAPSHOT_LIVE, busy: true, generation })
const released = (generation: number): EnsoFollowFrame => ({ type: 'status', live: true, busy: false, generation })

/** The status bar of the pane on screen. */
function statusOf(container: HTMLElement): string {
  const bar = [...container.querySelectorAll<HTMLElement>('#thread-status')].find(
    (candidate) => candidate.closest('[inert]') === null,
  )
  return bar?.textContent ?? ''
}

/** The rail row of a thread. */
const railRow = (container: HTMLElement, stores: ThreadStores): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`#threads-rail button[data-thread-id="${stores.threadId}"]`)

// ── 1. the live view lost ────────────────────────────────────────────────────

test('⚠ keepalives stop → "live view lost" within the silence threshold, reconnecting; heard again, live again with nothing missed', async () => {
  // Keepalives alone for longer than "possibly stuck" waits is not this test's subject.
  setRunStatusTimingForTest({ stuckMs: 60_000, tickMs: 20 })
  const alpha = thread('alpha')
  const container = await mountPage(alpha)
  await alpha.settle(busy(1))
  const stop = alpha.keepAlive()
  await act(() => sleep(SILENT_MS * 2))
  expect(statusOf(container)).toContain(THREAD_STATUS_WORDS.working)
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.lost)
  stop()
  const silentFrom = Date.now()
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.lost))
  // The threshold plus the watchdog's period and one flush: never a working page past it.
  expect(Date.now() - silentFrom).toBeLessThan(SILENT_MS + 200)
  expect(statusOf(container)).toContain('not receiving updates — reconnecting…')
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.working)
  // The server is heard from again: the bytes were held, not lost — live, and no reload asked.
  alpha.keepAlive()
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.working))
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.lost)
  expect(pageFault.get()).toBeUndefined()
})

test('a silent follow while the server answers: the follow is given up, and the page says "Reload to catch up"', async () => {
  reachable = true
  try {
    const alpha = thread('alpha')
    const container = await mountPage(alpha)
    await alpha.settle(busy(1))
    await waitUntil(() => statusOf(container).includes('Reload to catch up'))
    expect(statusOf(container)).toContain(THREAD_STATUS_WORDS.lost)
    expect(container.querySelector('[data-page-fault]')?.getAttribute('data-page-fault')).toBe('lost')
    expect([...container.querySelectorAll('#thread-status button')].map((button) => button.textContent)).toContain(
      'Reload',
    )
    // Abandoned: the composer stops offering what this page could not see happen.
    await waitUntil(() => alpha.stores.disconnected.get())
    expect(alpha.stores.disconnected.get()).toBe(true)
  } finally {
    reachable = false
  }
})

test('⚠ the server killed mid-run: "live view lost" at once, reconnecting while it is down; back up, "Reload to catch up"', async () => {
  const alpha = thread('alpha')
  const container = await mountPage(alpha)
  await alpha.settle(busy(1))
  const stop = alpha.keepAlive()
  await act(async () => {
    stop()
    alpha.server.setDown(true)
    await sleep(30)
  })
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.lost))
  expect(statusOf(container)).toContain('not receiving updates — reconnecting…')
  // Still down: still reconnecting, no banner.
  await act(() => sleep(200))
  expect(statusOf(container)).toContain('reconnecting…')
  expect(pageFault.get()).toBeUndefined()
  // The server is back: a follow cannot catch up on what it missed, so the page asks for a reload.
  reachable = true
  try {
    await waitUntil(() => statusOf(container).includes('Reload to catch up'))
    expect(statusOf(container)).toContain('Reload to catch up')
    expect(pageFault.get()?.trigger).toBe('lost')
  } finally {
    reachable = false
  }
})

// ── 2. working, on what, for how long ────────────────────────────────────────

test('working names the step and its time; the thinking tail moves live; a call the model writes is composing, then running', async () => {
  const alpha = thread('alpha')
  const container = await mountPage(alpha)
  alpha.keepAlive()
  await alpha.settle(busy(1))
  await waitUntil(() => statusOf(container).includes("waiting for the model's first output"))
  expect(statusOf(container)).toMatch(/run \d+s/)
  await alpha.settle(
    observed({ kind: 'message-start', role: 'assistant' }),
    observed({ kind: 'thinking-delta', contentIndex: 0, delta: 'weigh the options\nfirst the grid' }),
  )
  await waitUntil(() => statusOf(container).includes('first the grid'))
  expect(statusOf(container)).toContain('thinking')
  expect(statusOf(container)).not.toContain('weigh the options')
  // The tail moves with the deltas.
  await alpha.settle(observed({ kind: 'thinking-delta', contentIndex: 0, delta: ' then the colours' }))
  await waitUntil(() => statusOf(container).includes('first the grid then the colours'))
  expect(statusOf(container)).toContain('first the grid then the colours')
  // #913: the request's output so far, counted as it streams.
  expect(statusOf(container)).toContain('~49 chars')
  // Opened, the thinking's latest stretch.
  const tail = [...container.querySelectorAll<HTMLButtonElement>('#thread-status button')].find(
    (button) => button.getAttribute('aria-expanded') !== null,
  )
  await act(async () => {
    tail?.click()
    await sleep(20)
  })
  expect(container.querySelector('[data-thinking-tail]')?.textContent).toContain('weigh the options')
  // The model writes a call's arguments: the call is named, with its subject and its size so far.
  const update = (assistantMessageEvent: Record<string, unknown>): EnsoFollowFrame =>
    observed({ kind: 'unmapped', event: { type: 'message_update', assistantMessageEvent } })
  await alpha.settle(
    update({ type: 'toolcall_start', contentIndex: 1, id: 'w1', toolName: 'write' }),
    update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"site/arcade.html","content":"' }),
    update({ type: 'toolcall_delta', contentIndex: 1, delta: 'x'.repeat(2000) }),
  )
  await waitUntil(() => statusOf(container).includes('composing write site/arcade.html · 2.0 KB'))
  expect(statusOf(container)).toContain('composing write site/arcade.html · 2.0 KB')
  await alpha.settle(
    update({ type: 'toolcall_end', contentIndex: 1 }),
    observed({ kind: 'tool-call', toolCallId: 'w1', toolName: 'write', args: { path: 'site/arcade.html' } }),
  )
  await waitUntil(() => statusOf(container).includes('running write site/arcade.html'))
  expect(statusOf(container)).toContain('running write site/arcade.html')
})

// ── 3. waiting on you ────────────────────────────────────────────────────────

test('a question opens → "waiting on you" over the run, with its line, which goes to the card', async () => {
  const alpha = thread('alpha')
  const container = await mountPage(alpha)
  alpha.keepAlive()
  await alpha.settle(busy(1))
  await alpha.settle(
    observed({
      kind: 'extension-ui-request',
      id: 'd1',
      method: 'confirm',
      blocking: true,
      origin: 'run',
      dialog: { method: 'confirm', title: 'Allow rm -rf build?', message: 'it deletes the build' },
    }),
  )
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.waiting))
  expect(statusOf(container)).toContain('Allow rm -rf build?')
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.working)
  // The line is the way to the card: focus lands in it.
  const line = container.querySelector<HTMLButtonElement>('#thread-status button[title^="go to the question"]')
  ;(document.activeElement as HTMLElement | null)?.blur()
  await act(async () => {
    line?.click()
    await sleep(50)
  })
  expect(document.activeElement?.closest('[role="group"]')?.textContent).toContain('Allow rm -rf build?')
})

// ── 4. possibly stuck ────────────────────────────────────────────────────────

test('⚠ no output for the threshold — keepalives and an extension’s status line arriving all along — is "possibly stuck", with a Stop; output again is working', async () => {
  const alpha = thread('alpha')
  const container = await mountPage(alpha)
  alpha.keepAlive()
  await alpha.settle(busy(1))
  // The harness re-sends its status line whatever the model does (seen live, one a minute): not output.
  const chatter = setInterval(() => {
    alpha.server.frame(
      observed({ kind: 'extension-ui-request', id: 's1', method: 'setStatus', blocking: false, origin: 'run' }),
    )
  }, 60)
  pumps.splice(pumps.length, 0, () => clearInterval(chatter))
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.stuck))
  expect(statusOf(container)).toMatch(/no output for \d+s \(model request open since \d\d:\d\d/)
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.lost)
  const stop = [...container.querySelectorAll<HTMLButtonElement>('#thread-status button')].find(
    (button) => button.textContent === 'Stop',
  )
  await act(async () => {
    stop?.click()
    await sleep(30)
  })
  expect(alpha.server.abortCount()).toBe(1)
  await alpha.settle(
    observed({ kind: 'message-start', role: 'assistant' }),
    observed({ kind: 'text-delta', contentIndex: 0, delta: 'here it is' }),
  )
  await waitUntil(() => statusOf(container).includes('writing a reply'))
  expect(statusOf(container)).toContain(THREAD_STATUS_WORDS.working)
})

// ── 5. stopped, and how ──────────────────────────────────────────────────────

test('run-end → "finished", "stopped by you" or "failed" with its reason, until the next prompt', async () => {
  const alpha = thread('alpha')
  const container = await mountPage(alpha)
  alpha.keepAlive()
  await alpha.settle(busy(1))
  await alpha.settle(observed({ kind: 'settled', aborted: false }), released(1))
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.finished))
  expect(statusOf(container)).toContain(THREAD_STATUS_WORDS.finished)

  await alpha.settle(busy(2))
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.working))
  await alpha.settle(observed({ kind: 'settled', aborted: true }), released(2))
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.stopped))
  expect(statusOf(container)).toContain(THREAD_STATUS_WORDS.stopped)

  await alpha.settle(busy(3))
  await alpha.settle(
    observed({ kind: 'extension-error', extensionPath: 'guard.ts', event: 'tool_call', error: 'boom' }),
    observed({ kind: 'settled', aborted: false }),
    released(3),
  )
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.failed))
  expect(statusOf(container)).toContain('guard.ts failed on tool_call: boom')
  // It stays until the next run.
  await act(() => sleep(100))
  expect(statusOf(container)).toContain(THREAD_STATUS_WORDS.failed)
  await alpha.settle(busy(4))
  await waitUntil(() => statusOf(container).includes(THREAD_STATUS_WORDS.working))
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.failed)
})

// ── the rail row of a thread off screen ──────────────────────────────────────

test('the rail row of a thread not on screen says possibly stuck, waiting on you, and finished', async () => {
  const alpha = thread('alpha')
  const bravo = thread('bravo')
  const container = await mountPage(alpha, bravo)
  alpha.keepAlive()
  bravo.keepAlive()
  await alpha.settle(busy(1))
  await bravo.settle(busy(1))
  const said = (): string | undefined => railRow(container, bravo.stores)?.dataset.runState
  await waitUntil(() => said() === 'stuck')
  expect(railRow(container, bravo.stores)?.textContent).toContain(THREAD_STATUS_WORDS.stuck)
  await bravo.settle(
    observed({
      kind: 'extension-ui-request',
      id: 'd2',
      method: 'confirm',
      blocking: true,
      origin: 'run',
      dialog: { method: 'confirm', title: 'Push to main?', message: '' },
    }),
  )
  await waitUntil(() => said() === 'waiting')
  expect(railRow(container, bravo.stores)?.textContent).toContain(THREAD_STATUS_WORDS.waiting)
  expect(railRow(container, bravo.stores)?.title).toContain('Push to main?')
  await bravo.settle(
    observed({ kind: 'dialog-settled', id: 'd2', outcome: 'answered' }),
    observed({ kind: 'settled', aborted: false }),
    released(1),
  )
  await waitUntil(() => said() === 'finished')
  expect(railRow(container, bravo.stores)?.textContent).toContain(THREAD_STATUS_WORDS.finished)
  // The thread on screen says its own.
  expect(statusOf(container)).not.toContain(THREAD_STATUS_WORDS.finished)
})
