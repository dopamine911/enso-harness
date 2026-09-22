import { expect, test } from 'bun:test'
import type { EnsoLogLine, EnsoLogTailFrame } from '@enso/core'
import type { FetchLike } from '../../browser-logging.ts'
import { DEFAULT_LOG_TAIL_FILTER, logTailUrl, openLogTailStream } from '../log-tail-connection.ts'

/**
 * The log tail client (#144 slice 2), driven over a scripted body: SSE text the test writes,
 * read as the page reads it. Everything asserted here is a promise the route makes — the
 * keepalive comment, the frame that arrives in two pieces, the byte a reconnect resumes from —
 * and a client that breaks one of them shows a reader a log that is not the file.
 */

const line = (message: string): EnsoLogLine => ({
  '@timestamp': '2026-09-22T10:00:00.000Z',
  level: 'INFO',
  logger: 'enso.server',
  message,
})

const frameText = (frame: EnsoLogTailFrame): string => `data: ${JSON.stringify(frame)}\n\n`

const backlog: EnsoLogTailFrame = {
  type: 'backlog',
  day: '2026-09-22',
  offset: 4096,
  lines: [line('the day so far')],
  matched: 1,
  malformed: 0,
}

const records: EnsoLogTailFrame = {
  type: 'records',
  day: '2026-09-22',
  offset: 8192,
  lines: [line('and this landed')],
  matched: 1,
  malformed: 0,
}

function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

interface Run {
  readonly urls: string[]
  readonly frames: EnsoLogTailFrame[]
  readonly problems: string[]
}

/**
 * Drive the client over `connections`: the nth connection is served the nth list of chunks,
 * and the run ends when the client asks for one more than the script has — which is how a
 * reconnect is observed without waiting on a real backoff twice.
 */
async function run(connections: ReadonlyArray<readonly string[]>): Promise<Run> {
  const urls: string[] = []
  const frames: EnsoLogTailFrame[] = []
  const problems: string[] = []
  const controller = new AbortController()
  const fetchTail: FetchLike = (input: string) => {
    urls.push(input)
    const chunks = connections[urls.length - 1]
    if (chunks === undefined) {
      controller.abort()
      return Promise.resolve(new Response(bodyOf([]), { status: 200 }))
    }
    return Promise.resolve(new Response(bodyOf(chunks), { status: 200 }))
  }
  await openLogTailStream({
    filter: DEFAULT_LOG_TAIL_FILTER,
    fetch: fetchTail,
    signal: controller.signal,
    onFrame: (frame: EnsoLogTailFrame) => frames.push(frame),
    onError: (problem: string) => problems.push(problem),
  })
  return { urls, frames, problems }
}

test('the unasked question is the bare route; every parameter away from its default is in the URL', () => {
  expect(logTailUrl(DEFAULT_LOG_TAIL_FILTER)).toBe('/api/logs/tail')
  expect(logTailUrl({ level: 'trace', thread: 'abc', process: 'pi', since: '10m' })).toBe(
    '/api/logs/tail?level=trace&thread=abc&process=pi&since=10m',
  )
})

// A resume is a byte IN A FILE, and the file is the day's: `from` without `day` is a position
// in whichever file the route happens to hold, so a tail that resumed across local midnight
// skipped the head of the new day (PR #336 review). Both travel, or neither.
test('⚠ a resume carries the byte AND the day it is a position in; no resume carries neither', () => {
  expect(logTailUrl(DEFAULT_LOG_TAIL_FILTER, { day: '2026-09-22', offset: 512 })).toBe(
    '/api/logs/tail?from=512&day=2026-09-22',
  )
  const bare = new URL(logTailUrl(DEFAULT_LOG_TAIL_FILTER), 'http://enso.test')
  expect(bare.searchParams.has('from')).toBe(false)
  expect(bare.searchParams.has('day')).toBe(false)
})

test('a backlog frame and a records frame both arrive; a keepalive comment is not a frame', async () => {
  const { frames, problems } = await run([
    [`: keepalive\n\n${frameText(backlog)}`, `: keepalive\n\n${frameText(records)}`],
  ])
  expect(frames.map((frame) => frame.type)).toEqual(['backlog', 'records'])
  expect(frames[0]?.lines[0]?.message).toBe('the day so far')
  expect(frames[1]?.lines[0]?.message).toBe('and this landed')
  expect(problems).toEqual([])
})

// The wire arrives in network chunks, not in frames: a split anywhere — including mid-JSON —
// must still be one frame, or a busy day reads as a stream of parse failures.
test('⚠ a frame split across two chunks is one frame', async () => {
  const whole = frameText(backlog)
  const { frames, problems } = await run([[whole.slice(0, 30), whole.slice(30)]])
  expect(frames).toHaveLength(1)
  expect(frames[0]?.offset).toBe(4096)
  expect(problems).toEqual([])
})

