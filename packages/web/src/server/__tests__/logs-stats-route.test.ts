import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_LOG_EVENTS } from '@enso/core'
import { ensoLogFilename } from '@enso/core/log-process'
import { createLogStatsRoute } from '../logs-stats-route.ts'

/**
 * The stats route's own facts (#144 slice 4, PR #336 review, #739): WHICH file it folds is the
 * clock's local day, a day nobody has written is an empty answer and not a failure, a line that
 * is not a record is counted rather than folded, and a record appended since the last request is
 * in the next. What the fold produces is `log-stats.test.ts`; that the route writes no record is
 * `logs-tail-route.test.ts`; the follow's own edges (a partial line, truncation, rotation) are
 * `day-file-fold.test.ts`.
 */

const TODAY = new Date('2026-09-22T10:00:00')
const YESTERDAY = new Date('2026-09-21T10:00:00')

const record = (message: string, properties: Record<string, unknown>): string =>
  JSON.stringify({
    '@timestamp': TODAY.toISOString(),
    level: 'INFO',
    message,
    logger: 'enso.server.registry',
    properties: { process: 'server', ...properties },
  })

test("the route folds the clock's local day, and only that day's file", () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-stats-day-'))
  writeFileSync(
    join(logsDir, ensoLogFilename(YESTERDAY)),
    `${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 'y', generation: 1 })}\n`,
  )
  writeFileSync(
    join(logsDir, ensoLogFilename(TODAY)),
    `${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 't', generation: 1 })}\n${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 't', generation: 2 })}\n`,
  )
  expect(createLogStatsRoute({ logsDir, now: () => TODAY })()).toMatchObject({
    day: '2026-09-22',
    records: 2,
    totals: { runs: 2 },
  })
  expect(createLogStatsRoute({ logsDir, now: () => YESTERDAY })()).toMatchObject({
    day: '2026-09-21',
    records: 1,
    totals: { runs: 1 },
  })
})

test('a day nobody has written yet is an empty answer, not a failure', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-stats-empty-'))
  const stats = createLogStatsRoute({ logsDir, now: () => TODAY })()
  expect(stats).toMatchObject({
    day: '2026-09-22',
    records: 0,
    malformed: 0,
    processes: [],
    runs: [],
    totals: { runs: 0 },
  })
})

test('a line that is not a record is counted, and the records around it still fold', () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-stats-malformed-'))
  writeFileSync(
    join(logsDir, ensoLogFilename(TODAY)),
    `not json\n${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 't', generation: 1 })}\n{"level":"NOPE"}\n`,
  )
  expect(createLogStatsRoute({ logsDir, now: () => TODAY })()).toMatchObject({
    records: 1,
    malformed: 2,
    totals: { runs: 1 },
  })
})

test("#739: one route follows the day — a record appended since the last request is in the next, and the turned day's file is folded once the clock moves", () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-stats-follow-'))
  const today = join(logsDir, ensoLogFilename(TODAY))
  writeFileSync(today, `${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 't', generation: 1 })}\n`)
  writeFileSync(
    join(logsDir, ensoLogFilename(YESTERDAY)),
    `${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 'y', generation: 1 })}\n`,
  )
  let clock = YESTERDAY
  const route = createLogStatsRoute({ logsDir, now: () => clock })
  expect(route()).toMatchObject({ day: '2026-09-21', records: 1 })
  clock = TODAY
  expect(route()).toMatchObject({ day: '2026-09-22', records: 1, totals: { runs: 1 } })
  appendFileSync(today, `${record(ENSO_LOG_EVENTS.runAcquired, { threadId: 't', generation: 2 })}\n`)
  expect(route()).toMatchObject({ day: '2026-09-22', records: 2, totals: { runs: 2 } })
})
