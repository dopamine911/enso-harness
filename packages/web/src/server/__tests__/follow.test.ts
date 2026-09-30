import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DialogAnswer,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_PROMPT_BODY_MAX_BYTES,
  ENSO_PROMPT_MAX_IMAGES,
  type EnsoFollowFrame,
  type EnsoObservation,
  type PromptOutcome,
  type PromptRequest,
  type ThreadRuntime,
} from '@enso/core'
import { type FlowTrace, flowTrace } from '@enso/core/flow-trace'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import type { AgentHost } from '../../host/agent-host.ts'
import { answerThreadDialog, type FollowRouteDeps } from '../follow.ts'
import { startEnsoServer } from '../index.ts'
import { takeFirstDeltaMs } from '../run-timing.ts'
import {
  createFakeAgentHost,
  createFakeHostedThread,
  type FakeStoredThread,
  type FakeThreadParts,
  type FakeThreadRecord,
} from './fake-hosted-thread.ts'
import { type OpenFollow, openFollow as openSharedFollow } from './follow-reader.ts'

/**
 * The wire, measured (#109's receipt, kept as the contract — #112). Each test is one
 * property of the prompt/follow split over a scripted host. Read the test names as the
 * findings.
 *
 * The fake's `emit` is exposed to the test, so every scenario advances by emitting the pi
 * event that would arrive and awaiting the frame it produces — never a guessed delay.
 */

interface FakeHost {
  readonly host: AgentHost
  readonly built: FakeThreadRecord[]
  /** Emit into the LAST built session — every scenario here uses one thread. */
  readonly emit: (observation: EnsoObservation) => void
  /** Fire the last prompt's acceptance (a slash command's completion signal). */
  readonly accept: () => void
  /** Draw this host's calls and emissions into a flow trace: the runtime's side of the diagram. */
  readonly traceInto: (trace: FlowTrace) => void
}

/**
 * `overrides`: a test's own answer for one runtime method, over the fake's recording default (L3 step C).
 * `stored`: session files the host lists — a continue needs one to exist (PR #442 review).
 * `buildGate`: every build waits on it — the window two requests on a cold thread share (#444).
 */
function fakeHost(
  commands: string[] = ['mode'],
  overrides: Partial<ThreadRuntime> = {},
  stored: Record<string, FakeStoredThread> = {},
  buildGate: Promise<void> = Promise.resolve(),
): FakeHost {
  const built: FakeThreadRecord[] = []
  let emit: (observation: EnsoObservation) => void = () => undefined
  let accept: () => void = () => undefined
  let trace: FlowTrace | undefined
  const host = createFakeAgentHost(() => {
    const fake = createFakeHostedThread({
      runtime: ({ record }: FakeThreadParts) => ({
        prompt: (request: PromptRequest, outcome: PromptOutcome) => {
          trace?.send('R', 'P', `prompt "${request.message}" { onAccepted, onRejected }`)
          record.prompts.push(request)
          accept = () => outcome.onAccepted()
        },
        listCommands: () => commands.map((name) => ({ name, source: 'extension' as const })),
        permissionModeState: () => ({ mode: 'default', available: ['default', 'plan'] }),
        ...overrides,
      }),
      inspect: { sessionId: 's1', cwd: '/', sessionDir: '/s', commands },
      onCall: (method: string, args: readonly unknown[]) => {
        const [first] = args
        if (method === 'answerDialog') trace?.send('R', 'P', `answerDialog ${fieldsOf(first)}`)
        if (method === 'clearQueue' || method === 'abort') trace?.send('T', 'P', `${method}()`)
      },
    })
    built.push(fake.record)
    emit = fake.emit
    return buildGate.then(() => fake.hosted)
  }, stored)
  return {
    host,
    built,
    emit: (observation: EnsoObservation) => {
      trace?.send('P', 'F', observation.kind)
      emit(observation)
    },
    accept: () => {
      trace?.reply('P', 'R', 'onAccepted()')
      accept()
    },
    traceInto: (into: FlowTrace) => {
      trace = into
    },
  }
}

/** A call's argument as the diagram shows it: `{key: value, …}`, strings quoted. */
function fieldsOf(argument: unknown): string {
  if (typeof argument !== 'object' || argument === null) return String(argument)
  const fields = Object.entries(argument).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `{${fields.join(', ')}}`
}

function emptyHarnessDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-follow-harness-'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fake-harness', pi: {} }))
  return directory
}

const openServers: Array<{ close: () => Promise<void> }> = []
/** Every follow a test opened — aborted first, or a failed assertion leaves `server.close()` waiting on it. */
const openFollows: AbortController[] = []
afterEach(async () => {
  for (const follow of openFollows.splice(0)) follow.abort()
  for (const started of openServers.splice(0)) await started.close()
})

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordEnsoLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseEnsoLogs)

async function startWith(fake: FakeHost, sseKeepaliveMs = 1000): Promise<string> {
  const started = startEnsoServer({
    cwd: tmpdir(),
    harnessPackageDir: emptyHarnessDir(),
    agentDir: mkdtempSync(join(tmpdir(), 'enso-follow-agent-')),
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
    host: () => fake.host,
    sseKeepaliveMs,
  })
  openServers.push(started)
  return await started.listening
}

async function openFollow(url: string, threadId: string): Promise<OpenFollow> {
  const controller = new AbortController()
  openFollows.push(controller)
  return await openSharedFollow(url, threadId, controller)
}

async function prompt(
  url: string,
  threadId: string,
  message: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/threads/${threadId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function threadSummary(url: string, threadId: string): Promise<Record<string, unknown> | undefined> {
  const summaries = (await (await fetch(`${url}/api/threads`)).json()) as Array<Record<string, unknown>>
  return summaries.find((summary) => summary.threadId === threadId)
}

// What the runtime says to its subscriber — observations, since L2 (#162 workstream 4).
const SETTLED: EnsoObservation = { kind: 'settled' }
const TEXT_DELTA: EnsoObservation = { kind: 'text-delta', contentIndex: 0, delta: 'hi' }
const SELECT_DIALOG: EnsoObservation = {
  kind: 'extension-ui-request',
  id: 'd1',
  method: 'select',
  blocking: true,
  dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] },
  origin: 'run',
}

/** The server's side of `docs/flows/prompt-run-settle.md`, one column per part that speaks. */
const PROMPT_FLOW = {
  participants: {
    B: 'browser (the test client)',
    R: 'prompt route (server/index.ts, follow.ts)',
    T: 'thread registry',
    P: 'runtime (fake host)',
    F: 'feed (observation log)',
  },
  categories: {
    'enso.server.http': 'R',
    'enso.server.follow': 'R',
    'enso.server.threads': 'T',
    'enso.server.events': 'F',
  },
} as const

