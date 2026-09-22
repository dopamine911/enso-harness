import { afterEach, expect, test } from 'bun:test'
import { EnsoBrowserLogBatch, ensoLogger } from '@enso/core'
import { type LogRecord, reset } from '@logtape/logtape'
import { Check } from 'typebox/value'
import {
  configureBrowserLogging,
  createLogRing,
  createLogShipper,
  type FetchLike,
  pageLogLevel,
  SHIP_BATCH_SIZE,
} from '../browser-logging.ts'

/**
 * The page's logging (#132 slice 3): the ring the drawer reads, the shipper to the server,
 * and the `?log=` knob — driven through a real `configure`, asserted at the sinks.
 */

afterEach(reset)

interface Post {
  readonly url: string
  readonly body: unknown
  readonly keepalive: boolean | undefined
}

/** A `fetch` that records every POST and answers as told; `nextPost` is the signal a test awaits. */
function recordingFetch(answer: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 204 }))): {
  fetch: FetchLike
  posts: Post[]
  nextPost: () => Promise<Post>
} {
  const posts: Post[] = []
  let waiting: { promise: Promise<Post>; resolve: (post: Post) => void } | undefined
  return {
    posts,
    nextPost: () => {
      waiting ??= Promise.withResolvers<Post>()
      return waiting.promise
    },
    fetch: (url: string, init?: RequestInit) => {
      const post: Post = { url, body: JSON.parse(String(init?.body)), keepalive: init?.keepalive }
      posts.push(post)
      waiting?.resolve(post)
      waiting = undefined
      return answer()
    },
  }
}

test("the ring keeps the last N as lines, newest last, at the page's level; the shipper takes info and up regardless", async () => {
  const { fetch, posts } = recordingFetch()
  const { ring } = await configureBrowserLogging({ fetch, level: 'debug', page: 'p1' })
  const log = ensoLogger('browser', 'probe')
  log.debug('only the ring hears this', { threadId: 't1' })
  log.warn('both hear this: {what}', { threadId: 't1', what: 'a problem' })
  expect(ring.get().map((line) => [line.level, line.message, line.logger])).toEqual([
    ['DEBUG', 'only the ring hears this', 'enso.browser.probe'],
    ['WARN', 'both hear this: {what}', 'enso.browser.probe'],
  ])
  // A per-page count on every record, for order and for the drawer's key.
  expect(ring.get().map((line) => line.properties?.pageSequence)).toEqual([1, 2])
  // Nothing has shipped yet: one record, under the batch size, waits on the timer.
  expect(posts).toHaveLength(0)
})

// ⚠ THE DEBUG PAGE'S CONTRACT (#144). A surface that exists to read the trace must not enter
// it: shipped records come back through `POST /api/logs` into the very file that page is
// tailing. The page expresses that by configuring no `fetch` at all, so the claim worth
// pinning is that no shipper is built — not that some stub transport was handed a batch.
test('⚠ a page configured without a fetch builds no shipper and posts nothing, while the ring still sees everything', async () => {
  const logging = await configureBrowserLogging({ level: 'debug', page: 'observer' })
  expect(logging.shipper).toBeUndefined()
  const log = ensoLogger('browser', 'probe')
  log.error('an error the reader should still see in devtools', { threadId: 't1' })
  expect(logging.ring.get().map((line) => line.message)).toEqual(['an error the reader should still see in devtools'])
})

test('⚠ the shipper batches by count or by time, ships only info and up, sends a valid EnsoBrowserLogBatch, and never logs a failure', async () => {
  const { fetch, posts, nextPost } = recordingFetch(() => Promise.reject(new Error('server down')))
  const shipper = createLogShipper({ fetch, page: 'p2', flushMs: 1 })
  const at = Date.now()
  const record = (level: 'debug' | 'info' | 'warning', message: string): LogRecord => ({
    category: ['enso', 'browser', 'follow'],
    level,
    timestamp: at,
    message: [message],
    rawMessage: message,
    properties: { threadId: 't1' },
  })
  shipper.sink(record('debug', 'not shipped'))
  shipper.sink(record('info', 'shipped'))
  expect(posts).toHaveLength(0)
  // The timer's flush: awaited as the POST it produces, not as a duration.
  await nextPost()
  expect(posts).toHaveLength(1)
  expect(Check(EnsoBrowserLogBatch, posts[0]?.body)).toBe(true)
  expect(posts[0]?.body).toMatchObject({
    page: 'p2',
    records: [{ level: 'info', logger: 'enso.browser.follow', message: 'shipped', properties: { threadId: 't1' } }],
  })
  // By count: a full batch goes at once, without the timer.
  for (let index = 0; index < SHIP_BATCH_SIZE; index += 1) shipper.sink(record('warning', `w${index}`))
  expect(posts).toHaveLength(2)
  const second = posts[1]?.body as EnsoBrowserLogBatch | undefined
  expect(second?.records).toHaveLength(SHIP_BATCH_SIZE)
  // The rejected POSTs above were swallowed — the test is still running, nothing threw.
  // A hide-time flush is `keepalive`, so the browser lets it finish after the page goes.
  shipper.sink(record('info', 'last words'))
  shipper.flush(true)
  expect(posts[2]?.keepalive).toBe(true)
})

test('the ring is bounded', () => {
  const ring = createLogRing(3)
  for (let index = 0; index < 5; index += 1) {
    ring.sink({
      category: ['enso'],
      level: 'info',
      timestamp: 0,
      message: [`m${index}`],
      rawMessage: `m${index}`,
      properties: {},
    })
  }
  expect(ring.get().map((line) => line.message)).toEqual(['m2', 'm3', 'm4'])
})

test("?log= is the page's knob: a level, warn for warning, anything else is info", () => {
  expect(pageLogLevel('')).toBe('info')
  expect(pageLogLevel('?debug')).toBe('info')
  expect(pageLogLevel('?debug&log=trace')).toBe('trace')
  expect(pageLogLevel('?log=warn')).toBe('warning')
  expect(pageLogLevel('?log=loud')).toBe('info')
})
