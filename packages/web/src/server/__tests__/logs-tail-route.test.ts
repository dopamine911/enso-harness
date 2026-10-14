import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_LOG_EVENTS, EnsoDayStats, type EnsoLogLine, EnsoLogTailFrame } from '@enso/core'
import { ensoLogFilename } from '@enso/core/log-process'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/test-support/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import { Check } from 'typebox/value'
import { startEnsoServer } from '../index.ts'
import { type LogTailQuery, parseLogTailQuery } from '../logs-tail-route.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * `GET /api/logs/tail` (#144 slice 2), over real HTTP: the day's file, filtered server-side,
 * as frames the browser's schema takes — and NO record of its own, which is the rule the
 * whole debug surface rests on (#144, #97).
 *
 * The route reads a directory, not a registry, so every test writes the file itself and the
 * host is the barest fake the server will start with.
 */

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordEnsoLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseEnsoLogs)

const THREAD = '6923e620-856a-4f1e-9d33-000000000001'
const OTHER_THREAD = 'aaaaaaaa-0000-4000-8000-000000000002'

function line(overrides: Partial<EnsoLogLine> = {}): EnsoLogLine {
  return {
    '@timestamp': new Date().toISOString(),
    level: 'INFO',
    message: 'run {generation} acquired',
    logger: 'enso.server.threads',
    properties: { generation: 1, threadId: THREAD, process: 'server' },
    ...overrides,
  }
}

function append(logsDir: string, ...records: EnsoLogLine[]): void {
  writeFileSync(
    join(logsDir, ensoLogFilename(new Date())),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { flag: 'a' },
  )
}

/** A harness dir with an empty pi manifest — enough for `assertVendorLinks` to pass. */
function emptyHarnessDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-tail-harness-'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fake-harness', pi: {} }))
  return directory
}

const openServers: Array<{ close: () => Promise<void> }> = []
const openTails: AbortController[] = []
afterEach(async () => {
  for (const tail of openTails.splice(0)) tail.abort()
  for (const started of openServers.splice(0)) await started.close()
})

async function startOverLogs(): Promise<{ url: string; logsDir: string }> {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-tail-logs-'))
  const started = startEnsoServer({
    cwd: tmpdir(),
    harnessPackageDir: emptyHarnessDir(),
    agentDir: mkdtempSync(join(tmpdir(), 'enso-tail-agent-')),
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir,
    port: 0,
    host: () => createFakeAgentHost(() => Promise.resolve(createFakeHostedThread().hosted)),
  })
  openServers.push(started)
  return { url: await started.listening, logsDir }
}

/**
 * A tail as a test reads it: frames awaited by count, each checked against the schema the
 * browser compiles, so a shape the page could not read fails the test that produced it.
 */
interface OpenTail {
  readonly frames: EnsoLogTailFrame[]
  /** Resolves once at least `count` frames have arrived; rejects once the wire has failed. */
  readonly untilFrames: (count: number) => Promise<void>
  /** The first fault this tail saw, or `undefined` while the wire has been readable. */
  readonly failure: () => Error | undefined
  readonly close: () => void
}

/**
 * Each `data:` line's frame the browser's schema takes goes into `frames`; each one it refuses
 * goes to `refuse` as it is read, so a later line that does not parse cannot hide it.
 */
function acceptFrames(lines: readonly string[], frames: EnsoLogTailFrame[], refuse: (refused: Error) => void): void {
  for (const raw of lines) {
    if (!raw.startsWith('data: ')) continue
    const frame: unknown = JSON.parse(raw.slice('data: '.length))
    if (Check(EnsoLogTailFrame, frame)) frames.push(frame)
    else refuse(new Error(`a frame the browser's schema refuses: ${raw}`))
  }
}

