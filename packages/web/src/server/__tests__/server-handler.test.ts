import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EnsoObservation,
  EnsoStoredThread,
  EnsoThreadCommands,
  EnsoThreadEvents,
  EnsoThreadHistory,
  EnsoThreadInspection,
  EnsoThreadSummary,
  type EnsoTranscriptEntry,
  type PromptOutcome,
  type PromptRequest,
  type ThreadRuntime,
} from '@enso/core'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import { Check } from 'typebox/value'
import type { AgentHost, HostedThreadInspection } from '../../host/agent-host.ts'
import { transcriptOf } from '../../host/transcript.ts'
import { startEnsoServer } from '../index.ts'
import {
  createFakeAgentHost,
  createFakeHostedThread,
  type FakeStoredThread,
  type FakeThreadParts,
  type FakeThreadRecord,
  fakeHostRows,
} from './fake-hosted-thread.ts'
import { openFollow } from './follow-reader.ts'

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordEnsoLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseEnsoLogs)

/**
 * The server's routes beside the wire, over real HTTP (#76, #86, #95, #97): what the
 * inspection, history and session-listing routes report about threads the prompt route
 * built. A fake host whose sessions record `abort` / `dispose` calls, handed in through
 * `EnsoServerOptions.host`, makes each contract an assertion. The server binds port 0;
 * `listening` yields the bound URL. The wire itself is `follow.test.ts`.
 */

/** How a scripted session pushes observations at its followers. */
type EmitPiEvent = (observation: EnsoObservation) => void

interface FakeSessionScript {
  /** Called on every prompt; emit events through `emit`, signal acceptance via `outcome`. */
  onPrompt: (emit: EmitPiEvent, outcome: PromptOutcome, message: string) => void
  /** Further runtime members to replace over the fake's own — a fault to inject, say. */
  runtime?: (parts: FakeThreadParts) => Partial<ThreadRuntime>
}

/**
 * A branch shaped like pi's, with a picc `modes` entry, and NO file on disk — the unflushed
 * state #86's inspection must report honestly rather than invent (#86). The fixture is
 * written as the file holds it and crosses the seam as the transcript of ours, through the
 * host's own converter — what the real host hands out (L2).
 */
function piccShapedInspection(): Partial<HostedThreadInspection> {
  return {
    sessionDir: '/fake/agent/sessions/--fake-cwd--',
    entries: transcriptOf([
      { type: 'session', id: 'root', parentId: null, timestamp: '2026-09-08T00:00:00.000Z' },
      {
        type: 'custom',
        customType: 'modes',
        data: { mode: 'plan' },
        id: 'm1',
        parentId: 'root',
        timestamp: '2026-09-08T00:00:01.000Z',
      },
    ]),
    commands: ['mode', 'plan'],
  }
}

/** What this fake host says a fresh thread starts in — picc's five, in picc's order, as the real host would. */
const FRESH_MODE = { mode: 'default', available: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] }

function fakeHost(
  script: FakeSessionScript,
  stored: Record<string, FakeStoredThread> = {},
): { host: AgentHost; built: FakeThreadRecord[]; requested: string[] } {
  const built: FakeThreadRecord[] = []
  /** Thread ids the host was asked to build, in order — the prompt route passes the id through. */
  const requested: string[] = []
  const host = createFakeAgentHost(
    (threadId: string) => {
      requested.push(threadId)
      const fake = createFakeHostedThread({
        runtime: (parts: FakeThreadParts) => ({
          prompt: (request: PromptRequest, outcome: PromptOutcome) => {
            parts.record.prompts.push(request)
            script.onPrompt(parts.emit, outcome, request.message)
          },
          // picc's row first, the host's two after — the real host's order (#338 slice 2).
          listCommands: () => [{ name: 'mode', source: 'extension' }, ...fakeHostRows(parts.record)],
          permissionModeState: () => ({ mode: 'default', available: ['default', 'acceptEdits'] }),
          ...script.runtime?.(parts),
        }),
        inspect: piccShapedInspection(),
      })
      built.push(fake.record)
      return Promise.resolve(fake.hosted)
    },
    stored,
    FRESH_MODE,
  )
  return { host, built, requested }
}

/** A harness dir with an empty pi manifest — enough for `assertVendorLinks` to pass. */
function emptyHarnessDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-handler-harness-'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fake-harness', pi: {} }))
  return directory
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

function neverPrompted(): void {
  // The 400 path must reject before any prompt reaches a session.
}