/** The server's side of the follow (`docs/flows/follow-snapshot-frames.md`): two tabs, one feed. */
const FOLLOW_FLOW = {
  participants: {
    B: 'first tab (the test client)',
    C: 'second tab (the test client)',
    R: 'follow route (server/follow.ts)',
    T: 'thread registry',
    P: 'runtime (fake host)',
    F: 'feed (observation log)',
  },
  categories: PROMPT_FLOW.categories,
} as const

/** The server's side of a dialog (`docs/flows/dialog-ask-answer-settled.md`): asked, answered, settled. */
const DIALOG_FLOW = {
  participants: {
    B: 'browser (the test client)',
    R: 'dialog route (server/index.ts, follow.ts)',
    T: 'thread registry',
    P: 'runtime (fake host)',
    F: 'feed (observation log)',
  },
  categories: PROMPT_FLOW.categories,
} as const

/** The server's side of a stop (`docs/flows/abort-clear-restore.md`): cleared, handed back, settled. */
const ABORT_FLOW = {
  participants: {
    B: 'browser (the test client)',
    R: 'abort route (server/index.ts, follow.ts)',
    T: 'thread registry',
    P: 'runtime (fake host)',
    F: 'feed (observation log)',
  },
  categories: PROMPT_FLOW.categories,
} as const

// ── 1. prompt is admission; the thread's own settle releases it ──────────────────────

// @pins prompt-run-settle/admission prompt-run-settle/generation
// @pins follow-snapshot-frames/cold-empty resume/cold-then-live
test("prompt answers at admission with a message id; the run is released by pi's settle, no HTTP response in between", async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  // Observation preceded the first prompt: an empty snapshot, not a 404.
  expect(follow.frames[0]).toMatchObject({ type: 'snapshot', live: false, busy: false, generation: 0, messages: [] })

  const trace = flowTrace({ ...PROMPT_FLOW, logs })
  fake.traceInto(trace)
  trace.request('B', 'R', 'POST /api/threads/t1/prompt', { message: 'hello' })
  const admitted = await prompt(url, 't1', 'hello')
  trace.respond('R', 'B', admitted.status, admitted.body)
  expect(admitted.status).toBe(202)
  expect(admitted.body).toMatchObject({ threadId: 't1', generation: 1, queued: false })
  expect(typeof admitted.body.messageId).toBe('string')
  // The admission is a record (#132): the same ids as the receipt, so a bundle joins them.
  logs.assertLogged({
    level: 'info',
    rawMessage: 'prompt {messageId} {admission} on run {generation}',
    properties: { threadId: 't1', messageId: admitted.body.messageId, generation: 1, admission: 'opened' },
  })
  // Nothing has been emitted yet, and the prompt has already been answered.
  expect(fake.built[0]?.prompts.map((request) => request.message)).toEqual(['hello'])
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })

  // The follow saw the thread come alive and get taken — status frames, in order.
  await follow.untilFrames(3)
  expect(follow.frames.slice(1)).toEqual([
    { type: 'status', live: true, busy: false, generation: 0 },
    { type: 'status', live: true, busy: true, generation: 1 },
  ])

  fake.emit(TEXT_DELTA)
  fake.emit(SETTLED)
  await follow.untilFrames(6)
  expect(follow.frames.slice(3)).toEqual([
    { type: 'observation', seq: 1, observation: expect.objectContaining({ kind: 'text-delta' }) },
    { type: 'observation', seq: 2, observation: { kind: 'settled' } },
    { type: 'status', live: true, busy: false, generation: 1 },
  ])
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })

  // The trace (#132): the spine at `info` — built, acquired, the settle, released — and the
  // delta at `debug` as a COUNT, its text nowhere below `trace`.
  logs.assertLogged({ level: 'info', rawMessage: /^thread built/, properties: { threadId: 't1', generation: 0 } })
  logs.assertLogged({
    level: 'info',
    rawMessage: 'run {generation} acquired',
    properties: { threadId: 't1', generation: 1 },
  })
  logs.assertLogged({
    level: 'debug',
    category: ['enso', 'server', 'events'],
    properties: { threadId: 't1', generation: 1, seq: 1, kind: 'text-delta', chars: 2 },
  })
  logs.assertLogged({ level: 'info', category: ['enso', 'server', 'events'], properties: { seq: 2, kind: 'settled' } })
  logs.assertLogged({
    level: 'info',
    rawMessage: /^run \{generation\} released/,
    properties: { threadId: 't1', generation: 1 },
  })
  const payload = logs.find({ level: 'trace', properties: { seq: 1 } })
  expect(payload?.properties.observation).toMatchObject({ kind: 'text-delta', delta: 'hi' })
  // Below trace, the text appears in no record's properties.
  expect(
    logs.records
      .filter((record) => record.level !== 'trace')
      .some((record) => JSON.stringify(record.properties).includes('"hi"')),
  ).toBe(false)
  // The flow page's diagram (#482): what this test drove and what the server logged, in order.
  expect(trace.diagram()).toMatchSnapshot('flow prompt-run-settle: the server')
  follow.close()
})

// ── the server half of a rejected prompt (docs/flows/prompt-run-settle.md, stated gap) ──
// The browser tests script `prompt-rejected` onto the wire; nothing had driven the ROUTE's
// `onRejected` → `announce` → follower path. Two paths, two leases to get right.

// @pins prompt-run-settle/refusals
test("⚠ a prompt the runtime REJECTS after the 202 is said on the follow with the receipt's message id, and the thread is released", async () => {
  const fake = fakeHost([], {
    prompt: (_request: PromptRequest, outcome: PromptOutcome) => outcome.onRejected('the runtime would not take it'),
  })
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  const admitted = await prompt(url, 't1', 'hello')
  expect(admitted.status).toBe(202)
  const messageId = String(admitted.body.messageId)
  await follow.untilFrames(4)
  // The rejection names the SAME message id the receipt carried: that is how the browser matches it to its run.
  expect(follow.frames).toContainEqual({
    type: 'observation',
    seq: 1,
    observation: { kind: 'prompt-rejected', messageId, reason: 'the runtime would not take it' },
  })
  // The lease was released on rejection: not left busy behind a run that never started.
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })
  logs.assertLogged({
    level: 'warning',
    rawMessage: /^prompt \{messageId\} rejected/,
    properties: { threadId: 't1', messageId },
  })
  follow.close()
})

