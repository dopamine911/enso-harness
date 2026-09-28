import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENSO_PROJECT_HEADER,
  EnsoForkPoint,
  type EnsoFollowFrame,
  type EnsoModelState,
  type EnsoObservation,
  EnsoProject,
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
import {
  type AgentHost,
  type HostedThread,
  type HostedThreadInspection,
  SessionDirectoryRefused,
} from '../../host/agent-host.ts'
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
  /** What the live session's inspection holds, over the fake's own — a branch to serve. */
  inspect?: Partial<HostedThreadInspection>
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
          // picc's row first, the host's two after — the real host's order (#338 slice 2).
          listCommands: () => [{ name: 'mode', source: 'extension' }, ...fakeHostRows(parts.record)],
          permissionModeState: () => ({ mode: 'default', available: ['default', 'acceptEdits'] }),
          ...script.runtime?.(parts),
        }),
        inspect: { ...piccShapedInspection(), cwd: directory, ...script.inspect },
      })
      built.push(fake.record)
      return Promise.resolve(fake.hosted)
    },
    stored,
    FRESH_MODE,
    servesDirectory,
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
  /** Where a page may register projects (#395); none, so only the launch directory, when absent. */
  projectRoots: readonly string[] = [],
): Promise<{ url: string; built: FakeThreadRecord[]; requested: string[]; builtIn: string[] }> {
  // The fake is made before the server, whose projects' rule it must apply — bound when the server asks.
  let servesDirectory: (directory: string) => boolean = () => false
  const { host, built, requested, builtIn } = fakeHost(script, stored, (directory: string) =>
    servesDirectory(directory),
  )
  const started = startEnsoServer({
    cwd: tmpdir(),
    projectRoots,
    harnessPackageDir: emptyHarnessDir(),
    agentDir: mkdtempSync(join(tmpdir(), 'enso-handler-agent-')),
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

// ⚠ THE PALETTE'S LIST IS THE THREAD'S OWN (#338, #390). This route is asked only when a person
// opens the `/` palette or the model picker, or sends a bare command — so a thread with no session
// is BUILT here (#390: after a restart `/login` could not run until something had been prompted),
// while inspection keeps the look that builds nothing (#86). The answer still says where its list
// came from: `live`, the thread's own session; and when the build FAILS, the last build's list with
// its host rows stripped of their value (`remembered` — another session's current model would be a
// lie here), or `none` before any build. A palette that quietly showed a stale list would lie.
test('⚠ GET …/commands builds the thread’s session and answers its own list; a failed build says remembered or none', async () => {
  const { url, built } = await startWith(settlesAtOnce, {}, (host: AgentHost) => ({
    ...host,
    createSession: (threadId: string, directory: () => string): ReturnType<AgentHost['createSession']> =>
      threadId.startsWith('broken')
        ? Promise.reject(new Error('the build failed'))
        : host.createSession(threadId, directory),
  }))
  const commandsOf = async (threadId: string): Promise<EnsoThreadCommands> => {
    const answered: unknown = await (await fetch(`${url}/api/threads/${threadId}/commands`)).json()
    if (!Check(EnsoThreadCommands, answered)) throw new Error('the answer is not an EnsoThreadCommands')
    return answered
  }

  // A failed build before any other: nothing to remember.
  expect(await commandsOf('broken-first')).toEqual({ threadId: 'broken-first', commands: [], source: 'none' })
  expect(built).toHaveLength(0)

  // No prompt has run: the ask itself builds the session, and the list is live, values and all.
  const live = await commandsOf('fresh')
  expect(live).toMatchObject({ threadId: 'fresh', source: 'live' })
  expect(built).toHaveLength(1)
  expect(built[0]?.prompts).toEqual([])
  // pi's row first, then the host's (#338 slices 2 and 3, #361, #433) — the settings with their CURRENT
  // value on a live thread, the flows with none (there is no "current" login), the views last.
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
  expect(live.commands[3]).toMatchObject({ kind: 'flow', options: [{ id: 'fake/oauth' }, { id: 'fake/api_key' }] })
  expect(live.commands[3]?.value).toBeUndefined()
  expect(live.commands[1]).toMatchObject({ kind: 'select', value: 'fake/fake-1' })
  expect(live.commands[1]?.options?.map((option) => option.id)).toEqual(['fake/fake-1', 'fake/fake-2'])
  expect(live.commands[2]).toMatchObject({
    kind: 'level',
    value: 'medium',
    options: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }],
  })

  // Asking again reuses the session: an ask is not a build.
  await commandsOf('fresh')
  expect(built).toHaveLength(1)

  // A failed build after one: the remembered list. The host rows keep their options (every
  // session offers the same) and LOSE their value: this thread has no current model.
  const remembered = await commandsOf('broken-later')
  expect(remembered).toMatchObject({ threadId: 'broken-later', source: 'remembered' })
  expect(remembered.commands.map((command) => command.name)).toEqual(live.commands.map((command) => command.name))
  const rememberedHostRows = remembered.commands.filter((command) => command.source === 'host')
  expect(rememberedHostRows.every((hostRow) => hostRow.value === undefined)).toBe(true)
  // An `action` or a `view` row has no options to keep; every other host row keeps its.
  const withOptions = rememberedHostRows.filter((hostRow) => hostRow.kind !== 'action' && hostRow.kind !== 'view')
  expect(withOptions.map((hostRow) => hostRow.options?.length ?? 0).every((length) => length > 0)).toBe(true)
  expect(withOptions).toHaveLength(4)
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
  const { url, builtIn } = await startWith(settlesAtOnce, {}, undefined, [root])
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
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, [root])
  const launchOnly: unknown = await (await fetch(`${url}/api/projects`)).json()
  expect(launchOnly).toEqual([expect.objectContaining({ launch: true, path: realpathSync(tmpdir()), status: 'ok' })])

  const first = await registerProject(url, { path: app })
  expect(first.status).toBe(201)
  const again = await registerProject(url, { path: `${app}/` })
  expect(again.status).toBe(200)
  expect(((await again.json()) as EnsoProject).projectId).toBe(((await first.json()) as EnsoProject).projectId)

  const outside = await registerProject(url, { path: mkdtempSync(join(tmpdir(), 'enso-outside-')) })
  expect(outside.status).toBe(422)
  expect(await outside.text()).toContain('not under a declared project root')
  const rootItself = await registerProject(url, { path: root })
  expect(rootItself.status).toBe(422)
  expect(await rootItself.text()).toContain('is a project root itself')
  expect((await registerProject(url, { path: app, cwd: '/' })).status).toBe(400)

  expect(await prompt(url, 't1', 'hello', { [ENSO_PROJECT_HEADER]: '0123456789abcdef' })).toBe(400)
  expect(requested).toEqual([])
})