/** A prompt that settles synchronously — the run is over by the time the receipt is read. */
const settlesAtOnce: FakeSessionScript = {
  onPrompt: (emit: EmitPiEvent, outcome: PromptOutcome) => {
    outcome.onAccepted()
    emit(SETTLED)
  },
}

/** A prompt that asks a question and never settles — the thread stays busy. */
const asksAndWaits: FakeSessionScript = {
  onPrompt: (emit: EmitPiEvent, _outcome: PromptOutcome, message: string) => {
    if (message === '/mode') emit(SELECT_DIALOG)
  },
}

const openServers: Array<{ close: () => Promise<void> }> = []
const openFollows: AbortController[] = []
afterEach(async () => {
  for (const follow of openFollows.splice(0)) follow.abort()
  for (const started of openServers.splice(0)) await started.close()
})

async function startWith(
  script: FakeSessionScript,
  stored: Record<string, FakeStoredThread> = {},
  /** Wrap the fake host — a test that needs something to happen mid-read replaces one method. */
  wrapHost: (host: AgentHost) => AgentHost = (host: AgentHost) => host,
): Promise<{ url: string; built: FakeThreadRecord[]; requested: string[] }> {
  const { host, built, requested } = fakeHost(script, stored)
  const started = startEnsoServer({
    cwd: tmpdir(),
    harnessPackageDir: emptyHarnessDir(),
    agentDir: mkdtempSync(join(tmpdir(), 'enso-handler-agent-')),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
    host: wrapHost(host),
  })
  openServers.push(started)
  const url = await started.listening
  return { url, built, requested }
}

async function prompt(url: string, threadId: string, message: string): Promise<number> {
  const response = await fetch(`${url}/api/threads/${encodeURIComponent(threadId)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  await response.text()
  return response.status
}

test('⚠ two prompts on one thread reuse ONE session; a second thread gets its own (#43 over HTTP)', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  expect(await prompt(url, 't1', 'one')).toBe(202)
  expect(await prompt(url, 't1', 'two')).toBe(202)
  expect(built).toHaveLength(1)
  expect(built[0]?.prompts.map((request) => request.message)).toEqual(['one', 'two'])
  await prompt(url, 't2', 'three')
  expect(built).toHaveLength(2)
  // A settled run releases the thread and never aborts or disposes the session.
  expect(built.map((record) => [record.aborts, record.disposed])).toEqual([
    [0, 0],
    [0, 0],
  ])
})

// The header's first paint (#84): what a fresh thread starts in, answered WITHOUT building
// a session — asking must not be the thing that spins pi up.
test('GET /api/mode reports what the HOST says a fresh thread starts in, and builds no session', async () => {
  const { url, built } = await startWith({ onPrompt: neverPrompted })
  const response = await fetch(`${url}/api/mode`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(FRESH_MODE)
  expect(built).toHaveLength(0)
})

// ── session inspection (#86) ─────────────────────────────────────────────────

// ⚠ LOOKING MUST NOT BUILD. `peek`, never `acquire`: an inspection request for a thread
// that has never run must be a 404, not the thing that spins pi up for it.
test('⚠ inspecting an unknown thread is a 404 and builds no session', async () => {
  const { url, built } = await startWith({ onPrompt: neverPrompted })
  const listed = await fetch(`${url}/api/threads`)
  expect(await listed.json()).toEqual([])
  const response = await fetch(`${url}/api/threads/never-ran`)
  expect(response.status).toBe(404)
  expect(built).toHaveLength(0)
})

// ⚠ A BAD URL MUST NOT KILL THE SERVER. `decodeURIComponent` throws on a malformed escape,
// and before the guard that throw escaped the request listener and took the whole process
// down — every live session with it — from one hand-typed URL (PR #87 review, reproduced).
// The decisive assertion is the SECOND request: the server is still there to answer it.
test('⚠ a malformed thread id is a 400, and the server survives to answer the next request', async () => {
  const { url, built } = await startWith({ onPrompt: neverPrompted })
  const malformed = await fetch(`${url}/api/threads/%`)
  expect(malformed.status).toBe(400)
  const afterwards = await fetch(`${url}/api/threads`)
  expect(afterwards.status).toBe(200)
  expect(built).toHaveLength(0)
})

// ⚠ THE ID IS A FILENAME. Since #95 pi names the session file after the thread id, so an id
// from a request is a path component (Claude review on PR #104). Refused at every entry
// point before anything is built; the traversal never reaches the host.
test('⚠ a thread id that is not thread-id shaped is a 400 at every entry point, and builds nothing', async () => {
  const { url, built, requested } = await startWith({ onPrompt: neverPrompted })
  const evil = encodeURIComponent('../../evil')
  expect(await prompt(url, '../../evil', 'hi')).toBe(400)
  for (const route of ['', '/history', '/events', '/follow', '/commands']) {
    expect((await fetch(`${url}/api/threads/${evil}${route}`)).status).toBe(400)
  }
  // The one thread route that DOES build on purpose (#338 slice 2, #341) — so the one whose
  // id check "builds nothing" most needs to cover (PR #344 review).
  const command = await fetch(`${url}/api/threads/${evil}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'thinking', value: 'high' }),
  })
  expect(command.status).toBe(400)
  expect(built).toHaveLength(0)
  expect(requested).toEqual([])
  // And the server is still up.
  expect((await fetch(`${url}/api/threads`)).status).toBe(200)
})

