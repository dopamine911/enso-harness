import { afterAll, expect, test } from 'bun:test'
import type { EnsoLogLine, EnsoLogTailFrame, EnsoThreadEvent, EnsoThreadEvents } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ensureDom, releaseDom } from '../../__tests__/dom-environment.ts'
import type { FetchLike } from '../../browser-logging.ts'
import { NO_LIVE_SESSION, ThreadTimelineScreen } from '../thread-timeline-screen.tsx'

// ⚠ Loaded by a DYNAMIC import, for the reason `log-tail-screen.test.tsx` gives: react-dom/client
// probes the DOM when its module evaluates, and a static import would see none.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The thread timeline (#144 slice 3), MOUNTED over a scripted server: the events route answers
 * with whatever the test has put there, and the log tail is an SSE body the test writes frames
 * into. Both are read as the page reads them — through its `fetch` seam.
 *
 * ⚠ happy-dom has NO LAYOUT, and the list is virtualized: the viewport is given on the
 * prototype before anything mounts, as the tail's test does.
 */
for (const [measurement, size] of [
  ['offsetHeight', 600],
  ['offsetWidth', 800],
] as const) {
  Object.defineProperty(window.HTMLElement.prototype, measurement, { configurable: true, get: () => size })
}

afterAll(releaseDom)

const THREAD_ID = 'thread-01ABCDEF'
const EVENTS_ROUTE = `/api/threads/${THREAD_ID}/events`

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 10)
  return promise
}

/** React's `act` with async work — typed so its Promise overload is the one seen. */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const EVENTUALLY_DEADLINE_MS = 2000

async function eventually<T>(probe: () => T): Promise<T> {
  const deadline = Date.now() + EVENTUALLY_DEADLINE_MS
  for (;;) {
    try {
      return probe()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await flush(tick)
    }
  }
}

const line = (stamp: string, message: string, properties?: Record<string, unknown>): EnsoLogLine => ({
  '@timestamp': stamp,
  level: 'INFO',
  logger: 'enso.server.thread',
  message,
  properties: { threadId: THREAD_ID, ...properties },
})

const event = (sequence: number, stamp: string, provenance: EnsoThreadEvent['provenance']): EnsoThreadEvent => ({
  sequence,
  type: `type_${sequence}`,
  provenance,
  at: stamp,
  count: 1,
})

/** How the events route answers: a status and a body, replaceable between requests. */
interface EventsAnswer {
  status: number
  body: unknown
}

interface MountedTimeline {
  readonly container: HTMLElement
  /** Every URL the page has asked for, in order. */
  readonly urls: string[]
  readonly eventsRequests: () => number
  readonly answer: EventsAnswer
  readonly send: (frame: EnsoLogTailFrame) => Promise<void>
  readonly unmount: () => Promise<void>
}

