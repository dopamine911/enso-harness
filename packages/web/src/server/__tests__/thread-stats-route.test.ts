import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_LOG_EVENTS, type EnsoLogLine, type EnsoSessionUsage } from '@enso/core'
import { ensoLogFilename } from '@enso/core/log-process'
import type { BranchStats } from '../../host/branch-stats.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createThreadStatsRoute } from '../thread-stats-route.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * #45 phase 2: one thread's stats — pi's session for the numbers, the day files for the times.
 * Driven with the fake host and day files written under a temporary directory.
 */

const THREAD = 'thread-stats-1'
const OTHER = 'thread-stats-2'
/** Local days, as the files name them: two before the branch began, then the branch's two. */
const EARLIER = new Date(2026, 8, 19, 12)
const FIRST_DAY = new Date(2026, 8, 21, 10)
const TODAY = new Date(2026, 8, 22, 15)

const USAGE: EnsoSessionUsage = { cost: 0.5, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, context: null }
/** A branch call, as the host walks one — no duration: the route joins that. */
const branchCall = (toolCallId: string, toolName: string): BranchStats['callStats'][number] => ({
  toolCallId,
  toolName,
  turn: 1,
  prompt: 1,
  inputChars: 10,
  outputChars: 20,
  isError: false,
  pending: false,
})

const BRANCH: BranchStats = {
  branchCost: 0.25,
  turnStats: [],
  promptStats: [],
  // `call-0` is timed only on a day before the branch began, `call-x` only under another
  // thread's id, `call-3` nowhere: none of the three may come back with a duration.
  callStats: [
    branchCall('call-0', 'bash'),
    branchCall('call-1', 'bash'),
    branchCall('call-2', 'bash'),
    branchCall('call-x', 'bash'),
    branchCall('call-3', 'read'),
  ],
  firstAt: FIRST_DAY.toISOString(),
}

function at(day: Date, seconds: number): string {
  const moment = new Date(day)
  moment.setSeconds(moment.getSeconds() + seconds)
  return moment.toISOString()
}

function observation(stamp: string, threadId: string, properties: Record<string, unknown>): EnsoLogLine {
  return {
    '@timestamp': stamp,
    level: 'INFO',
    message: ENSO_LOG_EVENTS.observation,
    logger: 'enso.server.events',
    properties: { process: 'server', threadId, generation: 1, ...properties },
  }
}

/** A bash call on `day` that took `milliseconds`, for `threadId`. */
function timedCall(day: Date, threadId: string, toolCallId: string, milliseconds: number): EnsoLogLine[] {
  const called = new Date(day)
  const answered = new Date(called.getTime() + milliseconds)
  return [
    observation(called.toISOString(), threadId, { kind: 'tool-call', toolCallId, toolName: 'bash' }),
    observation(answered.toISOString(), threadId, {
      kind: 'tool-result',
      toolCallId,
      toolName: 'bash',
      complete: true,
      isError: false,
    }),
  ]
}

function writeDay(logsDir: string, day: Date, lines: readonly EnsoLogLine[]): void {
  writeFileSync(join(logsDir, ensoLogFilename(day)), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

function logsDirForTheThread(): string {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-thread-stats-'))
  // Before the branch began: a call under the same id is not this branch's, and is not read.
  writeDay(logsDir, EARLIER, timedCall(EARLIER, THREAD, 'call-0', 9000))
  writeDay(logsDir, FIRST_DAY, [
    ...timedCall(FIRST_DAY, THREAD, 'call-1', 400),
    ...timedCall(FIRST_DAY, OTHER, 'call-x', 5000),
    {
      '@timestamp': at(FIRST_DAY, 0),
      level: 'INFO',
      message: ENSO_LOG_EVENTS.runFirstDelta,
      logger: 'enso.server.events',
      properties: { process: 'server', threadId: THREAD, generation: 1, firstDeltaMs: 700 },
    },
  ])
  writeDay(logsDir, TODAY, [
    ...timedCall(TODAY, THREAD, 'call-2', 100),
    {
      '@timestamp': at(TODAY, 0),
      level: 'INFO',
      message: ENSO_LOG_EVENTS.runFirstDelta,
      logger: 'enso.server.events',
      // The server restarted: generation 1 again, a different run. Folded per day, it stays one.
      properties: { process: 'server', threadId: THREAD, generation: 1, firstDeltaMs: 300 },
    },
  ])
  return logsDir
}

const noLiveThread = { peek: (): ThreadView | undefined => undefined }

test("a stored thread's calls carry the log's durations from the days its branch spans, and no other thread's", async () => {
  const route = createThreadStatsRoute({
    threads: noLiveThread,
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      [THREAD]: { transcript: [], modified: TODAY, firstMessage: '', usage: USAGE, branch: BRANCH },
    }),
    logsDir: logsDirForTheThread(),
    now: () => TODAY,
  })
  const stats = await route(THREAD)
  expect(stats?.live).toBe(false)
  expect(stats?.usage).toEqual(USAGE)
  expect(stats?.branchCost).toBe(0.25)
  expect(stats?.logDays).toEqual(['2026-09-21', '2026-09-22'])
  expect(stats?.callStats.map((call) => [call.toolCallId, call.durationMs])).toEqual([
    ['call-0', undefined],
    ['call-1', 400],
    ['call-2', 100],
    ['call-x', undefined],
    ['call-3', undefined],
  ])
  expect(stats?.latency.firstDelta).toMatchObject({ count: 2, minMs: 300, maxMs: 700 })
})

test('a live thread is answered from its session; a thread held nowhere is no answer', async () => {
  const live = createFakeHostedThread({ branch: BRANCH })
  live.record.sessionUsage = USAGE
  const route = createThreadStatsRoute({
    threads: {
      peek: (threadId: string) => (threadId === THREAD ? ({ hosted: live.hosted } as ThreadView) : undefined),
    },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build'))),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-thread-stats-empty-')),
    now: () => TODAY,
  })
  expect(await route(THREAD)).toMatchObject({ live: true, usage: USAGE, branchCost: 0.25, logDays: [] })
  expect(await route('held-nowhere')).toBeUndefined()
})

// #359: a past day is folded once and kept; today is read fresh each time; a day the prune
// deletes is forgotten. The file REWRITTEN under a kept day is how "kept" is observed — a real
// past day never changes once the rotation moved on, which is the premise of keeping it.
test('a day before today is read once and kept; today is re-read; a pruned day is dropped', async () => {
  const logsDir = logsDirForTheThread()
  const route = createThreadStatsRoute({
    threads: noLiveThread,
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      [THREAD]: { transcript: [], modified: TODAY, firstMessage: '', usage: USAGE, branch: BRANCH },
    }),
    logsDir,
    now: () => TODAY,
  })
  const durations = async (): Promise<Array<number | undefined>> =>
    (await route(THREAD))?.callStats.map((call) => call.durationMs) ?? []
  expect(await durations()).toEqual([undefined, 400, 100, undefined, undefined])
  writeDay(logsDir, FIRST_DAY, timedCall(FIRST_DAY, THREAD, 'call-1', 999))
  writeDay(logsDir, TODAY, [...timedCall(TODAY, THREAD, 'call-2', 150), ...timedCall(TODAY, THREAD, 'call-3', 20)])
  expect(await durations()).toEqual([undefined, 400, 150, undefined, 20])
  rmSync(join(logsDir, ensoLogFilename(FIRST_DAY)))
  const pruned = await route(THREAD)
  expect(pruned?.logDays).toEqual(['2026-09-22'])
  expect(pruned?.callStats.map((call) => call.durationMs)).toEqual([undefined, undefined, 150, undefined, 20])
})
