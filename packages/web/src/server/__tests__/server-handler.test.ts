import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_RISK_THRESHOLDS,
  ENSO_PROJECT_HEADER,
  ENSO_RUN_STOPPED_ENTRY,
  ENSO_SYSTEM_PROMPT_ENTRY,
  EnsoForkPoint,
  type EnsoFollowFrame,
  type EnsoModelState,
  type EnsoObservation,
  type EnsoPermissionCheckRequest,
  EnsoPermissionVerdict,
  EnsoProject,
  EnsoProjectSettings,
  EnsoProjectTrust,
  EnsoProjectPromptLibrary,
  EnsoStoredThread,
  EnsoSystemPromptPreview,
  EnsoThreadCommands,
  EnsoThreadEvents,
  EnsoThreadHistory,
  EnsoThreadInspection,
  EnsoThreadSummary,
  type EnsoTranscriptEntry,
  type EnsoTreeSetupOutcome,
  estimateTextTokens,
  type PromptOutcome,
  type PromptRequest,
  type ThreadRuntime,
  readEnsoThreadIncidents,
  readEnsoThreadJudgeCases,
} from '@enso/core'
import { ENSO_DEFAULT_PERMISSION_POLICY } from '@enso/core/permission-rules'
import { type FlowTrace, flowTrace } from '@enso/test-support/flow-trace'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/test-support/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import { Check } from 'typebox/value'
import { type AgentHost, SessionDirectoryRefused } from '../../host/agent-host.ts'
import type { HostedThread, HostedThreadInspection } from '../../host/live-thread.ts'
import type { ThreadRestoreOutcome, ThreadTreePlace } from '../../host/thread-log-edits.ts'
import { transcriptOf } from '../../host/transcript.ts'
import type { ProjectThreadSettingsSource } from '../../host/tree-setup.ts'
import { startEnsoServer } from '../index.ts'
import { NO_PROMPT_LIBRARY } from '../prompt-library.ts'
import { HISTORY_PAGE_MESSAGES } from '../thread-read.ts'
import {
  createFakeAgentHost,
  createFakeHostedThread,
  FAKE_PI_PREAMBLE,
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
  /** What the live session's inspection holds, over the fake's own — a branch to serve. */
  inspect?: Partial<HostedThreadInspection>
}

/**
 * A branch shaped like pi's, with an `active_agent` mode entry (#496), and NO file on disk — the unflushed
 * state #86's inspection must report honestly rather than invent (#86). The fixture is
 * written as the file holds it and crosses the seam as the transcript of ours, through the
 * host's own converter — what the real host hands out (L2).
 */
function modeShapedInspection(): Partial<HostedThreadInspection> {
  return {
    sessionDir: '/fake/agent/sessions/--fake-cwd--',
    entries: transcriptOf([
      { type: 'session', id: 'root', parentId: null, timestamp: '2026-09-08T00:00:00.000Z' },
      {
        type: 'custom',
        customType: 'active_agent',
        data: { name: 'enso-mode-plan' },
        id: 'm1',
        parentId: 'root',
        timestamp: '2026-09-08T00:00:01.000Z',
      },
    ]),
    commands: ['mode', 'plan'],
  }
}

/** What this fake host says a fresh thread starts in — Enso's five modes, in menu order, as the real host would. */
const FRESH_MODE = { mode: 'default', available: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] }

function fakeHost(
  script: FakeSessionScript,
  stored: Record<string, FakeStoredThread> = {},
  /** The server's projects' rule, as the real host is given it (#395). */
  servesDirectory: (directory: string) => boolean = () => true,
): { host: AgentHost; built: FakeThreadRecord[]; requested: string[]; builtIn: string[] } {
  const built: FakeThreadRecord[] = []
  /** Thread ids the host was asked to build, in order — the prompt route passes the id through. */
  const requested: string[] = []
  /**
   * The directory each NEW session was built in (#395) — the session reports it as its cwd. A
   * stored thread reopens where it was made and, as the real host does, never asks.
   */
  const builtIn: string[] = []
  const host = createFakeAgentHost(
    (threadId: string, newSessionDirectory: () => string) => {
      requested.push(threadId)
      const storedThread = stored[threadId]
      const directory = storedThread === undefined ? newSessionDirectory() : (storedThread.cwd ?? tmpdir())
      if (storedThread === undefined) builtIn.push(directory)
      const fake = createFakeHostedThread({
        runtime: (parts: FakeThreadParts) => ({
          prompt: (request: PromptRequest, outcome: PromptOutcome) => {
            parts.record.prompts.push(request)
            script.onPrompt(parts.emit, outcome, request.message)
          },
          // The permission-modes extension's row first, the host's two after — the real host's order (#338 slice 2).
          listCommands: () => [{ name: 'mode', source: 'extension' }, ...fakeHostRows(parts.record)],
          permissionModeState: () => ({ mode: 'default', available: ['default', 'acceptEdits'] }),
          ...script.runtime?.(parts),
        }),
        inspect: { ...modeShapedInspection(), cwd: directory, ...script.inspect },
      })
      built.push(fake.record)
      return Promise.resolve(fake.hosted)
    },
    stored,
    FRESH_MODE,
    { servesDirectory },
  )
  return { host, built, requested, builtIn }
}

/** A harness dir with an empty pi manifest — enough for `assertVendorLinks` to pass. */
function emptyHarnessDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-handler-harness-'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'fake-harness', pi: {} }))
  return directory
}

// What the runtime says to its subscriber — observations, since L2 (#162 workstream 4).
const SETTLED: EnsoObservation = { kind: 'settled', aborted: false }
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
  /**
   * Where a page may register projects (#395) — none, so only the launch directory, when absent —
   * the prompt library's directory (#443) — absent, the server has none — and the permission
   * policy file (#474), a shared path no test reads when absent.
   */
  {
    projectRoots = [],
    promptsDir,
    permissionRulesPath = join(tmpdir(), 'enso-unread-permissions.json'),
    launch = tmpdir(),
    agentDir = mkdtempSync(join(tmpdir(), 'enso-handler-agent-')),
    threadSettings,
  }: {
    readonly projectRoots?: readonly string[]
    readonly promptsDir?: string
    readonly permissionRulesPath?: string
    /** The launch directory — where a new thread is built (#395); the shared temp dir when absent. */
    readonly launch?: string
    /** pi's agent dir, whose `trust.json` a test may write (#754); a fresh one when absent. */
    readonly agentDir?: string
    /** The user's config the project settings resolve against (#754); absent, the server has none. */
    readonly threadSettings?: ProjectThreadSettingsSource
  } = {},
): Promise<{ url: string; built: FakeThreadRecord[]; requested: string[]; builtIn: string[] }> {
  // The fake is made before the server, whose projects' rule it must apply — bound when the server asks.
  let servesDirectory: (directory: string) => boolean = () => false
  const { host, built, requested, builtIn } = fakeHost(script, stored, (directory: string) =>
    servesDirectory(directory),
  )
  const started = startEnsoServer({
    cwd: launch,
    projectRoots,
    ...(promptsDir === undefined ? {} : { promptsDir }),
    ...(threadSettings === undefined ? {} : { threadSettings }),
    harnessPackageDir: emptyHarnessDir(),
    agentDir,
    permissionRulesPath,
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
    host: (serverRule: (directory: string) => boolean) => {
      servesDirectory = serverRule
      return wrapHost(host)
    },
  })
  openServers.push(started)
  const url = await started.listening
  return { url, built, requested, builtIn }
}

async function prompt(
  url: string,
  threadId: string,
  message: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await fetch(`${url}/api/threads/${encodeURIComponent(threadId)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ message }),
  })
  await response.text()
  return response.status
}

// @pins prompt-run-settle/release-keeps-session
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

// ⚠ LOOKING MUST NOT BUILD (#86, #484). This route used to build a thread's session to list its
// commands (#390), and the Start dialog (now the launch panel, #877) read its models here — so opening the page built one. Now a
// thread the server holds answers its own live list, and any other id answers the host's CATALOGUE:
// `/model` over the models pi could run (no value: no current one), the flows — nothing a session
// alone has, and nothing built. A build that fails is not this route's concern any more.
test('⚠ GET …/commands never builds: a live thread answers its own list; any other id, the catalogue', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const commandsOf = async (threadId: string): Promise<EnsoThreadCommands> => {
    const answered: unknown = await (await fetch(`${url}/api/threads/${threadId}/commands`)).json()
    if (!Check(EnsoThreadCommands, answered)) throw new Error('the answer is not an EnsoThreadCommands')
    return answered
  }

  // A thread nobody has run: the catalogue, and no build. Twice, to show the second read is not special.
  const fresh = await commandsOf('fresh')
  await commandsOf('fresh')
  expect(fresh).toMatchObject({ threadId: 'fresh', source: 'catalogue' })
  expect(built).toHaveLength(0)
  expect((await (await fetch(`${url}/api/threads`)).json()) as unknown[]).toEqual([])
  expect(fresh.commands.map((command) => [command.name, command.source, command.kind])).toEqual([
    ['model', 'host', 'select'],
    ['login', 'host', 'flow'],
    ['logout', 'host', 'flow'],
  ])
  // The launch panel's rows (#877): every model with its own thinking levels, and no current value.
  expect(fresh.commands[0]?.value).toBeUndefined()
  expect(fresh.commands[0]?.options?.map((option) => [option.id, option.thinkingLevels])).toEqual([
    ['fake/fake-1', ['off', 'low', 'medium', 'high']],
    ['fake/fake-2', ['off']],
  ])
  expect(fresh.commands[1]).toMatchObject({ options: [{ id: 'fake/oauth' }, { id: 'fake/api_key' }] })

  // A control route builds (#390: choosing the model before the first prompt is the point) …
  const set = await fetch(`${url}/api/threads/fresh/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'thinking', value: 'high' }),
  })
  expect(set.status).toBe(204)
  expect(built).toHaveLength(1)
  // … and from then on the thread answers its OWN list, values and pi's rows included.
  const live = await commandsOf('fresh')
  expect(live).toMatchObject({ threadId: 'fresh', source: 'live' })
  expect(live.commands.map((command) => [command.name, command.source])).toEqual([
    ['mode', 'extension'],
    ['model', 'host'],
    ['thinking', 'host'],
    ['login', 'host'],
    ['logout', 'host'],
    ['compact', 'host'],
    ['context', 'host'],
    ['fork', 'host'],
  ])
  expect(live.commands[1]).toMatchObject({ kind: 'select', value: 'fake/fake-1' })
  expect(live.commands[2]).toMatchObject({ kind: 'level', value: 'high' })
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
  const unknown = await run('fresh', { name: 'reload' })
  expect(unknown.status).toBe(422)
  expect(await unknown.text()).toBe('no host command named reload')
  // A view (#361) is the page's to open; a run of one — the palette never sends it — is the
  // host's refusal, not a 500 and not a silent 204.
  const viewRun = await run('fresh', { name: 'context' })
  expect(viewRun.status).toBe(422)
  expect(await viewRun.text()).toBe('/context opens in the page; there is nothing for the host to run')
  // `/compact` (slice 4) is an ACTION: it starts like a flow (202) but HOLDS the lease until it
  // settles — a compaction rewrites the branch, so the thread is busy until then: a setting is 409
  // (a prompt would be queued behind the lease, #75, and pi refuses it with its own reason).
  const compacting = await run('fresh', { name: 'compact' })
  expect(compacting.status).toBe(202)
  const compaction = built[0]?.flows.at(-1)
  expect(compaction?.run).toEqual({ name: 'compact' })
  expect((await run('fresh', { name: 'thinking', value: 'low' })).status).toBe(409)
  compaction?.settle()
  expect((await run('fresh', { name: 'thinking', value: 'low' })).status).toBe(204)
  const malformed = await run('fresh', '{"name":')
  expect(malformed.status).toBe(400)
  const extra = await run('fresh', { name: 'thinking', value: 'low', extra: 1 })
  expect(extra.status).toBe(400)
  // Still the one build: every run above acquired the same live thread.
  expect(built).toHaveLength(1)
})

// #434: a cold thread's snapshot says what its branch last ran on, as RECORDED beside a `null`
// model — nothing is built to read it. Once the thread is live, the live state is the whole answer.
test("a cold thread's snapshot carries its recorded model beside a null model; once live, only the live model (#434)", async () => {
  const recordedModel = { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'medium' }
  const stored = { cold: { transcript: [], modified: new Date(0), firstMessage: 'earlier', recordedModel } }
  const { url, built } = await startWith(settlesAtOnce, stored)
  const controller = new AbortController()
  openFollows.push(controller)
  const coldFollow = await openFollow(url, 'cold', controller)
  expect(coldFollow.frames[0]).toMatchObject({ type: 'snapshot', live: false, model: null, recordedModel })
  expect(built).toHaveLength(0)

  expect(await prompt(url, 'cold', 'run it')).toBe(202)
  const later = new AbortController()
  openFollows.push(later)
  const liveFollow = await openFollow(url, 'cold', later)
  expect(liveFollow.frames[0]).toMatchObject({ type: 'snapshot', live: true, model: { model: { name: 'Fake One' } } })
  expect(liveFollow.frames[0]).not.toHaveProperty('recordedModel')
})

// #878: the composer's locked System prompt chip says what the session runs with, after a reload
// too — so the snapshot carries the branch's record, named without its text; none is pi's default.
test("a follow's snapshot names the system prompt the branch records, without its text; a branch with none says pi's default (#878)", async () => {
  const choice = { id: 'reviewer', name: 'Reviewer', mode: 'system', sha256: 'c'.repeat(64), text: 'Read the diff.' }
  const recorded = { kind: 'custom' as const, id: 'sp1', customType: ENSO_SYSTEM_PROMPT_ENTRY, data: choice }
  const stored = {
    chosen: { transcript: [recorded], modified: new Date(1), firstMessage: 'reviewed' },
    plain: { transcript: [], modified: new Date(0), firstMessage: 'plain' },
  }
  const { url } = await startWith(settlesAtOnce, stored)
  const snapshotOf = async (threadId: string): Promise<unknown> => {
    const controller = new AbortController()
    openFollows.push(controller)
    return (await openFollow(url, threadId, controller)).frames[0]
  }
  const { text: _text, ...named } = choice
  expect(await snapshotOf('chosen')).toMatchObject({ type: 'snapshot', live: false, systemPrompt: named })
  expect(JSON.stringify(await snapshotOf('chosen'))).not.toContain('Read the diff.')
  expect(await snapshotOf('plain')).toMatchObject({ type: 'snapshot', systemPrompt: null })
})

// #871: the stored listing names the model each thread last ran on — the project page's Threads tab
// shows it — checked against the listing's schema; a thread whose file records none has no `model`.
test('the stored listing carries the model a thread last ran on, and none for a thread that records none (#871)', async () => {
  const recordedModel = { model: { provider: 'openai', modelId: 'gpt-kept' }, thinkingLevel: 'high' }
  const stored = {
    ran: { transcript: [], modified: new Date(1), firstMessage: 'ran', recordedModel },
    levelOnly: {
      transcript: [],
      modified: new Date(0),
      firstMessage: 'never answered',
      recordedModel: { model: null, thinkingLevel: 'low' },
    },
  }
  const { url } = await startWith(settlesAtOnce, stored)
  const listed = (await (await fetch(`${url}/api/stored-threads`)).json()) as unknown[]
  expect(listed.every((row) => Check(EnsoStoredThread, row))).toBe(true)
  expect(listed).toEqual([
    expect.objectContaining({ threadId: 'ran', model: { provider: 'openai', modelId: 'gpt-kept' } }),
    expect.objectContaining({ threadId: 'levelOnly' }),
  ])
  expect(listed[1]).not.toHaveProperty('model')
})