// #160 §8: run-timing keeps a run's admission until its first delta or its settle. A prompt pi
// rejects after the receipt never settles, and neither does an extension slash command (its
// acceptance IS its completion), so each left one entry for the life of the process.
test('⚠ a rejected prompt and a finished slash command leave no run-timing entry; an ordinary run keeps its own (#160 §8)', async () => {
  let reject = true
  const fake = fakeHost(['mode'], {
    prompt: (request: PromptRequest, outcome: PromptOutcome) => {
      if (request.message === '/mode') outcome.onAccepted()
      else if (reject) outcome.onRejected('the runtime would not take it')
    },
  })
  const url = await startWith(fake)
  const rejected = await prompt(url, 'timing-rejected', 'hello')
  expect(takeFirstDeltaMs('timing-rejected', Number(rejected.body.generation))).toBeUndefined()
  const command = await prompt(url, 'timing-command', '/mode')
  expect(takeFirstDeltaMs('timing-command', Number(command.body.generation))).toBeUndefined()
  // The control: a run that is still going keeps its admission for its first delta.
  reject = false
  const running = await prompt(url, 'timing-running', 'hello')
  expect(takeFirstDeltaMs('timing-running', Number(running.body.generation))).toBeNumber()
})

// @pins prompt-run-settle/refusals
test('⚠ a QUEUED prompt the runtime rejects is said on the follow too, and the run it queued behind stays open', async () => {
  let prompts = 0
  const fake = fakeHost([], {
    prompt: (_request: PromptRequest, outcome: PromptOutcome) => {
      prompts += 1
      // the first prompt opens the run and is accepted; the second — queued behind it — is refused
      if (prompts === 2) outcome.onRejected('Agent is already processing')
    },
  })
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  const first = await prompt(url, 't1', 'first')
  expect(first.body).toMatchObject({ queued: false, generation: 1 })
  await follow.untilFrames(3)
  const second = await prompt(url, 't1', 'second')
  expect(second.body).toMatchObject({ queued: true, generation: 1 })
  await follow.untilFrames(4)
  expect(follow.frames.at(-1)).toEqual({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'prompt-rejected',
      messageId: String(second.body.messageId),
      reason: 'Agent is already processing',
    },
  })
  // The refused prompt was the queued one; the run in flight is untouched.
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })
  follow.close()
})

// @pins abort-clear-restore/one-abort-by-thread abort-clear-restore/queue-cleared-first abort-clear-restore/settle-ends-run
test('⚠ POST …/abort tells pi once and answers with the restored queue; the run still ends on the follow by its settle, not by the route (#116, #75)', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  const trace = flowTrace({ ...ABORT_FLOW, logs })
  fake.traceInto(trace)
  const abortWith = async (threadId: string): Promise<Response> => {
    trace.request('B', 'R', `POST /api/threads/${threadId}/abort`)
    const response = await fetch(`${url}/api/threads/${threadId}/abort`, { method: 'POST' })
    trace.respond('R', 'B', response.status, response.status === 200 ? await response.clone().json() : undefined)
    return response
  }

  // Nothing live: 404. Idle after a run: 409. Neither reaches the session.
  expect((await abortWith('never')).status).toBe(404)
  trace.request('B', 'R', 'POST /api/threads/t1/prompt', { message: 'hello' })
  await prompt(url, 't1', 'hello')
  await follow.untilFrames(3)
  // Two prompts wait behind the run; the stop hands them back, the interrupting one first.
  const built = fake.built[0]
  if (built === undefined) throw new Error('no session built')
  built.queue.enqueued.push('then this')
  built.queue.interrupting.push('wait — stop at the tests')
  trace.send('B', 'P', 'the test queues two prompts behind the run')
  const told = await abortWith('t1')
  expect(told.status).toBe(200)
  expect(await told.json()).toEqual({ threadId: 't1', restored: ['wait — stop at the tests', 'then this'] })
  expect(built.aborts).toBe(1)
  // Both outcomes are records: the 404 above named its thread; the stop names what it handed back.
  logs.assertLogged({ level: 'warning', rawMessage: /^abort refused/, properties: { threadId: 'never', status: 404 } })
  logs.assertLogged({ level: 'info', rawMessage: /^abort: queue of/, properties: { threadId: 't1', restored: 2 } })
  expect(built.queue).toEqual({ interrupting: [], enqueued: [] })
  // The route released nothing: the thread is still busy until pi's own settle arrives.
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })
  // Every follower saw the queue empty (pi's queue_update from clearQueue), then the settle.
  await follow.untilFrames(4)
  expect(follow.frames[3]).toEqual({
    type: 'observation',
    seq: 1,
    observation: { kind: 'queue', interrupting: [], enqueued: [] },
  })
  fake.emit(SETTLED)
  await follow.untilFrames(6)
  expect(follow.frames.slice(4)).toEqual([
    { type: 'observation', seq: 2, observation: { kind: 'settled' } },
    { type: 'status', live: true, busy: false, generation: 1 },
  ])
  const idle = await abortWith('t1')
  expect(idle.status).toBe(409)
  expect(await idle.text()).toContain('nothing is running')
  expect(fake.built[0]?.aborts).toBe(1)
  // The flow page's diagram (#482): refused, stopped with the queue handed back, ended by the settle.
  expect(trace.diagram()).toMatchSnapshot('flow abort-clear-restore: the server')
  follow.close()
})

// ── the mode route (L3 step C): a control, not a prompt ─────────────────────────────

test('⚠ POST …/mode tells the runtime a MODE, never a command, and the change comes back on the follow as permission-mode', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  // Before any prompt: the route builds the thread the way a prompt would.
  const told = await fetch(`${url}/api/threads/t1/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'plan' }),
  })
  expect(told.status).toBe(204)
  expect(fake.built[0]?.modeChanges).toEqual(['plan'])
  // No prompt was sent: the runtime heard a mode.
  expect(fake.built[0]?.prompts).toEqual([])
  // The receipt is the feed's: the host's own event, as the permission-mode observation.
  await follow.untilFrames(3)
  expect(follow.frames.at(-1)).toEqual({
    type: 'observation',
    seq: 1,
    observation: { kind: 'permission-mode', mode: 'plan', available: ['default', 'plan'] },
  })
  // An extension command's acceptance is its completion: the thread is idle again.
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })
  logs.assertLogged({
    level: 'info',
    rawMessage: 'mode change to {mode} told',
    properties: { threadId: 't1', mode: 'plan' },
  })
  follow.close()
})

test('⚠ a mode change the runtime REJECTS after the 204 is said on the follow — the click did nothing, every follower hears it', async () => {
  const fake = fakeHost(['mode'], {
    setPermissionMode: (_mode: string, outcome: PromptOutcome) => outcome.onRejected('the vendor command refused'),
  })
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  const told = await fetch(`${url}/api/threads/t1/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'plan' }),
  })
  expect(told.status).toBe(204)
  await follow.untilFrames(4)
  expect(follow.frames).toContainEqual({
    type: 'observation',
    seq: 1,
    observation: { kind: 'permission-mode-rejected', mode: 'plan', reason: 'the vendor command refused' },
  })
  // …and no permission-mode: the mode did not change.
  expect(
    follow.frames.some((frame) => frame.type === 'observation' && frame.observation.kind === 'permission-mode'),
  ).toBe(false)
  // The lease was released on rejection: the thread is not left busy.
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })
  logs.assertLogged({
    level: 'warning',
    rawMessage: /^mode change to \{mode\} rejected/,
    properties: { threadId: 't1', mode: 'plan' },
  })
  follow.close()
})

