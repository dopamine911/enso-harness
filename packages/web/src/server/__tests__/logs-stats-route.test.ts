import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_LOG_EVENTS } from '@enso/core'
import { ensoLogFilename } from '@enso/core/log-process'
import { createLogStatsRoute } from '../logs-stats-route.ts'

/**
 * The stats route's own three facts (#144 slice 4, PR #336 review): WHICH file it folds is the
 * clock's local day, a day nobody has written is an empty answer and not a failure, and a line
 * that is not a record is counted rather than folded. What the fold produces is
 * `log-stats.test.ts`; that the route writes no record is `logs-tail-route.test.ts`.
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