/** A project root with one directory under it, both canonical — a page may register `app` (#395). */
function projectRoot(): { root: string; app: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'enso-roots-')))
  const app = join(root, 'app')
  mkdirSync(app)
  return { root, app }
}

async function registerProject(url: string, body: unknown): Promise<Response> {
  return await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function registeredProject(url: string, path: string): Promise<EnsoProject> {
  const answered: unknown = await (await registerProject(url, { path })).json()
  if (!Check(EnsoProject, answered)) throw new Error('the answer is not an EnsoProject')
  return answered
}

// #44, #395: the project indicator's source. A thread with no session says where it WILL be built —
// the project a page named for it, else the launch directory; a live one says its session's own.
// The named project differs from the launch directory on purpose, so the precedence is what is pinned.
test("a follow's snapshot names where the thread runs: its project's directory before a session, the session's own after", async () => {
  const { root, app } = projectRoot()
  const { url, builtIn } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  const naming = { [ENSO_PROJECT_HEADER]: project.projectId }

  const unnamed = new AbortController()
  openFollows.push(unnamed)
  expect((await openFollow(url, 'plain', unnamed)).frames[0]).toMatchObject({
    live: false,
    cwd: realpathSync(tmpdir()),
  })
  const cold = new AbortController()
  openFollows.push(cold)
  expect((await openFollow(url, 'fresh', cold, naming)).frames[0]).toMatchObject({ live: false, cwd: app })

  expect(await prompt(url, 'fresh', 'hello', naming)).toBe(202)
  expect(builtIn).toEqual([app])
  const live = new AbortController()
  openFollows.push(live)
  expect((await openFollow(url, 'fresh', live)).frames[0]).toMatchObject({ live: true, cwd: app })
})

// #395's boundary over HTTP: only a directory strictly under a declared root registers, the answer
// says why not, registering twice is the same project, and a page can never name a project that is
// not registered — nothing is built for it.
test('⚠ projects: registered under a root or refused with the reason; an unregistered id on a thread is a 400 and builds nothing', async () => {
  const { root, app } = projectRoot()
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const launchOnly: unknown = await (await fetch(`${url}/api/projects`)).json()
  expect(launchOnly).toEqual([expect.objectContaining({ launch: true, path: realpathSync(tmpdir()), status: 'ok' })])

  // #872: the name the Add project page sends is the name the project is listed by.
  const first = await registerProject(url, { path: app, title: 'Ledger app' })
  expect(first.status).toBe(201)
  const listed: unknown = await (await fetch(`${url}/api/projects`)).json()
  expect(listed).toContainEqual(expect.objectContaining({ path: app, title: 'Ledger app' }))
  // Already a project: a 200 naming it, which the page opens (#872).
  const again = await registerProject(url, { path: `${app}/`, title: 'Another name' })
  expect(again.status).toBe(200)
  expect(await again.json()).toMatchObject({
    projectId: ((await first.json()) as EnsoProject).projectId,
    title: 'Ledger app',
  })

  const outside = await registerProject(url, { path: mkdtempSync(join(tmpdir(), 'enso-outside-')) })
  expect(outside.status).toBe(422)
  expect(await outside.text()).toContain('outside your declared project roots')
  const rootItself = await registerProject(url, { path: root })
  expect(rootItself.status).toBe(422)
  expect(await rootItself.text()).toContain('a project root itself')
  expect((await registerProject(url, { path: app, cwd: '/' })).status).toBe(400)

  expect(await prompt(url, 't1', 'hello', { [ENSO_PROJECT_HEADER]: '0123456789abcdef' })).toBe(400)
  expect(requested).toEqual([])
})

// A stored session belongs to the project its OWN directory is (pi's header); one whose directory
// is no project is not served at all — not listed, not read — and forgetting a project takes its
// threads off the rail without touching them: adding the folder again serves them again. The project
// page's Remove card says exactly this (#871, `project-page.tsx`).
test('stored threads are listed and read only in a project, each under its own; removing a project hides its threads until it is added again', async () => {
  const { root, app } = projectRoot()
  const stored = (cwd: string): FakeStoredThread => ({
    cwd,
    transcript: [],
    modified: new Date('2026-09-24T00:00:00.000Z'),
    firstMessage: `made in ${cwd}`,
  })
  const { url } = await startWith(
    settlesAtOnce,
    { inLaunch: stored(tmpdir()), inApp: stored(app), elsewhere: stored('/somewhere/else') },
    undefined,
    { projectRoots: [root] },
  )
  const project = await registeredProject(url, app)
  const launch = ((await (await fetch(`${url}/api/projects`)).json()) as EnsoProject[])[0]
  const listed = async (): Promise<unknown> => await (await fetch(`${url}/api/stored-threads`)).json()
  expect(await listed()).toEqual([
    expect.objectContaining({ threadId: 'inLaunch', projectId: launch?.projectId }),
    expect.objectContaining({ threadId: 'inApp', projectId: project.projectId }),
  ])
  expect(await (await fetch(`${url}/api/threads/inApp/history`)).json()).toMatchObject({ projectId: project.projectId })
  // #378: a file outside every project is refused BY NAME — 403, saying where — never the 404 a page
  // reads as an id nobody has used, and starts afresh. An id nobody has used is still the 404.
  const refusedHistory = async (threadId: string): Promise<[number, string]> => {
    const response = await fetch(`${url}/api/threads/${threadId}/history`)
    return [response.status, await response.text()]
  }
  expect(await refusedHistory('elsewhere')).toEqual([
    403,
    'stored in /somewhere/else — not a project here; add it as one to open it',
  ])
  expect(await refusedHistory('never-used')).toEqual([404, 'no session for thread never-used'])

  expect((await fetch(`${url}/api/projects/${launch?.projectId}`, { method: 'DELETE' })).status).toBe(409)
  expect((await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })).status).toBe(204)
  expect(await listed()).toEqual([expect.objectContaining({ threadId: 'inLaunch' })])
  expect(await refusedHistory('inApp')).toEqual([
    403,
    `stored in ${app} — not a project here; add it as one to open it`,
  ])
  // A stale tab still following it is told there is nowhere it runs — never the launch directory,
  // where resuming it would not happen either (PR #399 review).
  const stale = new AbortController()
  openFollows.push(stale)
  expect((await openFollow(url, 'inApp', stale)).frames[0]).toMatchObject({ live: false, cwd: '' })
  // Nothing was deleted: the same folder added again is the same project, and its threads are back.
  expect((await registeredProject(url, app)).projectId).toBe(project.projectId)
  expect(await listed()).toEqual([
    expect.objectContaining({ threadId: 'inLaunch' }),
    expect.objectContaining({ threadId: 'inApp', projectId: project.projectId }),
  ])
  expect(await (await fetch(`${url}/api/threads/inApp/history`)).json()).toMatchObject({ projectId: project.projectId })
})

// PR #399 review. Removing a project must not strand a run: while a thread in it RUNS, the removal is
// refused and the project stays. And a thread that is live but idle is taken again without a
// build — so it ends with the project, or a page still showing it could go on prompting it there.
test('⚠ removing a project is refused while one of its threads runs, and the project stays', async () => {
  const { root, app } = projectRoot()
  const { url } = await startWith(asksAndWaits, {}, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  await prompt(url, 'busy', '/mode', { [ENSO_PROJECT_HEADER]: project.projectId })
  const refused = await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('is running')
  const listed = (await (await fetch(`${url}/api/projects`)).json()) as EnsoProject[]
  expect(listed.map((listedProject) => listedProject.projectId)).toContain(project.projectId)
})

test('⚠ removing a project ends its idle live threads, and nothing is built for them in the removed directory', async () => {
  const { root, app } = projectRoot()
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  const naming = { [ENSO_PROJECT_HEADER]: project.projectId }
  expect(await prompt(url, 't1', 'hello', naming)).toBe(202)
  const liveIds = async (): Promise<string[]> =>
    ((await (await fetch(`${url}/api/threads`)).json()) as EnsoThreadSummary[]).map((summary) => summary.threadId)
  expect(await liveIds()).toEqual(['t1'])

  expect((await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })).status).toBe(204)
  expect(await liveIds()).toEqual([])
  expect(await prompt(url, 't1', 'again', naming)).toBe(400)
  expect(requested).toEqual(['t1'])
})

// PR #399 review, the gaps it reproduced. A claim is asked for only when a NEW session is made: a
// stored thread once named for a project that is since removed still resumes where pi recorded it.
test('⚠ a claim naming a removed project does not block resuming a thread that has a session', async () => {
  const { root, app } = projectRoot()
  const old: FakeStoredThread = { transcript: [], modified: new Date('2026-09-24T00:00:00.000Z'), firstMessage: 'old' }
  const { url, requested, builtIn } = await startWith(settlesAtOnce, { old }, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  const history = await fetch(`${url}/api/threads/old/history`, {
    headers: { [ENSO_PROJECT_HEADER]: project.projectId },
  })
  expect(history.status).toBe(200)
  expect((await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })).status).toBe(204)

  expect(await prompt(url, 'old', 'still here?')).toBe(202)
  expect(requested).toEqual(['old'])
  expect(builtIn).toEqual([])
})

// A new thread whose project is gone is built nowhere, and says so: its snapshot has no directory,
// and its prompt is a 409 with the reason — a refusal the server decided, not a failed request.
test('⚠ a new thread whose project was removed shows no directory, and its prompt is refused with the reason (409)', async () => {
  const { root, app } = projectRoot()
  const { url, builtIn } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  const named = new AbortController()
  openFollows.push(named)
  expect(
    (await openFollow(url, 'orphan', named, { [ENSO_PROJECT_HEADER]: project.projectId })).frames[0],
  ).toMatchObject({
    cwd: app,
  })
  expect((await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })).status).toBe(204)

  const after = new AbortController()
  openFollows.push(after)
  expect((await openFollow(url, 'orphan', after)).frames[0]).toMatchObject({ live: false, cwd: '' })
  const refused = await fetch(`${url}/api/threads/orphan/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('its project is no longer registered')
  expect(builtIn).toEqual([])
})

// ⚠ #897: a page names its new thread's project on every request, and nothing builds it until Start.
// A reload asked `/history` with no project named, got a 404, minted the id again with no project,
// and showed the launch project — while the server kept the claim and built the session in the
// claimed one. `/history` says such a thread is a draft of the project it was named for, and names
// it still once that project is removed, so the page says it is gone; the page's reads naming it
// again are served, and its prompt is refused with the reason. An id nobody named stays 404.
test('⚠ GET …/history says a thread named for a project and never built is a draft of that project, removed or not (#897)', async () => {
  const { root, app } = projectRoot()
  const { url, built } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  const commands = await fetch(`${url}/api/threads/named/commands`, {
    headers: { [ENSO_PROJECT_HEADER]: project.projectId },
  })
  expect(commands.status).toBe(200)
  const draftOf = async (): Promise<EnsoThreadHistory> => {
    const response = await fetch(`${url}/api/threads/named/history`)
    expect(response.status).toBe(200)
    const history = (await response.json()) as EnsoThreadHistory
    expect(Check(EnsoThreadHistory, history)).toBe(true)
    return history
  }
  expect(await draftOf()).toMatchObject({ threadId: 'named', projectId: project.projectId, messages: [], draft: true })
  expect((await fetch(`${url}/api/threads/nobody-named/history`)).status).toBe(404)

  expect((await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })).status).toBe(204)
  expect(await draftOf()).toMatchObject({ projectId: project.projectId, draft: true })
  const naming = { [ENSO_PROJECT_HEADER]: project.projectId }
  expect((await fetch(`${url}/api/threads/named/commands`, { headers: naming })).status).toBe(200)
  expect((await fetch(`${url}/api/threads/other/commands`, { headers: naming })).status).toBe(400)
  const refused = await fetch(`${url}/api/threads/named/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...naming },
    body: JSON.stringify({ message: 'hello' }),
  })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain('its project is no longer registered')
  expect(built).toEqual([])
})