test('⚠ a mode the thread does not offer is a 422 and moves nothing; a malformed body is a 400', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const unoffered = await fetch(`${url}/api/threads/t1/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'bypassPermissions' }),
  })
  expect(unoffered.status).toBe(422)
  expect(await unoffered.text()).toContain('Available: default, plan')
  expect(fake.built[0]?.modeChanges).toEqual([])
  logs.assertLogged({ level: 'warning', rawMessage: /^mode change to \{mode\} refused/, properties: { status: 422 } })
  for (const body of ['not json', '{}', '{"mode":""}', '{"mode":7}']) {
    const malformed = await fetch(`${url}/api/threads/t1/mode`, { method: 'POST', body })
    expect(malformed.status).toBe(400)
  }
})

test('⚠ a mode change while the thread is busy is a 409 — not queued behind the run', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  await prompt(url, 't1', 'hello')
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true })
  const busy = await fetch(`${url}/api/threads/t1/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'plan' }),
  })
  expect(busy.status).toBe(409)
  expect(fake.built[0]?.modeChanges).toEqual([])
  fake.emit(SETTLED)
})

// ── continue: a torn thread resumed from its stored state (#436) ─────────────────────

/** A stored thread cut off after its prompt — what a continue is for. */
const TORN: Record<string, FakeStoredThread> = {
  t1: { transcript: [], modified: new Date(0), firstMessage: 'the question' },
}

test("⚠ POST …/continue takes the thread and is released by the run's settle; while it runs a second is a 409 (#436)", async () => {
  const fake = fakeHost(['mode'], {}, TORN)
  const url = await startWith(fake)
  const accepted = await fetch(`${url}/api/threads/t1/continue`, { method: 'POST' })
  expect(accepted.status).toBe(202)
  expect(fake.built[0]?.continues).toBe(1)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })

  const busy = await fetch(`${url}/api/threads/t1/continue`, { method: 'POST' })
  expect(busy.status).toBe(409)
  expect(await busy.text()).toContain('is running')
  expect(fake.built[0]?.continues).toBe(1)

  fake.emit(SETTLED)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false, generation: 1 })
})

// #444, PR #438 review (reproduced through HTTP): two Continues on a cold thread both passed the
// busy peek before the build, both got leases, and the refused one's release left the accepted run
// idle — `busy: false` mid-run, and a Stop that answered "nothing is running".
test('⚠ two Continues racing on a cold thread: one runs, the other is a 409 before it holds the thread; Stop still reaches the run', async () => {
  let running = false
  const build = Promise.withResolvers<void>()
  const fake = fakeHost(
    [],
    {
      // pi's own guard (`isStreaming`): a run already in flight refuses a second.
      continueRun: (outcome: PromptOutcome) => {
        if (running) {
          outcome.onRejected('the thread is running; continue when it settles')
          return
        }
        running = true
        outcome.onAccepted()
      },
    },
    TORN,
    build.promise,
  )
  // The build opens once BOTH requests are past the route's busy peek: each asks for the stored
  // file only after it (`continueThread`), so the second ask is the race's window, held open.
  const storedThreadDirectory = fake.host.storedThreadDirectory.bind(fake.host)
  let asked = 0
  fake.host.storedThreadDirectory = (threadId: string) => {
    asked += 1
    if (asked === 2) build.resolve()
    return storedThreadDirectory(threadId)
  }
  const url = await startWith(fake)
  const continueOnce = (): Promise<Response> => fetch(`${url}/api/threads/t1/continue`, { method: 'POST' })
  const statuses = (await Promise.all([continueOnce(), continueOnce()])).map((answer) => answer.status)
  expect(statuses.toSorted((first, second) => first - second)).toEqual([202, 409])
  expect(fake.built).toHaveLength(1)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })
  expect((await fetch(`${url}/api/threads/t1/abort`, { method: 'POST' })).status).toBe(200)
  expect(fake.built[0]?.aborts).toBe(1)
  fake.emit(SETTLED)
})

test('a continue the runtime refuses is a 422 with its reason, and the thread is released at once (#436)', async () => {
  const fake = fakeHost(
    [],
    { continueRun: (outcome: PromptOutcome) => outcome.onRejected('nothing to continue: the thread ends on a reply') },
    TORN,
  )
  const url = await startWith(fake)
  const refused = await fetch(`${url}/api/threads/t1/continue`, { method: 'POST' })
  expect(refused.status).toBe(422)
  expect(await refused.text()).toBe('nothing to continue: the thread ends on a reply')
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })
  // Released, not stuck: a prompt takes the thread next.
  expect((await prompt(url, 't1', 'hello')).status).toBe(202)
  fake.emit(SETTLED)
})

test('a continue whose runtime faults before accepting or refusing is a 500, and the thread is not left held (#436, PR #442 review)', async () => {
  const fake = fakeHost(
    [],
    {
      continueRun: () => {
        throw new TypeError('lifecycle._runAgentPrompt is not a function')
      },
    },
    TORN,
  )
  const url = await startWith(fake)
  const faulted = await fetch(`${url}/api/threads/t1/continue`, { method: 'POST' })
  expect(faulted.status).toBe(500)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })
  expect((await prompt(url, 't1', 'hello')).status).toBe(202)
  fake.emit(SETTLED)
})

test('a continue of a thread neither live nor stored is a 404, and nothing is built (#436, PR #442 review)', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const missing = await fetch(`${url}/api/threads/nowhere/continue`, { method: 'POST' })
  expect(missing.status).toBe(404)
  expect(await missing.text()).toBe('no thread nowhere to continue')
  expect(fake.built).toEqual([])
})

// ── 2. a dialog parks nothing ─────────────────────────────────────────────────────────

