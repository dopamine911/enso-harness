import { expect, test } from 'bun:test'
import { Check } from 'typebox/value'
import { dayStats, ENSO_LOG_EVENTS, EnsoDayStats } from '../log-stats.ts'
import type { EnsoLogLine } from '../log.ts'

/**
 * The day, derived (#144 slice 4): every number a fold over records that already exist, joined
 * by the ids they carry and never by adjacency in a file three processes interleave.
 */

const THREAD = '6923e620-856a-4f1e-9d33-000000000001'
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002'

function at(seconds: number, millis = 0): string {
  return new Date(Date.UTC(2026, 8, 22, 10, 0, seconds, millis)).toISOString()
}

function record(
  stamp: string,
  message: string,
  properties: Record<string, unknown>,
  overrides: Partial<EnsoLogLine> = {},
): EnsoLogLine {
  return {
    '@timestamp': stamp,
    level: 'INFO',
    message,
    logger: 'enso.server.events',
    properties: { process: 'server', ...properties },
    ...overrides,
  }
}

const observation = (stamp: string, properties: Record<string, unknown>): EnsoLogLine =>
  record(stamp, ENSO_LOG_EVENTS.observation, properties)

/** One run's worth of records, as the server writes them, interleaved with another writer's. */
function aRun(): EnsoLogLine[] {
  return [
    record(
      at(0),
      ENSO_LOG_EVENTS.loggingConfigured,
      { pid: 4079, startedAt: at(0), file: 'info', console: 'off', overrides: ['enso.host.events=trace'] },
      { logger: 'enso.log' },
    ),
    record(
      at(0, 5),
      ENSO_LOG_EVENTS.loggingConfigured,
      { process: 'web', pid: 4080, startedAt: at(0), file: 'info', console: 'info', overrides: [] },
      { logger: 'enso.log' },
    ),
    record(at(1), ENSO_LOG_EVENTS.runAcquired, { threadId: THREAD, generation: 1 }, { logger: 'enso.server.registry' }),
    record(
      at(1, 50),
      ENSO_LOG_EVENTS.promptAdmitted,
      { threadId: THREAD, generation: 1, messageId: 'm1', admission: 'opened' },
      { logger: 'enso.server' },
    ),
    // The browser's copy of the same admission, a second later at receipt: not where the wait began.
    record(
      at(2, 60),
      ENSO_LOG_EVENTS.promptAdmitted,
      { threadId: THREAD, generation: 1, messageId: 'm1', admission: 'opened', process: 'browser' },
      { logger: 'enso.browser.follow' },
    ),
    record(at(1, 800), ENSO_LOG_EVENTS.runFirstDelta, { threadId: THREAD, generation: 1, firstDeltaMs: 750 }),
    observation(at(2), { threadId: THREAD, generation: 1, kind: 'tool-call', toolCallId: 'call_1', toolName: 'bash' }),
    observation(at(2, 400), {
      threadId: THREAD,
      generation: 1,
      kind: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'bash',
      complete: true,
      isError: false,
    }),
    observation(at(3), { threadId: THREAD, generation: 1, kind: 'tool-call', toolCallId: 'call_2', toolName: 'bash' }),
    record(
      at(3, 10),
      ENSO_LOG_EVENTS.toolDenied,
      { toolCallId: 'call_2', toolName: 'bash', rule: 'network-egress', reason: 'blocked', process: 'pi' },
      { level: 'WARN', logger: 'enso.extension.guards' },
    ),
    observation(at(3, 100), {
      threadId: THREAD,
      generation: 1,
      kind: 'tool-result',
      toolCallId: 'call_2',
      toolName: 'bash',
      complete: true,
      isError: true,
    }),
    record(at(4), ENSO_LOG_EVENTS.messageUsage, {
      threadId: THREAD,
      generation: 1,
      role: 'assistant',
      model: 'claude-sonnet-4',
      input: 100,
      output: 40,
      cacheRead: 900,
      cacheWrite: 0,
      totalCost: 0.01,
    }),
    observation(at(5), { threadId: THREAD, generation: 1, kind: 'settled' }),
    record(
      at(5, 20),
      ENSO_LOG_EVENTS.runReleased,
      { threadId: THREAD, generation: 1, idleTimeoutMs: 1_800_000 },
      { logger: 'enso.server.registry' },
    ),
  ]
}

