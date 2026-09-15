import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { LogRecorder } from '@logtape/testing/recorder'
import { recordZenLogs, releaseZenLogs } from '@zen/core/log-recorder'
import { MAX_LOG_BODY_BYTES, receiveBrowserLogs } from '../logs-route.ts'

/**
 * `POST /api/logs` (#132 slice 3): the browser's batch into this process's logger, under the
 * browser's own category, at its level, marked as the browser's — or a 4xx that is never a
 * record of its own.
 */

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordZenLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseZenLogs)

const batch = (records: unknown[]): string => JSON.stringify({ page: 'tab-1', records })

test("a good batch is re-emitted: the browser's category and level, its clock as `at`, marked process browser", () => {
  const outcome = receiveBrowserLogs(
    batch([
      {
        at: '2026-09-09T23:41:26.174Z',
        level: 'warning',
        logger: 'zen.browser.follow',
        message: 'the follow failed: {error}',
        properties: { threadId: 't1', error: 'TypeError: fetch failed' },
      },
      { at: '2026-09-09T23:41:27.000Z', level: 'info', logger: 'zen.browser', message: 'page loaded', properties: {} },
    ]),
  )
  expect(outcome).toEqual({ status: 204 })
  logs.assertLogged({
    level: 'warning',
    category: ['zen', 'browser', 'follow'],
    rawMessage: 'the follow failed: {error}',
    properties: {
      threadId: 't1',
      error: 'TypeError: fetch failed',
      process: 'browser',
      page: 'tab-1',
      at: '2026-09-09T23:41:26.174Z',
    },
  })
  logs.assertLogged({
    level: 'info',
    category: ['zen', 'browser'],
    rawMessage: 'page loaded',
    properties: { process: 'browser' },
  })
  expect(logs.records).toHaveLength(2)
})

test('⚠ a bad batch is a 4xx that says why — and is NOT logged, so a page in a loop cannot write its garbage here', () => {
  expect(receiveBrowserLogs('not json')).toMatchObject({ status: 400, reason: 'a log batch is JSON' })
  expect(receiveBrowserLogs(JSON.stringify({ page: 'p', records: [{ at: 'x' }] }))).toMatchObject({ status: 400 })
  // The browser may only speak for itself: another layer's category is refused.
  expect(
    receiveBrowserLogs(
      batch([{ at: 'x', level: 'info', logger: 'zen.host.ui', message: 'not mine to say', properties: {} }]),
    ),
  ).toMatchObject({ status: 400 })
  expect(receiveBrowserLogs(`{"page":"p","records":[],"pad":"${'x'.repeat(MAX_LOG_BODY_BYTES)}"}`)).toMatchObject({
    status: 413,
  })
  // Bytes, not code units: a body under the cap in characters but over it in UTF-8.
  expect(
    receiveBrowserLogs(`{"page":"p","records":[],"pad":"${'é'.repeat(MAX_LOG_BODY_BYTES / 2 + 8)}"}`),
  ).toMatchObject({
    status: 413,
  })
  expect(logs.records).toHaveLength(0)
})