// @pins dialog-ask-answer-settled/parked-in-host dialog-ask-answer-settled/answer-checked
test('⚠ a blocking dialog is an observation on the follow and a unary answer back — nothing parks, nothing expires', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)

  const trace = flowTrace({ ...DIALOG_FLOW, logs })
  fake.traceInto(trace)
  trace.request('B', 'R', 'POST /api/threads/t1/prompt', { message: '/mode' })
  const admitted = await prompt(url, 't1', '/mode')
  expect(admitted.status).toBe(202)
  fake.emit(SELECT_DIALOG)
  await follow.untilFrames(4)
  expect(follow.frames[3]).toMatchObject({
    type: 'observation',
    observation: { kind: 'extension-ui-request', id: 'd1', blocking: true, dialog: expect.anything() },
  })
  // The thread is busy; nothing anywhere holds the question but pi itself.
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true })

  // An unoffered value is refused at the door (#112) — the seam the old resume path
  // closed with the same check; the question stays open, nothing reaches pi.
  const answerWith = async (body: Record<string, unknown>): Promise<Response> => {
    trace.request('B', 'R', 'POST /api/threads/t1/dialog', body)
    const response = await fetch(`${url}/api/threads/t1/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    trace.respond('R', 'B', response.status)
    return response
  }
  const refused = await answerWith({ id: 'd1', value: 'zzz' })
  expect(refused.status).toBe(422)
  expect(await refused.text()).toContain('refused')
  const unknown = await answerWith({ id: 'nope', value: 'a' })
  expect(unknown.status).toBe(404)
  expect(fake.built[0]?.answers).toEqual([])

  const answered = await answerWith({ id: 'd1', value: 'a' })
  expect(answered.status).toBe(204)
  expect(fake.built[0]?.answers).toEqual([{ id: 'd1', value: 'a' }])
  // Answered: the question is spent, a replay is refused.
  expect((await answerWith({ id: 'd1', value: 'a' })).status).toBe(404)

  // A slash command's completion is its acceptance (it never settles) — the lease follows it.
  // Before it: the answer's own settle (#114), so this tab's card drops by the feed, not by faith.
  fake.accept()
  await follow.untilFrames(6)
  expect(follow.frames[4]).toEqual({
    type: 'observation',
    seq: 2,
    observation: { kind: 'dialog-settled', id: 'd1', outcome: 'answered' },
  })
  expect(follow.frames[5]).toEqual({ type: 'status', live: true, busy: false, generation: 1 })
  expect(fake.built[0]?.aborts).toBe(0)
  // The flow page's diagram (#482): asked, refused twice at the door, answered once, settled.
  expect(trace.diagram()).toMatchSnapshot('flow dialog-ask-answer-settled: the server')
  follow.close()
})

// @pins follow-snapshot-frames/snapshot-exact follow-snapshot-frames/snapshot-lists-complete
// @pins dialog-ask-answer-settled/settle-per-id
test("⚠ a question answered in one tab is settled on every follower's feed, and a follow opened under it gets it in the snapshot (#114)", async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const first = await openFollow(url, 't1')
  const second = await openFollow(url, 't1')
  await prompt(url, 't1', '/mode')
  fake.emit(SELECT_DIALOG)
  await first.untilFrames(4)
  await second.untilFrames(4)

  // A third follower arrives while pi waits: the question is in ITS snapshot — a reload
  // under an open question renders the card, not a busy thread with nothing to answer.
  const late = await openFollow(url, 't1')
  await late.untilFrames(1)
  expect(late.frames[0]).toMatchObject({
    type: 'snapshot',
    busy: true,
    openDialogs: [{ id: 'd1', dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] } }],
  })

  // The first tab answers; the second and the late one learn it without touching the route.
  const answered = await fetch(`${url}/api/threads/t1/dialog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', value: 'a' }),
  })
  expect(answered.status).toBe(204)
  const settled: EnsoFollowFrame = {
    type: 'observation',
    seq: 2,
    observation: { kind: 'dialog-settled', id: 'd1', outcome: 'answered' },
  }
  await second.untilFrames(5)
  await late.untilFrames(2)
  expect(second.frames[4]).toEqual(settled)
  expect(late.frames[1]).toEqual(settled)

  // And a follow opened after the settle lists nothing.
  const after = await openFollow(url, 't1')
  await after.untilFrames(1)
  expect(after.frames[0]).toMatchObject({ type: 'snapshot', openDialogs: [] })
  for (const follow of [first, second, late, after]) follow.close()
})

// ── 3. silence ends nothing ───────────────────────────────────────────────────────────

test('⚠ a long silent tool call ends nothing: the follow stays open on keepalives and the thread stays busy', async () => {
  const fake = fakeHost()
  // A keepalive interval far shorter than the run path's 90 s cutoff, so three of them
  // are a silence the cutoff would have called a hung run.
  const url = await startWith(fake, 5)
  const follow = await openFollow(url, 't1')
  await prompt(url, 't1', 'hello')
  await follow.untilFrames(3)

  await follow.untilComments(3)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true })
  expect(follow.frames).toHaveLength(3)

  fake.emit(SETTLED)
  await follow.untilFrames(5)
  expect(follow.frames.at(-1)).toEqual({ type: 'status', live: true, busy: false, generation: 1 })
  follow.close()
})

// ── 4. a follower leaving is not a client leaving a run ───────────────────────────────

test("⚠ closing the follow mid-run aborts nothing — the run is pi's, not the connection's", async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await prompt(url, 't1', 'hello')
  await follow.untilFrames(3)
  follow.close()

  // A second follower opens a NEW generation: a fresh snapshot, taken live, mid-run.
  const again = await openFollow(url, 't1')
  await again.untilFrames(1)
  expect(again.frames[0]).toMatchObject({ type: 'snapshot', live: true, busy: true, generation: 1 })
  expect(fake.built[0]?.aborts).toBe(0)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true })

  fake.emit(SETTLED)
  await again.untilFrames(3)
  expect(again.frames.at(-1)).toEqual({ type: 'status', live: true, busy: false, generation: 1 })
  again.close()
})

// @pins follow-snapshot-frames/snapshot-exact
test('⚠ two followers share one feed: both see every frame with the same seq, and one leaving detaches nothing', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const trace = flowTrace({ ...FOLLOW_FLOW, logs })
  fake.traceInto(trace)
  trace.request('B', 'R', 'GET /api/threads/t1/follow')
  const first = await openFollow(url, 't1')
  await first.untilFrames(1)
  trace.request('C', 'R', 'GET /api/threads/t1/follow')
  const second = await openFollow(url, 't1')
  await second.untilFrames(1)

  trace.request('B', 'R', 'POST /api/threads/t1/prompt', { message: 'hello' })
  await prompt(url, 't1', 'hello')
  fake.emit(TEXT_DELTA)
  await first.untilFrames(4)
  await second.untilFrames(4)
  expect(second.frames.slice(1)).toEqual(first.frames.slice(1))
  expect(first.frames[3]).toMatchObject({ type: 'observation', seq: 1 })

  // The first follower leaves; the feed stays attached for the second (the last-listener
  // detach must count listeners, not followers that ever existed).
  trace.send('B', 'R', 'closes its follow')
  first.close()
  fake.emit(SETTLED)
  await second.untilFrames(6)
  expect(second.frames.slice(4)).toEqual([
    { type: 'observation', seq: 2, observation: { kind: 'settled' } },
    { type: 'status', live: true, busy: false, generation: 1 },
  ])
  // The flow page's diagram (#482): two follows, their snapshots, one feed.
  expect(trace.diagram()).toMatchSnapshot('flow follow-snapshot-frames: two followers, one feed')
  second.close()
})