test("⚠ the host's refusal to run a session where it would have to is a 409 with its reason, never a 500", async () => {
  const { url } = await startWith(settlesAtOnce, {}, (host: AgentHost) => ({
    ...host,
    createSession: (threadId: string): Promise<HostedThread> =>
      Promise.reject(
        new SessionDirectoryRefused(`thread ${threadId}: /gone is not a project this server runs sessions in`),
      ),
  }))
  const refused = await fetch(`${url}/api/threads/unserved/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toBe('thread unserved: /gone is not a project this server runs sessions in')
})

test('removing the launch project says why at once, even while one of its threads runs', async () => {
  const { url } = await startWith(asksAndWaits)
  await prompt(url, 'busy', '/mode')
  const launch = ((await (await fetch(`${url}/api/projects`)).json()) as EnsoProject[])[0]
  const refused = await fetch(`${url}/api/projects/${launch?.projectId}`, { method: 'DELETE' })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toBe('the launch directory is always a project')
})

// ── #754: the project page's Worktrees section ────────────────────────────────────────────────

/** A server launched in a fresh project with these tier files; the user's config copies `.env`; pi's trust for the project is `trusted`. */
async function settingsServer(options: {
  readonly trusted: boolean
  readonly shared?: unknown
  readonly local?: string
}): Promise<{ url: string; project: string; projectId: string; userPath: string; agentDir: string }> {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'enso-settings-project-')))
  mkdirSync(join(project, '.enso'))
  if (options.shared !== undefined) writeFileSync(join(project, '.enso', 'config.json'), JSON.stringify(options.shared))
  if (options.local !== undefined) writeFileSync(join(project, '.enso', 'config.local.json'), options.local)
  const agentDir = mkdtempSync(join(tmpdir(), 'enso-settings-agent-'))
  // pi's trust store, written as pi writes it (`<agentDir>/trust.json`, keyed by the real path): this
  // file may not name pi (the vendor gate, #145).
  writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [project]: options.trusted }))
  const userPath = join(mkdtempSync(join(tmpdir(), 'enso-settings-home-')), 'config.json')
  const threadSettings = { user: { threads: { copy: ['.env'] } }, userPath, canonical: (key: string) => key }
  const { url } = await startWith(settlesAtOnce, {}, undefined, { launch: project, agentDir, threadSettings })
  const launch = ((await (await fetch(`${url}/api/projects`)).json()) as EnsoProject[])[0]
  if (launch === undefined) throw new Error('no launch project')
  return { url, project, projectId: launch.projectId, userPath, agentDir }
}

function putSettings(url: string, projectId: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/projects/${projectId}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function settingsOf(response: Response): Promise<EnsoProjectSettings> {
  const answered: unknown = await response.json()
  if (!Check(EnsoProjectSettings, answered)) throw new Error('the answer is not EnsoProjectSettings')
  return answered
}

test("the launch project's settings: each value with its tier, the files behind them, and its trust (#754)", async () => {
  const { url, project, projectId, userPath } = await settingsServer({
    trusted: true,
    shared: { threads: { setup: ['bun install --frozen-lockfile'] } },
  })
  const response = await fetch(`${url}/api/projects/${projectId}/settings`)
  expect(response.status).toBe(200)
  expect(await settingsOf(response)).toEqual({
    projectId,
    path: project,
    trusted: true,
    threads: {
      tree: { value: 'worktree', tier: 'default' },
      setup: { value: ['bun install --frozen-lockfile'], tier: 'shared' },
      copy: { value: ['.env'], tier: 'user' },
    },
    files: {
      user: userPath,
      shared: join(project, '.enso', 'config.json'),
      local: join(project, '.enso', 'config.local.json'),
    },
    unreadable: [],
  })
})

test("⚠ an untrusted project's own tiers are not read, and the settings say so (#754)", async () => {
  const { url, projectId } = await settingsServer({ trusted: false, shared: { threads: { setup: ['make'] } } })
  const settings = await settingsOf(await fetch(`${url}/api/projects/${projectId}/settings`))
  expect(settings.trusted).toBe(false)
  expect(settings.threads.setup).toEqual({ value: [], tier: 'default' })
})

test('a PUT sets and removes keys in its tier, keeps the rest of the file, and answers the settings as they now resolve (#754)', async () => {
  const { url, project, projectId } = await settingsServer({
    trusted: true,
    local: JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] } }),
  })
  const set = await putSettings(url, projectId, { tier: 'local', threads: { tree: 'off', copy: ['.env.local'] } })
  expect(set.status).toBe(200)
  expect((await settingsOf(set)).threads).toMatchObject({
    tree: { value: 'off', tier: 'local' },
    copy: { value: ['.env.local'], tier: 'local' },
  })
  const localPath = join(project, '.enso', 'config.local.json')
  expect(readFileSync(localPath, 'utf8')).toBe(
    `${JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { tree: 'off', copy: ['.env.local'] } }, null, 2)}\n`,
  )
  // `null` removes the key from that tier: the next tier's value shows through.
  const cleared = await putSettings(url, projectId, { tier: 'local', threads: { copy: null } })
  expect((await settingsOf(cleared)).threads.copy).toEqual({ value: ['.env'], tier: 'user' })
  expect(JSON.parse(readFileSync(localPath, 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
    threads: { tree: 'off' },
  })
  // The shared tier is its own file, made with its directory's `.enso/` already there.
  await putSettings(url, projectId, { tier: 'shared', threads: { setup: ['bun install'] } })
  expect(JSON.parse(readFileSync(join(project, '.enso', 'config.json'), 'utf8'))).toEqual({
    threads: { setup: ['bun install'] },
  })
})

test('⚠ project settings refusals: an unknown project 404, a body that is not an update 400, an unreadable tier file 422 and untouched (#754)', async () => {
  const { url, project, projectId } = await settingsServer({ trusted: true, local: '{ not json' })
  expect((await fetch(`${url}/api/projects/0123456789abcdef/settings`)).status).toBe(404)
  expect((await putSettings(url, '0123456789abcdef', { tier: 'local', threads: {} })).status).toBe(404)
  expect((await putSettings(url, projectId, { tier: 'user', threads: {} })).status).toBe(400)
  expect((await putSettings(url, projectId, { tier: 'shared', threads: { tree: 'none' } })).status).toBe(400)
  expect((await putSettings(url, projectId, { tier: 'shared', threads: { setup: [''] } })).status).toBe(400)
  expect((await putSettings(url, projectId, '{ not json')).status).toBe(400)
  const refused = await putSettings(url, projectId, { tier: 'local', threads: { tree: 'off' } })
  expect(refused.status).toBe(422)
  expect(await refused.text()).toContain('never overwritten')
  expect(readFileSync(join(project, '.enso', 'config.local.json'), 'utf8')).toBe('{ not json')
  // The page says which file was skipped, so a value from the tier below is not mistaken for it.
  const { unreadable } = await settingsOf(await fetch(`${url}/api/projects/${projectId}/settings`))
  expect(unreadable.map((skipped) => [skipped.tier, skipped.path])).toEqual([
    ['local', join(project, '.enso', 'config.local.json')],
  ])
})

// ── #873: trust from the project page ─────────────────────────────────────────────────────────

function putTrust(
  url: string,
  projectId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/projects/${projectId}/trust`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function trustOf(response: Response): Promise<EnsoProjectTrust> {
  expect(response.status).toBe(200)
  const answered: unknown = await response.json()
  if (!Check(EnsoProjectTrust, answered)) throw new Error('the answer is not EnsoProjectTrust')
  return answered
}

/** pi's `trust.json` as the store holds it: what every new session reads. */
const trustFile = (agentDir: string): unknown => JSON.parse(readFileSync(join(agentDir, 'trust.json'), 'utf8'))

test("the trust read names each of the project's own files with the setup commands it declares as written, or none — untrusted, and nothing applied (#873)", async () => {
  const { url, project, projectId } = await settingsServer({
    trusted: false,
    shared: { threads: { setup: ['bun install --frozen-lockfile', 'cp .env.example .env'] } },
    local: JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] } }),
  })
  expect(await trustOf(await fetch(`${url}/api/projects/${projectId}/trust`))).toEqual({
    projectId,
    path: project,
    trusted: false,
    files: [
      { tier: 'local', path: join(project, '.enso', 'config.local.json') },
      {
        tier: 'shared',
        path: join(project, '.enso', 'config.json'),
        setup: ['bun install --frozen-lockfile', 'cp .env.example .env'],
      },
    ],
  })
  // Shown, not applied: the settings still resolve without the project's own files.
  const settings = await settingsOf(await fetch(`${url}/api/projects/${projectId}/settings`))
  expect(settings.threads.setup).toEqual({ value: [], tier: 'default' })

  const bare = await settingsServer({ trusted: false })
  expect((await trustOf(await fetch(`${bare.url}/api/projects/${bare.projectId}/trust`))).files).toEqual([])
})

test("a PUT trusts the project in pi's store and its tiers apply; a revoke saves an explicit false, so a trusted ancestor does not show through (#873)", async () => {
  const { url, project, projectId, agentDir } = await settingsServer({
    trusted: false,
    shared: { threads: { setup: ['make'] } },
  })
  const trusted = await trustOf(await putTrust(url, projectId, { trusted: true }))
  expect(trusted.trusted).toBe(true)
  expect(trustFile(agentDir)).toEqual({ [project]: true })
  const settings = await settingsOf(await fetch(`${url}/api/projects/${projectId}/settings`))
  expect(settings.threads.setup).toEqual({ value: ['make'], tier: 'shared' })

  // The project's folder trusted from above (pi takes the nearest ancestor's decision): a revoke
  // that deleted the project's own entry would leave it trusted.
  writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [dirname(project)]: true }))
  expect((await trustOf(await fetch(`${url}/api/projects/${projectId}/trust`))).trusted).toBe(true)
  expect((await trustOf(await putTrust(url, projectId, { trusted: false }))).trusted).toBe(false)
  expect(trustFile(agentDir)).toEqual({ [dirname(project)]: true, [project]: false })
  expect((await settingsOf(await fetch(`${url}/api/projects/${projectId}/settings`))).trusted).toBe(false)
})

test('⚠ trust refusals: an unregistered id 404, a body that is not exactly `{ trusted }` 400 — a path is never taken — and nothing is written (#873)', async () => {
  const { url, project, projectId, agentDir } = await settingsServer({ trusted: false })
  expect((await fetch(`${url}/api/projects/0123456789abcdef/trust`)).status).toBe(404)
  const unknown = await putTrust(url, '0123456789abcdef', { trusted: true })
  expect(unknown.status).toBe(404)
  expect(await unknown.text()).toBe('no registered project has the id 0123456789abcdef')
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'enso-unregistered-')))
  for (const body of [{ trusted: 'yes' }, { trusted: true, path: elsewhere }, { path: elsewhere }, '{ not json']) {
    expect([body, (await putTrust(url, projectId, body)).status]).toEqual([body, 400])
  }
  // A path in the URL is no project id: no route matches it.
  expect((await putTrust(url, encodeURIComponent(elsewhere), { trusted: true })).status).toBe(404)
  expect(trustFile(agentDir)).toEqual({ [project]: false })
})

// #717's guard, on the route that decides what a project may run: a page on another loopback port
// (a dev server running agent-written code) can neither trust a project nor read what it declares.
test('⚠ a foreign page cannot trust a project or read its trust; Enso’s own page can (#873, #717)', async () => {
  const { url, project, projectId, agentDir } = await settingsServer({ trusted: false })
  const otherPort = { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'text/plain' }
  expect((await putTrust(url, projectId, { trusted: true }, otherPort)).status).toBe(403)
  const crossSite = { 'Sec-Fetch-Site': 'cross-site' }
  expect((await fetch(`${url}/api/projects/${projectId}/trust`, { headers: crossSite })).status).toBe(403)
  expect(trustFile(agentDir)).toEqual({ [project]: false })
  const ownPage = { Origin: 'http://127.0.0.1:5178', 'Sec-Fetch-Site': 'same-origin' }
  expect((await trustOf(await putTrust(url, projectId, { trusted: true }, ownPage))).trusted).toBe(true)
})

// A revoke fails closed AT ONCE, as removal does: never under a running thread of the project, and
// its idle live threads are retired, so the next prompt builds each again under the revoke.
test('⚠ revoking trust is refused while one of the project’s threads runs, and nothing is written (#873)', async () => {
  const { root, app } = projectRoot()
  const agentDir = mkdtempSync(join(tmpdir(), 'enso-revoke-agent-'))
  const { url } = await startWith(asksAndWaits, {}, undefined, { projectRoots: [root], agentDir })
  const project = await registeredProject(url, app)
  writeFileSync(join(agentDir, 'trust.json'), JSON.stringify({ [app]: true }))
  await prompt(url, 'busy', '/mode', { [ENSO_PROJECT_HEADER]: project.projectId })
  const refused = await putTrust(url, project.projectId, { trusted: false })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toBe('a thread in this project is running; revoke its trust when that settles')
  expect(trustFile(agentDir)).toEqual({ [app]: true })
})

test('⚠ revoking trust retires the project’s idle live threads, so each is built again at its next prompt; a grant retires none (#873)', async () => {
  const { root, app } = projectRoot()
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const project = await registeredProject(url, app)
  const naming = { [ENSO_PROJECT_HEADER]: project.projectId }
  expect(await prompt(url, 't1', 'hello', naming)).toBe(202)
  const liveIds = async (): Promise<string[]> =>
    ((await (await fetch(`${url}/api/threads`)).json()) as EnsoThreadSummary[]).map((summary) => summary.threadId)
  expect(await liveIds()).toEqual(['t1'])
  expect((await trustOf(await putTrust(url, project.projectId, { trusted: true }))).trusted).toBe(true)
  expect(await liveIds()).toEqual(['t1'])

  expect((await trustOf(await putTrust(url, project.projectId, { trusted: false }))).trusted).toBe(false)
  expect(await liveIds()).toEqual([])
  expect(await prompt(url, 't1', 'again', naming)).toBe(202)
  expect(requested).toEqual(['t1', 't1'])
})

// The trust read happens BEFORE the project is trusted, so its files are untrusted input: a link
// could point at a file an agent may not read, and the page would show it; a FIFO would hold the
// server. Neither is read — each is named, and said to be read anyway once trusted.
test('⚠ the trust read follows no link and opens no FIFO: each is named, never read, and said to be read once trusted (#873)', async () => {
  const { url, project, projectId } = await settingsServer({ trusted: false })
  const outside = mkdtempSync(join(tmpdir(), 'enso-trust-outside-'))
  writeFileSync(join(outside, 'config.json'), JSON.stringify({ threads: { setup: ['leaked-from-outside'] } }))
  symlinkSync(join(outside, 'config.json'), join(project, '.enso', 'config.json'))
  execFileSync('mkfifo', [join(project, '.enso', 'config.local.json')])
  const response = await fetch(`${url}/api/projects/${projectId}/trust`)
  const text = await response.clone().text()
  expect(text).not.toContain('leaked-from-outside')
  const { files } = await trustOf(response)
  expect(files.map((file) => ['unread' in file ? file.unread : 'read', file.tier])).toEqual([
    [
      'is not a regular file, so it is not shown here; trusting the project reads it anyway, setup commands included',
      'local',
    ],
    ['is a link, so it is not shown here; trusting the project reads it anyway, setup commands included', 'shared'],
  ])

  // `.enso/` itself a link: the file inside is reached through it, and not read either.
  const linked = await settingsServer({ trusted: false })
  const elsewhere = mkdtempSync(join(tmpdir(), 'enso-trust-dir-'))
  writeFileSync(join(elsewhere, 'config.json'), JSON.stringify({ threads: { setup: ['leaked-through-dir'] } }))
  rmdirSync(join(linked.project, '.enso'))
  symlinkSync(elsewhere, join(linked.project, '.enso'))
  const throughDir = await trustOf(await fetch(`${linked.url}/api/projects/${linked.projectId}/trust`))
  expect(JSON.stringify(throughDir)).not.toContain('leaked-through-dir')
  expect(throughDir.files).toEqual([
    {
      tier: 'shared',
      path: join(linked.project, '.enso', 'config.json'),
      unread:
        'is reached through a link, so it is not shown here; trusting the project reads it anyway, setup commands included',
    },
  ])
})