test('the answer validates its own schema, and a run reads as its wait, its first token and its spend', () => {
  const stats = dayStats('2026-09-22', aRun(), 0)
  expect(Check(EnsoDayStats, stats)).toBe(true)
  expect(stats.runs).toEqual([
    expect.objectContaining({
      threadId: THREAD,
      generation: 1,
      runMs: 4020,
      // opened at 1.050 → settled at 5.000: the server's admission, not the browser's copy.
      promptMs: 3950,
      firstDeltaMs: 750,
      cost: 0.01,
      input: 100,
      output: 40,
      messages: 1,
    }),
  ])
  expect(stats.totals).toMatchObject({ runs: 1, toolCalls: 2, denials: 1, cost: 0.01, messages: 1 })
  expect(stats.totals.prompts).toEqual({ count: 1, minMs: 3950, maxMs: 3950, meanMs: 3950, totalMs: 3950 })
})

test('a tool is joined call → result by its id: durations, results and errors per tool', () => {
  const stats = dayStats('2026-09-22', aRun(), 0)
  expect(stats.tools).toEqual([
    {
      toolName: 'bash',
      calls: 2,
      results: 2,
      errors: 1,
      durations: { count: 2, minMs: 100, maxMs: 400, meanMs: 250, totalMs: 500 },
    },
  ])
})

test('denials count by rule, and a record from before the rule existed is not dropped', () => {
  const lines = [
    ...aRun(),
    record(
      at(6),
      ENSO_LOG_EVENTS.toolDenied,
      { toolName: 'read', reason: 'old record' },
      { level: 'WARN', logger: 'enso.extension.guards' },
    ),
  ]
  expect(dayStats('2026-09-22', lines, 0).denials).toEqual([
    { rule: 'network-egress', count: 1 },
    { rule: '(no rule)', count: 1 },
  ])
})

// #468: the day's security record, one line per fact. A line that predates `model` or `checked`
// still counts, under `(unknown)` or as an unchecked report.
test('security lines count signals, incidents by model, reports and resolutions — each once', () => {
  const guards = { level: 'WARN' as const, logger: 'enso.extension.guards' }
  const lines = [
    ...aRun(),
    record(at(6), ENSO_LOG_EVENTS.securitySignal, { signal: 'denial-retry', toolCallId: 'c1', detail: '' }, guards),
    record(at(6), ENSO_LOG_EVENTS.securitySignal, { signal: 'denial-retry', toolCallId: 'c2', detail: '' }, guards),
    record(at(6), ENSO_LOG_EVENTS.securitySignal, { signal: 'policy-introspection', toolCallId: 'c3' }, guards),
    record(at(7), ENSO_LOG_EVENTS.incidentOpened, { incidentId: 'i1', halted: true, model: 'claude-sonnet' }, guards),
    record(at(7), ENSO_LOG_EVENTS.incidentOpened, { incidentId: 'i2', halted: false }, guards),
    record(at(8), ENSO_LOG_EVENTS.incidentReportFiled, { incidentId: 'i1', filed: true, checked: true }),
    record(at(8), ENSO_LOG_EVENTS.incidentReportFiled, { incidentId: 'i3', filed: true }),
    record(at(8), ENSO_LOG_EVENTS.incidentReportFiled, { incidentId: 'i4', filed: false }),
    record(at(9), ENSO_LOG_EVENTS.incidentResolved, {
      incidentId: 'i1',
      classification: 'agent-error',
      outcome: 'resume',
    }),
    record(at(9), ENSO_LOG_EVENTS.incidentResolved, {
      incidentId: 'i2',
      classification: 'agent-error',
      outcome: 'resume',
    }),
    record(at(9), ENSO_LOG_EVENTS.incidentResolved, {
      incidentId: 'i3',
      classification: 'confirmed-bypass',
      outcome: 'end-thread',
    }),
  ]
  const stats = dayStats('2026-09-22', lines, 0)
  expect(Check(EnsoDayStats, stats)).toBe(true)
  expect(stats.security).toEqual({
    signals: [
      { signal: 'denial-retry', count: 2 },
      { signal: 'policy-introspection', count: 1 },
    ],
    incidents: { opened: 2, halted: 1 },
    models: [
      { model: 'claude-sonnet', incidents: 1 },
      { model: '(unknown)', incidents: 1 },
    ],
    reports: { filed: 2, checked: 1, missing: 1 },
    resolutions: [
      { classification: 'agent-error', outcome: 'resume', count: 2 },
      { classification: 'confirmed-bypass', outcome: 'end-thread', count: 1 },
    ],
  })
})

