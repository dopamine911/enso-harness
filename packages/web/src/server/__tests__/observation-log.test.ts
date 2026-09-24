import { afterEach, expect, test } from 'bun:test'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { LogRecord } from '@logtape/logtape'
import { recordObservation } from '../observation-log.ts'
import { noteRunAdmitted } from '../run-timing.ts'

/**
 * The tier an observation lands at, and the one record that is not an observation at all:
 * the run's time to first token (#144). The deltas themselves stay at `debug` — the text
 * is pi's session file, not this one — so this `info` line is the only thing at the spine's
 * tier that dates the first token.
 */

afterEach(releaseEnsoLogs)

function firstDeltaRecords(records: readonly LogRecord[]): readonly LogRecord[] {
  return records.filter((record) => String(record.rawMessage).includes('first delta'))
}

test('⚠ the first delta of a run is one info record with the latency; the rest stay debug deltas', async () => {
  const logs = await recordEnsoLogs()
  noteRunAdmitted('obs-t1', 1)
  for (const delta of ['he', 'llo']) {
    recordObservation('obs-t1', 1, 1, { kind: 'text-delta', contentIndex: 0, delta })
  }
  const timing = firstDeltaRecords(logs.records)
  expect(timing).toHaveLength(1)
  expect(timing[0]?.level).toBe('info')
  expect(typeof timing[0]?.properties?.firstDeltaMs).toBe('number')
  expect(timing[0]?.properties).toMatchObject({ threadId: 'obs-t1', generation: 1 })
  // The compact lines are unchanged: `debug`, a char count, never the text. (`{kind}` is the
  // compact line's own template; the `trace` twin says `{kind} payload` and carries the text.)
  const compact = logs.records.filter((record) => record.rawMessage === '{kind}')
  expect(compact.map((record) => record.level)).toEqual(['debug', 'debug'])
  expect(compact.map((record) => record.properties?.chars)).toEqual([2, 3])
  expect(JSON.stringify(compact)).not.toContain('hello')
})

test('a run with no delta leaves nothing behind: after it settles, a late delta records no latency', async () => {
  const logs = await recordEnsoLogs()
  noteRunAdmitted('obs-t2', 4)
  recordObservation('obs-t2', 4, 9, { kind: 'settled' })
  recordObservation('obs-t2', 4, 10, { kind: 'text-delta', contentIndex: 0, delta: 'x' })
  expect(firstDeltaRecords(logs.records)).toHaveLength(0)
})

// ⚠ WHAT TODAY COST, at the spine's tier (#144 slice 4). `message-end` stays `debug` — most
// are boundaries — but a message pi attributes spend to is one `info` line carrying the
// accounting, so a day's cost is in the file for whoever reads it later, not only for whoever
// was turned up. The unit is the completed message, the one pi's `/stats` sums.
test('⚠ a message-end with usage is one info record with the tokens, the cost and the model; one without stays debug', async () => {
  const logs = await recordEnsoLogs()
  recordObservation('obs-t3', 2, 30, {
    kind: 'message-end',
    role: 'assistant',
    model: 'claude-sonnet-4',
    usage: { input: 120, output: 45, cacheRead: 1000, cacheWrite: 0, totalCost: 0.0123 },
  })
  recordObservation('obs-t3', 2, 31, { kind: 'message-end', role: 'user' })
  const spend = logs.records.filter((record) => String(record.rawMessage).startsWith('message {role} used'))
  expect(spend).toHaveLength(1)
  expect(spend[0]?.level).toBe('info')
  expect(spend[0]?.properties).toMatchObject({
    threadId: 'obs-t3',
    generation: 2,
    seq: 30,
    role: 'assistant',
    model: 'claude-sonnet-4',
    input: 120,
    output: 45,
    cacheRead: 1000,
    cacheWrite: 0,
    totalCost: 0.0123,
  })
  // The boundary without usage is the compact `debug` line and nothing more.
  const boundary = logs.records.filter((record) => record.rawMessage === '{kind}' && record.properties?.seq === 31)
  expect(boundary.map((record) => record.level)).toEqual(['debug'])
})

// ⚠ THE FACT, not the shape (#340): two hours of 429s were once only `run-ended` records with no
// tokens. A refusal is one `info` line with the provider, the model, the status and the provider's
// own sentence — out of its JSON, capped — and pi's retry is another.
test('⚠ a provider refusal, pi’s retry and its end are info records with the provider, the status and the provider’s sentence', async () => {
  const logs = await recordEnsoLogs()
  recordObservation('obs-t4', 3, 40, {
    kind: 'provider-refused',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    status: 429,
    message:
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
  })
  recordObservation('obs-t4', 3, 41, { kind: 'provider-retry', attempt: 1, maxAttempts: 3, delayMs: 2000 })
  recordObservation('obs-t4', 3, 42, {
    kind: 'provider-retry-ended',
    success: false,
    attempt: 3,
    finalError: '503: upstream unavailable',
  })
  const compact = logs.records.filter((record) => record.rawMessage === '{kind}')
  expect(compact.map((record) => [record.level, record.properties?.kind])).toEqual([
    ['info', 'provider-refused'],
    ['info', 'provider-retry'],
    ['info', 'provider-retry-ended'],
  ])
  expect(compact[0]?.properties).toMatchObject({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    status: 429,
    reason: "This request would exceed your account's rate limit.",
  })
  expect(compact[1]?.properties).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 2000 })
  expect(compact[2]?.properties).toMatchObject({ success: false, attempt: 3, reason: 'upstream unavailable' })
})