test('⚠ a request naming a different project for a thread already named is a 409, and nothing is built', async () => {
  const { root, app } = projectRoot()
  const other = join(root, 'other')
  mkdirSync(other)
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, { projectRoots: [root] })
  const appProject = await registeredProject(url, app)
  const otherProject = await registeredProject(url, other)
  const follow = new AbortController()
  openFollows.push(follow)
  await openFollow(url, 'named', follow, { [ENSO_PROJECT_HEADER]: appProject.projectId })

  const refused = await fetch(`${url}/api/threads/named/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ENSO_PROJECT_HEADER]: otherProject.projectId },
    body: JSON.stringify({ message: 'hello' }),
  })
  expect(refused.status).toBe(409)
  expect(await refused.text()).toContain(`already named for project ${appProject.projectId}`)
  expect(requested).toEqual([])
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
  const beforePrompt = follow.frames.length
  expect(await prompt(url, 'flowing', 'hello while logging in')).toBe(202)
  // That prompt's run settles at once, and its `settled` must be on the follow before the flow's
  // window is measured below, or it lands inside it (a slow CI runner delivered it late).
  const settled = (frame: EnsoFollowFrame): boolean =>
    frame.type === 'observation' && frame.observation.kind === 'settled'
  if (!follow.frames.slice(beforePrompt).some(settled)) await follow.untilFrame(settled)

  // One flow at a time on a session: a second start while the first waits is refused, and says which.
  const second = await run({ name: 'login', value: 'fake/api_key' })
  expect(second.status).toBe(422)
  expect(await second.text()).toBe('/login is already in progress here')

  // The flow ends on its own clock: its notify and the model state land on the feed. Waited for
  // by predicate — the `model` observation itself — and read as observations only, so the lease
  // frames of the prompt and the refused start above cannot race the assertion.
  const beforeSettle = follow.frames.length
  thread.flows[0]?.settle()
  await follow.untilFrame((frame) => frame.type === 'observation' && frame.observation.kind === 'model')
  const observed = follow.frames
    .slice(beforeSettle)
    .flatMap((frame) => (frame.type === 'observation' ? [frame.observation.kind] : []))
  expect(observed).toEqual(['extension-ui-request', 'model'])

  const refused = await run({ name: 'login', value: 'nowhere/oauth' })
  expect(refused.status).toBe(422)
  expect(await refused.text()).toBe('login nowhere/oauth is not offered here')
  const noFlow = await run({ name: 'logout', value: 'nobody' })
  expect(noFlow.status).toBe(422)
  expect(await noFlow.text()).toBe('no stored credential for nobody')
  expect(built).toHaveLength(1)
})

// ⚠ #348: a login holds no lease, so `POST …/abort` answered 409 "nothing is running" through a
// device-code wait. Stop now ends the login: 200, the flow settles, and a follow that opens
// mid-login is told there is one (its snapshot), so a page arriving then offers the Stop too.
test('⚠ POST …/abort during a login ends it: the snapshot says a login waits, Stop is 200, then nothing is left', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const started = await fetch(`${url}/api/threads/logging-in/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'login', value: 'fake/oauth' }),
  })
  expect(started.status).toBe(202)
  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 'logging-in', controller)
  expect(follow.frames[0]).toMatchObject({ type: 'snapshot', busy: false, login: { provider: 'fake' } })

  const stop = async (): Promise<number> =>
    (await fetch(`${url}/api/threads/logging-in/abort`, { method: 'POST' })).status
  expect(await stop()).toBe(200)
  expect(built[0]?.flows.map((flow) => flow.settled)).toEqual([true])
  // Nothing waits any more, and no run is in flight: the next Stop has nothing to stop.
  expect(await stop()).toBe(409)
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

/** `POST …/fork` (#433) with this body; the status and the text or receipt it answered. */
async function fork(url: string, threadId: string, body: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}/api/threads/${threadId}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

test('⚠ POST …/fork answers the new thread and its prefill; refuses a running thread (409), an unknown thread or entry (404), a non-user entry and a bad body (400) (#433)', async () => {
  const stored = { 'stored-1': { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question' } }
  const { url, built } = await startWith(asksAndWaits, stored)
  const forked = await fork(url, 'stored-1', { entryId: 'u1' })
  expect(forked.status).toBe(200)
  expect(JSON.parse(forked.body)).toEqual({ threadId: 'stored-1-fork', prefill: 'earlier question' })
  // Forking reads the file: nothing is built for the source (#86).
  expect(built).toHaveLength(0)
  expect((await fork(url, 'stored-1', { entryId: 'a1' })).status).toBe(400)
  expect((await fork(url, 'stored-1', { entryId: 'nope' })).status).toBe(404)
  expect((await fork(url, 'never-stored', { entryId: 'u1' })).status).toBe(404)
  expect((await fork(url, 'stored-1', { entryId: 'u1', extra: 1 })).status).toBe(400)
  // A run holds the thread: the fork point may not be where the run leaves the branch.
  await prompt(url, 'stored-1', '/mode')
  const busy = await fork(url, 'stored-1', { entryId: 'u1' })
  expect(busy.status).toBe(409)
  expect(busy.body).toContain('is running')
})

/** `POST …/restore` (#551) with this body; the status and the text or receipt it answered. */
async function restore(url: string, threadId: string, body: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}/api/threads/${threadId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

test('⚠ POST …/restore answers the restored and safety hashes; refuses an unknown thread or entry (404), no tree, no snapshot, a refused restore and a running thread (409), a bad body (400) (#551)', async () => {
  const thread = { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question' }
  const stored = {
    restored: { ...thread, restore: { kind: 'restored', hash: 'a'.repeat(40), safety: 'b'.repeat(40) } as const },
    treeless: thread,
    unsnapshotted: { ...thread, restore: { kind: 'no-snapshot', reason: 'no snapshot at u1' } as const },
    refusing: { ...thread, restore: { kind: 'refused', reason: 'checkout-index failed' } as const },
  }
  const { url, built } = await startWith(asksAndWaits, stored)
  const restored = await restore(url, 'restored', { entryId: 'u1' })
  expect(restored.status).toBe(200)
  expect(JSON.parse(restored.body)).toEqual({ hash: 'a'.repeat(40), safety: 'b'.repeat(40) })
  expect(await restore(url, 'treeless', { entryId: 'u1' })).toEqual({
    status: 409,
    body: 'thread treeless has no tree',
  })
  expect(await restore(url, 'unsnapshotted', { entryId: 'u1' })).toEqual({ status: 409, body: 'no snapshot at u1' })
  expect(await restore(url, 'refusing', { entryId: 'u1' })).toEqual({ status: 409, body: 'checkout-index failed' })
  expect((await restore(url, 'restored', { entryId: 'nope' })).status).toBe(404)
  // An unknown thread is answered before the lease: nothing is BUILT under its id.
  const builtBefore = built.length
  expect((await restore(url, 'never-stored', { entryId: 'u1' })).status).toBe(404)
  expect(built).toHaveLength(builtBefore)
  expect((await restore(url, 'restored', { entryId: 'u1', extra: 1 })).status).toBe(400)
  expect((await restore(url, 'restored', { entryId: '' })).status).toBe(400)
  // A run holds the thread: it is writing the very files a restore would replace.
  await prompt(url, 'restored', '/mode')
  const busy = await restore(url, 'restored', { entryId: 'u1' })
  expect(busy.status).toBe(409)
  expect(busy.body).toContain('is running')
})

/** `POST …/name` (#670) with this body; the status and the text it answered. */
async function rename(url: string, threadId: string, body: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}/api/threads/${threadId}/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

test('⚠ POST …/name names a thread — trimmed — and the listing carries it, as the history carries a stored name; refuses a blank or too long name or a bad body (400), an unknown thread (404) and a running one (409) (#670)', async () => {
  const branch = { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question' }
  // `long`: a name pi's own `/name` wrote, past the 120 a rename takes (PR #722 review).
  const stored = {
    'stored-1': branch,
    named: { ...branch, name: 'Approach B: a parser' },
    plain: branch,
    long: { ...branch, name: 'n'.repeat(200) },
  }
  const { url, built } = await startWith(asksAndWaits, stored)
  expect(await rename(url, 'stored-1', { name: '  Approach A: regex  ' })).toEqual({ status: 204, body: '' })
  const listed = (await (await fetch(`${url}/api/stored-threads`)).json()) as EnsoStoredThread[]
  expect(listed.find((row) => row.threadId === 'stored-1')).toMatchObject({
    name: 'Approach A: regex',
    title: 'earlier question',
  })
  // Every row is still a listing row the page takes, and the history the page mounts.
  expect(listed.every((row) => Check(EnsoStoredThread, row))).toBe(true)
  expect(Check(EnsoThreadHistory, await (await fetch(`${url}/api/threads/long/history`)).json())).toBe(true)
  // A resume mounts from the history: a named thread comes back named. (A live one's name is its
  // session's — the host test's.)
  const history = (await (await fetch(`${url}/api/threads/named/history`)).json()) as EnsoThreadHistory
  expect(history.name).toBe('Approach B: a parser')
  const unnamed = (await (await fetch(`${url}/api/threads/plain/history`)).json()) as { name?: string }
  expect(unnamed.name).toBeUndefined()
  for (const refused of [{ name: '   ' }, { name: '' }, { name: 'x'.repeat(121) }, { name: 'a', extra: 1 }, {}]) {
    expect((await rename(url, 'stored-1', refused)).status).toBe(400)
  }
  // An unknown thread is answered before the lease: nothing is BUILT under its id.
  const builtBefore = built.length
  expect((await rename(url, 'never-stored', { name: 'x' })).status).toBe(404)
  expect(built).toHaveLength(builtBefore)
  // A run holds the thread: a name appended now would land between the run's messages.
  await prompt(url, 'stored-1', '/mode')
  const busy = await rename(url, 'stored-1', { name: 'later' })
  expect(busy.status).toBe(409)
  expect(busy.body).toContain('is running')
})

// ⚠ PR #561 review: the restore routes HOLD the thread for the whole restore, as a run does — a
// control route that comes meanwhile is refused, and the hold is given back once it settles.
test('⚠ a restore holds its thread until it settles: a mode change meanwhile is refused (409), and accepted after; POST …/restore/undo answers the same way (#551, #565)', async () => {
  const finish = Promise.withResolvers<ThreadRestoreOutcome>()
  const thread = { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question' }
  const { url } = await startWith(settlesAtOnce, { held: { ...thread, restore: finish.promise } })
  const changeMode = (): Promise<Response> =>
    fetch(`${url}/api/threads/held/mode`, { method: 'POST', body: JSON.stringify({ mode: 'acceptEdits' }) })
  const undoOf = (threadId: string, body: unknown): Promise<Response> =>
    fetch(`${url}/api/threads/${threadId}/restore/undo`, { method: 'POST', body: JSON.stringify(body) })
  // The undo names the safety its notice promised (PR #561 review): without one it is no undo.
  expect((await undoOf('held', {})).status).toBe(400)
  expect((await undoOf('held', { safety: 'not-a-hash' })).status).toBe(400)
  const undo = undoOf('held', { safety: 'b'.repeat(40) })
  await Bun.sleep(50)
  const meanwhile = await changeMode()
  expect(meanwhile.status).toBe(409)
  finish.resolve({ kind: 'restored', hash: 'c'.repeat(40), safety: 'd'.repeat(40) })
  const undone = await undo
  expect(undone.status).toBe(200)
  expect(await undone.json()).toEqual({ hash: 'c'.repeat(40), safety: 'd'.repeat(40) })
  expect((await changeMode()).status).toBe(204)
  expect((await undoOf('never-stored', { safety: 'b'.repeat(40) })).status).toBe(404)
})

/** `DELETE …` (#571), with `query` appended and `ifMatch` as its `If-Match`; the status and the text it answered. */
async function deleteOf(
  url: string,
  threadId: string,
  query = '',
  ifMatch?: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}/api/threads/${threadId}${query}`, {
    method: 'DELETE',
    ...(ifMatch === undefined ? {} : { headers: { 'If-Match': ifMatch } }),
  })
  return { status: response.status, body: await response.text() }
}

/** The `If-Match` a page sends to confirm the work it showed (PR #572 review): its words' sha256, a strong tag. */
const confirming = (work: string): string => `"${createHash('sha256').update(work).digest('hex')}"`

test('⚠ DELETE /api/threads/:id answers 204 and the thread is gone; a tree holding work is a 422 naming it, deleted with ?force=1 and no other query; an unknown thread 404; a running one 409 (#571)', async () => {
  const thread = { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question' }
  const stored = {
    plain: thread,
    working: { ...thread, holdsWork: 'the tree holds work — untracked: work.md' },
    running: thread,
  }
  const { url } = await startWith(asksAndWaits, stored)
  // The preview (#571): what a delete would do, read before it — nothing deleted by asking.
  const preview = await fetch(`${url}/api/threads/working/delete-preview`)
  expect([preview.status, await preview.json()]).toEqual([
    200,
    { tree: null, size: null, holdsWork: 'the tree holds work — untracked: work.md', keptFor: [] },
  ])
  expect(await deleteOf(url, 'plain')).toEqual({ status: 204, body: '' })
  expect((await deleteOf(url, 'plain')).status).toBe(404)
  // PR #572 review: a deleted id's history is a 410, not the 404 a page takes for "start it under this id".
  const gone = await fetch(`${url}/api/threads/plain/history`)
  expect([gone.status, await gone.text()]).toEqual([410, 'thread plain was deleted'])
  expect((await fetch(`${url}/api/threads/never-stored/history`)).status).toBe(404)
  expect((await fetch(`${url}/api/threads/plain/delete-preview`)).status).toBe(410)
  expect((await fetch(`${url}/api/threads/never-stored/delete-preview`)).status).toBe(404)
  expect(await deleteOf(url, 'working')).toEqual({ status: 422, body: 'the tree holds work — untracked: work.md' })
  expect((await deleteOf(url, 'working', '?force=0')).status).toBe(404)
  expect((await deleteOf(url, 'working', '?force=1&x=1')).status).toBe(404)
  // PR #572 review: force takes only the work the page showed — named by its digest in `If-Match`.
  expect(await deleteOf(url, 'working', '?force=1')).toEqual({
    status: 422,
    body: 'the tree holds work — untracked: work.md',
  })
  expect(
    (await deleteOf(url, 'working', '?force=1', confirming('the tree holds work — untracked: other.md'))).status,
  ).toBe(422)
  expect((await deleteOf(url, 'working', '?force=1', 'not-a-tag')).status).toBe(400)
  expect(await deleteOf(url, 'working', '?force=1', confirming('the tree holds work — untracked: work.md'))).toEqual({
    status: 204,
    body: '',
  })
  expect((await deleteOf(url, 'never-stored')).status).toBe(404)
  // A run holds the thread: refused before the host is asked, never forceable.
  await prompt(url, 'running', '/mode')
  const busy = await deleteOf(url, 'running', '?force=1')
  expect(busy.status).toBe(409)
  expect(busy.body).toContain('is running')
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
  // `other` with its type, the `active_agent` entry is `custom` with its data — a reader
  // cross-checks the mode without knowing the vendor's stored shape.
  const entries = (inspection as EnsoThreadInspection).entries
  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ kind: 'other', type: 'session' })
  expect(entries[1]).toMatchObject({ kind: 'custom', customType: 'active_agent', data: { name: 'enso-mode-plan' } })
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
  {
    type: 'custom',
    customType: 'active_agent',
    data: { name: 'enso-mode-plan' },
    id: 'p',
    parentId: null,
    timestamp: '',
  },
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

/** The server's side of `docs/flows/resume.md` (#482): the listing, the cold read, the first prompt. */
const RESUME_FLOW = {
  participants: {
    B: 'browser (the test client)',
    S: 'server (server/index.ts)',
    T: 'thread registry',
    H: 'host (fake, over stored threads)',
  },
  categories: { 'enso.server.http': 'S', 'enso.server.threads': 'T', 'enso.server.follow': 'S' },
} as const

/**
 * A host wrapper that draws the store-facing calls into a trace once one is set: the listing, the
 * cold read, the build. Handed to `startWith` before the trace exists, so the server's own start
 * is not drawn.
 */
function drawnHost(): {
  readonly wrap: (host: AgentHost) => AgentHost
  readonly traceInto: (trace: FlowTrace) => void
} {
  let trace: FlowTrace | undefined
  return {
    wrap: (host: AgentHost): AgentHost => ({
      ...host,
      listSessions: () => {
        trace?.send('S', 'H', 'listSessions()')
        return host.listSessions()
      },
      readStoredThread: (threadId: string) => {
        trace?.send('S', 'H', `readStoredThread(${threadId})`)
        return host.readStoredThread(threadId)
      },
      createSession: (threadId: string, newSessionDirectory: () => string) => {
        trace?.send('T', 'H', `createSession(${threadId})`)
        return host.createSession(threadId, newSessionDirectory)
      },
    }),
    traceInto: (into: FlowTrace) => {
      trace = into
    },
  }
}

// @pins resume/one-id
test("⚠ a prompt on a thread passes THAT id to the host — the thread id is pi's session id, so a stored one reopens", async () => {
  const drawn = drawnHost()
  const { url, requested } = await startWith(settlesAtOnce, {}, drawn.wrap)
  const trace = flowTrace({ ...RESUME_FLOW, logs })
  drawn.traceInto(trace)
  trace.request('B', 'S', 'POST /api/threads/stored-1/prompt', { message: 'continue' })
  trace.respond('S', 'B', await prompt(url, 'stored-1', 'continue'))
  expect(requested).toEqual(['stored-1'])
  expect(trace.diagram()).toMatchSnapshot('flow resume: the first prompt builds the thread under its own id')
})

// @pins resume/rail-listing
// Also waiting (#876): the test's name keys the flow snapshot below, so it stays as it was.
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
      parentThreadId: 'stored-1',
    },
  }
  const drawn = drawnHost()
  const { url } = await startWith(asksAndWaits, stored, drawn.wrap)
  // An open question holds stored-1 busy on this server: taken, never released.
  await prompt(url, 'stored-1', '/mode')
  const trace = flowTrace({ ...RESUME_FLOW, logs })
  drawn.traceInto(trace)
  trace.request('B', 'S', 'GET /api/stored-threads')
  const response = await fetch(`${url}/api/stored-threads`)
  trace.respond('S', 'B', response.status)
  expect(response.status).toBe(200)
  const listed: unknown = await response.json()
  expect(Array.isArray(listed) && listed.every((thread) => Check(EnsoStoredThread, thread))).toBe(true)
  const launch = ((await (await fetch(`${url}/api/projects`)).json()) as EnsoProject[])[0]?.projectId
  expect(listed).toEqual([
    {
      threadId: 'stored-1',
      projectId: launch,
      title: 'earlier question',
      lastActivityAt: '2026-09-08T10:00:05.000Z',
      messageCount: 2,
      busy: true,
      // The question it asked is open: waiting on the person, so the rail says so for a thread the page has not opened (#876).
      waiting: true,
    },
    // A blank first message is no title — the rail says "new thread", not "   ". A fork names its parent (#433).
    {
      threadId: 'stored-2',
      projectId: launch,
      lastActivityAt: '2026-09-08T11:00:00.000Z',
      messageCount: 0,
      busy: false,
      waiting: false,
      parentThreadId: 'stored-1',
    },
  ])
  expect(trace.diagram()).toMatchSnapshot('flow resume: the rail lists what is stored')

  // Answered, the question is closed: no longer waiting, while the run it was asked in goes on.
  const answered = await fetch(`${url}/api/threads/stored-1/dialog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'd1', value: 'a' }),
  })
  expect(answered.status).toBe(204)
  const after = (await (await fetch(`${url}/api/stored-threads`)).json()) as EnsoStoredThread[]
  expect(after.find((thread) => thread.threadId === 'stored-1')).toMatchObject({ busy: true, waiting: false })
})