// ⚠ THE PALETTE'S SOURCE, SAID (#338). A thread has no session until its first prompt, and
// looking must not build (#86) — so the route cannot ask a runtime that does not exist. Every
// session builds its list from the same sources under the same configuration, as they stood at
// that build, so the last built session's list is the next one's until a file changes on disk;
// the answer says which it is, and a palette that quietly showed a stale list would be a palette
// that lies. Before any session: `none`, an empty list, no build. A `remembered` host row's
// options are the last build's too — the models a provider offered THEN, credentials as they
// stood then — which is why the row keeps them and loses its value.
test('⚠ GET …/commands says where its list came from: none before any session, remembered after one, live for the thread that has it', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const commandsOf = async (threadId: string): Promise<unknown> =>
    (await fetch(`${url}/api/threads/${threadId}/commands`)).json()

  const before = await commandsOf('never-ran')
  expect(Check(EnsoThreadCommands, before)).toBe(true)
  expect(before).toEqual({ threadId: 'never-ran', commands: [], source: 'none' })
  expect(built).toHaveLength(0)

  await prompt(url, 'ran', 'hello')
  const live = (await commandsOf('ran')) as EnsoThreadCommands
  expect(live).toMatchObject({ threadId: 'ran', source: 'live' })
  // pi's row first, then the host's (#338 slices 2 and 3) — the settings with their CURRENT value
  // on a live thread, the flows with none (there is no "current" login).
  expect(live.commands.map((command) => [command.name, command.source])).toEqual([
    ['mode', 'extension'],
    ['model', 'host'],
    ['thinking', 'host'],
    ['login', 'host'],
    ['logout', 'host'],
  ])
  expect(live.commands[3]).toMatchObject({ kind: 'flow', options: [{ id: 'fake/oauth' }, { id: 'fake/api_key' }] })
  expect(live.commands[3]?.value).toBeUndefined()
  expect(live.commands[1]).toMatchObject({ kind: 'select', value: 'fake/fake-1' })
  expect(live.commands[1]?.options?.map((option) => option.id)).toEqual(['fake/fake-1', 'fake/fake-2'])
  expect(live.commands[2]).toMatchObject({
    kind: 'level',
    value: 'medium',
    options: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }],
  })

  // Another thread, no session of its own: the remembered list, and still no build for it. The
  // host rows keep their options (every session offers the same) and LOSE their value: this
  // thread has no current model, and a value that was another session's would be a lie.
  const remembered = (await commandsOf('never-ran')) as EnsoThreadCommands
  expect(remembered).toMatchObject({ threadId: 'never-ran', source: 'remembered' })
  expect(remembered.commands.map((command) => command.name)).toEqual(['mode', 'model', 'thinking', 'login', 'logout'])
  for (const hostRow of remembered.commands.filter((command) => command.source === 'host')) {
    expect(hostRow.value).toBeUndefined()
    expect(hostRow.options?.length ?? 0).toBeGreaterThan(0)
  }
  expect(built).toHaveLength(1)
})

