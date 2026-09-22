import { afterAll, expect, spyOn, test } from 'bun:test'
import { type EnsoLogLine, type EnsoLogTailFrame, LOG_TAIL_MAX_RECORDS } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ensureDom, releaseDom } from '../../__tests__/dom-environment.ts'
import type { FetchLike } from '../../browser-logging.ts'
import { ROW_HEIGHT_PX } from '../log-row.tsx'
import { LogTailScreen } from '../log-tail-screen.tsx'

// ⚠ Loaded by a DYNAMIC import, and that is the one place this repo needs one: react-dom/client
// probes the DOM when its module evaluates (`"oninput" in document`), and bun evaluates
// node_modules imports before a local side-effect import can register happy-dom — statically
// imported it sits in an IE-era polyfill mode where `onChange` never fires. `thread-pane.test.tsx`
// carries the full measurement (#118).
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The log page (#144 slice 2), MOUNTED over a scripted tail: frames the test writes into a
 * live SSE body, read as the page reads them.
 *
 * ⚠ happy-dom has NO LAYOUT, and the list is virtualized: `@tanstack/react-virtual` draws
 * nothing at all when the scroll element measures zero (`calculateRange` returns no range for
 * `outerSize === 0`). So the two offset readings it takes — `offsetHeight`/`offsetWidth` — are
 * given a viewport on the prototype before anything mounts. This is the test environment
 * standing in for a browser's layout, not a shim around the component.
 */
for (const [name, size] of [
  ['offsetHeight', 600],
  ['offsetWidth', 900],
] as const) {
  Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => size })
}

afterAll(releaseDom)

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 10)
  return promise
}

/** React's `act` with async work — typed so its Promise overload is the one seen (`thread-pane.test.tsx`'s note). */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

/** How long `eventually` keeps trying before a failing probe is a failure — a real failure's report time, never a pass's. */
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

const line = (message: string, properties?: Record<string, unknown>): EnsoLogLine => ({
  '@timestamp': '2026-09-22T10:11:12.345Z',
  level: 'INFO',
  logger: 'enso.server.thread',
  message,
  ...(properties === undefined ? {} : { properties }),
})

/** What a connection is answered INSTEAD of a stream: a status and the route's words about it. */
interface ScriptedAnswer {
  readonly status: number
  readonly body: string
}

interface MountedTail {
  readonly container: HTMLElement
  /** Every URL the page has asked for, in order. */
  readonly urls: string[]
  /** Write a frame into the connection that is currently open, and let React render it. */
  readonly send: (frame: EnsoLogTailFrame) => Promise<void>
  /** Write anything at all into the open connection — what the server would never send. */
  readonly sendRaw: (text: string) => Promise<void>
  readonly unmount: () => Promise<void>
}

/**
 * Mount the page over a scripted tail. The nth entry of `answers` is what the nth connection
 * gets instead of a stream — a refusal, in the route's own words — and every connection past
 * the script is an open stream the test writes frames into.
 */