// A stored session belongs to the project its OWN directory is (pi's header); one whose directory
// is no project is not served at all — not listed, not read — and forgetting a project takes its
// threads off the rail without touching them.
test('stored threads are listed and read only in a project, each under its own; removing a project hides its threads', async () => {
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
    [root],
  )
  const project = await registeredProject(url, app)
  const launch = ((await (await fetch(`${url}/api/projects`)).json()) as EnsoProject[])[0]
  const listed = async (): Promise<unknown> => await (await fetch(`${url}/api/stored-threads`)).json()
  expect(await listed()).toEqual([
    expect.objectContaining({ threadId: 'inLaunch', projectId: launch?.projectId }),
    expect.objectContaining({ threadId: 'inApp', projectId: project.projectId }),
  ])
  expect(await (await fetch(`${url}/api/threads/inApp/history`)).json()).toMatchObject({ projectId: project.projectId })
  expect((await fetch(`${url}/api/threads/elsewhere/history`)).status).toBe(404)

  expect((await fetch(`${url}/api/projects/${launch?.projectId}`, { method: 'DELETE' })).status).toBe(409)
  expect((await fetch(`${url}/api/projects/${project.projectId}`, { method: 'DELETE' })).status).toBe(204)
  expect(await listed()).toEqual([expect.objectContaining({ threadId: 'inLaunch' })])
  expect((await fetch(`${url}/api/threads/inApp/history`)).status).toBe(404)
  // A stale tab still following it is told there is nowhere it runs — never the launch directory,
  // where resuming it would not happen either (PR #399 review).
  const stale = new AbortController()
  openFollows.push(stale)
  expect((await openFollow(url, 'inApp', stale)).frames[0]).toMatchObject({ live: false, cwd: '' })
})

// PR #399 review. Removing a project must not strand a run: while a thread in it RUNS, the removal is
// refused and the project stays. And a thread that is live but idle is taken again without a
// build — so it ends with the project, or a page still showing it could go on prompting it there.
test('⚠ removing a project is refused while one of its threads runs, and the project stays', async () => {
  const { root, app } = projectRoot()
  const { url } = await startWith(asksAndWaits, {}, undefined, [root])
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
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, [root])
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
  const { url, requested, builtIn } = await startWith(settlesAtOnce, { old }, undefined, [root])
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
  const { url, builtIn } = await startWith(settlesAtOnce, {}, undefined, [root])
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

test('⚠ a request naming a different project for a thread already named is a 409, and nothing is built', async () => {
  const { root, app } = projectRoot()
  const other = join(root, 'other')
  mkdirSync(other)
  const { url, requested } = await startWith(settlesAtOnce, {}, undefined, [root])
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
      parentThreadId: 'stored-1',
    },
  }
  const { url } = await startWith(asksAndWaits, stored)
  // An open question holds stored-1 busy on this server: taken, never released.
  await prompt(url, 'stored-1', '/mode')
  const response = await fetch(`${url}/api/stored-threads`)
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
    },
    // A blank first message is no title — the rail says "new thread", not "   ". A fork names its parent (#433).
    {
      threadId: 'stored-2',
      projectId: launch,
      lastActivityAt: '2026-09-08T11:00:00.000Z',
      messageCount: 0,
      busy: false,
      parentThreadId: 'stored-1',
    },
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
    conditions: { model: null, thinkingLevel: 'high', mode: 'plan', cwd: '/repo', runContext: null },
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