// @pins resume/looking-builds-nothing resume/opening-mode
test("GET /api/threads/:id/history serves a STORED thread's branch as messages with its persisted mode, and builds no session", async () => {
  const stored = {
    'stored-1': { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question', mode: 'plan' },
  }
  const drawn = drawnHost()
  const { url, built } = await startWith({ onPrompt: neverPrompted }, stored, drawn.wrap)
  const trace = flowTrace({ ...RESUME_FLOW, logs })
  drawn.traceInto(trace)
  trace.request('B', 'S', 'GET /api/threads/stored-1/history')
  const response = await fetch(`${url}/api/threads/stored-1/history`)
  expect(response.status).toBe(200)
  const history: unknown = await response.json()
  // The project id hashes the launch directory, which differs by machine: left out of the drawing.
  const { projectId: _projectId, ...drawnHistory } = history as Record<string, unknown>
  trace.respond('S', 'B', response.status, drawnHistory)
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
  trace.request('B', 'S', 'GET /api/threads/never-existed/history')
  const missing = await fetch(`${url}/api/threads/never-existed/history`)
  trace.respond('S', 'B', missing.status)
  expect(missing.status).toBe(404)
  expect(built).toHaveLength(0)
  expect(trace.diagram()).toMatchSnapshot('flow resume: the cold read builds nothing')
})

// ⚠ HELD IS NOT BUSY (PR #104 review). A released thread stays cached for the idle window;
// gating on presence locked a reloaded page out of its own session for thirty minutes.
// @pins resume/rail-listing resume/opening-mode
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
  // Its in-memory branch carries no messages (a session-start entry and a mode entry).
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
    readStoredThread: async (threadId: string) => {
      const storedRead = await host.readStoredThread(threadId)
      await promptDuringRead?.()
      promptDuringRead = undefined
      return storedRead
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
  expect(snapshot.messageCount).toBe(history.messages.length)
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

// #412: pi parked on a question ends its branch on the `ask_user` call, with no result yet — the
// shape #109's torn-tail rule warns about. While the run is live that is not a torn tail, and the
// warning (with every call on the page read as aborted) contradicted the question card beside it.
const ENDS_ON_AN_OPEN_CALL: Partial<HostedThreadInspection> = {
  entries: transcriptOf([
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-09-08T10:00:00.000Z',
      message: { role: 'user', content: 'pick one', timestamp: 1 },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-09-08T10:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'ask-1', name: 'ask_user', arguments: {} }] },
    },
  ]),
}

test('⚠ a thread BUSY here that ends on a call with no result is not a torn tail; the same tail once idle is (#412)', async () => {
  const busy = await startWith({ ...asksAndWaits, inspect: ENDS_ON_AN_OPEN_CALL })
  await prompt(busy.url, 't1', '/mode')
  const asked = (await (await fetch(`${busy.url}/api/threads/t1/history`)).json()) as EnsoThreadHistory
  expect(asked.messages).not.toEqual([])
  expect(asked).not.toHaveProperty('interrupted')
  // Live but idle, the run is over: #109's warning stands.
  const idle = await startWith({ ...settlesAtOnce, inspect: ENDS_ON_AN_OPEN_CALL })
  await prompt(idle.url, 't1', 'go')
  const ended = (await (await fetch(`${idle.url}/api/threads/t1/history`)).json()) as EnsoThreadHistory
  expect(ended.interrupted).toBe('tool-call-without-result')
})

// #766: a reload must say a stopped run was stopped, after the message it stopped at. The stop is the
// host's `enso-run-stopped` entry; both routes carry, per stop, the message before it — a branch
// with none carries no field at all.
test('/history and the follow’s snapshot say where a stored thread’s run was stopped; a branch with no stop says nothing (#766)', async () => {
  const stop = { type: 'custom', customType: ENSO_RUN_STOPPED_ENTRY, data: {}, id: 's1', parentId: 'a1', timestamp: '' }
  const stored = {
    stopped: { transcript: [...STORED_BRANCH, ...transcriptOf([stop])], modified: new Date(0), firstMessage: 'q' },
    finished: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'q' },
  }
  const { url } = await startWith({ onPrompt: neverPrompted }, stored)
  const history = (await (await fetch(`${url}/api/threads/stopped/history`)).json()) as EnsoThreadHistory
  expect(history.stoppedAfter).toEqual(['a1'])
  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 'stopped', controller)
  await follow.untilFrames(1)
  expect(follow.frames[0]).toMatchObject({ type: 'snapshot', stoppedAfter: ['a1'] })
  const finished = (await (await fetch(`${url}/api/threads/finished/history`)).json()) as EnsoThreadHistory
  expect(finished).not.toHaveProperty('stoppedAfter')
})

// #739: opening a thread sent the whole branch twice — `/history` and the follow's snapshot, 15 MB
// each at 5,040 turns. `/history` sends the last page and says what is before it; `?before=` reads
// the page before a message; the snapshot says only how many messages there are.
test('/history pages a long branch from its end, `?before=` reads the page before, and the snapshot carries no messages (#739)', async () => {
  const count = HISTORY_PAGE_MESSAGES + 5
  const transcript: EnsoTranscriptEntry[] = Array.from({ length: count }, (_, position) => ({
    kind: 'message',
    id: `m${position}`,
    role: position % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `message ${position}` }],
  }))
  const stored = { long: { transcript, modified: new Date(0), firstMessage: 'message 0' } }
  const { url } = await startWith({ onPrompt: neverPrompted }, stored)
  const ids = (history: EnsoThreadHistory): unknown[] =>
    history.messages.map((message) =>
      typeof message === 'object' && message !== null && 'id' in message ? message.id : undefined,
    )

  const last = (await (await fetch(`${url}/api/threads/long/history`)).json()) as EnsoThreadHistory
  expect(Check(EnsoThreadHistory, last)).toBe(true)
  expect(ids(last)).toEqual(Array.from({ length: HISTORY_PAGE_MESSAGES }, (_, position) => `m${position + 5}`))
  // Five before it, three of them prompts; the first prompt rides along for the thread's title.
  expect(last.earlier).toEqual({
    messages: 5,
    prompts: 3,
    firstPrompt: { id: 'm0', role: 'user', parts: [{ type: 'text', content: 'message 0' }] },
  })

  const earlier = (await (await fetch(`${url}/api/threads/long/history?before=m5`)).json()) as EnsoThreadHistory
  expect(ids(earlier)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  expect(earlier).not.toHaveProperty('earlier')

  // A message the branch no longer holds (a compaction rewrote it): refused, never another page spliced in.
  const gone = await fetch(`${url}/api/threads/long/history?before=rewritten`)
  expect(gone.status).toBe(409)
  expect(await gone.text()).toContain('no longer holds message rewritten')

  const controller = new AbortController()
  openFollows.push(controller)
  const follow = await openFollow(url, 'long', controller)
  await follow.untilFrames(1)
  expect(follow.frames[0]).toMatchObject({ type: 'snapshot', messageCount: count })
  expect(follow.frames[0]).not.toHaveProperty('messages')
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
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
    host: () => host,
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
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: occupied,
    host: () => host,
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
  expect(Object.keys(about).toSorted()).toEqual(['at', 'bun', 'enso', 'os', 'pi', 'selection'])
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

// ⚠ #717, measured: `Origin` names a host, and a page on `localhost:5173` — a dev server running
// agent-written code — passed the loopback check and switched a thread to `bypassPermissions` (204).
// A browser's `Sec-Fetch-Site` says what `Origin` cannot: the page is on another origin. Enso's own
// page is `same-origin`; a navigation the person made is `none`; the repo's CLIs send no such header.
test('⚠ a page on another loopback port cannot escalate, prompt, answer or read; Enso’s own page, a navigation and a CLI still can (#717)', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const otherPort = { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'text/plain' }
  for (const [route, body] of [
    ['zzz3/mode', { mode: 'acceptEdits' }],
    ['zzz3/prompt', { message: 'read every secret you can find' }],
    ['zzz3/dialog', { dialogId: 'd1', optionId: 'allow' }],
  ] as const) {
    const answer = await fetch(`${url}/api/threads/${route}`, {
      method: 'POST',
      headers: otherPort,
      body: JSON.stringify(body),
    })
    expect([route, answer.status]).toEqual([route, 403])
  }
  // The mode change acquires: a session here would be proof the escalation went through.
  expect(built.length).toBe(0)
  // #866: registering a folder sets what an agent can reach, and no root fences it any more, so a
  // foreign page is refused here as on every route — and nothing is registered.
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'enso-elsewhere-')))
  const foreignRegister = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: otherPort,
    body: JSON.stringify({ path: elsewhere }),
  })
  expect(foreignRegister.status).toBe(403)
  expect(await (await fetch(`${url}/api/projects`)).json()).toHaveLength(1)
  // Reading is refused the same way to another site, its Origin absent as on a no-cors GET.
  expect((await fetch(`${url}/api/about`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)

  // What still works: Enso's own page, a navigation, and a CLI with no Fetch Metadata.
  const ownPage = { Origin: 'http://127.0.0.1:5178', 'Sec-Fetch-Site': 'same-origin' }
  expect((await fetch(`${url}/api/about`, { headers: ownPage })).status).toBe(200)
  expect((await fetch(`${url}/api/about`, { headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(200)
  expect((await fetch(`${url}/api/about`, { headers: { Origin: 'http://localhost:5178' } })).status).toBe(200)
  // Enso's own page registers a folder with no root declared (#866): a fresh install needs no config.
  const ownRegister = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { ...ownPage, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: elsewhere }),
  })
  expect(ownRegister.status).toBe(201)
})

// #754: a failed setup is shown on the thread with its output — the tree route carries what the
// branch recorded, and nothing for a thread whose tree had nothing to set up.
test("the tree route carries what preparing the thread's tree did, from its branch (#754)", async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-setup-tree-'))
  const setup: EnsoTreeSetupOutcome = {
    ok: false,
    copied: [],
    missing: ['.env'],
    steps: [{ command: 'bun install', exitCode: 1, durationMs: 5, output: 'no lockfile\n', truncated: false }],
    tiers: { setup: 'shared', copy: 'local' },
  }
  const { url } = await startWith(
    settlesAtOnce,
    {
      prepared: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'one', cwd: tree },
      plain: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'two', cwd: tree },
    },
    (host) => ({
      ...host,
      threadTree: (threadId: string): Promise<ThreadTreePlace> =>
        Promise.resolve({
          record: {
            kind: 'worktree',
            project: '/work/app',
            path: tree,
            branch: `enso/${threadId}`,
            base: 'a'.repeat(40),
          },
          store: '/enso/snapshots/x',
          ...(threadId === 'prepared' ? { setup } : {}),
        }),
    }),
    { launch: tree },
  )
  const prepared: unknown = await (await fetch(`${url}/api/threads/prepared/tree`)).json()
  expect(prepared).toMatchObject({ threadId: 'prepared', path: tree, setup })
  const plain: unknown = await (await fetch(`${url}/api/threads/plain/tree`)).json()
  expect(plain).not.toHaveProperty('setup')
})