async function openTail(url: string, query = ''): Promise<OpenTail> {
  const controller = new AbortController()
  openTails.push(controller)
  const response = await fetch(`${url}/api/logs/tail${query}`, { signal: controller.signal })
  if (response.status !== 200) throw new Error(`tail: ${response.status} ${await response.text()}`)
  const frames: EnsoLogTailFrame[] = []
  let failure: Error | undefined
  const waiters: Array<() => void> = []
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('no body')
  void (async () => {
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        acceptFrames(lines, frames, (refused) => {
          failure ??= refused
        })
        for (const waiter of waiters.splice(0)) waiter()
      }
    } catch {
      // The test closed the tail, or the server went away with it. Either way the awaited
      // count below is what reports the failure.
    }
    for (const waiter of waiters.splice(0)) waiter()
  })()
  const untilFrames = (count: number): Promise<void> => {
    if (failure !== undefined) return Promise.reject(failure)
    if (frames.length >= count) return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const check = (): void => {
      if (failure !== undefined) reject(failure)
      else if (frames.length >= count) resolve()
      else waiters.push(check)
    }
    waiters.push(check)
    return promise
  }
  return { frames, untilFrames, failure: () => failure, close: () => controller.abort() }
}
// ── the query ─────────────────────────────────────────────────────────────────────────────

const NOW = (): Date => new Date('2026-09-22T10:00:00.000Z')
/** The LOCAL day `NOW` falls on — the file is named by the machine's day, and a literal would be off by one at UTC−11 or UTC+14. */
const TODAY = ensoLogFilename(NOW()).slice('enso-'.length, -'.jsonl'.length)

function parse(query: string): LogTailQuery {
  return parseLogTailQuery(new URLSearchParams(query), NOW)
}

test('an absent parameter takes its default; a level, thread, process and since are read as the CLI reads them', () => {
  expect(parse('')).toEqual({
    filter: { levelRank: 2, thread: undefined, process: undefined, notBefore: 0 },
    from: undefined,
  })
  expect(parse(`level=debug&thread=6923e6&process=pi&since=10m&from=512`)).toEqual({
    filter: { levelRank: 1, thread: '6923e6', process: 'pi', notBefore: NOW().getTime() - 600_000 },
    from: { offset: 512, day: TODAY },
  })
})

// ⚠ A page that asked for `level=infp` and was quietly given `info` would show a filtered log
// while claiming to show another. For a surface whose whole job is to be believed, a default
// applied to a typo is the one failure mode that cannot be allowed.
test('⚠ a parameter that is not what it claims is REFUSED, never defaulted', () => {
  expect(parse('level=infp')).toMatchObject({ reason: expect.stringContaining('level must be one of') })
  expect(parse('thread=not a thread id')).toMatchObject({ reason: expect.stringContaining('thread must be') })
  expect(parse('since=10weeks')).toMatchObject({ reason: expect.stringContaining('since wants a duration') })
  expect(parse('from=-1')).toMatchObject({ reason: expect.stringContaining('from wants a byte offset') })
  expect(parse('from=nowhere')).toMatchObject({ reason: expect.stringContaining('from wants a byte offset') })
})

// ── the stream ────────────────────────────────────────────────────────────────────────────

test('the first frame is the day so far; what lands next arrives as an append', async () => {
  const { url, logsDir } = await startOverLogs()
  append(logsDir, line({ message: 'already on disk' }))
  const tail = await openTail(url)
  await tail.untilFrames(1)
  expect(tail.frames[0]).toMatchObject({ type: 'backlog', matched: 1, malformed: 0 })
  expect(tail.frames[0]?.lines.map((record) => record.message)).toEqual(['already on disk'])

  append(logsDir, line({ message: 'landed while open' }))
  await tail.untilFrames(2)
  expect(tail.frames[1]).toMatchObject({ type: 'records' })
  expect(tail.frames[1]?.lines.map((record) => record.message)).toEqual(['landed while open'])
  expect(tail.failure()).toBeUndefined()
})

// ⚠ THE RULE THE WHOLE SURFACE RESTS ON (#144, #97): a route that exists to read the trace
// must not appear in it. One record per connection would arrive in the tail that connection
// is serving; one per frame would bury whatever the reader was sent to find under its own
// reading. Measured here as the server's recorder seeing nothing across a connection, its
// frames, and its close.
test('⚠ the tail writes no record of its own — the tail never appears in the tail', async () => {
  const { url, logsDir } = await startOverLogs()
  append(logsDir, line({ message: 'the only record there is' }))
  const before = logs.records.length
  const tail = await openTail(url)
  await tail.untilFrames(1)
  append(logsDir, line({ message: 'and a second' }))
  await tail.untilFrames(2)
  tail.close()
  expect(logs.records.length).toBe(before)
})