test('a confirm dialog round-trips through /dialog; a value answer to it is refused', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await prompt(url, 't1', '/mode')
  fake.emit({
    kind: 'extension-ui-request',
    id: 'c1',
    method: 'confirm',
    blocking: true,
    dialog: { method: 'confirm', title: 'Apply?', message: 'It is reversible' },
    origin: 'run',
  })
  await follow.untilFrames(4)
  const answerWith = (body: Record<string, unknown>): Promise<Response> =>
    fetch(`${url}/api/threads/t1/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await answerWith({ id: 'c1', value: 'yes' })).status).toBe(422)
  expect((await answerWith({ id: 'c1', confirmed: true })).status).toBe(204)
  expect(fake.built[0]?.answers).toEqual([{ id: 'c1', confirmed: true }])
  follow.close()
})

// The questionnaire's `{ answers }` over the HTTP route the card posts to (#12): the shape is read
// here (400 before the question is consulted), then held to THIS question — a label it never
// offered is the select-injection seam again, with a second door (422, the question stays open).
test('a questionnaire round-trips { answers } through /dialog; a malformed body is 400, an unoffered label 422', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await prompt(url, 't1', 'set up storage')
  fake.emit({
    kind: 'extension-ui-request',
    id: 'q1',
    method: 'questionnaire',
    blocking: true,
    dialog: {
      method: 'questionnaire',
      title: 'Which database?',
      questions: [
        {
          header: 'Database',
          question: 'Which database?',
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
          multiSelect: false,
        },
      ],
    },
    origin: 'run',
  })
  await follow.untilFrames(4)
  const answerWith = (body: Record<string, unknown>): Promise<Response> =>
    fetch(`${url}/api/threads/t1/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await answerWith({ id: 'q1', answers: 'Postgres' })).status).toBe(400)
  expect((await answerWith({ id: 'q1', answers: [{ selected: ['MySQL'] }] })).status).toBe(422)
  expect((await answerWith({ id: 'q1', answers: [{ selected: ['SQLite'] }] })).status).toBe(204)
  expect(fake.built[0]?.answers).toEqual([{ id: 'q1', answers: [{ selected: ['SQLite'] }] }])
  follow.close()
})

/**
 * ⚠ `answerThreadDialog` decides "is this a cancellation?" by the VALUE of `cancelled`, never by
 * the key being present. Before #225 `DialogAnswer`'s three arms overlapped, the guard read
 * `'cancelled' in answer`, and ANY object carrying that key — `cancelled: false` included —
 * skipped `validateDialogAnswer` and handed pi an unoffered select value verbatim. The route's own
 * `readDialogBody` never builds such an object; it is every OTHER producer of a `DialogAnswer`
 * (`ThreadRuntime.answerDialog`'s public signature, a runtime fake, a future surface) that the
 * type now stops. A red line here means the select-injection fence is open again.
 */
test('⚠ a cancellation is a value, not a key: `cancelled: false` carrying an unoffered value is refused (#225)', () => {
  const answers: DialogAnswer[] = []
  const deps = {
    threads: {
      peek: () => ({
        hosted: {
          runtime: {
            openDialogs: () => [{ id: 'd1', dialog: { method: 'select', title: 'Pick', options: ['a', 'b'] } }],
            answerDialog: (answer: DialogAnswer) => answers.push(answer),
          },
        },
      }),
    },
  } as unknown as FollowRouteDeps

  // The cast is the finding: this shape is no longer a `DialogAnswer`, so only a producer
  // outside the contract can present it — which is exactly who the guard has to survive.
  const smuggled = { id: 'd1', cancelled: false, value: 'zzz' } as unknown as DialogAnswer
  expect(answerThreadDialog(deps, 't1', smuggled)).toMatchObject({ status: 422 })
  expect(answers).toEqual([])

  // …and the compile-level half of the same claim, asserted as a TYPE rather than with the
  // type checker's expect-error directive, which the no-suppressions gate bans (#82). The
  // arms' `?: never` members are what makes the mixed shape assignable to none of them, so
  // this alias is `true`. Untag the union and it becomes `never`, and `bun run check` fails
  // at tsc before any of the above runs.
  type CancellationCannotConfirm = { id: 'd1'; cancelled: true; confirmed: true } extends DialogAnswer ? never : true
  const cancellationCannotConfirm: CancellationCannotConfirm = true
  expect(cancellationCannotConfirm).toBe(true)
  // The value still has to exist to reach the runtime half, and only a producer outside the
  // contract can present it — the same cast, for the same reason, as `smuggled` above.
  const mixed = { id: 'd1', cancelled: true, confirmed: true } as unknown as DialogAnswer
  expect(answerThreadDialog(deps, 't1', mixed)).toEqual({ status: 204 })
  expect(answers).toEqual([mixed])
})

// ── 5. a busy thread queues through pi (#75) ──────────────────────────────────────────

// @pins prompt-run-settle/busy-queued
test('a prompt on a busy thread is enqueued through the runtime, not refused and not re-acquired', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const first = await prompt(url, 't1', 'one')
  expect(first.body).toMatchObject({ generation: 1, queued: false })
  const second = await prompt(url, 't1', 'two')
  expect(second.status).toBe(202)
  expect(second.body).toMatchObject({ generation: 1, queued: true })
  expect(fake.built[0]?.prompts).toEqual([{ message: 'one' }, { message: 'two', admission: 'enqueue' }])
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })
})

// ⚠ The record on the BUSY path, which is the one nothing asserted (PR #326 review). Two facts
// are logged here — what the SERVER did (`queued`) and what the CLIENT asked for (`enqueue`) —
// and #216's rename briefly gave both the key `admission`, so the object literal's spread
// silently overwrote the outcome on every prompt typed while a run is in flight. The idle-path
// assertion above could not see it: there is no requested admission to collide with when the
// thread is idle, which is exactly why the coverage read as complete and was not.
test('⚠ the queued prompt records BOTH what the server did and what the client asked for (#132, #216)', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  await prompt(url, 't1', 'one')
  logs.clear()
  const queuedPrompt = await promptWith(url, 't1', { message: 'two', admission: 'enqueue' })
  expect(queuedPrompt.status).toBe(202)
  logs.assertLogged({
    level: 'info',
    rawMessage: 'prompt {messageId} {admission} on run {generation}',
    properties: { threadId: 't1', generation: 1, admission: 'queued', requestedAdmission: 'enqueue' },
  })
})

// ── 7. two threads are two feeds (#103 invariant 1) ────────────────────────────────