// A surface that exists to show what the system wrote may not quietly drop part of it.
test('⚠ an unreadable frame is reported, not delivered', async () => {
  const { frames, problems } = await run([['data: {"type":"nope"}\n\n', 'data: not json at all\n\n']])
  expect(frames).toEqual([])
  expect(problems[0]).toContain('fails EnsoLogTailFrame')
  expect(problems[1]).toContain('is not JSON')
})

// The reconnect is what keeps a dropped connection from re-rendering the day underneath a
// reader who was halfway down it — and the byte it resumes from is only meaningful in the
// day's file it came from, so the retry names that day too (PR #336 review).
test('⚠ after the stream ends the client resumes from the last byte it was given, in the day it was given for', async () => {
  const { urls } = await run([[frameText(backlog), frameText({ ...records, day: '2026-09-23', offset: 64 })]])
  expect(urls[0]).toBe('/api/logs/tail')
  expect(urls[1]).toBe('/api/logs/tail?from=64&day=2026-09-23')
})

test('a refused question is reported and NOT asked again; a server error is', async () => {
  const urls: string[] = []
  const problems: string[] = []
  const controller = new AbortController()
  const fetchTail: FetchLike = (input: string) => {
    urls.push(input)
    if (urls.length > 1) controller.abort()
    return Promise.resolve(new Response('since wants a duration like 30s, 10m, 2h, 1d', { status: 400 }))
  }
  await openLogTailStream({
    filter: { ...DEFAULT_LOG_TAIL_FILTER, since: 'soon' },
    fetch: fetchTail,
    signal: controller.signal,
    onFrame: () => undefined,
    onError: (problem: string) => problems.push(problem),
  })
  expect(urls).toEqual(['/api/logs/tail?since=soon'])
  expect(problems[0]).toBe('the log tail refused: 400 since wants a duration like 30s, 10m, 2h, 1d')
})

test('a server error is asked again, from the head, because nothing said otherwise', async () => {
  const urls: string[] = []
  const problems: string[] = []
  const controller = new AbortController()
  const fetchTail: FetchLike = (input: string) => {
    urls.push(input)
    if (urls.length > 1) controller.abort()
    return Promise.resolve(new Response('the log is not readable', { status: 503 }))
  }
  await openLogTailStream({
    filter: DEFAULT_LOG_TAIL_FILTER,
    fetch: fetchTail,
    signal: controller.signal,
    onFrame: () => undefined,
    onError: (problem: string) => problems.push(problem),
  })
  expect(urls).toEqual(['/api/logs/tail', '/api/logs/tail'])
  expect(problems[0]).toContain('503')
})

test('a fetch that throws is reported, not swallowed', async () => {
  const problems: string[] = []
  const controller = new AbortController()
  let calls = 0
  const fetchTail: FetchLike = () => {
    calls += 1
    if (calls > 1) controller.abort()
    return Promise.reject(new Error('the network is gone'))
  }
  await openLogTailStream({
    filter: DEFAULT_LOG_TAIL_FILTER,
    fetch: fetchTail,
    signal: controller.signal,
    onFrame: () => undefined,
    onError: (problem: string) => problems.push(problem),
  })
  expect(problems[0]).toContain('the network is gone')
})

test('an answer with no body is reported rather than read as an empty day', async () => {
  const problems: string[] = []
  const controller = new AbortController()
  let calls = 0
  const fetchTail: FetchLike = () => {
    calls += 1
    if (calls > 1) controller.abort()
    return Promise.resolve(new Response(null, { status: 200 }))
  }
  await openLogTailStream({
    filter: DEFAULT_LOG_TAIL_FILTER,
    fetch: fetchTail,
    signal: controller.signal,
    onFrame: () => undefined,
    onError: (problem: string) => problems.push(problem),
  })
  expect(problems[0]).toBe('the log tail answered with no body')
})

// The page's leaving has to reach a client that is WAITING to reconnect, or a closed tab
// keeps a timer and then asks the log route a question nobody is reading the answer to.
//
// ⚠ A REAL TIMER, deliberately: the thing under test IS the cancellation of a real backoff
// timer, so a fake clock would only prove that a fake clock advances. The margin is the whole
// point of the reading — the abort is armed at 5 ms against a 250 ms first step, and the
// assertion leaves 215 ms of slack, so only a client that ignores the abort can fail it.
test('⚠ leaving during the reconnect backoff ends the loop without asking again', async () => {
  const urls: string[] = []
  const controller = new AbortController()
  const fetchTail: FetchLike = (input: string) => {
    urls.push(input)
    setTimeout(() => controller.abort(), 5)
    return Promise.resolve(new Response(bodyOf([]), { status: 200 }))
  }
  const started = Date.now()
  await openLogTailStream({
    filter: DEFAULT_LOG_TAIL_FILTER,
    fetch: fetchTail,
    signal: controller.signal,
    onFrame: () => undefined,
    onError: () => undefined,
  })
  expect(urls).toHaveLength(1)
  expect(Date.now() - started).toBeLessThan(220)
})