test('the filter runs on the server: a thread and a tier the caller did not ask for never reach the wire', async () => {
  const { url, logsDir } = await startOverLogs()
  append(
    logsDir,
    line({ message: 'wanted' }),
    line({ message: 'another thread', properties: { threadId: OTHER_THREAD } }),
    line({ message: 'below the floor', level: 'DEBUG' }),
  )
  const tail = await openTail(url, `?thread=${THREAD}&level=info`)
  await tail.untilFrames(1)
  expect(tail.frames[0]?.lines.map((record) => record.message)).toEqual(['wanted'])
  expect(tail.frames[0]?.matched).toBe(1)
})

// ⚠ `from` is how a reconnecting page says "I already have the day". Without it a dropped
// connection re-renders every record the operator had already read.
test('⚠ a tail resumed at an offset appends, and is not handed the day a second time', async () => {
  const { url, logsDir } = await startOverLogs()
  append(logsDir, line({ message: 'already seen' }))
  const first = await openTail(url)
  await first.untilFrames(1)
  const offset = first.frames[0]?.offset ?? 0
  first.close()

  append(logsDir, line({ message: 'missed while away' }))
  const resumed = await openTail(url, `?from=${offset}`)
  await resumed.untilFrames(1)
  expect(resumed.frames[0]).toMatchObject({ type: 'records' })
  expect(resumed.frames[0]?.lines.map((record) => record.message)).toEqual(['missed while away'])
})

test('a refused parameter answers 400 with the reason, and opens no stream', async () => {
  const { url } = await startOverLogs()
  const response = await fetch(`${url}/api/logs/tail?level=infp`)
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('level must be one of')
})

// The same loopback check every route is admitted by (#205, #160): a tail is a read of the
// operator's whole day, so a page they merely visited must not be able to open one.
test('a request from an untrusted origin is refused before the tail opens', async () => {
  const { url } = await startOverLogs()
  const rebound = await fetch(`${url}/api/logs/tail`, { headers: { Host: 'attacker.example' } })
  expect(rebound.status).toBe(403)
})

// ⚠ A resume offset is a byte of ONE file (PR #336 review). Across local midnight the page
// still holds yesterday's byte; handed to today's file it skipped the head silently once today
// outgrew it. `day` says which file the byte belongs to, and a mismatch drops it.
test('⚠ a from that belongs to another day is dropped; one that names today, or no day, is kept', () => {
  expect(parse(`from=512&day=${TODAY}`)).toMatchObject({ from: { offset: 512, day: TODAY } })
  expect(parse('from=512&day=2020-01-01')).toMatchObject({ from: undefined })
  expect(parse('from=512')).toMatchObject({ from: { offset: 512, day: TODAY } })
})

// ⚠ `constructor` and `__proto__` are not levels, and a plain object literal said otherwise
// (PR #336 review): the lookup answered `Object` and `Object.prototype`, the rank became a
// non-number, every comparison was false, and the whole `trace` day streamed. Refused now.
test('⚠ a level that is a prototype property is refused like any other non-level', () => {
  expect(parse('level=constructor')).toMatchObject({ reason: expect.stringContaining('level must be one of') })
  expect(parse('level=__proto__')).toMatchObject({ reason: expect.stringContaining('level must be one of') })
  expect(parse('level=toString')).toMatchObject({ reason: expect.stringContaining('level must be one of') })
})