test("⚠ what happens on thread A is on A's feed only: B's follow, snapshot, summary and dialog route see none of it", async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  // B first, then A, so the fake's emitter targets A's session (it follows the latest build).
  await prompt(url, 'b', 'hello from b')
  const followB = await openFollow(url, 'b')
  await followB.untilFrames(1)
  await prompt(url, 'a', '/mode')
  const followA = await openFollow(url, 'a')
  await followA.untilFrames(1)
  fake.emit(SELECT_DIALOG)
  fake.emit(TEXT_DELTA)
  await followA.untilFrames(3)
  expect(
    followA.frames.slice(1).map((frame) => (frame.type === 'observation' ? frame.observation.kind : frame.type)),
  ).toEqual(['extension-ui-request', 'text-delta'])
  // B's feed: its own snapshot, nothing after — no seq advanced, no question, no text.
  await followB.untilComments(2)
  expect(followB.frames).toHaveLength(1)
  expect(followB.frames[0]).toMatchObject({ type: 'snapshot', threadId: 'b', busy: true, openDialogs: [] })
  // A follow opened on B NOW still lists no question; the summaries are per thread.
  const lateB = await openFollow(url, 'b')
  await lateB.untilFrames(1)
  expect(lateB.frames[0]).toMatchObject({ type: 'snapshot', threadId: 'b', openDialogs: [] })
  expect(await threadSummary(url, 'a')).toMatchObject({ busy: true, generation: 1 })
  expect(await threadSummary(url, 'b')).toMatchObject({ busy: true, generation: 1 })
  // A's question cannot be answered through B: the id is not one of B's open questions.
  const crossed = await fetch(`${url}/api/threads/b/dialog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', value: 'a' }),
  })
  expect(crossed.status).toBe(404)
  expect(fake.built.map((record) => record.answers)).toEqual([[], []])
  for (const follow of [followA, followB, lateB]) follow.close()
})

// ── 6. refusals are plain HTTP, not stream events ─────────────────────────────────────

// @pins prompt-run-settle/refusals
test('an unknown slash command is a 400 at admission and releases the thread', async () => {
  const fake = fakeHost(['mode'])
  const url = await startWith(fake)
  const refused = await fetch(`${url}/api/threads/t1/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '/settings' }),
  })
  expect(refused.status).toBe(400)
  expect(await refused.text()).toContain('/settings is not available')
  expect(fake.built[0]?.prompts).toEqual([])
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: false })
})

// ⚠ THE BUSY PATH SKIPPED THE CHECK. A `/login` typed while a run held the thread was queued
// straight into the runtime — which treats a slash command it does not know as ordinary text —
// and nothing happened: no refusal, no record, no answer. Found live, the day #336 merged. The
// refusal is the same on both paths, and the run in flight is untouched by it.
test('⚠ an unknown slash command sent to a BUSY thread is the same 400 and queues nothing; a known one still queues', async () => {
  let prompts = 0
  const fake = fakeHost(['mode'], {
    prompt: () => {
      prompts += 1
    },
  })
  const url = await startWith(fake)
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)
  expect((await prompt(url, 't1', 'first')).body).toMatchObject({ queued: false, generation: 1 })
  await follow.untilFrames(3)
  const refused = await fetch(`${url}/api/threads/t1/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '/login' }),
  })
  expect(refused.status).toBe(400)
  expect(await refused.text()).toContain('/login is not available on this surface')
  // A space in front is not a different question (#337 review): still refused, still nothing queued.
  const spaced = await fetch(`${url}/api/threads/t1/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '  /login' }),
  })
  expect(spaced.status).toBe(400)
  // Nothing reached the runtime for either, and the run it would have queued behind is untouched.
  expect(prompts).toBe(1)
  expect(await threadSummary(url, 't1')).toMatchObject({ busy: true, generation: 1 })
  // …and the other half of the contract: a command this surface CAN run still queues.
  expect((await prompt(url, 't1', '/mode plan')).body).toMatchObject({ queued: true, generation: 1 })
  expect(prompts).toBe(2)
  follow.close()
})