// ⚠ A HOST COMMAND IS A CONTROL ROUTE, NOT A PROMPT (#338 slice 2, the control half of #44). It
// BUILDS a thread that has never run — choosing the model before the first prompt is the whole
// point (#341: "the default is Cursor, I have no Cursor") — and the change is never the route's
// answer: it is the `model` observation every follower reads, and the next snapshot's `model`.
test('⚠ POST …/command sets the thinking level on a thread that never ran: 204, one build, the feed says it, the next snapshot carries it', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const run = async (threadId: string, body: unknown): Promise<Response> =>
    fetch(`${url}/api/threads/${threadId}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 'fresh', controller)
  expect(follow.frames[0]).toMatchObject({ type: 'snapshot', live: false, model: null })

  const accepted = await run('fresh', { name: 'thinking', value: 'high' })
  expect(accepted.status).toBe(204)
  expect(built).toHaveLength(1)
  expect(built[0]?.hostCommands).toEqual([{ name: 'thinking', value: 'high' }])
  // snapshot, status(built), model, status(released) — the change is on the feed.
  await follow.untilFrames(4)
  const modelFrame = follow.frames.find((frame) => frame.type === 'observation' && frame.observation.kind === 'model')
  expect(modelFrame).toMatchObject({
    observation: { kind: 'model', thinkingLevel: 'high', model: { name: 'Fake One' } },
  })

  // A fresh follower's snapshot is the state as it stands now.
  const later = new AbortController()
  openFollows.push(later)
  const again = await openFollow(url, 'fresh', later)
  expect(again.frames[0]).toMatchObject({ type: 'snapshot', live: true, model: { thinkingLevel: 'high' } })

  // A model switch: the same route, the other row.
  expect((await run('fresh', { name: 'model', value: 'fake/fake-2' })).status).toBe(204)
  const switched = await run('fresh', { name: 'model', value: 'nope/nothing' })
  expect(switched.status).toBe(422)
  expect(await switched.text()).toBe('model nope/nothing is not available here')
  const unknown = await run('fresh', { name: 'compact' })
  expect(unknown.status).toBe(422)
  expect(await unknown.text()).toBe('no host command named compact')
  const malformed = await run('fresh', '{"name":')
  expect(malformed.status).toBe(400)
  const extra = await run('fresh', { name: 'thinking', value: 'low', extra: 1 })
  expect(extra.status).toBe(400)
  // Still the one build: every run above acquired the same live thread.
  expect(built).toHaveLength(1)
})

// ⚠ A FAULT IS NOT A REFUSAL (PR #344 review): only a refusal the host decided is the 422 the user
// reads as "your choice was refused"; anything else the runtime throws is the handler's 500.
test('POST …/command: a runtime fault is a 500, never a 422 dressed as a refusal', async () => {
  const { url } = await startWith({
    onPrompt: neverPrompted,
    runtime: () => ({
      runHostCommand: () => Promise.reject(new TypeError('session.setModel is not a function')),
    }),
  })
  const faulted = await fetch(`${url}/api/threads/faulty/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'thinking', value: 'low' }),
  })
  expect(faulted.status).toBe(500)
})

// ⚠ A FLOW STARTS AND THE ROUTE SAYS SO (#338 slice 3): a login may wait minutes on a device code.
// 202 once the host has accepted the option; the questions and progress are on the feed; and the
// thread is NOT busy meanwhile — a login is not a run, the lease is released on acceptance, so the
// composer stays open and a prompt during the wait is a prompt (the smoke found a held lease
// locking the thread for the device-code wait).
test('⚠ POST …/command with a flow row: 202 on start, the thread is not busy while it waits, a bad option is 422', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const run = async (body: unknown): Promise<Response> =>
    fetch(`${url}/api/threads/flowing/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 'flowing', controller)

  const started = await run({ name: 'login', value: 'fake/oauth' })
  expect(started.status).toBe(202)
  expect(built).toHaveLength(1)
  const thread = built[0]
  if (thread === undefined) throw new Error('expected one build')
  expect(thread.flows.map((flow) => flow.run)).toEqual([{ name: 'login', value: 'fake/oauth' }])

  // snapshot, status(built), status(taken), status(released) — released BEFORE the flow ends.
  await follow.untilFrames(4)
  expect(follow.frames.at(-1)).toMatchObject({ type: 'status', live: true, busy: false })
  // …so a prompt during the wait is accepted, not refused as busy.
  expect(await prompt(url, 'flowing', 'hello while logging in')).toBe(202)

  // One flow at a time on a session: a second start while the first waits is refused, and says which.
  const second = await run({ name: 'login', value: 'fake/api_key' })
  expect(second.status).toBe(422)
  expect(await second.text()).toBe('/login is already in progress here')

  // The flow ends on its own clock: its notify and the model state land on the feed.
  await follow.untilFrames(9) // taken, settled, released for the prompt; taken, released for the refused start
  const beforeSettle = follow.frames.length
  thread.flows[0]?.settle()
  await follow.untilFrames(beforeSettle + 2)
  const kinds = follow.frames.map((frame) => (frame.type === 'observation' ? frame.observation.kind : frame.type))
  expect(kinds.slice(beforeSettle)).toEqual(['extension-ui-request', 'model'])

  const refused = await run({ name: 'login', value: 'nowhere/oauth' })
  expect(refused.status).toBe(422)
  expect(await refused.text()).toBe('login nowhere/oauth is not offered here')
  const noFlow = await run({ name: 'logout', value: 'nobody' })
  expect(noFlow.status).toBe(422)
  expect(await noFlow.text()).toBe('no stored credential for nobody')
  expect(built).toHaveLength(1)
})

// ⚠ THE LEASE COMES BACK ON A FAULT (PR #346 review): a runtime that throws while a flow is being
// started — not a decided refusal — is the handler's 500, and the thread is not left busy under it.
test('POST …/command: a flow start that faults is a 500 and releases the lease — the next prompt runs', async () => {
  const { url } = await startWith({
    onPrompt: (emit: EmitPiEvent, outcome: PromptOutcome) => {
      outcome.onAccepted()
      emit(SETTLED)
    },
    runtime: () => ({
      startHostFlow: (): void => {
        throw new TypeError('modelRuntime.getProviders is not a function')
      },
    }),
  })
  const faulted = await fetch(`${url}/api/threads/faulty-flow/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'login', value: 'fake/oauth' }),
  })
  expect(faulted.status).toBe(500)
  expect(await prompt(url, 'faulty-flow', 'still mine')).toBe(202)
})