async function mountTail(answers: readonly ScriptedAnswer[] = []): Promise<MountedTail> {
  const urls: string[] = []
  const encoder = new TextEncoder()
  let open: ReadableStreamDefaultController<Uint8Array> | undefined
  const fetchTail: FetchLike = (input: string) => {
    urls.push(input)
    const answer = answers[urls.length - 1]
    if (answer !== undefined) return Promise.resolve(new Response(answer.body, { status: answer.status }))
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
    root.render(<LogTailScreen fetch={fetchTail} />)
  })
  await flush(tick)
  return {
    container,
    urls,
    send: async (frame: EnsoLogTailFrame) => {
      await flush(async () => {
        open?.enqueue(encoder.encode(`: keepalive\n\ndata: ${JSON.stringify(frame)}\n\n`))
        await tick()
      })
    },
    sendRaw: async (text: string) => {
      await flush(async () => {
        open?.enqueue(encoder.encode(text))
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

/** The header's spinner — on while the page is waiting for a first frame, and only then. */
const spinner = (container: HTMLElement): Element | null => container.querySelector('[data-slot="spinner"]')

/** The one destructive alert this page raises, or null when nothing is wrong. */
const alertText = (container: HTMLElement): string | null =>
  container.querySelector('[role="alert"] [data-slot="alert-description"]')?.textContent ?? null

/** The virtualized list's own height: rows times the row height, so it is the row COUNT made visible. */
const listHeight = (container: HTMLElement): string =>
  container.querySelector<HTMLElement>('[aria-label="log records"] ol')?.style.height ?? ''

test('the backlog is the view, and a records frame is appended to it', async () => {
  const page = await mountTail()
  // Nothing has arrived: the page is waiting, and says so in the header's spinner.
  expect(spinner(page.container)).not.toBeNull()
  await page.send(backlogOf([line('the day so far'), line('and then this')]))
  await eventually(() => {
    expect(page.container.textContent).toContain('the day so far')
    expect(page.container.textContent).toContain('and then this')
    expect(page.container.textContent).toContain('2026-09-22 · 2 records')
    expect(spinner(page.container)).toBeNull()
  })
  await page.send({
    type: 'records',
    day: '2026-09-22',
    offset: 8192,
    lines: [line('landed while watching')],
    matched: 1,
    malformed: 0,
  })
  await eventually(() => {
    expect(page.container.textContent).toContain('landed while watching')
    expect(page.container.textContent).toContain('the day so far')
    expect(page.container.textContent).toContain('3 records')
  })
  await page.unmount()
})

// ⚠ THE CAP HONESTY. A count that silently means "some of" is the one lie a debugging
// surface cannot tell: the server capped the read, so the page says which end it has.
test('⚠ a capped read reads as the last N of M records, and malformed lines are counted', async () => {
  const page = await mountTail()
  await page.send({ ...backlogOf([line('one'), line('another')], 9), malformed: 3 })
  await eventually(() => {
    expect(page.container.textContent).toContain('the last 2 of 9 records')
    expect(page.container.textContent).toContain('3 malformed lines')
  })
  await page.unmount()
})

// ⚠ BOUNDED. The server caps what it sends in ONE frame; a page that appended every `records`
// frame forever grew without limit on a `trace` day left open (PR #336 review). The view keeps
// the last cap's worth of rows, the oldest leaving as new ones land, and `matched` keeps
// counting so the heading still says how much of the day this is.
test('⚠ the view holds at most the cap; older rows leave as new ones land, and the count keeps counting', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('the day so far'), line('and then this'), line('and this')]))
  await eventually(() => expect(page.container.textContent).toContain('3 records'))
  const landed = Array.from({ length: LOG_TAIL_MAX_RECORDS + 1 }, (_unused, ordinal) => line(`record ${ordinal}`))
  await page.send({
    type: 'records',
    day: '2026-09-22',
    offset: 8192,
    lines: landed,
    matched: landed.length,
    malformed: 0,
  })
  await eventually(() => {
    expect(page.container.textContent).toContain(`the last ${LOG_TAIL_MAX_RECORDS} of ${3 + landed.length} records`)
    expect(listHeight(page.container)).toBe(`${LOG_TAIL_MAX_RECORDS * ROW_HEIGHT_PX}px`)
  })
  // Four rows past the cap: the three backlog rows and the first landed one are the ones gone.
  const firstRow = page.container.querySelector('[aria-label="log records"] li')
  expect(firstRow?.textContent).toContain('record 1')
  expect(page.container.textContent).not.toContain('the day so far')
  expect(page.container.textContent).not.toContain('record 0')
  await page.unmount()
})

// #142, and #144 slice 3: a thread id on this page is a way into the thread it names — its
// TIMELINE on this same page, not the chat page. Within the observation surface an id drills
// down; leaving the surface is the timeline header's one deliberate link.
test('⚠ a record’s thread id is a link to that thread’s timeline on this page', async () => {
  const page = await mountTail()
  const properties = { threadId: 'thread-01ABCDEF', generation: 4, process: 'server', attempt: { tries: 2 } }
  await page.send(backlogOf([line('run {generation} acquired', properties)]))
  const link = await eventually(() => {
    const found = page.container.querySelector('[aria-label="log records"] a')
    if (found === null) throw new Error('expected the thread id to be a link')
    return found
  })
  const href = link.getAttribute('href') ?? ''
  expect(href.startsWith('/debug')).toBe(true)
  expect(href).toContain('?thread=thread-01ABCDEF')
  // The template's own placeholder is rendered with its value in place and is NOT repeated in
  // the tail; a property the message never named is, JSON and all.
  expect(page.container.textContent).toContain('run 4 acquired')
  expect(page.container.textContent).toContain('process=server attempt={"tries":2}')
  expect(page.container.textContent).not.toContain('generation=4')
  await page.unmount()
})

// A page that exists to show what the system wrote may not quietly discard part of it: the
// frame it could not read is on screen, beside the records it could.
test('⚠ a frame the page cannot read is named on the page, and the records already there stay', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('the day so far')]))
  await eventually(() => expect(page.container.textContent).toContain('the day so far'))
  await page.sendRaw('data: {"type":"nope"}\n\n')
  await eventually(() => {
    expect(page.container.textContent).toContain('fails EnsoLogTailFrame')
    expect(page.container.textContent).toContain('the day so far')
  })
  await page.unmount()
})

// ⚠ AN ALERT THAT OUTLIVES ITS CAUSE IS A LIE: the frame that arrives after a failure is the
// connection working again, and the alert that named the failure comes down with it
// (PR #336 review: it stayed up beside a tail that had long since recovered).
test('⚠ the alert a bad frame raised comes down when the next frame lands', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('the day so far')]))
  await eventually(() => expect(page.container.textContent).toContain('the day so far'))
  await page.sendRaw('data: not json at all\n\n')
  await eventually(() => expect(alertText(page.container)).toContain('is not JSON'))
  await page.send({
    type: 'records',
    day: '2026-09-22',
    offset: 8192,
    lines: [line('landed after the bad frame')],
    matched: 1,
    malformed: 0,
  })
  await eventually(() => {
    expect(page.container.textContent).toContain('landed after the bad frame')
    expect(alertText(page.container)).toBeNull()
  })
  await page.unmount()
})