async function mountTimeline(answer: EventsAnswer): Promise<MountedTimeline> {
  const urls: string[] = []
  const encoder = new TextEncoder()
  let open: ReadableStreamDefaultController<Uint8Array> | undefined
  const scriptedFetch: FetchLike = (input: string) => {
    urls.push(input)
    if (input.startsWith(EVENTS_ROUTE)) {
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      return Promise.resolve(new Response(body, { status: answer.status }))
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        open = controller
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<ThreadTimelineScreen threadId={THREAD_ID} fetch={scriptedFetch} />)
  })
  await flush(tick)
  return {
    container,
    urls,
    answer,
    eventsRequests: () => urls.filter((url) => url.startsWith(EVENTS_ROUTE)).length,
    send: async (frame: EnsoLogTailFrame) => {
      await flush(async () => {
        open?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        await tick()
      })
    },
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

const backlogOf = (lines: EnsoLogLine[], matched = lines.length): EnsoLogTailFrame => ({
  type: 'backlog',
  day: '2026-09-22',
  offset: 4096,
  lines,
  matched,
  malformed: 0,
})

const rowTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[aria-label="thread timeline"] li')].map((row) => row.textContent ?? '')

const TAILS: EnsoThreadEvents = {
  threadId: THREAD_ID,
  emitted: [event(1, '2026-09-22T10:00:00.100Z', 'held'), event(2, '2026-09-22T10:00:00.400Z', 'dropped')],
  sent: [event(1, '2026-09-22T10:00:00.300Z', 'sent')],
}

// ⚠ THE JOIN IS `threadTimeline`'s, and the page shows its order: the two tails and the log
// interleaved by each record's own stamp, each row saying which of the three it came from.
test('⚠ both tails and the log render as one list in time order, each row tagged with its source', async () => {
  const page = await mountTimeline({ status: 200, body: TAILS })
  await page.send(
    backlogOf([
      line('2026-09-22T10:00:00.200Z', 'run {generation} acquired', { generation: 2, seq: 17 }),
      line('2026-09-22T10:00:00.500Z', 'tool {tool} ran', { tool: 'read', toolCallId: 'call_0123456789abcdef' }),
    ]),
  )
  const rows = await eventually(() => {
    const texts = rowTexts(page.container)
    expect(texts).toHaveLength(5)
    return texts
  })
  expect(rows[0]).toContain('host')
  expect(rows[0]).toContain('held')
  expect(rows[0]).toContain('type_1')
  expect(rows[1]).toContain('run 2 acquired')
  expect(rows[1]).toContain('gen 2 · seq 17')
  expect(rows[2]).toContain('wire')
  expect(rows[2]).toContain('type_1')
  expect(rows[3]).toContain('host')
  // A dropped event SAYS the word — the colour is only where the eye lands.
  expect(rows[3]).toContain('dropped')
  expect(rows[4]).toContain('tool read ran')
  expect(rows[4]).toContain('call_0123456…')
  expect(page.container.textContent).toContain(`thread ${THREAD_ID} · 5 rows · host 2 · wire 1 · log 2 records`)
  // The header's one link out of the observation surface, and the way back to the day.
  const anchors = [...page.container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href') ?? '')
  expect(anchors).toContain(`/?thread=${THREAD_ID}`)
  expect(anchors).toContain('/debug')
  // A log row's own thread id drills down, on this page.
  const rowAnchor = page.container.querySelector('[aria-label="thread timeline"] a')?.getAttribute('href') ?? ''
  expect(rowAnchor.startsWith('/debug')).toBe(true)
  expect(rowAnchor).toContain(`?thread=${THREAD_ID}`)
  await page.unmount()
})

// ⚠ A 404 IS NOT AN ERROR. A stored thread has no live session and so no tails; what remains
// is its log, and the page says so in its header rather than raising an alert over a correct list.
test('⚠ no live session: the header says so, and the timeline is the log alone', async () => {
  const page = await mountTimeline({ status: 404, body: 'no live session' })
  await page.send(backlogOf([line('2026-09-22T10:00:00.200Z', 'what remains')]))
  await eventually(() => {
    expect(page.container.textContent).toContain(NO_LIVE_SESSION)
    expect(rowTexts(page.container)).toHaveLength(1)
  })
  expect(page.container.textContent).toContain('what remains')
  expect(page.container.textContent).not.toContain('the tails')
  await page.unmount()
})

// A record landing is the signal that something happened: the tails are re-read once per
// frame that carries lines, and a frame that carries none re-reads nothing.
test('⚠ a records frame re-fetches the events route exactly once', async () => {
  const page = await mountTimeline({ status: 200, body: TAILS })
  await eventually(() => expect(page.eventsRequests()).toBe(1))
  await page.send(backlogOf([line('2026-09-22T10:00:00.200Z', 'the day so far')]))
  await eventually(() => expect(page.eventsRequests()).toBe(2))
  const before = page.eventsRequests()
  await page.send({ type: 'records', day: '2026-09-22', offset: 8192, lines: [], matched: 0, malformed: 0 })
  await flush(tick)
  expect(page.eventsRequests()).toBe(before)
  await page.send({
    type: 'records',
    day: '2026-09-22',
    offset: 8192,
    lines: [line('2026-09-22T10:00:00.600Z', 'landed while watching')],
    matched: 1,
    malformed: 0,
  })
  await eventually(() => expect(page.eventsRequests()).toBe(before + 1))
  await flush(tick)
  expect(page.eventsRequests()).toBe(before + 1)
  await eventually(() => expect(page.container.textContent).toContain('landed while watching'))
  await page.unmount()
})

test('the refresh control re-reads the tails; the level control re-opens the log from the head', async () => {
  const page = await mountTimeline({ status: 200, body: TAILS })
  await eventually(() => expect(page.eventsRequests()).toBe(1))
  const refresh = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')
  if (refresh === undefined) throw new Error('expected the refresh control')
  await flush(async () => {
    refresh.click()
    await tick()
  })
  await eventually(() => expect(page.eventsRequests()).toBe(2))

  const select = page.container.querySelector('select')
  if (select === null) throw new Error('expected the level control')
  await flush(async () => {
    select.value = 'trace'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
  })
  await eventually(() => {
    const tailUrls = page.urls.filter((url) => url.startsWith('/api/logs/tail'))
    expect(tailUrls[tailUrls.length - 1]).toBe(`/api/logs/tail?level=trace&thread=${THREAD_ID}`)
  })
  await page.unmount()
})

// Any failure OTHER than a 404 is said, verbatim: a debugging surface never drops what it
// could not read — and a payload that misses its schema is a failure, not an empty tail.
test('⚠ a failing events route is named in an alert, and so is a payload off its schema', async () => {
  const page = await mountTimeline({ status: 500, body: 'the host is gone' })
  await eventually(() => {
    expect(page.container.textContent).toContain('the tails')
    expect(page.container.textContent).toContain('500 the host is gone')
  })
  page.answer.status = 200
  page.answer.body = { threadId: THREAD_ID, emitted: 'not a list', sent: [] }
  await page.send(backlogOf([line('2026-09-22T10:00:00.200Z', 'a record')]))
  await eventually(() => expect(page.container.textContent).toContain('did not match its schema'))
  await page.unmount()
})

// ⚠ THE RULE A LOG VIEWER LIVES OR DIES BY, kept here: a reader who has scrolled up is reading.
test('⚠ scrolling up stops the view following the newest row, and returning resumes it', async () => {
  const page = await mountTimeline({ status: 200, body: TAILS })
  await page.send(backlogOf([line('2026-09-22T10:00:00.200Z', 'an older record')]))
  await eventually(() => expect(page.container.textContent).toContain('an older record'))
  const scroller = page.container.querySelector('[aria-label="thread timeline"]')
  if (scroller === null) throw new Error('expected the timeline list')
  let scrollTop = 0
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 2000 })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next
    },
  })
  await flush(async () => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    await tick()
  })
  await eventually(() => expect(page.container.textContent).toContain('scroll to the bottom to follow again'))
  scrollTop = 2000
  await flush(async () => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    await tick()
  })
  await eventually(() => expect(page.container.textContent).not.toContain('scroll to the bottom to follow again'))
  await page.unmount()
})