test('spend sums per thread and per model; a message without a model is attributed to none', () => {
  const lines = [
    ...aRun(),
    record(at(7), ENSO_LOG_EVENTS.runAcquired, { threadId: OTHER, generation: 1 }, { logger: 'enso.server.registry' }),
    record(at(8), ENSO_LOG_EVENTS.messageUsage, {
      threadId: OTHER,
      generation: 1,
      role: 'toolResult',
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    record(at(9), ENSO_LOG_EVENTS.messageUsage, {
      threadId: OTHER,
      generation: 1,
      role: 'assistant',
      model: 'claude-sonnet-4',
      input: 50,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalCost: 0.02,
    }),
  ]
  const stats = dayStats('2026-09-22', lines, 0)
  expect(stats.threads).toEqual([
    expect.objectContaining({ threadId: THREAD, runs: 1, cost: 0.01, messages: 1 }),
    expect.objectContaining({ threadId: OTHER, runs: 1, cost: 0.02, input: 60, output: 25, messages: 2 }),
  ])
  expect(stats.models).toEqual([
    expect.objectContaining({ model: 'claude-sonnet-4', cost: expect.closeTo(0.03, 10), input: 150, messages: 2 }),
    expect.objectContaining({ model: '(unattributed)', cost: 0, input: 10, messages: 1 }),
  ])
})

test('processes are whoever wrote: the boot facts from the first record, the last write from the last', () => {
  const stats = dayStats('2026-09-22', aRun(), 2)
  expect(stats.malformed).toBe(2)
  expect(stats.processes).toEqual([
    expect.objectContaining({
      process: 'server',
      pid: 4079,
      startedAt: at(0),
      file: 'info',
      console: 'off',
      overrides: ['enso.host.events=trace'],
      firstAt: at(0),
      lastAt: at(5, 20),
    }),
    expect.objectContaining({ process: 'web', pid: 4080, records: 1 }),
    // The browser and pi wrote too, and never say who booted them — no pid, no startedAt.
    expect.objectContaining({ process: 'browser', records: 1 }),
    expect.objectContaining({ process: 'pi', records: 1 }),
  ])
  expect(stats.processes[2]?.pid).toBeUndefined()
})

// ⚠ A writer's second `logging configured` of the day is a second LAUNCH (#385): one row per
// start, each with how it ended, so "a second start; nothing says how the first ended" is gone.
test("⚠ a second start is its own row; a stop, a crash and a later start's report each end the row they belong to (#385)", () => {
  const boot = (stamp: string, process: string, pid: number): EnsoLogLine =>
    record(stamp, ENSO_LOG_EVENTS.loggingConfigured, { process, pid, startedAt: stamp, file: 'info', console: 'off' })
  const lines = [
    boot(at(0), 'server', 100),
    boot(at(0, 5), 'web', 101),
    record(at(1), 'serving', { process: 'web' }),
    record(at(2), ENSO_LOG_EVENTS.processStopping, { process: 'server', signal: 'SIGTERM' }),
    // The second server, which crashes; the web surface is never heard from again …
    boot(at(3), 'server', 200),
    record(at(4), 'a record of the second launch', {}),
    record(
      at(5),
      ENSO_LOG_EVENTS.processCrashed,
      { error: 'ENOSPC: no space left on device', stack: 'x' },
      { level: 'FATAL' },
    ),
    // … until a third start finds its marker, and one from yesterday no row of today carries.
    boot(at(6), 'server', 300),
    record(
      at(6, 1),
      ENSO_LOG_EVENTS.processEndedWithoutRecord,
      { role: 'web', pid: 101, startedAt: at(0, 5) },
      { level: 'WARN' },
    ),
    record(
      at(6, 2),
      ENSO_LOG_EVENTS.processEndedWithoutRecord,
      { role: 'pi', pid: 9, startedAt: '2026-09-21T23:00:00.000Z' },
      { level: 'WARN' },
    ),
  ]
  const stats = dayStats('2026-09-22', lines, 0)
  expect(Check(EnsoDayStats, stats)).toBe(true)
  expect(stats.processes.map((row) => [row.process, row.pid, row.records, row.ended])).toEqual([
    ['server', 100, 2, { kind: 'stopped', at: at(2), detail: 'SIGTERM' }],
    ['web', 101, 2, { kind: 'unclean', at: at(6, 1), detail: 'ended without a record' }],
    ['server', 200, 3, { kind: 'crashed', at: at(5), detail: 'ENOSPC: no space left on device' }],
    ['server', 300, 3, undefined],
  ])
  expect(stats.totals).toEqual(expect.objectContaining({ stops: 1, crashes: 1, uncleanEnds: 2 }))
})

// ⚠ A span is a claim about two clocks. A run that never settled has no wait; a result whose
// call was never seen has no duration; a stamp that does not parse yields neither.
test('⚠ a half-seen run has no span rather than a negative or NaN one', () => {
  const lines = [
    record(at(1), ENSO_LOG_EVENTS.runAcquired, { threadId: THREAD, generation: 3 }, { logger: 'enso.server.registry' }),
    observation(at(2), {
      threadId: THREAD,
      generation: 3,
      kind: 'tool-result',
      toolCallId: 'never-called',
      toolName: 'read',
      complete: true,
    }),
    record(
      'whenever',
      ENSO_LOG_EVENTS.runReleased,
      { threadId: THREAD, generation: 3, idleTimeoutMs: 1 },
      { logger: 'enso.server.registry' },
    ),
  ]
  const stats = dayStats('2026-09-22', lines, 0)
  expect(stats.runs[0]).not.toHaveProperty('runMs')
  expect(stats.runs[0]).not.toHaveProperty('promptMs')
  expect(stats.tools).toEqual([
    {
      toolName: 'read',
      calls: 0,
      results: 1,
      errors: 0,
      durations: { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 },
    },
  ])
  expect(Check(EnsoDayStats, stats)).toBe(true)
})

// The call names the bucket (PR #336 review): a result that omits `toolName` — or spells it
// differently — joins its call by id and lands under the call's name, never in an `(unnamed)`
// row of results beside a named row of calls.
test('a result without a tool name is counted under the name its call carried', () => {
  const lines = [
    observation(at(1), { threadId: THREAD, generation: 1, kind: 'tool-call', toolCallId: 'c', toolName: 'read' }),
    observation(at(1, 300), { threadId: THREAD, generation: 1, kind: 'tool-result', toolCallId: 'c', complete: true }),
  ]
  expect(dayStats('2026-09-22', lines, 0).tools).toEqual([
    {
      toolName: 'read',
      calls: 1,
      results: 1,
      errors: 0,
      durations: { count: 1, minMs: 300, maxMs: 300, meanMs: 300, totalMs: 300 },
    },
  ])
})

// A day counts refusals by provider and status (#340), from the compact `info` line the server
// writes for each — so "how often did the provider refuse today, and why" is a fold, not a grep.
test('provider refusals count by provider and status; one with no provider or status is not dropped', () => {
  const lines = [
    ...aRun(),
    observation(at(6), {
      threadId: THREAD,
      generation: 1,
      kind: 'provider-refused',
      provider: 'anthropic',
      status: 429,
    }),
    observation(at(7), {
      threadId: THREAD,
      generation: 1,
      kind: 'provider-refused',
      provider: 'anthropic',
      status: 429,
    }),
    observation(at(8), {
      threadId: THREAD,
      generation: 1,
      kind: 'provider-refused',
      provider: 'anthropic',
      status: 400,
    }),
    observation(at(9), { threadId: OTHER, generation: 1, kind: 'provider-refused' }),
  ]
  const stats = dayStats('2026-09-22', lines, 0)
  expect(Check(EnsoDayStats, stats)).toBe(true)
  expect(stats.refusals).toEqual([
    { provider: 'anthropic', status: 429, count: 2 },
    { provider: 'anthropic', status: 400, count: 1 },
    { provider: '(unknown)', count: 1 },
  ])
  expect(stats.totals.refusals).toBe(4)
})
