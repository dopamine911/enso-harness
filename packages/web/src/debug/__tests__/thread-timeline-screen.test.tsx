import { afterAll, expect, spyOn, test } from 'bun:test'
import type { EnsoLogLine, EnsoLogTailFrame, EnsoThreadEvent, EnsoThreadEvents } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ensureDom, releaseDom } from '../../__tests__/dom-environment.ts'
import type { FetchLike } from '../../browser-logging.ts'
import { ROW_HEIGHT_PX } from '../log-row.tsx'
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

/** What a log connection is answered INSTEAD of a stream: a status and the route's words about it. */
interface ScriptedAnswer {
  readonly status: number
  readonly body: string
}

interface MountedTimeline {
  readonly container: HTMLElement
  /** Every URL the page has asked for, in order. */
  readonly urls: string[]
  readonly eventsRequests: () => number
  readonly answer: EventsAnswer
  readonly send: (frame: EnsoLogTailFrame) => Promise<void>
  /** Write anything at all into the open log connection — what the server would never send. */
  readonly sendRaw: (text: string) => Promise<void>
  /** Close the open log connection cleanly, the way a dropped socket does: the page reconnects. */
  readonly end: () => Promise<void>
  readonly unmount: () => Promise<void>
}

/**
 * Mount the page over a scripted server. The events route answers `answer`; the nth entry of
 * `logAnswers` is what the nth log connection gets instead of a stream — a refusal, in the
 * route's own words — and every log connection past that script is an open stream the test
 * writes frames into.
 */
