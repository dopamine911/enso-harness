import { afterAll, expect, test } from 'bun:test'
import type { EnsoLogLine, EnsoLogTailFrame } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ensureDom, releaseDom } from '../../__tests__/dom-environment.ts'
import type { FetchLike } from '../../browser-logging.ts'
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

async function mountTail(): Promise<MountedTail> {
  const urls: string[] = []
  const encoder = new TextEncoder()
  let open: ReadableStreamDefaultController<Uint8Array> | undefined
  const fetchTail: FetchLike = (input: string) => {
    urls.push(input)
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

test('the backlog is the view, and a records frame is appended to it', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('the day so far'), line('and then this')]))
  await eventually(() => {
    expect(page.container.textContent).toContain('the day so far')
    expect(page.container.textContent).toContain('and then this')
    expect(page.container.textContent).toContain('2026-09-22 · 2 records')
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

// #142, and #144 slice 3: a thread id on this page is a way into the thread it names — its
// TIMELINE on this same page, not the chat page. Within the observation surface an id drills
// down; leaving the surface is the timeline header's one deliberate link.
test('⚠ a record’s thread id is a link to that thread’s timeline on this page', async () => {
  const page = await mountTail()
  const properties = { threadId: 'thread-01ABCDEF', generation: 4, process: 'server', attempt: { tries: 2 } }
  await page.send(backlogOf([line('run {generation} acquired', properties)]))
  const link = await eventually(() => {
    const found = page.container.querySelector('a')
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
  await eventually(() => expect(page.urls[1]).toBe('/api/logs/tail?from=4096'))
  await page.unmount()
})

// ⚠ THE RULE A LOG VIEWER LIVES OR DIES BY: a reader who has scrolled up is reading, and the
// next record must not yank them back to the bottom. The view follows the newest row only
// while it is still at the bottom, and says so when it has stopped.
test('⚠ scrolling up stops the view following the newest record, and returning resumes it', async () => {
  const page = await mountTail()
  await page.send(backlogOf([line('an older record'), line('the newest record')]))
  await eventually(() => expect(page.container.textContent).toContain('the newest record'))
  const scroller = page.container.querySelector('[aria-label="log records"]')
  if (scroller === null) throw new Error('expected the record list')
  // happy-dom has no layout, so the scroll geometry IS the fixture: a tall list, scrolled to
  // the top, is a reader who has scrolled away from the newest row. `scrollTop` keeps a
  // setter — the virtualizer writes it through `scrollTo` when the view follows again.
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