// ⚠ #713, measured: in a CSP sandbox under Enso's origin (#619) the page had an opaque origin — no
// `localStorage`, and a root-relative `/src/main.js` missed its sub-path — so both apps two arena runs
// built showed broken in Preview. Each thread's preview is now an origin of its own: its tree at `/`,
// no sandbox. That is safe only because Enso trusts no other loopback origin (#717): this pins both,
// and that the listener serves the tree and nothing else, read-only, to loopback only.
test('⚠ a thread’s preview is an origin of its own: its tree at `/`, nothing outside it, read-only, and no way into Enso (#713)', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'enso-preview-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'not the tree')
  const tree = join(outside, 'tree')
  mkdirSync(join(tree, 'src'), { recursive: true })
  // A root-relative script, as Vite's default page loads one.
  writeFileSync(join(tree, 'index.html'), '<!doctype html><script type="module" src="/src/main.js"></script>')
  writeFileSync(join(tree, 'src', 'main.js'), 'localStorage.setItem("best", "12")')
  symlinkSync(join(outside, 'secret.txt'), join(tree, 'escape.txt'))
  // A second thread working in the same tree: the origin is the thread's, not the directory's.
  const { url, built } = await startWith(
    settlesAtOnce,
    {
      built: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'snake', cwd: tree },
      other: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'other', cwd: tree },
    },
    (host) => host,
    { launch: tree },
  )
  const listingOf = async (threadId: string): Promise<{ pages?: string[]; previewOrigin?: string }> =>
    (await (await fetch(`${url}/api/threads/${threadId}/tree`)).json()) as { pages?: string[]; previewOrigin?: string }
  const listing = await listingOf('built')
  expect(listing.pages).toEqual(['index.html'])
  const origin = listing.previewOrigin ?? 'no origin'
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(origin).not.toBe(new URL(url).origin)
  // The same origin each time, and another thread's is another.
  expect((await listingOf('built')).previewOrigin).toBe(origin)
  const otherOrigin = (await listingOf('other')).previewOrigin ?? 'no origin'
  expect(otherOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(otherOrigin).not.toBe(origin)

  // The tree at `/`, a root-relative path included, with no sandbox: the page's origin is its own.
  for (const [path, type] of [
    ['/', 'text/html; charset=utf-8'],
    ['/index.html', 'text/html; charset=utf-8'],
    ['/src/main.js', 'text/javascript; charset=utf-8'],
  ] as const) {
    const served = await fetch(`${origin}${path}`)
    expect([path, served.status, served.headers.get('content-type')]).toEqual([path, 200, type])
    expect(served.headers.get('content-security-policy')).toBeNull()
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  }
  expect((await fetch(`${otherOrigin}/src/main.js`)).status).toBe(200)
  for (const escape of [
    '/..%2Fsecret.txt',
    '/../secret.txt',
    '/escape.txt',
    '/src/..%2F..%2Fsecret.txt',
    '/nope.html',
  ]) {
    expect([escape, (await fetch(`${origin}${escape}`)).status]).toEqual([escape, 404])
  }
  // Read-only, and to loopback only: a rebound name is not the machine.
  expect((await fetch(`${origin}/index.html`, { method: 'POST', body: 'x' })).status).toBe(405)
  expect((await fetch(`${origin}/index.html`, { headers: { Host: 'attacker.example' } })).status).toBe(403)
  // Enso serves no preview of its own any more.
  expect((await fetch(`${url}/preview/threads/built/index.html`)).status).toBe(404)

  // What the page can send Enso: a request from another origin. The escalation is refused, and no
  // session was built on the way (the mode change acquires — a build would be proof it went through).
  const fromThePage = await fetch(`${url}/api/threads/built/mode`, {
    method: 'POST',
    headers: { Origin: origin, 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ mode: 'acceptEdits' }),
  })
  expect(fromThePage.status).toBe(403)
  expect(built.length).toBe(0)

  // The previews close with the server.
  await openServers.at(-1)?.close()
  expect(
    await fetch(`${origin}/`).then(
      () => 'answered',
      () => 'closed',
    ),
  ).toBe('closed')
})

test('the dev page and the header-less CLIs are unaffected', async () => {
  const { url } = await startWith(settlesAtOnce)
  for (const origin of ['http://127.0.0.1:5178', 'http://localhost:5178', 'http://127.0.0.1:5179']) {
    expect((await fetch(`${url}/api/about`, { headers: { Origin: origin } })).status).toBe(200)
  }
  // `enso-thread.ts` and `curl` send no Origin at all.
  expect((await fetch(`${url}/api/about`)).status).toBe(200)
})

// #361 phase 3: the one thread route with a second path parameter. Only a turn number or `next`
// matches it; a turn the branch lacks is a 404 that names the request.
test('GET …/context/:request reads a turn or `next`; any other segment, or a turn not there, is a 404', async () => {
  const detail = { elements: [], left: [] }
  const { url, built } = await startWith(settlesAtOnce, {
    s1: {
      transcript: [],
      modified: new Date('2026-09-24T10:00:00.000Z'),
      firstMessage: 'one',
      details: { '2': detail, next: detail },
    },
  })
  const read = async (segment: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${url}/api/threads/s1/context/${segment}`)
    return { status: response.status, body: await response.text() }
  }
  const turn = await read('2')
  expect(turn.status).toBe(200)
  expect(JSON.parse(turn.body)).toMatchObject({ threadId: 's1', request: 2 })
  const next = await read('next')
  expect(next.status).toBe(200)
  expect(JSON.parse(next.body)).toMatchObject({ request: 'next' })
  expect(await read('7')).toEqual({ status: 404, body: 'no request 7 on thread s1' })
  for (const segment of ['0', '01', 'x', '-1']) expect((await read(segment)).status).toBe(404)
  // Looking builds nothing (#86).
  expect(built).toHaveLength(0)
})

// #435: the fork point reads cold from the host's branch walk and live from pi's memory — the
// same route, and looking builds nothing (#86).
test('GET …/manifest answers a cold thread from its file without building, a live one from its session, and 404 for neither', async () => {
  const point: EnsoForkPoint = {
    identity: { threadId: 's1', leafEntryId: 'e2', parentThreadId: 's0' },
    conditions: {
      model: null,
      thinkingLevel: 'high',
      mode: 'plan',
      cwd: '/repo',
      runContext: null,
      systemPrompt: { id: 'reviewer', name: 'Reviewer', mode: 'system', sha256: 'e'.repeat(64) },
    },
  }
  const { url, built } = await startWith(settlesAtOnce, {
    s1: { transcript: [], modified: new Date('2026-09-24T10:00:00.000Z'), firstMessage: 'one', forkPoint: point },
  })
  const cold = await fetch(`${url}/api/threads/s1/manifest`)
  expect(cold.status).toBe(200)
  const body: unknown = await cold.json()
  expect(Check(EnsoForkPoint, body)).toBe(true)
  expect(body).toEqual(point)
  expect(built).toHaveLength(0)
  expect((await fetch(`${url}/api/threads/nowhere/manifest`)).status).toBe(404)
  expect(built).toHaveLength(0)

  expect(await prompt(url, 'live1', 'hi')).toBe(202)
  const live: unknown = await (await fetch(`${url}/api/threads/live1/manifest`)).json()
  expect(live).toMatchObject({ identity: { threadId: 'session-1' }, conditions: { runContext: null } })
})

// #468: the incident history replays under the server's thresholds, or the ones the query names —
// a threshold `config.json` would refuse is a 400 that says why, never a replay under nonsense.
test('GET …/incidents replays under the server’s thresholds or the query’s; a bad query is a 400, no thread a 404', async () => {
  const { url, built } = await startWith(settlesAtOnce, {
    s1: { transcript: [], modified: new Date('2026-09-24T10:00:00.000Z'), firstMessage: 'one' },
  })
  const read = async (query: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${url}/api/threads/s1/incidents${query}`)
    return { status: response.status, body: await response.text() }
  }
  const plain = await read('')
  expect(plain.status).toBe(200)
  expect(readEnsoThreadIncidents(JSON.parse(plain.body))?.thresholds).toEqual(DEFAULT_RISK_THRESHOLDS)
  const lowered = await read('?incidentAtSignals=4&windowCalls=12')
  expect(readEnsoThreadIncidents(JSON.parse(lowered.body))?.thresholds).toEqual({
    ...DEFAULT_RISK_THRESHOLDS,
    incidentAtSignals: 4,
    windowCalls: 12,
  })
  expect(await read('?incidentAtSignals=0')).toEqual({
    status: 400,
    body: 'incidentAtSignals must be a whole number from 1, not "0"',
  })
  expect(await read('?halt=1')).toEqual({
    status: 400,
    body: 'halt is no threshold; the thresholds are windowCalls, highAtSignals, highAtKinds, incidentAtSignals',
  })
  // Named twice, which value is meant is a guess: refused, not the last one silently.
  expect(await read('?incidentAtSignals=4&incidentAtSignals=9')).toEqual({
    status: 400,
    body: 'incidentAtSignals is named twice',
  })
  expect((await fetch(`${url}/api/threads/nowhere/incidents`)).status).toBe(404)
  // Looking builds nothing (#86).
  expect(built).toHaveLength(0)
})