test('POST …/command is refused while the thread runs (409) — a setting is not queued behind a run', async () => {
  const { url } = await startWith(asksAndWaits)
  await prompt(url, 'busy', '/mode')
  const refused = await fetch(`${url}/api/threads/busy/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'thinking', value: 'low' }),
  })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('is running')
})

test('GET /api/threads/:id returns the branch as the transcript of ours, with sessionFile null while unflushed', async () => {
  const { url } = await startWith(settlesAtOnce)
  await prompt(url, 't1', 'hello')
  const response = await fetch(`${url}/api/threads/t1`)
  expect(response.status).toBe(200)
  const inspection: unknown = await response.json()
  // Closed schema: a host internal cannot leak by an accidental spread.
  expect(Check(EnsoThreadInspection, inspection)).toBe(true)
  expect(inspection).toMatchObject({
    threadId: 't1',
    sessionId: 'session-1',
    sessionFile: null,
    permissionMode: { mode: 'default', available: ['default', 'acceptEdits'] },
    commands: ['mode', 'plan'],
    busy: false,
    generation: 1,
  })
  // The branch as the transcript of ours (L2): the session entry the host does not model is
  // `other` with its type, the picc `modes` entry is `custom` with its data — a reader
  // cross-checks the mode without knowing the vendor's stored shape.
  const entries = (inspection as EnsoThreadInspection).entries
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ kind: 'other', type: 'session' })
  expect(entries[1]).toMatchObject({ kind: 'custom', customType: 'modes', data: { mode: 'plan' } })
})

// #97: the two tails of one run, read after it — what the host emitted and what the server
// wrote to the follower, each in its own order. The sent tail is recorded at the frame
// writer, so it is the wire's order by construction; the test pins that the record matches
// what the follower actually received.
test('GET /api/threads/:id/events returns the emitted and sent tails of a run, in wire order, deltas coalesced', async () => {
  const { url } = await startWith({
    onPrompt: (emit: EmitPiEvent, outcome: PromptOutcome) => {
      outcome.onAccepted()
      emit(TEXT_DELTA)
      emit(TEXT_DELTA)
      emit(TEXT_DELTA)
      emit(SETTLED)
    },
  })
  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 't1', controller)
  await prompt(url, 't1', 'hello')
  // snapshot, status(built), status(taken), 3 deltas, settled, status(released)
  await follow.untilFrames(8)
  const response = await fetch(`${url}/api/threads/t1/events`)
  expect(response.status).toBe(200)
  const events: unknown = await response.json()
  expect(Check(EnsoThreadEvents, events)).toBe(true)
  const { emitted, sent } = events as EnsoThreadEvents
  // The host's funnel: three deltas fold into one row with an exact count, then the settle —
  // in the observation vocabulary the follow carries (L2), not the runtime's event types.
  expect(emitted.map((event) => [event.type, event.count])).toEqual([
    ['text-delta', 3],
    ['settled', 1],
  ])
  // The wire: the sent tail, expanded by its counts, IS the frame sequence the follower got
  // — from the first frame the thread was live for (the snapshot went out before it was).
  const sentExpanded = sent.flatMap((event) => Array.from({ length: event.count }, () => event.type))
  const received = follow.frames.slice(1).map((frame) => frame.type)
  expect(sentExpanded).toEqual(received)
  expect(sent.every((event) => event.provenance === 'sent')).toBe(true)
  expect(sent.find((event) => event.type === 'observation')).toMatchObject({ name: 'text-delta', count: 3 })
})

test('⚠ the events route of an unknown thread is a 404 and builds no session; a malformed id is a 400', async () => {
  const { url, built } = await startWith({ onPrompt: neverPrompted })
  expect((await fetch(`${url}/api/threads/never-ran/events`)).status).toBe(404)
  expect((await fetch(`${url}/api/threads/%/events`)).status).toBe(400)
  expect((await fetch(`${url}/api/threads`)).status).toBe(200)
  expect(built).toHaveLength(0)
})

// ── resume (#95) ─────────────────────────────────────────────────────────────

const STORED_BRANCH: EnsoTranscriptEntry[] = transcriptOf([
  { type: 'custom', customType: 'modes', data: { mode: 'plan' }, id: 'p', parentId: null, timestamp: '' },
  {
    type: 'message',
    id: 'u1',
    parentId: 'p',
    timestamp: '2026-09-08T10:00:00.000Z',
    message: { role: 'user', content: 'earlier question', timestamp: 1 },
  },
  {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-09-08T10:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
  },
])

test("⚠ a prompt on a thread passes THAT id to the host — the thread id is pi's session id, so a stored one reopens", async () => {
  const { url, requested } = await startWith(settlesAtOnce)
  await prompt(url, 'stored-1', 'continue')
  expect(requested).toEqual(['stored-1'])
})

test('GET /api/stored-threads lists stored threads with title, count and age, marking the ones a thread here is RUNNING', async () => {
  const stored = {
    'stored-1': {
      transcript: STORED_BRANCH,
      modified: new Date('2026-09-08T10:00:05.000Z'),
      firstMessage: 'earlier question',
    },
    'stored-2': {
      transcript: [] as EnsoTranscriptEntry[],
      modified: new Date('2026-09-08T11:00:00.000Z'),
      firstMessage: '   ',
    },
  }
  const { url } = await startWith(asksAndWaits, stored)
  // An open question holds stored-1 busy on this server: taken, never released.
  await prompt(url, 'stored-1', '/mode')
  const response = await fetch(`${url}/api/stored-threads`)
  expect(response.status).toBe(200)
  const listed: unknown = await response.json()
  expect(Array.isArray(listed) && listed.every((thread) => Check(EnsoStoredThread, thread))).toBe(true)
  expect(listed).toEqual([
    {
      threadId: 'stored-1',
      title: 'earlier question',
      lastActivityAt: '2026-09-08T10:00:05.000Z',
      messageCount: 2,
      busy: true,
    },
    // A blank first message is no title — the rail says "new thread", not "   ".
    { threadId: 'stored-2', lastActivityAt: '2026-09-08T11:00:00.000Z', messageCount: 0, busy: false },
  ])
})

test("GET /api/threads/:id/history serves a STORED thread's branch as messages with its persisted mode, and builds no session", async () => {
  const stored = {
    'stored-1': { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question', mode: 'plan' },
  }
  const { url, built } = await startWith({ onPrompt: neverPrompted }, stored)
  const response = await fetch(`${url}/api/threads/stored-1/history`)
  expect(response.status).toBe(200)
  const history: unknown = await response.json()
  expect(Check(EnsoThreadHistory, history)).toBe(true)
  expect(history).toMatchObject({
    threadId: 'stored-1',
    permissionMode: { mode: 'plan' },
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'earlier question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', content: 'earlier answer' }] },
    ],
  })
  expect(built).toHaveLength(0)
  // Neither live nor stored: 404, still nothing built.
  expect((await fetch(`${url}/api/threads/never-existed/history`)).status).toBe(404)
  expect(built).toHaveLength(0)
})

// ⚠ HELD IS NOT BUSY (PR #104 review). A released thread stays cached for the idle window;
// gating on presence locked a reloaded page out of its own session for thirty minutes.
test("⚠ a thread this server holds IDLE is resumable — /history reads pi's memory, /sessions does not mark it busy", async () => {
  const stored = {
    t1: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question', mode: 'plan' },
  }
  const { url, built } = await startWith(settlesAtOnce, stored)
  await prompt(url, 't1', 'hello')
  const listed = (await (await fetch(`${url}/api/stored-threads`)).json()) as EnsoStoredThread[]
  expect(listed.find((thread) => thread.threadId === 't1')?.busy).toBe(false)
  const response = await fetch(`${url}/api/threads/t1/history`)
  expect(response.status).toBe(200)
  const history = (await response.json()) as EnsoThreadHistory
  // The fake's LIVE mode is `default` while its stored file says `plan`: an idle live
  // thread's history is what pi holds now, the session's own answer, not the file's.
  expect(history.permissionMode).toEqual({ mode: 'default', available: ['default', 'acceptEdits'] })
  // Its in-memory branch carries no messages (a session-start entry and picc's modes entry).
  expect(history.messages).toEqual([])
  expect(built).toHaveLength(1)
})

// ⚠ THE COLD READ IS RACED, AND THE RACE IS ON THE BOOT PATH (#214). Boot adopts a named
// thread from /history before showing a pane, so another tab — or `enso-thread` — can prompt
// the same id while the file is being read. Both routes decide what they hold AFTER that
// read (`thread-read.ts#readThreadMount`). Before #214 only the follow re-peeked and
// /history answered from the peek it took BEFORE the await, so the two disagreed: the file's
// messages and the file's mode under a follow that reported the thread live with pi's branch
// and the session's own mode. A red line here means a pane can mount a transcript, and an
// opening mode, that the server itself no longer considers current — invariant 5's shape with
// no MISMATCH to name it, since each side is internally consistent.
test('⚠ a thread built WHILE /history reads the file is served pi\u2019s branch, and the follow opened after it agrees (#214)', async () => {
  const stored = {
    t1: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question', mode: 'plan' },
  }
  let promptDuringRead: (() => Promise<number>) | undefined
  const { url } = await startWith(settlesAtOnce, stored, (host: AgentHost) => ({
    ...host,
    readTranscript: async (threadId: string) => {
      const transcript = await host.readTranscript(threadId)
      await promptDuringRead?.()
      promptDuringRead = undefined
      return transcript
    },
  }))
  promptDuringRead = (): Promise<number> => prompt(url, 't1', 'hello')

  const response = await fetch(`${url}/api/threads/t1/history`)
  expect(response.status).toBe(200)
  const history = (await response.json()) as EnsoThreadHistory

  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 't1', controller)
  await follow.untilFrames(1)
  const snapshot = follow.frames[0]
  if (snapshot?.type !== 'snapshot') throw new Error('the first frame is the snapshot')

  // pi holds this thread now: its in-memory branch carries no messages, and the mode is the
  // session's own — not the file's two messages and not the `plan` its branch persists.
  expect(snapshot.live).toBe(true)
  expect(history.permissionMode).toEqual({ mode: 'default', available: ['default', 'acceptEdits'] })
  expect(history.messages).toEqual([])
  expect(history.messages).toEqual(snapshot.messages)
  expect(history.permissionMode).toEqual(snapshot.permissionMode)
})

test('⚠ GET /api/threads/:id/history serves a thread that is BUSY here — a reload under an open question can come back (#114)', async () => {
  const { url, built } = await startWith(asksAndWaits)
  await prompt(url, 't1', '/mode')
  const response = await fetch(`${url}/api/threads/t1/history`)
  expect(response.status).toBe(200)
  expect(((await response.json()) as EnsoThreadHistory).threadId).toBe('t1')
  // Looking did not build a second session.
  expect(built).toHaveLength(1)
})

test('GET /api/threads lists live threads with busy state and the run number', async () => {
  const { url } = await startWith(asksAndWaits)
  // An open question holds the thread: taken, never released.
  await prompt(url, 'held-thread', '/mode')
  const summaries: unknown = await (await fetch(`${url}/api/threads`)).json()
  expect(Array.isArray(summaries) && summaries.every((summary) => Check(EnsoThreadSummary, summary))).toBe(true)
  expect(summaries).toMatchObject([{ threadId: 'held-thread', busy: true, generation: 1, sessionFile: null }])
})

test('⚠ a bind conflict rejects `listening` instead of hanging, and reports the clash (#81 review)', async () => {
  const { host } = fakeHost({ onPrompt: neverPrompted })
  // Occupy a real port by letting the OS pick one (port 0).
  const first = startEnsoServer({
    cwd: tmpdir(),
    harnessPackageDir: emptyHarnessDir(),
    agentDir: mkdtempSync(join(tmpdir(), 'enso-handler-agent-')),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
    host,
  })
  openServers.push(first)
  const occupied = Number(new URL(await first.listening).port)

  // Asking for the same port must not dangle: before the fix `listening` never settled
  // (Bun does not re-fire 'listening' after an 'error'), so `await listening` hung forever.
  // Now it rejects, and the human-readable clash is still logged, naming the port.
  const second = startEnsoServer({
    cwd: tmpdir(),
    harnessPackageDir: emptyHarnessDir(),
    agentDir: mkdtempSync(join(tmpdir(), 'enso-handler-agent-')),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: occupied,
    host,
  })
  openServers.push(second)
  await expect(second.listening).rejects.toThrow()
  logs.assertLogged({ level: 'error', message: /already in use/, properties: { port: occupied } })
})

// #144: the observation rule's first route. Two properties, and the second is the rule —
// a surface that exists to read the trace must not appear in it.
test("⚠ GET /api/about answers the bundle's own header, and writes no record", async () => {
  const { url } = await startWith(settlesAtOnce)
  const before = logs.records.length
  const response = await fetch(`${url}/api/about`)
  expect(response.status).toBe(200)
  const about = (await response.json()) as Record<string, unknown>
  // Every field the bundle's header carries, and nothing undefined among them.
  expect(Object.keys(about).sort()).toEqual(['at', 'bun', 'enso', 'os', 'pi', 'selection'])
  expect(Number.isNaN(new Date(String(about.at)).getTime())).toBe(false)
  for (const twice of [0, 1]) await fetch(`${url}/api/about?call=${twice}`)
  expect(logs.records.length).toBe(before)
})

/**
 * ⚠ Loopback is not an authorization boundary against a BROWSER. A page on any origin can
 * post to 127.0.0.1, and a prompt is a full run of an agent with unconfined bash in the
 * operator's tree — the highest-impact thing this server can be made to do. The three
 * refusals below are what stands there; the two allowances are the surfaces that must keep
 * working (the page on the dev port, and the repo's own header-less CLIs).
 */
test('⚠ a cross-site page cannot prompt, an opaque origin cannot escalate, and a rebound host cannot read', async () => {
  const { url, built } = await startWith(settlesAtOnce)

  // The attack: a CORS-simple POST (text/plain needs no preflight) to an id nobody owns.
  const driveBy = await fetch(`${url}/api/threads/zzz1/prompt`, {
    method: 'POST',
    headers: { Origin: 'http://evil.example', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ message: 'read every secret you can find' }),
  })
  expect(driveBy.status).toBe(403)
  // …and it must not have built a session on the way to being refused.
  expect(built.length).toBe(0)

  // ⚠ #205: `Origin: null` is a browser declining to name a cross-origin caller — what a
  // sandboxed iframe, a `file://` page and a `data:` document all send. It was trusted
  // alongside the absent header until #205, which left the control plane open to the
  // escalate-then-prompt sequence below. A red line here means the exemption is back: the
  // mode change ACQUIRES, so a session in `built` is proof the escalation went through.
  // `acceptEdits` is what this fixture's session offers; the real host offers
  // `bypassPermissions` on the same route, validated the same way.
  const opaque = { Origin: 'null', 'Content-Type': 'text/plain' }
  const escalation = await fetch(`${url}/api/threads/zzz2/mode`, {
    method: 'POST',
    headers: opaque,
    body: JSON.stringify({ mode: 'acceptEdits' }),
  })
  expect(escalation.status).toBe(403)
  const opaquePrompt = await fetch(`${url}/api/threads/zzz2/prompt`, {
    method: 'POST',
    headers: opaque,
    body: JSON.stringify({ message: 'read every secret you can find' }),
  })
  expect(opaquePrompt.status).toBe(403)
  // The third route of the escalate → prompt → answer sequence the finding measured, so the
  // test covers what the report claims rather than one route short of it (PR #291 review).
  const dialogAnswer = await fetch(`${url}/api/threads/zzz2/dialog`, {
    method: 'POST',
    headers: opaque,
    body: JSON.stringify({ dialogId: 'd1', optionId: 'allow' }),
  })
  expect(dialogAnswer.status).toBe(403)
  expect(built.length).toBe(0)

  // Reading is refused the same way, which is what closes DNS rebinding: a name that
  // resolves to 127.0.0.1 still is not loopback.
  const rebound = await fetch(`${url}/api/about`, { headers: { Host: 'attacker.example' } })
  expect(rebound.status).toBe(403)
})

test('the dev page and the header-less CLIs are unaffected', async () => {
  const { url } = await startWith(settlesAtOnce)
  for (const origin of ['http://127.0.0.1:5178', 'http://localhost:5178', 'http://127.0.0.1:5179']) {
    expect((await fetch(`${url}/api/about`, { headers: { Origin: origin } })).status).toBe(200)
  }
  // `enso-thread.ts` and `curl` send no Origin at all.
  expect((await fetch(`${url}/api/about`)).status).toBe(200)
})