test('a whitespace-only message is a 400 before any lease or session exists', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const refused = await fetch(`${url}/api/threads/t1/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  })
  expect(refused.status).toBe(400)
  expect(fake.built).toHaveLength(0)
  expect(await threadSummary(url, 't1')).toBeUndefined()
})

// ── 9. images on a prompt (#68) ─────────────────────────────────────────────────────

/** A real 1×1 PNG — signature `89 50 4E 47`, IHDR, IDAT, IEND — the smallest file a decoder accepts. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function promptWith(url: string, threadId: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${url}/api/threads/${threadId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

test("a real PNG's bytes reach pi's prompt.images unchanged, byte for byte; the audit record carries the count and kinds, never the data", async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const data = ONE_PIXEL_PNG.toString('base64')
  const admitted = await promptWith(url, 't1', {
    message: 'what does this say?',
    images: [{ mimeType: 'image/png', data }],
  })
  expect(admitted.status).toBe(202)

  const received = fake.built[0]?.prompts[0]
  expect(received?.message).toBe('what does this say?')
  expect(received?.images).toEqual([{ type: 'image', mimeType: 'image/png', data }])
  expect(Buffer.from(received?.images?.[0]?.data ?? '', 'base64').equals(ONE_PIXEL_PNG)).toBe(true)

  logs.assertLogged({
    level: 'info',
    rawMessage: 'prompt carries {count} image(s): {mimeTypes}, {bytes} bytes',
    // A predicate: the recorder compares values with `Object.is`, which no two arrays pass.
    properties: (properties: Readonly<Record<string, unknown>>) =>
      properties.threadId === 't1' &&
      properties.count === 1 &&
      JSON.stringify(properties.mimeTypes) === JSON.stringify(['image/png']) &&
      properties.bytes === ONE_PIXEL_PNG.length,
  })
  expect(logs.records.map((record) => JSON.stringify(record.properties)).join('\n')).not.toContain(data.slice(0, 24))
})

test('[WARN] a text-only prompt has NO images key (the committed shape), and images ride a queued prompt on a busy thread too', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  await promptWith(url, 't1', { message: 'one' })
  expect(fake.built[0]?.prompts[0]).toEqual({ message: 'one' })
  expect(fake.built[0]?.prompts[0]).not.toHaveProperty('images')

  const data = ONE_PIXEL_PNG.toString('base64')
  const queued = await promptWith(url, 't1', { message: 'and this', images: [{ mimeType: 'image/webp', data }] })
  expect(queued.status).toBe(202)
  expect(fake.built[0]?.prompts[1]).toEqual({
    message: 'and this',
    admission: 'enqueue',
    images: [{ type: 'image', mimeType: 'image/webp', data }],
  })
})

test('[WARN] an image outside the allowlist, over the byte cap, or too many is a 400 that names the image and the reason — never silently dropped', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const data = ONE_PIXEL_PNG.toString('base64')

  const svg = await promptWith(url, 't1', { message: 'x', images: [{ mimeType: 'image/svg+xml', data }] })
  expect(svg.status).toBe(400)
  expect(svg.text).toContain('/images/0/mimeType')

  const notBase64 = await promptWith(url, 't1', {
    message: 'x',
    images: [{ mimeType: 'image/png', data: 'data:image/png;base64,AAAA' }],
  })
  expect(notBase64.status).toBe(400)
  expect(notBase64.text).toContain('/images/0/data')

  // Over the cap by one byte, decoded — the base64 string is 4/3 longer and would pass a length check.
  const oversized = Buffer.alloc(ENSO_IMAGE_MAX_BYTES + 1).toString('base64')
  const big = await promptWith(url, 't1', {
    message: 'x',
    images: [
      { mimeType: 'image/png', data },
      { mimeType: 'image/jpeg', data: oversized },
    ],
  })
  expect(big.status).toBe(400)
  expect(big.text).toBe('image 2 of 2 is 5.0 MB; an image is at most 5.0 MB')

  const tooMany = await promptWith(url, 't1', {
    message: 'x',
    images: Array.from({ length: ENSO_PROMPT_MAX_IMAGES + 1 }, () => ({ mimeType: 'image/png', data })),
  })
  expect(tooMany.status).toBe(400)
  expect(tooMany.text).toContain('/images')

  const empty = await promptWith(url, 't1', { message: 'x', images: [] })
  expect(empty.status).toBe(400)

  // Base64 that is not whole groups is "not base64", refused by path — not decoded leniently into a truncated image.
  const ragged = await promptWith(url, 't1', { message: 'x', images: [{ mimeType: 'image/png', data: 'AAAAA' }] })
  expect(ragged.status).toBe(400)
  expect(ragged.text).toContain('/images/0/data')

  // None of them reached pi, and no session was built for a prompt that was refused at the door.
  expect(fake.built).toHaveLength(0)
})

test('the edges are inside: an image of exactly the cap, exactly the maximum count (a gif among them), and an image with no words at all', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  const data = ONE_PIXEL_PNG.toString('base64')

  const atCap = Buffer.alloc(ENSO_IMAGE_MAX_BYTES).toString('base64')
  expect(
    (await promptWith(url, 't1', { message: 'x', images: [{ mimeType: 'image/jpeg', data: atCap }] })).status,
  ).toBe(202)
  expect(fake.built[0]?.prompts[0]?.images?.[0]?.data.length).toBe(atCap.length)

  const twenty = Array.from({ length: ENSO_PROMPT_MAX_IMAGES }, (_, index) => ({
    mimeType: index === 0 ? ('image/gif' as const) : ('image/png' as const),
    data,
  }))
  expect((await promptWith(url, 't1', { message: 'x', images: twenty })).status).toBe(202)
  expect(fake.built[0]?.prompts[1]?.images?.map((image) => image.mimeType)).toEqual(
    twenty.map((image) => image.mimeType),
  )

  // An image with an empty message is a prompt: pi-ai drops the empty text block and keeps
  // the image (`anthropic-messages.js`, `filteredBlocks`). Only nothing-at-all is refused.
  expect((await promptWith(url, 't1', { message: '', images: [{ mimeType: 'image/png', data }] })).status).toBe(202)
  expect(fake.built[0]?.prompts[2]).toMatchObject({ message: '', images: [{ type: 'image', mimeType: 'image/png' }] })
  expect((await promptWith(url, 't1', { message: '  ' })).status).toBe(400)
})

test('[WARN] a body past the wire cap is a 413 and the read stops — the server does not buffer it first', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  // Streamed in chunks so the cap has to trip mid-body, not on a Content-Length it never reads.
  const chunk = 'x'.repeat(1024 * 1024)
  const body = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      for (let sent = 0; sent <= ENSO_PROMPT_BODY_MAX_BYTES + chunk.length; sent += chunk.length) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })
  // `duplex` is required for a streaming request body and absent from the DOM lib's
  // `RequestInit`; widened here rather than suppressed (#249), so every other field in this
  // init is still type-checked instead of the whole call being exempted.
  const init: RequestInit & { readonly duplex: 'half' } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  }
  const response = await fetch(`${url}/api/threads/t1/prompt`, init)
  expect(response.status).toBe(413)
  expect(await response.text()).toContain('a prompt body is at most')
  expect(fake.built).toHaveLength(0)
})

// ── 10. the wire does not carry what the browser throws away (#279) ──────────────────

/** pi's cadence: the whole output SO FAR, every tick — `bash` reports one every 100 ms. */
function partialToolResult(text: string): EnsoObservation {
  return { kind: 'tool-result', toolCallId: 'call-1', toolName: 'bash', text, complete: false, isError: false }
}

test('⚠ an accumulated partial tool result never crosses the follow, the completed one does whole, and the sent tail counts only what crossed (#279)', async () => {
  const fake = fakeHost()
  const url = await startWith(fake)
  // Prompted BEFORE the follow opens, so the snapshot is recorded on a live thread and the
  // build/acquire status frames are already behind us: every frame below is an observation.
  await prompt(url, 't1', 'run the build')
  const follow = await openFollow(url, 't1')
  await follow.untilFrames(1)

  for (const text of ['a', 'ab', 'abc']) fake.emit(partialToolResult(text))
  // A different kind, emitted after them through the same writer: its arrival is what makes
  // the absence of the three above a decision rather than a delay.
  fake.emit(TEXT_DELTA)
  await follow.untilFrames(2)
  fake.emit({
    kind: 'tool-result',
    toolCallId: 'call-1',
    toolName: 'bash',
    text: 'abc',
    complete: true,
    isError: false,
  })
  await follow.untilFrames(3)

  // The partials are numbered in-process — the completed result is seq 5, not seq 2 — and
  // the text that crossed is the whole accumulated output, unshortened.
  expect(follow.frames).toEqual([
    expect.objectContaining({ type: 'snapshot', threadId: 't1' }),
    { type: 'observation', seq: 4, observation: TEXT_DELTA },
    {
      type: 'observation',
      seq: 5,
      observation: {
        kind: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'bash',
        text: 'abc',
        complete: true,
        isError: false,
      },
    },
  ])

  // The sent tail (#97) claims exactly the frames that crossed: one `tool-result` row, and
  // a total equal to the frames the follower actually read.
  const events = (await (await fetch(`${url}/api/threads/t1/events`)).json()) as {
    sent: Array<{ type: string; name?: string; count: number }>
  }
  expect(events.sent.map(({ type, name, count }) => ({ type, name, count }))).toEqual([
    { type: 'snapshot', name: undefined, count: 1 },
    { type: 'observation', name: 'text-delta', count: 1 },
    { type: 'observation', name: 'tool-result', count: 1 },
  ])
  expect(events.sent.reduce((total, event) => total + event.count, 0)).toBe(follow.frames.length)
  follow.close()
})