// #461: the changed-file route's own query — no path is the 400 that says to name one, a thread
// held nowhere a 404, and both paths are URL-decoded before they are held to the scope and read.
test('GET …/changes/file needs a path and a held thread, and reads its paths URL-decoded', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'enso-changed-file-')))
  const gitPath = Bun.which('git')
  if (gitPath === null) throw new Error('git is not on PATH')
  // Hermetic: no user or system config, a fixed identity — and none of a git hook's GIT_* variables.
  const environment = {
    PATH: dirname(gitPath),
    HOME: project,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Enso',
    GIT_AUTHOR_EMAIL: 'enso@example.invalid',
    GIT_COMMITTER_NAME: 'Enso',
    GIT_COMMITTER_EMAIL: 'enso@example.invalid',
  }
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: project, env: environment, stdio: 'pipe' })
  }
  git('init', '--quiet', '-b', 'main')
  mkdirSync(join(project, 'a dir'))
  writeFileSync(join(project, 'a dir', 'old name.ts'), 'one\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'one')
  git('mv', 'a dir/old name.ts', 'a dir/new name.ts')
  writeFileSync(join(project, 'a dir', 'new name.ts'), 'two\n')
  const { url } = await startWith(settlesAtOnce, {}, undefined, { launch: project })
  expect(await prompt(url, 'live1', 'hi')).toBe(202)
  const read = async (threadId: string, query: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${url}/api/threads/${threadId}/changes/file${query}`)
    return { status: response.status, body: await response.text() }
  }
  expect(await read('live1', '')).toEqual({ status: 400, body: 'name the file: ?path=<path>[&oldPath=<path>]' })
  expect((await read('nowhere', '?path=a')).status).toBe(404)
  const query = new URLSearchParams({ path: 'a dir/new name.ts', oldPath: 'a dir/old name.ts' })
  const answered = await read('live1', `?${query.toString()}`)
  expect(answered.status).toBe(200)
  expect(JSON.parse(answered.body)).toMatchObject({
    path: 'a dir/new name.ts',
    oldPath: 'a dir/old name.ts',
    oldText: { kind: 'text', text: 'one\n' },
    newText: { kind: 'text', text: 'two\n' },
  })
  // Encoded, a climb out is still a climb out.
  expect((await read('live1', `?path=${encodeURIComponent('../outside.ts')}`)).status).toBe(400)
})

// #469: the judge cases are read live-or-cold like the incidents; looking builds nothing.
test('GET …/judge-cases answers a stored thread with its cases, no thread a 404, and builds nothing', async () => {
  const { url, built } = await startWith(settlesAtOnce, {
    s1: { transcript: [], modified: new Date('2026-09-24T10:00:00.000Z'), firstMessage: 'one' },
  })
  const cold = await fetch(`${url}/api/threads/s1/judge-cases`)
  expect(cold.status).toBe(200)
  expect(readEnsoThreadJudgeCases(await cold.json())).toEqual({ threadId: 's1', live: false, cases: [] })
  expect((await fetch(`${url}/api/threads/nowhere/judge-cases`)).status).toBe(404)
  expect(built).toHaveLength(0)
})

// ⚠ #391: Start applies the new session's settings TOGETHER — the model first (the effort a model
// allows depends on it), then the effort, then the mode — and a refusal NAMES its step, so the
// dialog can say which: the steps before it applied, the ones after it never ran.
test('⚠ POST …/configure applies model, effort, mode in order and names the step that refuses (#391)', async () => {
  const { url, built } = await startWith(settlesAtOnce)
  const configure = async (body: unknown): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${url}/api/threads/start-me/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.text() }
  }
  const state = (): EnsoModelState | undefined => built[0]?.modelState

  // Everything applies; the mode the thread already has is left alone.
  expect(await configure({ model: 'fake/fake-2', thinking: 'high', mode: 'default' })).toEqual({
    status: 204,
    body: '',
  })
  expect(state()).toMatchObject({ model: { id: 'fake-2' }, thinkingLevel: 'high' })
  expect(built[0]?.prompts).toEqual([])

  // The model refuses: the effort after it is never applied.
  const refusedModel = await configure({ model: 'fake/no-such-model', thinking: 'off' })
  expect(refusedModel.status).toBe(422)
  expect(JSON.parse(refusedModel.body)).toMatchObject({ step: 'model' })
  expect(state()?.thinkingLevel).toBe('high')

  // A later step refuses: the ones before it applied.
  const refusedMode = await configure({ thinking: 'low', mode: 'plan' })
  expect(refusedMode.status).toBe(422)
  expect(JSON.parse(refusedMode.body)).toMatchObject({ step: 'mode', reason: expect.stringContaining('default') })
  expect(state()?.thinkingLevel).toBe('low')

  // Only the three settings, and nothing else, is a configuration.
  expect((await configure({ model: 'fake/fake-1', prompt: 'hi' })).status).toBe(400)
})

// ⚠ #479: a Start refused at a later step leaves a thread live on the server — the configure route
// built it — with no message and no session file. A reload found it with a 200 and no messages,
// adopted it as a resumed thread, and the launch panel never came back. `/history` says such a
// thread is a draft; a stored thread, read from its file, never is.
test('⚠ GET …/history says `draft` for a thread built by a control route and never prompted, and never for a stored one (#479)', async () => {
  const { url, built } = await startWith(settlesAtOnce, {
    old: { transcript: STORED_BRANCH, modified: new Date(0), firstMessage: 'earlier question' },
  })
  const refused = await send(url, '/api/threads/start-me/configure', 'POST', { model: 'fake/no-such-model' })
  expect(refused.status).toBe(422)
  expect(built).toHaveLength(1)

  const draft = await fetch(`${url}/api/threads/start-me/history`)
  expect(draft.status).toBe(200)
  const history = (await draft.json()) as EnsoThreadHistory
  expect(Check(EnsoThreadHistory, history)).toBe(true)
  expect(history).toMatchObject({ threadId: 'start-me', messages: [], draft: true })

  const stored = (await (await fetch(`${url}/api/threads/old/history`)).json()) as EnsoThreadHistory
  expect(stored.messages.length).toBeGreaterThan(0)
  expect(stored.draft).toBeUndefined()
})

// ── #443: the prompt library — files under ENSO_HOME/prompts, and a session's system prompt from it.

const REVIEWER = {
  name: 'Reviewer',
  description: 'Reads diffs',
  category: 'system',
  body: '# Reviewer\nSay what breaks.',
}

async function library(): Promise<{ url: string; built: FakeThreadRecord[]; directory: string }> {
  const directory = join(mkdtempSync(join(tmpdir(), 'enso-prompts-')), 'prompts')
  const { url, built } = await startWith(settlesAtOnce, {}, undefined, { promptsDir: directory })
  return { url, built, directory }
}

/** A create's precondition: no file under that name. */
const CREATE = { 'If-None-Match': '*' } as const

interface Sent {
  readonly status: number
  readonly body: string
  /** The `ETag` the answer carried, when it did. */
  readonly etag?: string
}

async function request(
  url: string,
  path: string,
  init: { readonly method: string; readonly body?: unknown; readonly headers?: Record<string, string> },
): Promise<Sent> {
  const response = await fetch(`${url}${path}`, {
    method: init.method,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const etag = response.headers.get('ETag')
  return { status: response.status, body: await response.text(), ...(etag === null ? {} : { etag }) }
}

function send(url: string, path: string, method: string, body?: unknown): Promise<Sent> {
  return request(url, path, { method, body })
}

/** A library prompt written as a create — `If-None-Match: *`, as the manager writes a new one. */
function createPrompt(url: string, id: string, fields: unknown): Promise<Sent> {
  return request(url, `/api/prompts/${id}`, { method: 'PUT', body: fields, headers: CREATE })
}

test('⚠ the prompt library: written whole and read back, listed by name with its sizes, deleted — a file that does not parse is listed as refused, by name (#443)', async () => {
  const { url, directory } = await library()
  // No directory yet is an empty library, not a failure.
  expect(JSON.parse((await send(url, '/api/prompts', 'GET')).body)).toEqual({ prompts: [], refused: [] })

  const written = await createPrompt(url, 'reviewer', REVIEWER)
  expect(written.status).toBe(200)
  const prompt = JSON.parse(written.body)
  expect(prompt).toMatchObject({ id: 'reviewer', ...REVIEWER, tokens: estimateTextTokens(REVIEWER.body) })
  expect(prompt.bytes).toBe(readFileSync(join(directory, 'reviewer.md')).length)

  writeFileSync(join(directory, 'broken.md'), '---\nname: Broken\ncategory: user\n---\nx')
  writeFileSync(join(directory, 'notes.txt'), 'not a prompt')
  const listing = JSON.parse((await send(url, '/api/prompts', 'GET')).body)
  expect(listing.prompts).toEqual([
    {
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Reads diffs',
      category: 'system',
      bytes: prompt.bytes,
      tokens: prompt.tokens,
    },
  ])
  expect(listing.refused).toEqual([
    { file: 'broken.md', reason: expect.stringContaining('broken.md: frontmatter category') },
  ])
  expect(await send(url, '/api/prompts/broken', 'GET')).toMatchObject({
    status: 422,
    body: expect.stringContaining('broken.md'),
  })

  // A body outside the closed shape is a 400; an id that could be a path never reaches the disk.
  expect((await createPrompt(url, 'fresh', { ...REVIEWER, model: 'x' })).status).toBe(400)
  expect((await createPrompt(url, 'blank-name', { ...REVIEWER, name: '   ' })).status).toBe(400)
  expect((await send(url, '/api/prompts/..%2Fescape', 'PUT', REVIEWER)).status).toBe(404)

  const any = { method: 'DELETE', headers: { 'If-Match': '*' } }
  expect((await request(url, '/api/prompts/reviewer', any)).status).toBe(204)
  expect((await request(url, '/api/prompts/reviewer', any)).status).toBe(404)
  expect((await send(url, '/api/prompts/reviewer', 'GET')).status).toBe(404)
})

test('⚠ every prompt write and delete states what it expects on disk: a create never lands on a file, a replace or delete only on the version read (#443)', async () => {
  const { url, directory } = await library()
  const put = (id: string, headers: Record<string, string>, fields: unknown = REVIEWER): Promise<Sent> =>
    request(url, `/api/prompts/${id}`, { method: 'PUT', body: fields, headers })
  const remove = (id: string, headers: Record<string, string>): Promise<Sent> =>
    request(url, `/api/prompts/${id}`, { method: 'DELETE', headers })

  // None is a 428, never an unconditional write — so a stale page or a script cannot write unread.
  expect(await put('reviewer', {})).toMatchObject({ status: 428, body: expect.stringContaining('If-None-Match: *') })
  expect(existsSync(join(directory, 'reviewer.md'))).toBe(false)
  expect((await put('reviewer', { ...CREATE, 'If-Match': '*' })).status).toBe(400)
  expect((await put('reviewer', { 'If-Match': 'W/"weak"' })).status).toBe(400)

  const created = await put('reviewer', CREATE)
  expect(created.status).toBe(200)
  const read = await send(url, '/api/prompts/reviewer', 'GET')
  expect(read.etag).toBe(created.etag)
  // A create over a file that is there — a name taken since the list was read.
  expect(await put('reviewer', CREATE, { ...REVIEWER, body: 'other' })).toEqual({
    status: 412,
    body: 'reviewer.md already exists',
  })

  // A replace of the version read; then that version is stale.
  const replaced = await put('reviewer', { 'If-Match': created.etag ?? '' }, { ...REVIEWER, body: 'v2' })
  expect(replaced.status).toBe(200)
  expect(replaced.etag).not.toBe(created.etag)
  expect(await put('reviewer', { 'If-Match': created.etag ?? '' }, { ...REVIEWER, body: 'v3' })).toEqual({
    status: 412,
    body: 'reviewer.md changed on disk since it was opened',
  })
  // Edited in another editor: the page's version is not the file's any more.
  writeFileSync(join(directory, 'reviewer.md'), '---\nname: "Reviewer"\ncategory: system\n---\nhand edit')
  expect((await put('reviewer', { 'If-Match': replaced.etag ?? '' })).status).toBe(412)
  expect(readFileSync(join(directory, 'reviewer.md'), 'utf8')).toContain('hand edit')
  // "Mine wins", asked for by name.
  expect((await put('reviewer', { 'If-Match': '*' }, { ...REVIEWER, body: 'mine' })).status).toBe(200)
  expect(readFileSync(join(directory, 'reviewer.md'), 'utf8')).toContain('mine')

  // A refused file is a file: no create lands on it, and it has no version a page could have read.
  writeFileSync(join(directory, 'broken.md'), 'no frontmatter')
  expect((await put('broken', CREATE)).status).toBe(412)
  expect((await put('broken', { 'If-Match': created.etag ?? '' })).status).toBe(412)
  expect(readFileSync(join(directory, 'broken.md'), 'utf8')).toBe('no frontmatter')
  // A replace of a file that is gone is no create.
  expect(await put('gone', { 'If-Match': '*' })).toEqual({
    status: 412,
    body: 'gone.md is no longer there: it was deleted since it was opened',
  })

  // A delete: stated, of the version read.
  const current = (await send(url, '/api/prompts/reviewer', 'GET')).etag ?? ''
  expect((await remove('reviewer', {})).status).toBe(428)
  expect((await remove('reviewer', CREATE)).status).toBe(400)
  expect((await remove('reviewer', { 'If-Match': created.etag ?? '' })).status).toBe(412)
  expect((await remove('reviewer', { 'If-Match': current })).status).toBe(204)
  expect(existsSync(join(directory, 'reviewer.md'))).toBe(false)
  // No stage is left behind by any of it.
  expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('a library file that is not UTF-8 is refused by name, never read with replacement characters (#443)', async () => {
  const { url, directory } = await library()
  await createPrompt(url, 'reviewer', REVIEWER)
  writeFileSync(
    join(directory, 'latin.md'),
    Buffer.from('---\nname: Latin\ncategory: system\n---\ncaf\xe9\n', 'latin1'),
  )
  const listing = JSON.parse((await send(url, '/api/prompts', 'GET')).body)
  expect(listing.refused).toEqual([{ file: 'latin.md', reason: 'latin.md: is not UTF-8 text' }])
  expect(await send(url, '/api/prompts/latin', 'GET')).toEqual({ status: 422, body: 'latin.md: is not UTF-8 text' })
})

test('a server started without a library says so on every prompt route (#443)', async () => {
  const { url } = await startWith(settlesAtOnce)
  expect(await send(url, '/api/prompts', 'GET')).toEqual({ status: 404, body: NO_PROMPT_LIBRARY })
  expect(await send(url, '/api/prompts/reviewer', 'PUT', REVIEWER)).toEqual({ status: 404, body: NO_PROMPT_LIBRARY })
})

test('⚠ POST …/configure takes a system prompt from the library first, and refuses by name a session prompt, a missing or unparseable file, and a choice after the first request (#443)', async () => {
  const { url, built, directory } = await library()
  await createPrompt(url, 'reviewer', REVIEWER)
  await createPrompt(url, 'opener', { ...REVIEWER, name: 'Opener', category: 'session' })
  await createPrompt(url, 'blank', { ...REVIEWER, name: 'Blank', body: '  \n' })
  writeFileSync(join(directory, 'broken.md'), 'no frontmatter')
  const configure = (thread: string, body: unknown): Promise<{ status: number; body: string }> =>
    send(url, `/api/threads/${thread}/configure`, 'POST', body)
  const refusal = async (thread: string, body: unknown): Promise<unknown> => {
    const answered = await configure(thread, body)
    expect(answered.status).toBe(422)
    return JSON.parse(answered.body)
  }

  expect(await refusal('t-session', { systemPrompt: 'opener', model: 'fake/fake-2' })).toEqual({
    step: 'systemPrompt',
    reason: 'Opener is a session prompt: it fills the first message, not the system prompt',
  })
  // The first step refused: the model after it never ran.
  expect(built[0]?.modelState.model?.id).not.toBe('fake-2')
  expect(await refusal('t-missing', { systemPrompt: 'nobody' })).toMatchObject({
    reason: expect.stringContaining('no prompt nobody'),
  })
  expect(await refusal('t-broken', { systemPrompt: 'broken' })).toMatchObject({
    reason: expect.stringContaining('broken.md: it does not open'),
  })
  expect(await refusal('t-blank', { systemPrompt: 'blank' })).toMatchObject({ reason: 'Blank has no text to send' })
  // ⚠ The id is a body field here, not a route capture: one that could be a path is refused by its
  // shape before any disk is touched — a valid `.md` beside the library answers as one that is not there.
  writeFileSync(join(directory, '..', 'escape.md'), '---\nname: "Escape"\ncategory: system\n---\nread me')
  expect(await refusal('t-escape', { systemPrompt: '../escape' })).toEqual({
    step: 'systemPrompt',
    reason: '../escape.md: the name is not lowercase words joined by hyphens',
  })
  expect(await refusal('t-absent', { systemPrompt: '../absent' })).toEqual({
    step: 'systemPrompt',
    reason: '../absent.md: the name is not lowercase words joined by hyphens',
  })

  expect((await configure('t-good', { systemPrompt: 'reviewer', model: 'fake/fake-2' })).status).toBe(204)
  const chosen = built.at(-1)
  expect(chosen?.systemPrompt).toEqual({
    id: 'reviewer',
    name: 'Reviewer',
    mode: 'system',
    sha256: createHash('sha256').update(REVIEWER.body).digest('hex'),
    text: REVIEWER.body,
  })
  expect(chosen?.modelState.model?.id).toBe('fake-2')
  // The same again is no change. Before the first request another REPLACES it — a Start refused at
  // a later step may try again with a different prompt; after it, the session keeps its prompt for life.
  expect((await configure('t-good', { systemPrompt: 'reviewer' })).status).toBe(204)
  await createPrompt(url, 'other', { ...REVIEWER, name: 'Other', category: 'append' })
  expect((await configure('t-good', { systemPrompt: 'other' })).status).toBe(204)
  expect(chosen?.systemPrompt).toMatchObject({ id: 'other', mode: 'append' })
  expect(await prompt(url, 't-good', 'hello')).toBe(202)
  expect(await refusal('t-good', { systemPrompt: 'reviewer' })).toMatchObject({
    reason: expect.stringContaining('already sent the system prompt Other and keeps it for its whole life'),
  })

  // ⚠ pi's default is a choice too (`null`): a Start whose first attempt applied a prompt and was
  // refused later retries with pi's default, and the session must run pi's default, not the prompt.
  expect((await configure('t-retry', { systemPrompt: 'reviewer' })).status).toBe(204)
  const retried = built.at(-1)
  expect(retried?.systemPrompt).toMatchObject({ id: 'reviewer' })
  expect((await configure('t-retry', { systemPrompt: null })).status).toBe(204)
  expect(retried?.systemPrompt).toBeUndefined()
  expect(await prompt(url, 't-retry', 'hello')).toBe(202)
  expect((await configure('t-retry', { systemPrompt: null })).status).toBe(204)
  expect(await refusal('t-good', { systemPrompt: null })).toMatchObject({
    reason: expect.stringContaining(
      "already sent the system prompt Other and keeps it for its whole life; start a new thread for pi's default",
    ),
  })

  // A thread that already prompted has sent pi's default.
  expect(await prompt(url, 't-late', 'hello')).toBe(202)
  expect(await refusal('t-late', { systemPrompt: 'reviewer' })).toMatchObject({
    reason: expect.stringContaining("pi's default"),
  })
})

test("⚠ GET …/system-prompt previews pi's default, a library prompt's breakdown, and refuses by name what cannot be one (#443)", async () => {
  const { url, built } = await library()
  await createPrompt(url, 'reviewer', REVIEWER)
  await createPrompt(url, 'opener', { ...REVIEWER, name: 'Opener', category: 'session' })
  const preview = (query: string): Promise<{ status: number; body: string }> =>
    send(url, `/api/threads/t-preview/system-prompt${query}`, 'GET')

  const pi = await preview('')
  expect(pi.status).toBe(200)
  const piPreview: unknown = JSON.parse(pi.body)
  expect(Check(EnsoSystemPromptPreview, piPreview)).toBe(true)
  expect(piPreview).toMatchObject({
    prompt: null,
    sections: [{ name: 'preamble', origin: 'pi', text: FAKE_PI_PREAMBLE }, { name: 'cwd' }],
  })

  const reviewer = JSON.parse((await preview('?prompt=reviewer')).body)
  expect(reviewer.prompt).toEqual({ id: 'reviewer', name: 'Reviewer', mode: 'system' })
  expect(reviewer.sections[0]).toEqual({
    name: 'preamble',
    origin: 'library',
    text: REVIEWER.body,
    tokens: estimateTextTokens(REVIEWER.body),
  })
  // Previewing chose nothing: the thread's own prompt is still pi's default.
  expect(built.at(-1)?.systemPrompt).toBeUndefined()

  expect(await preview('?prompt=opener')).toEqual({
    status: 422,
    body: 'Opener is a session prompt: it fills the first message, not the system prompt',
  })
  expect((await preview('?prompt=nobody')).status).toBe(422)
})

test('the system-prompt preview says so when the thread is running, and a server without a library names that (#443)', async () => {
  const { url } = await startWith(asksAndWaits)
  expect(await prompt(url, 't-busy', 'go')).toBe(202)
  const busy = await send(url, '/api/threads/t-busy/system-prompt', 'GET')
  expect(busy).toEqual({ status: 409, body: 'thread t-busy is running; preview its system prompt when it settles' })
  expect(await send(url, '/api/threads/t-other/system-prompt?prompt=reviewer', 'GET')).toEqual({
    status: 404,
    body: NO_PROMPT_LIBRARY,
  })
})

test('⚠ POST …/system-prompt previews an unsaved draft as a saved prompt is previewed, records nothing, and refuses a body off its shape (#443)', async () => {
  const { url, built } = await library()
  const draft = { mode: 'append', text: 'Always answer in haiku.', name: 'Haiku draft' }
  const answered = await send(url, '/api/threads/t-draft/system-prompt', 'POST', draft)
  expect(answered.status).toBe(200)
  const preview = JSON.parse(answered.body)
  expect(Check(EnsoSystemPromptPreview, preview)).toBe(true)
  expect(preview.prompt).toEqual({ id: 'draft', name: 'Haiku draft', mode: 'append' })
  expect(preview.sections).toContainEqual(expect.objectContaining({ name: 'addendum', origin: 'library' }))
  expect(built.at(-1)?.systemPrompt).toBeUndefined()
  expect((await send(url, '/api/threads/t-draft/system-prompt', 'POST', { ...draft, mode: 'session' })).status).toBe(
    400,
  )
  expect((await send(url, '/api/threads/t-draft/system-prompt', 'POST', { ...draft, text: '' })).status).toBe(400)
})

// ── #470: a project's own prompt library — `<project>/.enso/prompts`, read only under trust, never written.

/** A host whose project decision is `trusted`, for a thread it builds and for one it has not. */
function trusting(trusted: boolean): (host: AgentHost) => AgentHost {
  return (host: AgentHost) => ({
    ...host,
    projectTrust: (cwd: string) => ({ directory: cwd, trusted }),
    createSession: async (threadId: string, newSessionDirectory: () => string) => {
      const hosted = await host.createSession(threadId, newSessionDirectory)
      return { ...hosted, projectTrust: () => ({ directory: hosted.inspect().cwd, trusted }) }
    },
  })
}

/** A launch project holding a project library — a `system` prompt sharing the user's `reviewer` id, and a session one. */
async function projectLibrary(trusted: boolean): Promise<{ url: string; built: FakeThreadRecord[]; project: string }> {
  const project = mkdtempSync(join(tmpdir(), 'enso-470-project-'))
  const directory = join(project, '.enso', 'prompts')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'reviewer.md'), '---\nname: "Team reviewer"\ncategory: system\n---\nOur house rules.')
  writeFileSync(join(directory, 'kickoff.md'), '---\nname: "Kickoff"\ncategory: session\n---\nRead the README first.')
  writeFileSync(join(directory, 'broken.md'), 'no frontmatter')
  const promptsDir = join(mkdtempSync(join(tmpdir(), 'enso-470-user-')), 'prompts')
  const { url, built } = await startWith(settlesAtOnce, {}, trusting(trusted), { promptsDir, launch: project })
  await createPrompt(url, 'reviewer', REVIEWER)
  return { url, built, project }
}

test("⚠ GET …/project-prompts lists a trusted project's own prompts apart from the user's, reads one, and offers no write (#470)", async () => {
  const { url, built, project } = await projectLibrary(true)
  const directory = join(project, '.enso', 'prompts')

  // Nothing built: a thread no run has touched answers as its build would (#484).
  const listed = JSON.parse((await send(url, '/api/threads/t-470/project-prompts', 'GET')).body)
  expect(built).toEqual([])
  expect(Check(EnsoProjectPromptLibrary, listed)).toBe(true)
  expect(listed).toMatchObject({
    kind: 'listed',
    directory,
    listing: {
      prompts: [
        { id: 'kickoff', name: 'Kickoff', category: 'session' },
        { id: 'reviewer', name: 'Team reviewer', category: 'system' },
      ],
      refused: [{ file: 'broken.md', reason: expect.stringContaining('broken.md: it does not open') }],
    },
  })
  // The user's library is its own list: the same id there is a different prompt, never shadowed.
  const user = JSON.parse((await send(url, '/api/prompts', 'GET')).body)
  expect(user.prompts.map((prompt: { name: string }) => prompt.name)).toEqual(['Reviewer'])

  const read = await send(url, '/api/threads/t-470/project-prompts/kickoff', 'GET')
  expect(read.status).toBe(200)
  expect(JSON.parse(read.body)).toMatchObject({ id: 'kickoff', body: 'Read the README first.' })
  expect((await send(url, '/api/threads/t-470/project-prompts/nobody', 'GET')).status).toBe(404)
  expect((await send(url, '/api/threads/t-470/project-prompts/broken', 'GET')).status).toBe(422)
  // ⚠ READ-ONLY: no method writes or deletes a project's file, and the user's routes never reach it.
  expect(
    (
      await request(url, '/api/threads/t-470/project-prompts/kickoff', {
        method: 'PUT',
        body: REVIEWER,
        headers: CREATE,
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await request(url, '/api/threads/t-470/project-prompts/kickoff', {
        method: 'DELETE',
        headers: { 'If-Match': '*' },
      })
    ).status,
  ).toBe(404)
  expect(readFileSync(join(directory, 'kickoff.md'), 'utf8')).toContain('Read the README first.')
})

test("⚠ an untrusted project's prompts are not read: the listing names only the directory, a read is 403, and configure refuses a project prompt by saying why (#470)", async () => {
  const { url, built, project } = await projectLibrary(false)
  const directory = join(project, '.enso', 'prompts')
  expect(JSON.parse((await send(url, '/api/threads/t-470/project-prompts', 'GET')).body)).toEqual({
    kind: 'untrusted',
    directory,
  })
  const read = await send(url, '/api/threads/t-470/project-prompts/reviewer', 'GET')
  expect(read.status).toBe(403)
  expect(read.body).toContain(`the project's prompts (${directory}) are read only once the project is trusted`)

  const configured = await send(url, '/api/threads/t-470/configure', 'POST', { systemPrompt: 'project:reviewer' })
  expect(configured.status).toBe(422)
  expect(JSON.parse(configured.body)).toEqual({ step: 'systemPrompt', reason: expect.stringContaining('is trusted') })
  expect(built.at(-1)?.systemPrompt).toBeUndefined()
  expect((await send(url, '/api/threads/t-470/system-prompt?prompt=project:reviewer', 'GET')).status).toBe(422)
  // The user's own prompt is not gated on the project's trust.
  expect((await send(url, '/api/threads/t-470/configure', 'POST', { systemPrompt: 'reviewer' })).status).toBe(204)
})

