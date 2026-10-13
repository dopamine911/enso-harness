import { afterEach, expect, test } from 'bun:test'
import {
  clearThreadsForTest,
  MAX_LIVE_THREADS,
  markThreadActive,
  mintThread,
  type ThreadStores,
  threadListStore,
  updateThreadSummary,
} from '../thread-stores.ts'

/**
 * The page's follow budget (#272). A live thread holds one SSE connection for as long as
 * its pane is mounted, and before this the page opened one per New thread click and closed
 * none: past the browser's six-per-origin limit the newest follow — and every unary `/api`
 * call the page makes — queued behind the open streams, silently.
 *
 * Counted here the way the browser counts: sockets opened minus sockets aborted. Measured
 * on `main` at 12 threads: 12 opened, 0 closed, 12 live.
 */

interface FollowProbe {
  readonly fetch: typeof fetch
  readonly opened: () => number
  /** Sockets the page is holding right now. */
  readonly live: () => number
  /** The threads whose follow was released, in the order they were released. */
  readonly releasedThreads: () => string[]
  /** Resolves once `count` follows have been opened — each socket's own arrival, never a delay. */
  readonly untilOpened: (count: number) => Promise<void>
}

const FOLLOW_URL = /\/api\/threads\/([^/]+)\/follow$/

function followProbe(): FollowProbe {
  const opened: string[] = []
  const released: string[] = []
  const waiters: Array<() => void> = []
  const impl = (input: string, init?: RequestInit): Promise<Response> => {
    const threadId = FOLLOW_URL.exec(input)?.[1]
    if (threadId === undefined) return Promise.resolve(new Response('{}', { status: 200 }))
    opened.push(threadId)
    init?.signal?.addEventListener('abort', () => released.push(threadId))
    for (const waiter of waiters.splice(0)) waiter()
    // A follow that never ends by itself, exactly like the server's.
    return Promise.resolve(
      new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
  }
  return {
    fetch: impl as unknown as typeof fetch,
    opened: () => opened.length,
    live: () => opened.length - released.length,
    releasedThreads: () => [...released],
    untilOpened: (count: number) => {
      if (opened.length >= count) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers<void>()
      const check = (): void => {
        if (opened.length >= count) resolve()
        else waiters.push(check)
      }
      waiters.push(check)
      return promise
    },
  }
}

/** What a pane does at mount: `live: true` subscribes the thread's connection (`thread-pane.tsx`). */
function mount(stores: ThreadStores): void {
  const chunks: unknown[] = []
  void (async () => {
    for await (const chunk of stores.connection.subscribe(new AbortController().signal)) chunks.push(chunk)
  })()
}

afterEach(() => clearThreadsForTest())

test('the page holds at most MAX_LIVE_THREADS follows, however many threads it mints', async () => {
  const probe = followProbe()
  const minted: string[] = []
  for (let index = 0; index < MAX_LIVE_THREADS + 8; index += 1) {
    const stores = mintThread(probe.fetch)
    minted.push(stores.threadId)
    mount(stores)
    await probe.untilOpened(index + 1)
  }
  expect(probe.opened()).toBe(MAX_LIVE_THREADS + 8)
  expect(probe.live()).toBe(MAX_LIVE_THREADS)
  // The oldest go, in order, and the rail lists exactly the survivors (newest first).
  expect(probe.releasedThreads()).toEqual(minted.slice(0, 8))
  expect(threadListStore.get().map((summary) => summary.threadId)).toEqual(minted.slice(-MAX_LIVE_THREADS).toReversed())
})

test('⚠ a thread with a run in flight keeps its follow: the page goes over budget rather than cut a live run', async () => {
  const probe = followProbe()
  for (let index = 0; index < MAX_LIVE_THREADS; index += 1) {
    const stores = mintThread(probe.fetch)
    mount(stores)
    await probe.untilOpened(index + 1)
    updateThreadSummary(stores.threadId, { title: undefined, busy: true, waiting: false })
  }
  mount(mintThread(probe.fetch))
  await probe.untilOpened(MAX_LIVE_THREADS + 1)
  // ⚠ A red line here means eviction began dropping threads mid-run: the pane would vanish
  // under a run nobody on this page could then see or stop. Over budget, and recorded, is
  // the deliberate choice — see `makeRoomForOneMore`.
  expect(probe.releasedThreads()).toEqual([])
  expect(probe.live()).toBe(MAX_LIVE_THREADS + 1)
})

// ⚠ THE PANE THE USER IS READING IS NOT SPARE CAPACITY (PR #301 review). `lastActivityAt`
// moves on a title or a busy transition, so a thread whose reply has finished ages exactly
// like an abandoned one — and is then the OLDEST idle thread, i.e. the first victim. Before
// the exemption this dropped the visible thread: its pane unmounted, `active` resolved to
// undefined, the header fell back to the untitled label and the content area went blank,
// with nothing said. A red line here means that is back.
test('⚠ the thread on screen is never evicted, even when it is the least recently active', async () => {
  const probe = followProbe()
  const read = mintThread(probe.fetch)
  mount(read)
  await probe.untilOpened(1)
  markThreadActive(read.threadId)
  // Every other thread is minted AFTER it and is therefore more recently active, which is
  // what makes the thread being read the candidate recency alone would pick.
  for (let index = 0; index < MAX_LIVE_THREADS; index += 1) {
    mount(mintThread(probe.fetch))
    await probe.untilOpened(index + 2)
  }
  expect(probe.releasedThreads()).not.toContain(read.threadId)
  expect(threadListStore.get().map((summary) => summary.threadId)).toContain(read.threadId)
  // …and switching away makes it evictable again: it is protected while visible, not pinned.
  const next = threadListStore.get()[0]?.threadId ?? ''
  markThreadActive(next)
  mount(mintThread(probe.fetch))
  await probe.untilOpened(MAX_LIVE_THREADS + 2)
  expect(probe.releasedThreads()).toContain(read.threadId)
})

test('a thread the page stops holding releases its follow', async () => {
  const probe = followProbe()
  const stores = mintThread(probe.fetch)
  mount(stores)
  await probe.untilOpened(1)
  expect(probe.live()).toBe(1)
  clearThreadsForTest()
  expect(probe.releasedThreads()).toEqual([stores.threadId])
  expect(probe.live()).toBe(0)
})