// ⚠ A step that throws — EACCES on the directory, EISDIR under the name — used to escape the
// timer with nothing above it (PR #336 review). It ends THIS stream and the server answers the
// next request. ⚠ AND THE STREAM SAYS WHY (round two): a bare `end` read as a clean close, the
// page reconnected every five seconds, and each reconnect recorded the failure into the file
// it could not read. The `error` event is what lets the page stop asking; ONE record per
// connection is the whole of what this route writes.
test('⚠ a read that fails says so on the stream as an error event, records it once, and the server stays up', async () => {
  const { url, logsDir } = await startOverLogs()
  // A directory under the day's name: `stat` succeeds, `read` throws EISDIR.
  mkdirSync(join(logsDir, ensoLogFilename(new Date())))
  const before = logs.records.length
  const controller = new AbortController()
  openTails.push(controller)
  const response = await fetch(`${url}/api/logs/tail`, { signal: controller.signal })
  expect(response.status).toBe(200)
  // The stream ends on its own: the body reads to completion without the test closing it.
  const body = await response.text()
  expect(body).toMatch(/^event: error\ndata: .*EISDIR.*\n\n$/)
  const failures = logs.records
    .slice(before)
    .filter((record) => String(record.rawMessage).includes('could not read the file'))
  expect(failures).toHaveLength(1)
  expect((await fetch(`${url}/api/about`)).status).toBe(200)
})

// ── the day's stats ───────────────────────────────────────────────────────────────────────

// ⚠ THE WHOLE DAY, and nothing of the reader's in it (#144 slice 4). The tail says "the last
// N of M"; a stat over the last N would be a number that silently means "some of", so the
// route folds the file entire — and, like every route the debug page calls, leaves no record
// of having been asked.
test('⚠ GET /api/logs/stats folds the whole day into EnsoDayStats, and writes no record', async () => {
  const { url, logsDir } = await startOverLogs()
  append(
    logsDir,
    line({
      message: ENSO_LOG_EVENTS.runAcquired,
      logger: 'enso.server.registry',
      properties: { threadId: THREAD, generation: 1, process: 'server' },
    }),
    line({
      message: ENSO_LOG_EVENTS.messageUsage,
      properties: {
        threadId: THREAD,
        generation: 1,
        role: 'assistant',
        model: 'm',
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalCost: 0.5,
        process: 'server',
      },
    }),
    line({
      message: ENSO_LOG_EVENTS.toolDenied,
      level: 'WARN',
      logger: 'enso.extension.guards',
      properties: { toolName: 'bash', rule: 'network-egress', reason: 'no', process: 'pi' },
    }),
  )
  const before = logs.records.length
  const response = await fetch(`${url}/api/logs/stats`)
  expect(response.status).toBe(200)
  const stats: unknown = await response.json()
  expect(Check(EnsoDayStats, stats)).toBe(true)
  expect(stats).toMatchObject({
    records: 3,
    totals: { runs: 1, cost: 0.5, denials: 1 },
    denials: [{ rule: 'network-egress', count: 1 }],
    models: [expect.objectContaining({ model: 'm', cost: 0.5 })],
  })
  expect(logs.records.length).toBe(before)
})

// ⚠ A FOLD THAT THROWS IS A 500, NOT A DEAD SOCKET (PR #336 review, round two): the fold reads
// the file synchronously before the head is written, so a read that fails answers a plain
// status with a reason the reader can act on — and the failure IS recorded, exactly once,
// because a stats read that fails is the one thing about this route worth a line in the file.
test('⚠ GET /api/logs/stats over a day that cannot be read answers 500 with the reason, and records the failure once', async () => {
  const { url, logsDir } = await startOverLogs()
  // A directory under the day's name: not ENOENT, so not an empty day — `read` throws EISDIR.
  mkdirSync(join(logsDir, ensoLogFilename(new Date())))
  const before = logs.records.length
  const response = await fetch(`${url}/api/logs/stats`)
  expect(response.status).toBe(500)
  expect(await response.text()).toBe('the day could not be read — see the server log')
  const failures = logs.records
    .slice(before)
    .filter((record) => String(record.rawMessage).includes('could not be folded'))
  expect(failures).toHaveLength(1)
  expect(logs.records.length - before).toBe(1)
})

// A day nobody has written yet is an EMPTY day, not a failure: the file's absence is the
// answer, and the route neither complains about it nor writes the first line of the day itself.
test('GET /api/logs/stats over a day with no file yet is an empty day, and writes no record', async () => {
  const { url } = await startOverLogs()
  const before = logs.records.length
  const response = await fetch(`${url}/api/logs/stats`)
  expect(response.status).toBe(200)
  const stats: unknown = await response.json()
  expect(Check(EnsoDayStats, stats)).toBe(true)
  expect(stats).toMatchObject({ records: 0 })
  expect(logs.records.length).toBe(before)
})