test("⚠ the project library is the one the host names, not the thread's cwd: a thread on a tree (#551) reads its checkout's prompts (#470)", async () => {
  const checkout = mkdtempSync(join(tmpdir(), 'enso-470-checkout-'))
  mkdirSync(join(checkout, '.enso', 'prompts'), { recursive: true })
  writeFileSync(join(checkout, '.enso', 'prompts', 'house.md'), '---\nname: "House"\ncategory: append\n---\nOur rules.')
  // The thread runs in a tree that has no `.enso/prompts` of its own; the host answers with the checkout.
  const tree = mkdtempSync(join(tmpdir(), 'enso-470-tree-'))
  const onCheckout = (host: AgentHost): AgentHost => ({
    ...host,
    projectTrust: () => ({ directory: checkout, trusted: true }),
    createSession: async (threadId: string, newSessionDirectory: () => string) => {
      const hosted = await host.createSession(threadId, newSessionDirectory)
      return { ...hosted, projectTrust: () => ({ directory: checkout, trusted: true }) }
    },
  })
  const { url } = await startWith(settlesAtOnce, {}, onCheckout, { launch: tree })
  const listing = { kind: 'listed', directory: join(checkout, '.enso', 'prompts') }
  expect(JSON.parse((await send(url, '/api/threads/t-tree/project-prompts', 'GET')).body)).toMatchObject(listing)
  // Built, it answers the same: the live thread's project, not its cwd.
  expect((await send(url, '/api/threads/t-tree/configure', 'POST', { systemPrompt: 'project:house' })).status).toBe(204)
  expect(JSON.parse((await send(url, '/api/threads/t-tree/project-prompts', 'GET')).body)).toMatchObject({
    ...listing,
    listing: { prompts: [{ id: 'house', name: 'House' }] },
  })
})

test("⚠ a project prompt is chosen and previewed by its reference, `project:<id>`, and recorded under it — the user's prompt of the same id stays its own (#470)", async () => {
  const { url, built } = await projectLibrary(true)
  const preview = JSON.parse((await send(url, '/api/threads/t-470/system-prompt?prompt=project:reviewer', 'GET')).body)
  expect(preview.prompt).toEqual({ id: 'project:reviewer', name: 'Team reviewer', mode: 'system' })
  expect(preview.sections[0]).toMatchObject({ name: 'preamble', origin: 'library', text: 'Our house rules.' })

  expect((await send(url, '/api/threads/t-470/configure', 'POST', { systemPrompt: 'project:reviewer' })).status).toBe(
    204,
  )
  expect(built.at(-1)?.systemPrompt).toEqual({
    id: 'project:reviewer',
    name: 'Team reviewer',
    mode: 'system',
    sha256: createHash('sha256').update('Our house rules.').digest('hex'),
    text: 'Our house rules.',
  })
  // Before the first request another replaces it: the bare id is the user's prompt, not the project's.
  expect((await send(url, '/api/threads/t-470/configure', 'POST', { systemPrompt: 'reviewer' })).status).toBe(204)
  expect(built.at(-1)?.systemPrompt).toMatchObject({ id: 'reviewer', name: 'Reviewer', text: REVIEWER.body })

  const refusal = async (ref: string): Promise<unknown> => {
    const answered = await send(url, '/api/threads/t-470/configure', 'POST', { systemPrompt: ref })
    expect(answered.status).toBe(422)
    return JSON.parse(answered.body)
  }
  expect(await refusal('project:kickoff')).toMatchObject({ reason: expect.stringContaining('is a session prompt') })
  // ⚠ A project reference's id is held to the same shape before any disk is touched.
  expect(await refusal('project:../escape')).toEqual({
    step: 'systemPrompt',
    reason: '../escape.md: the name is not lowercase words joined by hyphens',
  })
  expect(await refusal('team:reviewer')).toMatchObject({
    reason: 'team:reviewer.md: the name is not lowercase words joined by hyphens',
  })
})

/** A server over its own policy file (#474), holding `text`. */
async function policyServer(text: string): Promise<{ url: string; policyPath: string }> {
  const policyPath = join(mkdtempSync(join(tmpdir(), 'enso-474-route-')), 'permissions.json')
  writeFileSync(policyPath, text)
  const { url } = await startWith(settlesAtOnce, {}, undefined, { permissionRulesPath: policyPath })
  return { url, policyPath }
}

test('⚠ the permission policy over HTTP: read with its ETag, saved only under the version read, refused with each problem, normalised, and reset with a backup (#474)', async () => {
  const original = `${JSON.stringify({ permission: { bash: { '**': 'ask', 'git status': 'allow' } } }, null, 2)}\n`
  const { url, policyPath } = await policyServer(original)
  const read = await send(url, '/api/permissions', 'GET')
  const policy = JSON.parse(read.body)
  expect(policy).toMatchObject({ kind: 'ok', path: policyPath, file: JSON.parse(original) })
  expect(read.etag).toBe(policy.etag)

  const save = (file: unknown, headers: Record<string, string>): Promise<Sent> =>
    request(url, '/api/permissions', { method: 'PUT', body: { file }, headers })
  const mine = { permission: { bash: { 'rm -rf *': 'deny' } } }
  // No precondition is a 428, a stale one a 412, a typo a 422 naming its place — none writes.
  expect((await save(mine, {})).status).toBe(428)
  expect((await save(mine, { 'If-Match': `"${'0'.repeat(64)}"` })).status).toBe(412)
  const refused = await save({ permission: { bash: { 'rm -rf *': 'dney' } } }, { 'If-Match': policy.etag })
  expect(refused.status).toBe(422)
  expect(JSON.parse(refused.body).problems).toEqual([{ at: '/permission/bash/rm -rf *', message: expect.any(String) }])
  expect(readFileSync(policyPath, 'utf8')).toBe(original)

  // A save lands with Enso's `**` first, as a launch puts it (#499), so no mode overrides the deny.
  const saved = await save(mine, { 'If-Match': policy.etag })
  expect(saved.status).toBe(200)
  expect(Object.keys(JSON.parse(readFileSync(policyPath, 'utf8')).permission.bash)).toEqual(['**', 'rm -rf *'])
  expect(saved.etag).toBe(JSON.parse(saved.body).etag)
  expect(saved.etag).not.toBe(policy.etag)
  const afterSave = readFileSync(policyPath, 'utf8')

  expect(
    (await request(url, '/api/permissions/reset', { method: 'POST', headers: { 'If-Match': policy.etag } })).status,
  ).toBe(412)
  const reset = await request(url, '/api/permissions/reset', {
    method: 'POST',
    headers: { 'If-Match': saved.etag ?? '' },
  })
  expect(reset.status).toBe(200)
  const { backup, policy: now } = JSON.parse(reset.body)
  expect(readFileSync(backup, 'utf8')).toBe(afterSave)
  expect(now).toMatchObject({ kind: 'ok', file: ENSO_DEFAULT_PERMISSION_POLICY })

  // A file the engine cannot parse is said to be one, never shown as an empty policy.
  writeFileSync(policyPath, '{ "permission": ')
  expect(JSON.parse((await send(url, '/api/permissions', 'GET')).body)).toMatchObject({
    kind: 'unreadable',
    reason: expect.any(String),
  })
})

test('"Try a command" in a thread whose engine published no service is a 409, never a guess (#474)', async () => {
  const { url } = await policyServer('{}')
  const check = await send(url, '/api/threads/t-check/permissions/check', 'POST', { surface: 'bash', value: 'ls' })
  expect(check.status).toBe(409)
  expect((await send(url, '/api/threads/t-check/permissions/check', 'POST', { surface: 'bash' })).status).toBe(400)
})

// #881: the route hands the page the thread's verdict whole, its guard layer included, and asks the
// thread about exactly the value sent. The thread here is a fake answering as the real host does:
// only `agent-host.test.ts` may build a real one (#518), and that file's zone may not import the
// server (fallow boundaries), so the real guard and engine are pinned there, on the call made here.
test("Try a command over HTTP: a guard's refusal reaches the page beside the engine's moot verdict, for the value sent (#881)", async () => {
  const asked: unknown[] = []
  const refused: EnsoPermissionVerdict = {
    mode: 'bypassPermissions',
    guard: {
      kind: 'refused',
      tool: 'bash',
      rule: 'secret-path',
      cause: 'bash command refused: "~/.ssh/id_ed25519" names credential material.',
      reason: 'bash command refused: "~/.ssh/id_ed25519" names credential material.',
    },
    state: 'allow',
    matchedPattern: 'cat *',
    origin: 'global',
  }
  const { url } = await startWith(settlesAtOnce, {}, (host: AgentHost) => ({
    ...host,
    createSession: async (threadId: string, newSessionDirectory: () => string) => {
      const hosted = await host.createSession(threadId, newSessionDirectory)
      return {
        ...hosted,
        checkPermission: (request: EnsoPermissionCheckRequest) => {
          asked.push(request)
          return refused
        },
      }
    },
  }))
  const check = await send(url, '/api/threads/t-guard/permissions/check', 'POST', {
    surface: 'bash',
    value: 'cat ~/.ssh/id_ed25519',
  })
  expect(check.status).toBe(200)
  const body: unknown = JSON.parse(check.body)
  expect(Check(EnsoPermissionVerdict, body)).toBe(true)
  expect(body).toEqual(refused)
  expect(asked).toEqual([{ surface: 'bash', value: 'cat ~/.ssh/id_ed25519' }])
})