async function mountTimeline(
  answer: EventsAnswer,
  logAnswers: readonly ScriptedAnswer[] = [],
): Promise<MountedTimeline> {
  const urls: string[] = []
  const encoder = new TextEncoder()
  let open: ReadableStreamDefaultController<Uint8Array> | undefined
  let logConnections = 0
  const scriptedFetch: FetchLike = (input: string) => {
    urls.push(input)
    if (input.startsWith(EVENTS_ROUTE)) {
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      return Promise.resolve(new Response(body, { status: answer.status }))
    }
    logConnections += 1
    const refusal = logAnswers[logConnections - 1]
    if (refusal !== undefined) return Promise.resolve(new Response(refusal.body, { status: refusal.status }))
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
    sendRaw: async (text: string) => {
      await flush(async () => {
        open?.enqueue(encoder.encode(text))
        await tick()
      })
    },
    end: async () => {
      await flush(async () => {
        open?.close()
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

/** The header's spinner — on while either the tails or the log is still being waited for. */
const spinner = (container: HTMLElement): Element | null => container.querySelector('[data-slot="spinner"]')

/** The alerts on the page, by title: `the tails` for the events route, `the tail` for the log. */
const alertTexts = (container: HTMLElement): Record<string, string> =>
  Object.fromEntries(
    [...container.querySelectorAll('[role="alert"]')].map((alert) => [
      alert.querySelector('[data-slot="alert-title"]')?.textContent ?? '',
      alert.querySelector('[data-slot="alert-description"]')?.textContent ?? '',
    ]),
  )

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
  // The hand-over (#144's last row): THIS thread's bundle, from the route that makes it.
  expect(anchors).toContain(`/api/logs/bundle?thread=${THREAD_ID}`)
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

// ⚠ A FAILED READ IS AN ANSWER. The events route said something went wrong; the tails are not
// pending any more, they are absent for now — so once the log has opened nothing is being
// waited for and the spinner stops (PR #336 review: it spun forever over the alert). And it is
// NOT "no live session": that sentence is the 404's, and the alert says what this was.
test('⚠ a failed events read stops the spinner once the log has opened, and is not called "no live session"', async () => {
  const page = await mountTimeline({ status: 500, body: 'the host is gone' })
  await page.send(backlogOf([line('2026-09-22T10:00:00.200Z', 'a record')]))
  await eventually(() => {
    expect(rowTexts(page.container)).toHaveLength(1)
    expect(alertTexts(page.container)).toEqual({ 'the tails': '500 the host is gone' })
    expect(spinner(page.container)).toBeNull()
  })
  expect(page.container.textContent).not.toContain(NO_LIVE_SESSION)
  expect(page.container.textContent).toContain(`thread ${THREAD_ID} · 1 rows · host 0 · wire 0 · log 1 records`)
  await page.unmount()
})

// ⚠ AN ALERT THAT OUTLIVES ITS CAUSE IS A LIE — and one that comes down too early is another.
// The recovery is the log CONNECTION coming up again, for the reason the tail page gives:
// clearing on every frame raced a bad frame and a good one in the same chunk into one render
// that showed no alert (PR #336 review, round two). The tails' own alert is a different
// question and is not touched.
test('⚠ the alert a bad log frame raised stays up through the same connection and comes down when a reconnect opens', async () => {
  const page = await mountTimeline({ status: 200, body: TAILS })
  const landed = backlogOf([line('2026-09-22T10:00:00.200Z', 'a record beside the bad frame')])
  // The race, in one chunk: the bad frame and the good one arrive together.
  await page.sendRaw(`data: {"type":"nope"}\n\ndata: ${JSON.stringify(landed)}\n\n`)
  await eventually(() => {
    expect(page.container.textContent).toContain('a record beside the bad frame')
    expect(alertTexts(page.container)['the tail']).toContain('fails EnsoLogTailFrame')
  })
  // A reconnect that OPENS is not yet the recovery (round three) — its first message is.
  await page.end()
  await eventually(() => {
    const tailUrls = page.urls.filter((url) => url.startsWith('/api/logs/tail'))
    expect(tailUrls[1]).toBe(`/api/logs/tail?thread=${THREAD_ID}&from=4096&day=2026-09-22`)
  })
  expect(alertTexts(page.container)['the tail']).toContain('fails EnsoLogTailFrame')
  await page.send({
    ...landed,
    type: 'records',
    offset: 4200,
    lines: [line('2026-09-22T10:00:00.300Z', 'the reconnect delivered')],
  })
  await eventually(() => {
    expect(page.container.textContent).toContain('the reconnect delivered')
    expect(alertTexts(page.container)).toEqual({})
  })
  expect(page.container.textContent).toContain('a record beside the bad frame')
  await page.unmount()
})

// ⚠ A REFUSED LOG IS AN ANSWER, ON THIS PAGE TOO (PR #336 review, round two): the round-one
// fix stopped the spinner but left the heading saying "waiting for the first frame" beside the
// alert that refused it — half of the tail page's fix, applied here. Once the tails have
// answered as well, nothing is being waited for, and the heading says what the log is.
test('⚠ a refused log connection stops the spinner once the tails have answered, and the heading says nothing is being read', async () => {
  const page = await mountTimeline({ status: 200, body: TAILS }, [
    { status: 400, body: 'thread must be a thread id or a prefix of one' },
  ])
  await eventually(() => {
    expect(alertTexts(page.container)).toEqual({
      'the tail': 'the log tail refused: 400 thread must be a thread id or a prefix of one',
    })
    expect(rowTexts(page.container)).toHaveLength(3)
    expect(spinner(page.container)).toBeNull()
    expect(page.container.textContent).toContain(
      `thread ${THREAD_ID} · 3 rows · host 2 · wire 1 · log nothing is being read`,
    )
  })
  expect(page.container.textContent).not.toContain('waiting for the first frame')
  expect(page.urls.filter((url) => url.startsWith('/api/logs/tail'))).toHaveLength(1)
  await page.unmount()
})

// ⚠ THE RULE A LOG VIEWER LIVES OR DIES BY, kept here: a reader who has scrolled up is reading.
// (PR #336 review: the test before this one read the header's words and never checked whether
// the list moved. The view follows through `scrollTo` on the scroll element —
// `@tanstack/virtual-core`'s `elementScroll` — so that call is what "moved" means here.)
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
  const follow = spyOn(scroller, 'scrollTo')
  await flush(async () => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    await tick()
  })
  await eventually(() => expect(page.container.textContent).toContain('scroll to the bottom to follow again'))

  // A record lands under a reader who has scrolled up: the list does NOT move.
  await page.send({
    type: 'records',
    day: '2026-09-22',
    offset: 8192,
    lines: [line('2026-09-22T10:00:00.900Z', 'landed while reading')],
    matched: 1,
    malformed: 0,
  })
  await eventually(() => expect(page.container.textContent).toContain('landed while reading'))
  await flush(tick)
  expect(follow).not.toHaveBeenCalled()
  expect(scrollTop).toBe(0)
  expect(page.container.textContent).toContain('scroll to the bottom to follow again')

  // Back at the bottom: the view follows the newest row again, and says so. "Follows" is a
  // `scrollTo` aimed at the NEWEST row's offset — not any call at all (PR #336 review, round
  // two: the assertion before this one passed on a `scrollTo` of 0, which is the top).
  const newestRowTop = ROW_HEIGHT_PX * (rowTexts(page.container).length - 1)
  expect(newestRowTop).toBeGreaterThan(0)
  scrollTop = 2000
  await flush(async () => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    await tick()
  })
  await eventually(() => {
    expect(page.container.textContent).not.toContain('scroll to the bottom to follow again')
    expect(follow).toHaveBeenCalledWith(expect.objectContaining({ top: newestRowTop }))
  })
  for (const [target] of follow.mock.calls) expect(target).toEqual(expect.objectContaining({ top: newestRowTop }))
  await page.unmount()
})