// The filter IS the question: a new one re-opens the stream from the day's head, and the
// answer to the old question does not stay on screen underneath the new one.
test('⚠ changing the level asks a new question — a new connection, from the head', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('an info record')]))
  await eventually(() => expect(page.container.textContent).toContain('an info record'))
  expect(page.urls).toEqual(['/api/logs/tail'])

  const select = page.container.querySelector('select')
  if (select === null) throw new Error('expected the level control')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('HTMLSelectElement.prototype.value has no setter')
  await flush(async () => {
    setter.call(select, 'trace')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
  })
  await eventually(() => {
    expect(page.urls[1]).toBe('/api/logs/tail?level=trace')
    expect(page.container.textContent).not.toContain('an info record')
    expect(page.container.textContent).toContain('waiting for the first frame')
  })
  await page.unmount()
})

// ⚠ A REFUSAL IS AN ANSWER. The route said the question cannot be asked and the client will
// not ask it again, so nothing is being waited for: the spinner stops and the header says why
// (PR #336 review: it spun forever beside the alert that refused it). A NEW question is a new
// wait — the spinner comes back for it.
test('⚠ a refused question stops the spinner and says nothing is being read; a new question is waited for again', async () => {
  const page = await mountTail([{ status: 400, body: 'since wants a duration like 30s, 10m, 2h, 1d' }])
  await eventually(() => {
    expect(alertText(page.container)).toBe('the log tail refused: 400 since wants a duration like 30s, 10m, 2h, 1d')
    expect(page.container.textContent).toContain('nothing is being read — the question was refused')
    expect(spinner(page.container)).toBeNull()
  })
  expect(page.container.textContent).not.toContain('waiting for the first frame')
  expect(page.urls).toEqual(['/api/logs/tail'])

  const select = page.container.querySelector('select')
  if (select === null) throw new Error('expected the level control')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('HTMLSelectElement.prototype.value has no setter')
  await flush(async () => {
    setter.call(select, 'trace')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
  })
  await eventually(() => {
    expect(page.urls[1]).toBe('/api/logs/tail?level=trace')
    expect(page.container.textContent).toContain('waiting for the first frame')
    expect(spinner(page.container)).not.toBeNull()
    expect(alertText(page.container)).toBeNull()
  })
  await page.unmount()
})

test('the pause control stops the connection, and following again resumes from the last byte', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('before the pause')]))
  await eventually(() => expect(page.container.textContent).toContain('before the pause'))
  const pause = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'pause')
  if (pause === undefined) throw new Error('expected the pause control')
  await flush(async () => {
    pause.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  const follow = await eventually(() => {
    const found = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'follow')
    if (found === undefined) throw new Error('expected the follow control')
    return found
  })
  // Paused holds what it had — an observation surface does not throw away what you were reading.
  expect(page.container.textContent).toContain('before the pause')
  await flush(async () => {
    follow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await eventually(() => expect(page.urls[1]).toBe('/api/logs/tail?from=4096&day=2026-09-22'))
  await page.unmount()
})

// ⚠ THE RULE A LOG VIEWER LIVES OR DIES BY: a reader who has scrolled up is reading, and the
// next record must not yank them back to the bottom. The view follows the newest row only
// while it is still at the bottom, and says so when it has stopped. (PR #336 review: the
// test before this one read the header's words and never once checked whether the list moved.)
test('⚠ scrolling up stops the view following the newest record, and returning resumes it', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('an older record'), line('the newest record')]))
  await eventually(() => expect(page.container.textContent).toContain('the newest record'))
  const scroller = page.container.querySelector('[aria-label="log records"]')
  if (scroller === null) throw new Error('expected the record list')
  // happy-dom has no layout, so the scroll geometry IS the fixture: a tall list, scrolled to
  // the top, is a reader who has scrolled away from the newest row. The view follows through
  // `scrollTo` on this element (`@tanstack/virtual-core`'s `elementScroll`), which writes
  // `scrollTop` — so that call is what "the list moved" means here, and `scrollTop` keeps a
  // setter for it to write.
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
    lines: [line('landed while reading')],
    matched: 1,
    malformed: 0,
  })
  await eventually(() => expect(page.container.textContent).toContain('landed while reading'))
  await flush(tick)
  expect(follow).not.toHaveBeenCalled()
  expect(scrollTop).toBe(0)
  expect(page.container.textContent).toContain('scroll to the bottom to follow again')

  // Back at the bottom: the view follows the newest row again, and says so.
  scrollTop = 2000
  await flush(async () => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    await tick()
  })
  await eventually(() => {
    expect(page.container.textContent).not.toContain('scroll to the bottom to follow again')
    expect(follow).toHaveBeenCalled()
  })
  await page.unmount()
})
