import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type InlineExtension,
  type SessionEntry,
  ProjectTrustStore,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_TOOL_NAME,
  ENSO_RUN_CONTEXT_ENTRY,
  ENSO_INCIDENT_OPENED_CHANNEL,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_REPORT_ENTRY,
  ENSO_INCIDENT_REPORT_TOOL_NAME,
  type EnsoIncidentReport,
  ENSO_INCIDENT_RESOLVED_CHANNEL,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_SYSTEM_PROMPT_ENTRY,
  type EnsoObservation,
  type EnsoIncidentOpened,
  type EnsoIncidentResolved,
  type EnsoSessionIncidents,
  type EnsoRunContext,
  type EnsoSystemPromptChoice,
  type EnsoSystemPromptMode,
  type EnsoSystemPromptPreview,
  type EnsoThreadEvent,
  decisionAction,
  effectiveRows,
  type EnsoPermissionMap,
  modeAgentName,
  openIncidentOf,
  sessionIncidentsOf,
  withRule,
  readEnsoRunContext,
  threadTrustsProject,
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_RESTORED_ENTRY,
  ENSO_TREE_SETUP_ENTRY,
  type EnsoConfig,
  type RuntimeCommand,
} from '@enso/core'
import { flowTrace } from '@enso/core/flow-trace'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import {
  ensoProjectsDir,
  findRepoRoot,
  harnessPackageDir,
  projectIdOf,
  projectSessionsDir,
  projectSnapshotsDir,
  projectTreesDir,
  realpathOrSelf,
  treeProjectId,
} from '@enso/core/paths'
import { ENSO_DEFAULT_PERMISSION_POLICY, permissionEngineConfigPath } from '@enso/core/permission-rules'
import { writeProjectThreadSettings } from '@enso/core/project-config'
import { snapshotPaths } from '@enso/core/snapshot-store'
import { getPermissionsService } from '@gotgenes/pi-permission-system'
import type { LogRecorder } from '@logtape/testing/recorder'
import {
  type AgentHost,
  createAgentHost,
  type HostedThread,
  type HostedThreadInspection,
  MODEL_WATCH_EXTENSION_PATH,
  SessionDirectoryRefused,
  seedMultiAccountConfig,
  stopRunSettlingDialogs,
  ThreadDeleted,
  type ThreadDeleteOutcome,
} from '../agent-host.ts'
import { LOST_TOOL_RESULT_TEXT, NOTHING_TO_CONTINUE } from '../continuation.ts'
import { PERMISSION_CALL_QUESTIONS_EXTENSION_PATH } from '../permission-call-questions.ts'
import { storedPermissionModeState } from '../permission-mode-adapter.ts'
import { readPermissionPolicy, resetPermissionPolicy, writePermissionPolicy } from '../permission-policy-file.ts'
import { RESTORE_NOTE_EXTENSION_PATH } from '../restore-note.ts'
import { recordedModelOf, transcriptOf } from '../transcript.ts'
import { writeStoredSession } from './stored-session.ts'

/**
 * The in-process host against the REAL harness package (#69) — every extension the manifest
 * names loads, and inline probe extensions observe what the host does. No key, no network: the
 * one test that prompts runs pi's own scripted `faux` provider (#45). What is asserted are the
 * spike's receipts, pinned:
 *
 *   - the isolation env is set before the first services (else multi-account reads ~/.pi/agent) —
 *     proven by WHERE multi-account resolved its config, not by reading the env back
 *   - `childProxy: false` is seeded (else the second session in a process hangs under Bun)
 *   - exactly the manifest's extensions load, in order, with no load errors
 *   - `session_start` fires exactly once per session, and two sessions do not share closures
 *   - a dialog an extension opens reaches a subscriber as an `extension-ui-request` observation and its
 *     answer resolves the extension's promise — the #27 round trip without a wire
 *   - a throwing `session_start` becomes an `extension-error` observation; the host stays usable
 */

const repoRoot = findRepoRoot(import.meta.url)
const harnessDir = harnessPackageDir(repoRoot)
/**
 * A scratch agent dir that trusts the repository, as the operator's own `trust.json` does (#502):
 * the repository has a `.pi/` (its `settings.json`), so undecided, every run here would wait on the
 * trust question. The tests of trust itself use projects of their own.
 */
function scratchAgentDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  new ProjectTrustStore(directory).set(repoRoot, true)
  return directory
}
const agentDir = scratchAgentDir('enso-host-agent-')
/** Where these hosts keep the permission policy (#446): a scratch file, never the operator's `ENSO_HOME`. */
const permissionRulesPath = join(mkdtempSync(join(tmpdir(), 'enso-host-rules-')), 'permissions.json')
/** The one directory these hosts run sessions in (#395) — the server's projects, reduced to one. */
const servesRepoRoot = (directory: string): boolean => realpathOrSelf(directory) === realpathOrSelf(repoRoot)
const openSessions: HostedThread[] = []

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordEnsoLogs()
})
afterAll(async () => {
  for (const hosted of openSessions) hosted.runtime.dispose()
  await releaseEnsoLogs()
})

/** The extension path suffixes the harness manifest declares, in load order. */
const MANIFEST_EXTENSION_MARKERS = [
  'extensions/logging/index.ts',
  'extensions/guards/index.ts',
  'extensions/web-fetch/index.ts',
  'extensions/web-search/index.ts',
  'pi-permission-system/src/index.ts',
  'extensions/permission-modes/index.ts',
  'pi-multi-account/index.ts',
  'extensions/ask-user/index.ts',
  'extensions/system-prompt/index.ts',
  'extensions/run-context/index.ts',
  'extensions/incident-report/index.ts',
]

/** Collect every event a session emits, from its first subscriber on (the host replays what came before). */
/** Everything the runtime says to its subscriber — observations, since L2 (#162 workstream 4). */
function collectEvents(hosted: HostedThread): EnsoObservation[] {
  const events: EnsoObservation[] = []
  hosted.runtime.subscribe((observation) => events.push(observation))
  return events
}

function hostWith(extensionFactories: InlineExtension[] = []): AgentHost {
  return createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories,
  })
}

async function hostedSession(extensionFactories: InlineExtension[] = []): Promise<HostedThread> {
  const hosted = await hostWith(extensionFactories).createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  return hosted
}

/**
 * A session in a plain project of its own, for the tests whose subject is the WORKSPACE boundary
 * ("a read inside passes", a relative write the mode allows). ⚠ Not the checkout (#754, #755): a
 * thread's tree lives under `~/.enso`, where the guard refuses every read and write, so in a tree a
 * test of "inside the workspace" run in the checkout measured where the checkout sits, not the guard
 * — six failed there, and passed everywhere else. The project holds the `package.json` they read.
 */
async function plainWorkspaceSession(extensionFactories: InlineExtension[] = []): Promise<HostedThread> {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-host-workspace-')))
  copyFileSync(join(repoRoot, 'package.json'), join(project, 'package.json'))
  const host = createAgentHost({
    servesDirectory: (directory) => realpathOrSelf(directory) === project,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories,
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(hosted)
  return hosted
}

/**
 * How long an awaited observation may take before the test fails BY NAME. Generous on purpose:
 * the vendor's persistence is a few microtasks on any machine, and the deadline exists so a
 * missing observation is a named failure rather than a stale assertion — not to time it.
 */
const OBSERVATION_DEADLINE_MILLISECONDS = 5000

/**
 * Resolves with the first observation matching `matches`, or rejects at the deadline — never a tick count.
 * A match may arrive DURING `subscribe` (the host replays what came before its first subscriber), so the
 * callback only records the match; the unsubscribe runs once the promise has settled.
 */
function untilObservation(
  hosted: HostedThread,
  matches: (event: EnsoObservation) => boolean,
): Promise<EnsoObservation> {
  const { promise, resolve, reject } = Promise.withResolvers<EnsoObservation>()
  const timer = setTimeout(
    () => reject(new Error(`no matching observation within ${OBSERVATION_DEADLINE_MILLISECONDS}ms`)),
    OBSERVATION_DEADLINE_MILLISECONDS,
  )
  let matched = false
  const unsubscribe = hosted.runtime.subscribe((observation) => {
    if (matched || !matches(observation)) return
    matched = true
    clearTimeout(timer)
    resolve(observation)
  })
  return promise.finally(unsubscribe)
}

const nextTick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

const SEEDED_AUTH_PATTERN = 'account is logged in for this request'

test("⚠ the agent dir's multi-account config is seeded — childProxy off, Enso's auth pattern added, Cursor off unless set — and the operator's keys and patterns are kept", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'enso-host-seed-'))
  const configPath = join(scratch, 'provider-failover.json')
  // absent → created with the pin, the pattern and Cursor off
  seedMultiAccountConfig(scratch)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    childProxy: false,
    authErrorPatterns: [SEEDED_AUTH_PATTERN],
    includeCursor: false,
  })
  // present with the operator's keys and patterns → merged, not clobbered; their Cursor choice kept
  writeFileSync(
    configPath,
    JSON.stringify({
      childProxy: true,
      showUsage: false,
      includeCursor: true,
      authErrorPatterns: ['my proxy says no', 42],
    }),
  )
  seedMultiAccountConfig(scratch)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    childProxy: false,
    showUsage: false,
    includeCursor: true,
    authErrorPatterns: ['my proxy says no', 42, SEEDED_AUTH_PATTERN],
  })
  // an agent dir an older seed wrote (`{ childProxy: false }`, no Cursor key) → the pattern and Cursor off added
  writeFileSync(configPath, JSON.stringify({ childProxy: false, showUsage: false }))
  seedMultiAccountConfig(scratch)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    childProxy: false,
    showUsage: false,
    authErrorPatterns: [SEEDED_AUTH_PATTERN],
    includeCursor: false,
  })
  // the pattern already there, in another case → not added twice (the vendor compares them so) — on a
  // rewrite, which the unpinned proxy forces; a `null` Cursor key is the vendor's default (on), so it is seeded
  writeFileSync(
    configPath,
    JSON.stringify({
      childProxy: true,
      showUsage: false,
      includeCursor: null,
      authErrorPatterns: [SEEDED_AUTH_PATTERN.toUpperCase()],
    }),
  )
  seedMultiAccountConfig(scratch)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    childProxy: false,
    showUsage: false,
    includeCursor: false,
    authErrorPatterns: [SEEDED_AUTH_PATTERN.toUpperCase()],
  })
  // and creating a host seeds it in the host's own agent dir — before any session exists
  const hostAgentDir = mkdtempSync(join(tmpdir(), 'enso-host-seed-at-boot-'))
  createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: hostAgentDir,
    harnessPackageDir: harnessDir,
    permissionRulesPath,
  })
  expect(JSON.parse(readFileSync(join(hostAgentDir, 'provider-failover.json'), 'utf8'))).toEqual({
    childProxy: false,
    authErrorPatterns: [SEEDED_AUTH_PATTERN],
    includeCursor: false,
  })
})

/**
 * multi-account's Cursor contract: the placeholder key a publication carries and the slot ids it is
 * published under. Loaded by file path, as the #341 test below loads its proxy — the package's entry
 * point would run the extension. A renamed key or id family goes red here instead of leaving stale
 * slots in `models.json` unnoticed.
 */
const vendorCursor = (await import(
  join(dirname(Bun.resolveSync('pi-multi-account/package.json', import.meta.dir)), 'cursor-bridge.ts')
)) as { CURSOR_PROXY_PLACEHOLDER_KEY: string; isCursorProviderId: (id: string) => boolean }

/** A Cursor slot as multi-account publishes it into `models.json` (`index.ts#provisionNativeSlot`). */
const cursorPublication = (port: number): Record<string, unknown> => ({
  api: 'openai-completions',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  models: [{ id: 'claude-4-sonnet' }],
  apiKey: vendorCursor.CURSOR_PROXY_PLACEHOLDER_KEY,
})

test("⚠ with Cursor off, the Cursor slots multi-account published into pi's models.json are dropped — an operator's overrides and own entries, and an opted-in Cursor, are kept", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'enso-host-seed-cursor-'))
  const modelsPath = join(scratch, 'models.json')
  const ollama = { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', apiKey: 'ollama', models: [] }
  const overrides = { 'claude-4-sonnet': { contextWindow: 200_000 } }
  // an operator's own Cursor-named provider: a real endpoint and key, not the vendor's loopback
  const ownCursor = {
    baseUrl: 'https://cursor.example.com/v1',
    api: 'openai-completions',
    apiKey: 'sk-own',
    models: [],
  }
  // the vendor's shape under an id outside its slot family
  const notASlot = cursorPublication(9123)
  const published = {
    note: 'kept',
    providers: {
      ollama,
      cursor: cursorPublication(9123),
      'cursor-account-2': { ...cursorPublication(9123), modelOverrides: overrides },
      'cursor-account-3': ownCursor,
      'cursor-account-x': notASlot,
    },
  }
  expect(['cursor', 'cursor-account-2', 'cursor-account-x'].map(vendorCursor.isCursorProviderId)).toEqual([
    true,
    true,
    false,
  ])
  // opted in → nothing is touched
  writeFileSync(join(scratch, 'provider-failover.json'), JSON.stringify({ includeCursor: true }))
  writeFileSync(modelsPath, JSON.stringify(published))
  seedMultiAccountConfig(scratch)
  expect(JSON.parse(readFileSync(modelsPath, 'utf8'))).toEqual(published)
  // off (as seeded) → each publication's route goes, the operator's overrides and everything else stay
  writeFileSync(join(scratch, 'provider-failover.json'), JSON.stringify({ includeCursor: false }))
  seedMultiAccountConfig(scratch)
  expect(JSON.parse(readFileSync(modelsPath, 'utf8'))).toEqual({
    note: 'kept',
    providers: {
      ollama,
      'cursor-account-2': { modelOverrides: overrides },
      'cursor-account-3': ownCursor,
      'cursor-account-x': notASlot,
    },
  })
  // a malformed registry is pi's to report, not a reason to fail host creation: seeded, file untouched
  writeFileSync(join(scratch, 'provider-failover.json'), '{}')
  writeFileSync(modelsPath, '{ "providers": { "cursor": ')
  seedMultiAccountConfig(scratch)
  expect(readFileSync(modelsPath, 'utf8')).toBe('{ "providers": { "cursor": ')
  expect(JSON.parse(readFileSync(join(scratch, 'provider-failover.json'), 'utf8')).includeCursor).toBe(false)
})

/**
 * #341, against the vendor's REAL code: its Cursor proxy, asked with no Cursor login, and its
 * classifier, called as its turn handler calls it (`errorMessage` only). Loaded by file path — the
 * package's entry point would run the extension. If the proxy is reworded, the seeded pattern stops
 * matching and this goes red; if it starts answering 401, the "without the seed" line goes red —
 * then the seed is no longer needed, and leaves.
 */
test("⚠ the seeded pattern makes the Cursor proxy's no-login refusal an AUTH failure — the vendor alone calls it transient (#341)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'enso-host-seed-contract-'))
  seedMultiAccountConfig(scratch)
  const seeded = JSON.parse(readFileSync(join(scratch, 'provider-failover.json'), 'utf8')) as {
    authErrorPatterns: string[]
  }
  const vendorDirectory = dirname(Bun.resolveSync('pi-multi-account/package.json', import.meta.dir))
  const cursor = (await import(join(vendorDirectory, 'cursor', 'cursor-shared.ts'))) as {
    ensureCursorProxy: (resolve: (slot: string) => Promise<string | undefined>) => Promise<number>
  }
  const proxy = (await import(join(vendorDirectory, 'cursor', 'proxy.ts'))) as { stopProxy: () => void }
  const planner = (await import(join(vendorDirectory, 'completion-route-planner.ts'))) as {
    classifyRouteAttempt: (attempt: object, patterns: object) => string
  }
  const port = await cursor.ensureCursorProxy(async () => undefined)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-4-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const errorMessage = `${response.status} ${await response.text()}`
    const classify = (auth: readonly string[]): string =>
      planner.classifyRouteAttempt(
        {
          operationId: 'contract',
          purpose: 'agent-turn',
          attempt: 1,
          model: { provider: 'cursor', id: 'claude-4-sonnet' },
          dispatched: true,
          stopReason: 'error',
          errorMessage,
        },
        // `500` is the vendor default that caught it (`DEFAULT_TRANSIENT_ERROR_PATTERNS`).
        { ignore: [], auth, limit: [], transient: ['500'], model: [], contextOverflow: [] },
      )
    expect(classify([])).toBe('transient')
    expect(classify(seeded.authErrorPatterns)).toBe('auth')
  } finally {
    proxy.stopProxy()
  }
})

// ⚠ #89. pi runs in this process and every `bash` child inherits its environment, so a
// secret still in `process.env` at host creation reaches the model's tools. The host
// quarantines at creation — before any session — and says which names it removed
// (never values). This test plants a secret-shaped variable and checks it is gone.
test('⚠ creating a host removes secret-shaped variables from its environment, naming them, before any session', () => {
  const environment: Record<string, string | undefined> = { PATH: '/usr/bin', PLANTED_API_KEY: 'must-not-survive' }
  logs.clear()
  createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: mkdtempSync(join(tmpdir(), 'enso-host-quarantine-')),
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    environment,
  })
  expect(environment).toEqual({ PATH: '/usr/bin' })
  const notice = logs.find({ rawMessage: /#89/ })
  expect(notice?.properties.removed).toEqual(['PLANTED_API_KEY'])
  // The NAME is the record; the value never was.
  expect(JSON.stringify(notice)).not.toContain('must-not-survive')
})

/** multi-account's own startup line — `loaded (enabled)…` for the root, `loaded in passive…` otherwise. */
async function multiAccountStartupLine(hosted: HostedThread): Promise<string> {
  const notice = await untilObservation(
    hosted,
    (event) =>
      event.kind === 'extension-ui-request' &&
      event.method === 'notify' &&
      /^pi-multi-account v\S+ loaded/.test(String(event.message)),
  )
  return notice.kind === 'extension-ui-request' ? String(notice.message) : ''
}

// @pins boot-and-launchers/isolation-triple
test('⚠ multi-account resolved its config inside the scratch agent dir, not ~/.pi/agent — the env was set first', async () => {
  const hosted = await hostedSession()
  // AWAITED, not read off the replay: since v1.23.0 the handler awaits its slot publishing
  // before it notifies, so the line can land after `createSession` resolves.
  expect(await multiAccountStartupLine(hosted)).toContain(join(agentDir, 'provider-failover.json'))
})

/**
 * ⚠ #351. pi-multi-account keeps ONE root session per process for terminal pi, and a session that
 * starts while another holds it goes passive: automatic failover OFF. The host sets
 * `PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS=1` (1.23.2, Sarrius/pi-multi-account#73) before the first
 * session, so every thread is its own root. Red means the host no longer sets it, or upstream
 * renamed or dropped it: the thread in use would silently lose failover again — re-read the
 * extension's `multiSessionHost`, then the `agent-host.ts` header.
 */
test('⚠ a thread started while another is live is a multi-account ROOT too — failover on (#351)', async () => {
  const first = await hostedSession()
  expect(await multiAccountStartupLine(first)).toMatch(/ loaded \(enabled\)/)
  const concurrent = await hostedSession()
  expect(await multiAccountStartupLine(concurrent)).toMatch(/ loaded \(enabled\)/)
})

// The chip's live state for a fresh thread comes from this observation (live check,
// 2026-09-23): nothing else says the model a session STARTS with once no extension switches it
// at `session_start` — multi-account ≥1.22 does not.
test('a new session says the model it starts with, as its own `model` observation', async () => {
  const hosted = await hostedSession()
  const opening = await untilObservation(hosted, (event) => event.kind === 'model')
  expect(opening).toEqual({ kind: 'model', ...hosted.runtime.modelState() })
})

// @pins boot-and-launchers/manifest-order
test("exactly the manifest's extensions load, in order, then the host's own model watcher, restore note and ear for the engine's questions, with no load errors", async () => {
  const hosted = await hostedSession()
  const loaded = hosted.loadedExtensionPaths
  // The last three are not the manifest's: the host's listener for pi's `model_select`, the only
  // place a model swap is announced (#338 slice 2; `agent-host.ts` header), its note to pi after a
  // restore (#652, `restore-note.ts`), and its listener for the permission engine's questions, which
  // says where each card stands among its call's (#728, `permission-call-questions.ts`). Listed, not hidden.
  expect(loaded).toHaveLength(MANIFEST_EXTENSION_MARKERS.length + 3)
  MANIFEST_EXTENSION_MARKERS.forEach((marker, index) => {
    expect(loaded[index]?.endsWith(marker)).toBe(true)
  })
  expect(loaded.slice(MANIFEST_EXTENSION_MARKERS.length)).toEqual([
    MODEL_WATCH_EXTENSION_PATH,
    RESTORE_NOTE_EXTENSION_PATH,
    PERMISSION_CALL_QUESTIONS_EXTENSION_PATH,
  ])
  logs.assertNotLogged({ rawMessage: /failed to load/ })
})

test('⚠ session_start fires exactly once per session, and two sessions do not share an extension instance', async () => {
  let factoryRuns = 0
  const startsPerInstance: number[] = []
  const probe: InlineExtension = {
    name: 'enso-host-probe',
    factory: (pi: ExtensionAPI) => {
      factoryRuns += 1
      const mine = factoryRuns - 1
      startsPerInstance[mine] = 0
      pi.on('session_start', () => {
        startsPerInstance[mine] = (startsPerInstance[mine] ?? 0) + 1
      })
    },
  }
  await hostedSession([probe])
  await hostedSession([probe])
  expect(factoryRuns).toBe(2)
  expect(startsPerInstance).toEqual([1, 1])
})

// @pins dialog-ask-answer-settled/parked-in-host
test('⚠⚠ a dialog an extension opens reaches the subscriber and its answer resolves the extension', async () => {
  let confirmed: boolean | undefined
  let settled = false
  const probe: InlineExtension = {
    name: 'enso-host-dialog-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', (_event, extensionContext) => {
        // Fire-and-forget on purpose: awaiting here would block bindExtensions until the
        // test answers, and the test cannot answer what it has not yet observed.
        void extensionContext.ui.confirm('Apply the change?', 'It is reversible').then((answer) => {
          confirmed = answer
          settled = true
        })
      })
    },
  }
  const hosted = await hostedSession([probe])
  const events = collectEvents(hosted)
  const request = events.find((event) => event.kind === 'extension-ui-request' && event.method === 'confirm')
  expect(request).toMatchObject({
    method: 'confirm',
    blocking: true,
    dialog: { method: 'confirm', title: 'Apply the change?', message: 'It is reversible' },
  })
  expect(typeof (request as { id?: unknown })?.id).toBe('string')
  expect(settled).toBe(false)

  hosted.runtime.answerDialog({ id: String((request as { id?: unknown })?.id), confirmed: true })
  await nextTick()
  expect(settled).toBe(true)
  expect(confirmed).toBe(true)
})

// @pins dialog-ask-answer-settled/one-finish dialog-ask-answer-settled/cancel-value
test("a cancelled dialog resolves to pi's cancel value, and dispose cancels what is still pending", async () => {
  const answers: unknown[] = []
  const probe: InlineExtension = {
    name: 'enso-host-cancel-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', (_event, extensionContext) => {
        void extensionContext.ui.select('Pick', ['a', 'b']).then((answer) => answers.push(answer))
        void extensionContext.ui.input('Name?').then((answer) => answers.push(answer))
      })
    },
  }
  const hosted = await hostedSession([probe])
  const events = collectEvents(hosted)
  const select = events.find((event) => event.kind === 'extension-ui-request' && event.method === 'select')
  hosted.runtime.answerDialog({ id: String((select as { id?: unknown })?.id), cancelled: true })
  await nextTick()
  expect(answers).toEqual([undefined])
  // the input is still pending; dispose cancels it
  hosted.runtime.dispose()
  await nextTick()
  expect(answers).toEqual([undefined, undefined])
})

// @pins dialog-ask-answer-settled/cancel-value
test('an answer naming no pending dialog is reported, never thrown', async () => {
  const hosted = await hostedSession()
  logs.clear()
  expect(() => hosted.runtime.answerDialog({ id: 'never-asked', cancelled: true })).not.toThrow()
  logs.assertLogged({ level: 'warning', rawMessage: /unknown request id/, properties: { dialogId: 'never-asked' } })
})

test('⚠ a throwing session_start becomes an extension-error observation; the session is still created', async () => {
  const probe: InlineExtension = {
    name: 'enso-host-throwing-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', () => {
        throw new Error('probe: session_start threw')
      })
    },
  }
  const hosted = await hostedSession([probe])
  const events = collectEvents(hosted)
  const error = events.find((event) => event.kind === 'extension-error')
  expect(error).toMatchObject({ event: 'session_start', error: 'probe: session_start threw' })
  expect(String((error as { extensionPath?: unknown })?.extensionPath)).toContain('enso-host-throwing-probe')
})

// ⚠ THE HOST MUST BE LISTENING WHILE session_start RUNS (#88). Extensions persist state
// during that hook — any `pi.appendEntry` there — and pi emits
// `entry_appended` for it to whoever is subscribed AT THAT MOMENT. Subscribing after
// `bindExtensions` returned meant those entries were emitted to nobody: the held-until-
// first-subscriber buffer sits behind the host's subscription, so nothing put them in it.
// Found by the #86 drawer: two `modes` entries on the branch, one `custom-entry` in the browser.
// @pins follow-snapshot-frames/held-until-first-subscriber
test('⚠ an entry an extension persists during session_start reaches the first subscriber (#88)', async () => {
  const probe: InlineExtension = {
    name: 'enso-host-startup-entry-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', () => {
        pi.appendEntry('probe-startup', { seen: true })
      })
    },
  }
  const hosted = await hostedSession([probe])
  const events = collectEvents(hosted)
  const probeEntry = events.find((event) => event.kind === 'custom-entry' && event.customType === 'probe-startup')
  expect(probeEntry).toMatchObject({ data: { seen: true } })
  // Another extension's custom entry is not a mode: no permission-mode follows it (#496).
  expect(events[events.indexOf(probeEntry as EnsoObservation) + 1]?.kind).not.toBe('permission-mode')
})

// ⚠ #446, #496: the permission engine reads its policy at one path under the agent dir, which the
// host links to the file it was given before the first session. A fresh file is Enso's policy; a
// file the user wrote is kept as they wrote it; either way the engine's path reads it.
test("⚠ the engine's config path reads the host's policy file: a fresh one is Enso's policy, a user's is theirs (#446)", async () => {
  // Nothing here for the launch to put Enso's catch-all into (#499), so it is kept byte for byte.
  // Holds a rule for the report tool, so launch has nothing to add (#467): the file stays theirs, byte for byte.
  const userPolicy = `${JSON.stringify({ permission: { read: 'allow', file_incident_report: 'allow' } })}\n`
  const fresh = join(mkdtempSync(join(tmpdir(), 'enso-host-rules-fresh-')), 'permissions.json')
  const written = join(mkdtempSync(join(tmpdir(), 'enso-host-rules-written-')), 'permissions.json')
  writeFileSync(written, userPolicy)
  const engineReads = async (path: string): Promise<string> => {
    const host = createAgentHost({
      servesDirectory: servesRepoRoot,
      agentDir,
      permissionRulesPath: path,
      harnessPackageDir: harnessDir,
    })
    openSessions.push(await host.createSession(crypto.randomUUID(), () => repoRoot))
    return readFileSync(permissionEngineConfigPath(agentDir), 'utf8')
  }
  expect(JSON.parse(await engineReads(fresh))).toEqual(ENSO_DEFAULT_PERMISSION_POLICY)
  expect(await engineReads(written)).toBe(userPolicy)
  // Back to the file every other host in this suite names.
  await engineReads(permissionRulesPath)
})

/**
 * A host whose engine reads `policy`, as the user wrote it. Nothing to restore after: every host
 * the suite builds links the engine to its own file again when it is created.
 */
async function hostedUnder(policy: object, extensionFactories: InlineExtension[] = []): Promise<HostedThread> {
  const path = join(mkdtempSync(join(tmpdir(), 'enso-host-rules-user-')), 'permissions.json')
  writeFileSync(path, JSON.stringify(policy))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir,
    permissionRulesPath: path,
    harnessPackageDir: harnessDir,
    extensionFactories,
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  return hosted
}

// ⚠ #499: a mode must never override a rule the user wrote. The engine merges a mode's preset key
// by key, and a preset key the user's map lacks lands AFTER the user's rules and wins: with this
// policy (no catch-all in the bash map), `bypassPermissions` once allowed the denied `rm -rf`.
// The launch puts Enso's catch-all first in the user's map, so the preset replaces only that.
// Path rules too, written as the bare `path` key beside a directional one: the engine expands the
// bare key first, per scope, before a preset merges (`policy/scope-merge.ts`), so the catch-all put
// into `path` also leads `path_write` (#500 review).
test('⚠ a deny the user wrote holds in every mode, through the real engine (#499)', async () => {
  const hosted = await hostedUnder({
    permission: {
      bash: { 'rm -rf *': 'deny', 'cp * /etc/*': 'deny' },
      path: { '*.pem': 'deny' },
      path_write: { '*/dist/*': 'deny' },
    },
  })
  const calls: [string, Record<string, unknown>][] = [
    ['bash', { command: 'rm -rf build' }],
    ['bash', { command: 'cp a /etc/x' }],
    ['read', { path: 'key.pem' }],
    ['write', { path: 'dist/app.js', content: 'x' }],
  ]
  for (const mode of ['bypassPermissions', 'acceptEdits', 'auto', 'plan', 'default']) {
    await switchMode(hosted, mode)
    for (const [tool, input] of calls) {
      const verdict = await hosted.probeToolCall(tool, input)
      expect({ mode, tool, input, blocked: verdict?.block }).toEqual({ mode, tool, input, blocked: true })
    }
  }
})

// #498 rests on a fact of the engine's: it reports Enso's catch-all as `**` and a surface-wide rule
// the user wrote (a string surface, or a `*` key) as `*`, so `auto` can leave the user's to the
// user. Asked through the engine's own service, as the auto link asks it.
test("the engine reports Enso's catch-all as `**` and a user's surface-wide rule as `*` (#498)", async () => {
  const matchedPattern = async (policy: object): Promise<unknown> => {
    let sessionId = ''
    const probe: InlineExtension = {
      name: 'enso-host-catch-all-probe',
      factory: (pi: ExtensionAPI) => {
        pi.on('session_start', (_event, extensionContext) => {
          sessionId = extensionContext.sessionManager.getSessionId()
        })
      },
    }
    await hostedUnder(policy, [probe])
    return getPermissionsService(sessionId)?.checkPermission('bash', 'npm test', modeAgentName('auto')).matchedPattern
  }
  expect(await matchedPattern(ENSO_DEFAULT_PERMISSION_POLICY)).toBe('**')
  expect(await matchedPattern({ permission: { bash: 'ask' } })).toBe('*')
  expect(await matchedPattern({ permission: { bash: { '*': 'ask' } } })).toBe('*')
})

// ⚠ Settings shows each mode's rules from `effectiveRows` (#474), a MODEL of the engine's merge —
// so it is pinned to the engine here: in every mode, every verdict the engine gives names a rule
// the model shows on that surface, with the decision the engine applied and the right owner (a
// preset's rule is `agent` to the engine, `mode` to the page). A merge the model gets wrong — a
// preset replacing a surface, a shorthand expanded in the wrong order — fails by mode and value.
test("⚠ Settings' model of every mode is the engine's: each verdict names a rule the model shows, with its decision and owner (#474)", async () => {
  const permission: EnsoPermissionMap = {
    ...(ENSO_DEFAULT_PERMISSION_POLICY.permission as EnsoPermissionMap),
    bash: {
      ...(ENSO_DEFAULT_PERMISSION_POLICY.permission.bash as Record<string, string>),
      'rm -rf *': 'deny',
      'git push *': 'ask',
    },
  }
  const hosted = await hostedUnder({ ...ENSO_DEFAULT_PERMISSION_POLICY, permission })
  const samples: readonly (readonly [string, string])[] = [
    ['bash', 'git status'],
    ['bash', 'rm -rf build'],
    ['bash', 'git push origin main'],
    ['bash', 'npm test'],
    ['edit', 'src/a.ts'],
    ['write', 'src/a.ts'],
    ['read', 'src/a.ts'],
    ['path_read', 'src/a.ts'],
    ['path_write', 'src/a.ts'],
  ]
  for (const mode of ['bypassPermissions', 'acceptEdits', 'auto', 'plan', 'default'] as const) {
    await switchMode(hosted, mode)
    const rows = effectiveRows(permission, mode)
    for (const [surface, value] of samples) {
      const verdict = hosted.checkPermission({ surface, value })
      const row = rows.find(
        (candidate) => candidate.surface === surface && candidate.pattern === verdict?.matchedPattern,
      )
      expect({ mode, surface, value, verdict }).toEqual({
        mode,
        surface,
        value,
        verdict: expect.objectContaining({
          mode,
          state: row === undefined ? 'a rule the model does not show' : decisionAction(row.decision),
          origin: row?.owner === 'mode' ? 'agent' : 'global',
        }),
      })
    }
  }
})

// Settings' save (#474) against the REAL engine a session runs: what the page writes is what the
// next call meets, in the session already running — and what the engine would not run is never
// written. ⚠ Here, in this suite's process-wide agent dir, and not in a server test: the
// multi-account extension keeps the agent dir of the first host a process builds, so a second
// suite building real hosts under its own dir broke the isolation test above whenever it ran first.

/** A running session over a fresh policy file (Enso's, seeded by the host), and that file's path. */
async function runningUnderFreshPolicy(): Promise<{ hosted: HostedThread; policyPath: string }> {
  const policyPath = join(mkdtempSync(join(tmpdir(), 'enso-474-rules-')), 'permissions.json')
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir,
    permissionRulesPath: policyPath,
    harnessPackageDir: harnessDir,
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  return { hosted, policyPath }
}

/** The policy as a page reads it — a test that gets `unreadable` has nothing to edit. */
function readOk(policyPath: string): { file: Record<string, unknown>; etag: string } {
  const read = readPermissionPolicy(policyPath, agentDir)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error(`policy unreadable: ${JSON.stringify(read)}`)
  return { file: read.file, etag: read.etag }
}

const PUBLISH = 'npm publish --tag enso-474'

test('⚠ a saved deny is in force at the running session’s next call — no restart — and blocks it (#474)', async () => {
  const { hosted, policyPath } = await runningUnderFreshPolicy()
  expect(hosted.checkPermission({ surface: 'bash', value: PUBLISH })?.state).not.toBe('deny')

  const { file, etag } = readOk(policyPath)
  const permission = withRule(file.permission as EnsoPermissionMap, 'bash', PUBLISH, 'deny')
  const written = writePermissionPolicy(policyPath, agentDir, { ...file, permission }, { kind: 'matches', etag })
  expect(written.kind).toBe('written')

  expect(hosted.checkPermission({ surface: 'bash', value: PUBLISH })).toMatchObject({
    mode: 'default',
    state: 'deny',
    matchedPattern: PUBLISH,
    origin: 'global',
  })
  expect((await hosted.probeToolCall('bash', { command: PUBLISH }))?.block).toBe(true)
})

// ⚠ The engine reads a file its schema rejects as an EMPTY policy — every deny gone. So a save it
// would not run is refused whole, each problem at its place, and the file (and its denies) stay.
test('⚠ a policy the engine would not run is refused with each problem’s place, and nothing is written (#474)', async () => {
  const { hosted, policyPath } = await runningUnderFreshPolicy()
  const { file, etag } = readOk(policyPath)
  const denied = withRule(file.permission as EnsoPermissionMap, 'bash', PUBLISH, 'deny')
  writePermissionPolicy(policyPath, agentDir, { ...file, permission: denied }, { kind: 'matches', etag })
  const before = readFileSync(policyPath, 'utf8')
  const current = readOk(policyPath)

  const typo = { ...current.file, permission: { ...denied, bash: { ...(denied.bash as object), 'git *': 'alow' } } }
  expect(writePermissionPolicy(policyPath, agentDir, typo, { kind: 'matches', etag: current.etag })).toEqual({
    kind: 'refused',
    refusal: {
      reason: expect.stringContaining('nothing was saved'),
      problems: [{ at: '/permission/bash/git *', message: expect.stringContaining('allow, ask, deny') }],
    },
  })
  const unknownKey = { ...current.file, yolomode: true }
  const refused = writePermissionPolicy(policyPath, agentDir, unknownKey, { kind: 'matches', etag: current.etag })
  expect(refused.kind).toBe('refused')

  expect(readFileSync(policyPath, 'utf8')).toBe(before)
  expect(hosted.checkPermission({ surface: 'bash', value: PUBLISH })?.state).toBe('deny')
})

test('a save over a file changed since it was read is refused, and the change on disk is kept (#474)', async () => {
  const { policyPath } = await runningUnderFreshPolicy()
  const { file, etag } = readOk(policyPath)
  const byHand = `${JSON.stringify({ ...file, permission: { bash: 'ask' } }, null, 2)}\n`
  writeFileSync(policyPath, byHand)
  const outcome = writePermissionPolicy(policyPath, agentDir, file, { kind: 'matches', etag })
  expect(outcome).toEqual({ kind: 'conflict', reason: expect.stringContaining('changed on disk') })
  expect(readFileSync(policyPath, 'utf8')).toBe(byHand)
})

test('a reset puts Enso’s policy in force and keeps every file it replaced, under a name of its own (#474)', async () => {
  const { hosted, policyPath } = await runningUnderFreshPolicy()
  const mine = `${JSON.stringify({ permission: { bash: { '**': 'ask', [PUBLISH]: 'deny' } } }, null, 2)}\n`
  writeFileSync(policyPath, mine)
  expect(hosted.checkPermission({ surface: 'bash', value: PUBLISH })?.state).toBe('deny')

  const first = resetPermissionPolicy(policyPath, agentDir, { kind: 'present' })
  if (first.kind !== 'reset') throw new Error(first.reason)
  const firstBackup = `${realpathOrSelf(policyPath)}.bak`
  expect(first.backup).toBe(firstBackup)
  expect(readFileSync(firstBackup, 'utf8')).toBe(mine)
  expect(JSON.parse(readFileSync(policyPath, 'utf8'))).toEqual(ENSO_DEFAULT_PERMISSION_POLICY)
  expect(hosted.checkPermission({ surface: 'bash', value: PUBLISH })?.state).not.toBe('deny')

  const second = resetPermissionPolicy(policyPath, agentDir, { kind: 'present' })
  if (second.kind !== 'reset') throw new Error(second.reason)
  expect(second.backup).toBe(`${realpathOrSelf(policyPath)}.bak.1`)
  expect(readFileSync(firstBackup, 'utf8')).toBe(mine)

  // With no file at all, a reset is a create: nothing to keep, and `*` — "whatever is there" — refused.
  rmSync(policyPath)
  expect(resetPermissionPolicy(policyPath, agentDir, { kind: 'present' }).kind).toBe('conflict')
  const created = resetPermissionPolicy(policyPath, agentDir, { kind: 'absent' })
  expect(created).toMatchObject({ kind: 'reset', read: { kind: 'ok', file: ENSO_DEFAULT_PERMISSION_POLICY } })
  expect('backup' in created).toBe(false)
})

// L3 step C's MECHANISM, at the host and against the real extension (#162, #496):
// `setPermissionMode` runs Enso's per-mode slash command as a prompt, the extension appends its
// `active_agent` entry, the host emits `permission-mode` right after it, and
// `permissionModeState()` moves. Above the host no surface reads that entry: the host says the
// mode as its own event, the whole reason the browser can fold `permission-mode` alone.
test('⚠ setPermissionMode runs the mode command: the active_agent entry, then the permission-mode observation, and the state all say the new mode', async () => {
  const hosted = await hostedSession()
  const events = collectEvents(hosted)
  expect(hosted.runtime.permissionModeState()).toEqual({
    mode: 'default',
    available: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
  })
  const { promise: accepted, resolve: onAccepted, reject: onRejected } = Promise.withResolvers<void>()
  // Wait for the OBSERVATION, not a tick count: acceptance is the command's completion, and the
  // entry may land any number of turns later.
  const modeChanged = untilObservation(hosted, (event) => event.kind === 'permission-mode' && event.mode === 'plan')
  hosted.runtime.setPermissionMode('plan', {
    onAccepted,
    onRejected: (reason: string): void => onRejected(new Error(reason)),
  })
  await accepted
  const change = await modeChanged
  expect(change).toMatchObject({ kind: 'permission-mode', mode: 'plan' })
  const entry = events[events.indexOf(change) - 1]
  expect(entry).toMatchObject({
    kind: 'custom-entry',
    customType: 'active_agent',
    data: { name: 'enso-mode-plan' },
  })
  expect(hosted.runtime.permissionModeState().mode).toBe('plan')
  // A cold read of the transcript agrees with the live state.
  expect(storedPermissionModeState(hosted.inspect().entries).mode).toBe('plan')
})

/** Set a mode through the host and wait until the host says it moved. */
async function switchMode(hosted: HostedThread, mode: string): Promise<void> {
  const changed = untilObservation(hosted, (event) => event.kind === 'permission-mode' && event.mode === mode)
  const { promise: accepted, resolve: onAccepted, reject } = Promise.withResolvers<void>()
  hosted.runtime.setPermissionMode(mode, { onAccepted, onRejected: (reason: string) => reject(new Error(reason)) })
  await accepted
  await changed
}

// ⚠ The mode shown is the mode ENFORCED, back to `default` included (#496 review). `default` was
// once recorded as `active_agent {name: null}`, which the engine resolves by falling back to the
// last agent it saw: after `/bypassPermissions`, `/default` kept bypass enforced (writes ran
// unasked) while the host said `default`. Asked through the real engine: a write bypass lets
// through must ask again once the mode is back to `default`.
test('⚠ back to default after bypassPermissions, the engine asks again: the mode shown is the mode enforced', async () => {
  const hosted = await plainWorkspaceSession()
  const write = { path: 'enso-496-mode-probe.txt', content: 'x' }
  await switchMode(hosted, 'bypassPermissions')
  expect((await hosted.probeToolCall('write', write))?.block ?? false).toBe(false)
  await switchMode(hosted, 'default')
  expect(hosted.runtime.permissionModeState().mode).toBe('default')
  const asked = untilObservation(hosted, (event) => event.kind === 'extension-ui-request' && event.blocking)
  const verdict = hosted.probeToolCall('write', write)
  // Asking is a dialog, not a verdict: the probe waits on it. A bypass still in force would answer.
  const first = await Promise.race([verdict.then(() => 'answered without asking'), asked.then(() => 'asked')])
  expect(first).toBe('asked')
  expect(hosted.runtime.openDialogs()).toHaveLength(1)
  await hosted.runtime.abort()
  expect((await verdict)?.block).toBe(true)
})

/** A bash call that writes outside the tree with a command `default` asks about: two of the engine's gates ask. */
const OUTSIDE_WRITE_HEREDOC = "<< 'EOF'\necho hi\nEOF"
const OUTSIDE_WRITE = `cp package.json package.json.backup && cat > /tmp/enso-728.sh ${OUTSIDE_WRITE_HEREDOC}`

/** Probe `command` as a bash call through the real engine, answering every card with `answer`: the cards' titles, in order. */
async function bashCardTitles(hosted: HostedThread, command: string, answer: string): Promise<string[]> {
  const titles: string[] = []
  const unsubscribe = hosted.runtime.subscribe((event) => {
    if (event.kind !== 'extension-ui-request' || !event.blocking || event.dialog?.method !== 'select') return
    titles.push(event.dialog.title)
    queueMicrotask(() => hosted.runtime.answerDialog({ id: event.id, value: answer }))
  })
  try {
    await hosted.probeToolCall('bash', { command })
  } finally {
    unsubscribe()
  }
  return titles
}

// ⚠ #728, from an arena run: one bash call that wrote outside the tree asked twice, one card straight
// after the other — the outside path, then the command — and the first said nothing of the second,
// so its "Yes, for this session" read as the call's answer. The engine asks gate by gate, each card
// with its own answers, so each card says where it stands: the first that it covers the path only and
// that a question about the command follows, the second that it is the last. A call that asks once
// says nothing more, and a No on the first card leaves nothing for the next call to inherit.
test('⚠ one bash call asked twice says so on both cards: the path first, the command last (#728)', async () => {
  const hosted = await plainWorkspaceSession()
  const [pathCard, commandCard, ...more] = await bashCardTitles(hosted, OUTSIDE_WRITE, 'Yes')
  expect(more).toEqual([])
  expect(pathCard).toStartWith(
    'Question 1 about this bash call: this answer covers the path only. A separate question about running the command follows.\nPermission Required\n',
  )
  expect(pathCard).toContain('external path     : /tmp/enso-728.sh')
  expect(commandCard).toStartWith(
    'Question 2 of 2 about this bash call: running the command. The question before it covered the path only.\nPermission Required\n',
  )
  expect(commandCard).toContain('command      : cp package.json package.json.backup')

  // Only the path asks (`cat *` is allowed): one card, the engine's own.
  const pathOnly = await bashCardTitles(hosted, `cat > /tmp/enso-728.sh ${OUTSIDE_WRITE_HEREDOC}`, 'Yes')
  expect(pathOnly).toEqual([expect.stringMatching(/^Permission Required\n/)])

  // A No on the first card blocks the call: no second card, and the next call's lone card is no "Question 2".
  const denied = await bashCardTitles(hosted, OUTSIDE_WRITE, 'No')
  expect(denied).toEqual([expect.stringMatching(/^Question 1 about this bash call: /)])
  const lone = await bashCardTitles(hosted, 'cp package.json package.json.backup', 'Yes')
  expect(lone).toEqual([expect.stringMatching(/^Permission Required\n/)])
})

/** What the repository's `.pi/APPEND_SYSTEM.md` says: in a request only when trust loaded the project. */
const PROJECT_APPEND_MARKER = 'enso-502-project-append-system'

/**
 * A "cloned repository" (#502) with the engine's project config switching prompts off, and a
 * `.pi/APPEND_SYSTEM.md` — a resource pi binds only when a session loads, so it reaches the model
 * only if a Trust reloaded the session before the run.
 */
function yoloRepository(): string {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-502-repo-')))
  const configDir = join(project, '.pi', 'extensions', 'pi-permission-system')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ yoloMode: true }))
  writeFileSync(join(project, '.pi', 'APPEND_SYSTEM.md'), `${PROJECT_APPEND_MARKER}\n`)
  return project
}

/** A host over `project` whose faux model counts the requests it answers: a run that started is one. */
function trustHost(project: string): { host: AgentHost; requests: unknown[] } {
  const core = createFauxCore()
  core.setResponses(Array.from({ length: 8 }, (_, index) => faux.fauxAssistantMessage(`reply ${index + 1}`)))
  const requests: unknown[] = []
  const counted: FauxCore = {
    ...core,
    streamSimple: (...call: Parameters<FauxCore['streamSimple']>) => {
      requests.push(call[1])
      return core.streamSimple(...call)
    },
  }
  const host = createAgentHost({
    servesDirectory: (directory) => realpathOrSelf(directory) === project,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxModelExtension(counted)],
  })
  return { host, requests }
}

async function openThread(host: AgentHost, project: string, threadId = crypto.randomUUID()): Promise<HostedThread> {
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  return hosted
}

const isTrustQuestion = (event: EnsoObservation): boolean =>
  event.kind === 'extension-ui-request' &&
  event.dialog?.method === 'select' &&
  event.dialog.title.startsWith('Trust the project ')

/** Whether the engine asks before a `write` (a permission dialog the probe waits on) or answers at once. */
async function writeAsks(hosted: HostedThread): Promise<boolean> {
  const asked = untilObservation(
    hosted,
    (event) => event.kind === 'extension-ui-request' && event.blocking && !isTrustQuestion(event),
  )
  const verdict = hosted.probeToolCall('write', { path: 'enso-502-probe.txt', content: 'x' })
  const first = await Promise.race([verdict.then(() => 'answered'), asked.then(() => 'asked')])
  if (first === 'answered') return false
  const dialog = await asked
  hosted.runtime.answerDialog({ id: String((dialog as { id?: unknown }).id), cancelled: true })
  expect((await verdict)?.block).toBe(true)
  return true
}

/** Prompt, answer the trust question with `answer` once it is asked, and wait for the run to settle. */
async function promptAnswering(hosted: HostedThread, requests: unknown[], answer: string): Promise<void> {
  const question = untilObservation(hosted, isTrustQuestion)
  const settled = runPrompt(hosted, 'hello')
  const asked = await question
  // The run waits on the question: nothing has reached the model yet.
  expect(requests).toHaveLength(0)
  hosted.runtime.answerDialog({ id: String((asked as { id?: unknown }).id), value: answer })
  await settled
}

/** Whether the thread's STORED branch records "Trust this thread" — what a resume reads. */
function storedThreadTrust(hosted: HostedThread): boolean {
  const file = hosted.inspect().sessionFile
  if (file === null) throw new Error('the thread has no stored session yet')
  return threadTrustsProject(transcriptOf(SessionManager.open(file).getBranch()))
}

// ⚠ #502: the web host trusted every project, so a repository's own `.pi/` could switch permission
// prompts off. Undecided is untrusted now, and the first run waits on the question: "Trust this
// thread" records the trust on the thread and reloads the session BEFORE the run, so the repository's
// policy applies to it; resuming the thread asks nothing, and a new thread in the project asks again.
test('⚠ an undecided repository cannot switch prompts off; "Trust this thread" holds for the thread only (#502)', async () => {
  const project = yoloRepository()
  const { host, requests } = trustHost(project)
  const threadId = crypto.randomUUID()
  const hosted = await openThread(host, project, threadId)
  expect(await writeAsks(hosted)).toBe(true)
  await promptAnswering(hosted, requests, 'Trust this thread')
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests)).toContain(PROJECT_APPEND_MARKER)
  expect(await writeAsks(hosted)).toBe(false)
  expect(storedThreadTrust(hosted)).toBe(true)
  expect(new ProjectTrustStore(agentDir).get(project)).toBeNull()

  hosted.runtime.dispose()
  const resumed = await openThread(host, project, threadId)
  expect(await writeAsks(resumed)).toBe(false)
  await runPrompt(resumed, 'again')
  expect(resumed.runtime.openDialogs()).toHaveLength(0)

  const fresh = await openThread(host, project)
  expect(await writeAsks(fresh)).toBe(true)
  const asked = untilObservation(fresh, isTrustQuestion)
  fresh.runtime.prompt({ message: 'new thread' }, { onAccepted: () => undefined, onRejected: () => undefined })
  await asked
  await fresh.runtime.abort()
})

test('"Trust project" is saved and never asked again; "Don\'t trust" runs untrusted, saves nothing, asks once (#502)', async () => {
  const trusting = yoloRepository()
  const first = trustHost(trusting)
  await promptAnswering(await openThread(first.host, trusting), first.requests, 'Trust project')
  expect(new ProjectTrustStore(agentDir).get(trusting)).toBe(true)
  const next = await openThread(first.host, trusting)
  expect(await writeAsks(next)).toBe(false)
  await runPrompt(next, 'no question')

  const declining = yoloRepository()
  const second = trustHost(declining)
  const hosted = await openThread(second.host, declining)
  await promptAnswering(hosted, second.requests, "Don't trust")
  expect(await writeAsks(hosted)).toBe(true)
  await runPrompt(hosted, 'still untrusted, not asked again')
  expect(second.requests).toHaveLength(2)
  expect(JSON.stringify(second.requests)).not.toContain(PROJECT_APPEND_MARKER)
  expect(new ProjectTrustStore(agentDir).get(declining)).toBeNull()
  expect(storedThreadTrust(hosted)).toBe(false)
})

// Stop while the question is open: the waiting run must not start once it is answered later.
test('Stop before the trust question is answered drops the waiting run, and the next run asks again (#502)', async () => {
  const project = yoloRepository()
  const { host, requests } = trustHost(project)
  const hosted = await openThread(host, project)
  const asked = untilObservation(hosted, isTrustQuestion)
  const refused = Promise.withResolvers<string>()
  hosted.runtime.prompt({ message: 'waits' }, { onAccepted: () => undefined, onRejected: refused.resolve })
  await asked
  await hosted.runtime.abort()
  expect(await refused.promise).toContain('stopped before the project-trust question was answered')
  await promptAnswering(hosted, requests, 'Trust this thread')
  expect(requests).toHaveLength(1)
})

test('a trusted repository behaves as before: its policy applies from the start, and nothing is asked (#502)', async () => {
  const project = yoloRepository()
  new ProjectTrustStore(agentDir).set(project, true)
  const { host, requests } = trustHost(project)
  const hosted = await openThread(host, project)
  expect(await writeAsks(hosted)).toBe(false)
  await runPrompt(hosted, 'hello')
  expect(requests).toHaveLength(1)
  expect(hosted.runtime.openDialogs()).toHaveLength(0)
})

// ⚠ Found by this test's first run: the runtime treats an unknown slash command as ordinary
// text, so `setPermissionMode('no-such-mode')` was ACCEPTED and would have gone to the model
// as the chat message "/no-such-mode". The route refuses earlier (422, `changeThreadMode`);
// the host now refuses too, so the seam cannot be misused from any caller.
test('setPermissionMode with a mode the extension registers no command for is rejected at the host, never prompted', async () => {
  const hosted = await hostedSession()
  const events = collectEvents(hosted)
  const { promise: settled, resolve } = Promise.withResolvers<string>()
  hosted.runtime.setPermissionMode('no-such-mode', { onAccepted: () => resolve('accepted'), onRejected: resolve })
  const outcome = await settled
  expect(outcome).toBe('mode no-such-mode is not one this thread offers')
  await nextTick()
  expect(hosted.runtime.permissionModeState().mode).toBe('default')
  // nothing was prompted: no message boundary, no text, no run
  expect(events.some((event) => event.kind === 'message-start' || event.kind === 'text-delta')).toBe(false)
})

// ── the guard through the RUNTIME's hook runner (docs/flows/guarded-tool-call.md, stated gap) ──
// guards.test.ts pins the handler against a hand-built ExtensionAPI. These ask the real runner,
// with the real load order and the real participants, what a model's call would meet.

// @pins guarded-tool-call/one-verdict
test('⚠ through the runtime, the real guards refuse a write outside the workspace with their reason; a read inside passes', async () => {
  const hosted = await plainWorkspaceSession()
  const refused = await hosted.probeToolCall('write', { path: '/etc/passwd', content: 'x' })
  expect(refused).toMatchObject({ block: true })
  expect(refused?.reason).toContain('/etc/passwd')
  const passed = await hosted.probeToolCall('read', { path: 'package.json' })
  // Passing is "not blocked": the permission engine answers an allowed call with an explicit
  // `{ block: false }` where no participant used to answer at all (#496).
  expect(passed?.block ?? false).toBe(false)
})

// #160 §4, through the runner: pi's own `grep` tool name reaches the search-beneath check, so a
// rename of it in pi shows here, not in production. The refusal is the GUARD's (its reason names
// the credential location); on `main` the call reached the permission layer's question instead.
// (`ls ~` is not asserted here: outside the workspace the permission mode asks before any listing,
// which is that layer's call — the names-only exemption is pinned in guards.test.ts.)
test('⚠ through the runtime, the guards refuse grep over home for the credential beneath it (#160 §4)', async () => {
  const hosted = await hostedSession()
  const searched = await hosted.probeToolCall('grep', { pattern: 'aws_secret_access_key', path: '~' })
  expect(searched?.block).toBe(true)
  expect(searched?.reason).toContain(join(homedir(), '.ssh'))
})

// ⚠ FIRST BLOCK WINS — the runtime's behaviour the guards header rests on (guards/index.ts:20-25),
// pinned by no test of ours until now. An extension loaded AFTER guards that answers "allow"
// (returns nothing) cannot un-block; one that blocks a call guards allow adds its own block.
// @pins guarded-tool-call/one-verdict
test('⚠ first block is final: a later extension cannot un-block the guards, and its own block on an allowed call stands', async () => {
  const seen: string[] = []
  const laterExtension: InlineExtension = {
    name: 'enso-host-later-participant-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('tool_call', (event) => {
        seen.push(event.toolName)
        // "allow" for every write — which is exactly what must NOT un-block the guards' refusal…
        if (event.toolName === 'write') return undefined
        // …and a block of its own on a read the guards allow.
        return { block: true, reason: 'the later participant refuses reads' }
      })
    },
  }
  const hosted = await plainWorkspaceSession([laterExtension])
  const write = await hosted.probeToolCall('write', { path: '/etc/passwd', content: 'x' })
  expect(write?.block).toBe(true)
  expect(write?.reason).not.toContain('later participant')
  // the guards blocked first, so the later handler never ran for the write
  expect(seen).not.toContain('write')
  const read = await hosted.probeToolCall('read', { path: 'package.json' })
  expect(read).toEqual({ block: true, reason: 'the later participant refuses reads' })
})

// ── the run's abort and a pending dialog (docs/flows/dialog-ask-answer-settled.md) ──
// Was a RECORD: abort() settled nothing, so Stop during a permission question waited on the
// card until a human answered (the vendor's prompt passes no signal; the runtime's loop awaits
// the handler; the handler awaited the human). Decided 2026-09-16: if the user says stop, it's
// stop. `abort()` settles every pending question as `aborted` — the glossary's word for it —
// AFTER telling the runtime, so the loop holds the signal when the handler returns.
// @pins dialog-ask-answer-settled/stop-stops dialog-ask-answer-settled/one-finish dialog-ask-answer-settled/cancel-value
test("⚠ Stop stops: the run's abort settles a pending dialog as `aborted` — the card drops, the extension resumes with its cancel value", async () => {
  // The host's side of `docs/flows/dialog-ask-answer-settled.md` (#482): asked, then stopped.
  const trace = flowTrace({
    participants: {
      X: 'extension (the probe)',
      H: 'host (agent-host.ts, extension-ui-context.ts)',
      S: 'subscriber (the test)',
    },
    categories: { 'enso.host.ui': 'H' },
    logs,
  })
  let outcome: unknown = 'unsettled'
  const probe: InlineExtension = {
    name: 'enso-host-abort-dialog-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', (_event, extensionContext) => {
        trace.send('X', 'H', 'ctx.ui.confirm("Still here?")')
        void extensionContext.ui.confirm('Still here?', 'after an abort').then((answer) => {
          trace.reply('H', 'X', `resolves ${String(answer)}`)
          outcome = answer
        })
      })
    },
  }
  const hosted = await hostedSession([probe])
  // The one subscriber, so the replayed request reaches it: collects what `collectEvents` would, and draws.
  const events: EnsoObservation[] = []
  hosted.runtime.subscribe((event) => {
    events.push(event)
    if (event.kind === 'extension-ui-request' && event.method === 'confirm') {
      trace.send('H', 'S', `extension-ui-request {method: confirm, blocking: ${String(event.blocking)}}`)
    }
    if (event.kind === 'dialog-settled') trace.send('H', 'S', `dialog-settled {outcome: ${event.outcome}}`)
  })
  trace.send('S', 'H', 'openDialogs()')
  const openBefore = hosted.runtime.openDialogs()
  trace.reply('H', 'S', `${openBefore.length} open`)
  expect(openBefore).toHaveLength(1)
  const dialogId = openBefore[0]?.id ?? ''
  const settled = untilObservation(hosted, (event) => event.kind === 'dialog-settled')
  trace.send('S', 'H', 'abort()')
  await hosted.runtime.abort()
  expect(await settled).toEqual({ kind: 'dialog-settled', id: dialogId, outcome: 'aborted' })
  expect(hosted.runtime.openDialogs()).toHaveLength(0)
  // confirm's cancel value is `false`: the extension resumed and was told no
  expect(outcome).toBe(false)
  expect(events.filter((event) => event.kind === 'dialog-settled')).toHaveLength(1)
  // an answer arriving after the abort is the "already settled" path: reported, not thrown, nothing moves
  trace.send('S', 'H', 'answerDialog {confirmed: true}, after the stop')
  hosted.runtime.answerDialog({ id: dialogId, confirmed: true })
  await nextTick()
  expect(outcome).toBe(false)
  expect(trace.diagram()).toMatchSnapshot('flow dialog-ask-answer-settled: the host, a question the stop settles')
})

// A stop must stop, even when the runtime's abort rejects: the dialogs settle and the
// rejection still propagates — the same rule thread-registry.test.ts pins for a queue clear
// that throws, one layer down.
test("⚠ a stop must stop: when the runtime's abort rejects, the dialogs still settle and the rejection still propagates", async () => {
  const order: string[] = []
  const stopping = stopRunSettlingDialogs(
    async () => {
      order.push('runtime told')
      throw new Error('the runtime would not stop')
    },
    () => order.push('dialogs settled'),
  )
  await expect(stopping).rejects.toThrow('the runtime would not stop')
  expect(order).toEqual(['runtime told', 'dialogs settled'])
  // and the ordinary order, for the record: runtime first, dialogs after
  order.length = 0
  await stopRunSettlingDialogs(
    async () => {
      order.push('runtime told')
    },
    () => order.push('dialogs settled'),
  )
  expect(order).toEqual(['runtime told', 'dialogs settled'])
})

test('abort with no pending dialog settles nothing and says nothing', async () => {
  const hosted = await hostedSession()
  const events = collectEvents(hosted)
  await hosted.runtime.abort()
  await nextTick()
  expect(events.some((event) => event.kind === 'dialog-settled')).toBe(false)
})

test('listCommands is synchronous and names the permission-modes extension’s /mode', async () => {
  const hosted = await hostedSession()
  const commands = hosted.runtime.listCommands()
  expect(commands.some((command) => command.name === 'mode' && command.source === 'extension')).toBe(true)
})

/** Emits a notify on command — used to produce an event while nobody is subscribed. */
const lateNotifyProbe: InlineExtension = {
  name: 'enso-host-late-notify-probe',
  factory: (pi: ExtensionAPI) => {
    pi.registerCommand('enso-late-notify', {
      description: 'emit a notify while nobody is listening',
      handler: async (_args: string, extensionContext: ExtensionCommandContext) => {
        extensionContext.ui.notify('late notify', 'info')
      },
    })
  },
}

// @pins follow-snapshot-frames/held-until-first-subscriber
test('⚠ events are held only until the FIRST subscriber; with nobody listening afterwards they are dropped, not replayed', async () => {
  // Per-thread sessions (#69 PR 2) subscribe one pump per run. If the host kept holding
  // between runs, an aborted run's `agent_settled` would replay into the next run's pump
  // and end it before its first token. The probe command emits a notify while no one is
  // subscribed; the next subscriber must NOT see it.
  const hosted = await hostedSession([lateNotifyProbe])
  const firstSubscriberEvents: EnsoObservation[] = []
  const unsubscribeFirst = hosted.runtime.subscribe((observation) => firstSubscriberEvents.push(observation))
  // Startup records were replayed to the first subscriber.
  expect(
    firstSubscriberEvents.some((event) => event.kind === 'extension-ui-request' && event.method === 'notify'),
  ).toBe(true)
  unsubscribeFirst()

  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/enso-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })

  const secondSubscriberEvents: EnsoObservation[] = []
  hosted.runtime.subscribe((observation) => secondSubscriberEvents.push(observation))
  expect(
    secondSubscriberEvents.filter(
      (event) => event.kind === 'extension-ui-request' && String(event.message).includes('late notify'),
    ),
  ).toHaveLength(0)
  // And the startup records are not replayed a second time either.
  expect(secondSubscriberEvents).toHaveLength(0)
})

// #88 and #69 were both ordering bugs reconstructed from source. The tail (#97) is the record
// that would have shown each in one glance: the provenance column says HOW every event through
// the host's funnel was delivered, and a held/replayed pair or a dropped row is the finding.
// @pins follow-snapshot-frames/provenance-tail follow-snapshot-frames/held-until-first-subscriber
test("⚠ the emitted tail records each event's provenance: held at startup, replayed to the first subscriber, live, dropped (#97)", async () => {
  const hosted = await hostedSession([lateNotifyProbe])
  // The host's side of `docs/flows/follow-snapshot-frames.md` (#482): what the subscriber
  // received and what the tail said, each time the test read it.
  const trace = flowTrace({
    participants: { S: 'subscriber (the test)', H: 'host (agent-host.ts: emit, subscribe, the tail)' },
    categories: { 'enso.host': 'H' },
    logs,
  })
  /** The tail's provenances, in order, a run of one provenance read once. */
  const provenances = (rows: readonly EnsoThreadEvent[]): string =>
    rows
      .map((event) => event.provenance)
      .filter((provenance, index, all) => provenance !== all[index - 1])
      .join(', ')
  const atStartup = hosted.emittedEvents()
  trace.send('S', 'H', 'emittedEvents(), before anyone subscribed')
  trace.reply('H', 'S', `the tail: ${provenances(atStartup)}`)
  // Before anyone subscribes every startup record is `held`.
  expect(atStartup.length).toBeGreaterThan(0)
  expect(atStartup.every((event) => event.provenance === 'held')).toBe(true)

  let lastOrigin: string | undefined
  trace.send('S', 'H', 'subscribe(listener)')
  const unsubscribe = hosted.runtime.subscribe((observation) => {
    // Only the kinds that say where they came from (#96); an entry carries no origin.
    if (!('origin' in observation)) return
    const origin = observation.origin
    if (origin !== lastOrigin) trace.send('H', 'S', `observations, origin ${origin}`)
    lastOrigin = origin
  })
  // The replay is recorded as it happens, in the held order, after the held rows.
  const afterSubscribe = hosted.emittedEvents()
  trace.send('S', 'H', 'emittedEvents()')
  trace.reply('H', 'S', `the tail: ${provenances(afterSubscribe)}`)
  const heldFirst = afterSubscribe.find((event) => event.provenance === 'held')
  const replayedFirst = afterSubscribe.find(
    (event) => event.provenance === 'replayed' && event.type === heldFirst?.type && event.name === heldFirst?.name,
  )
  expect(heldFirst).toBeDefined()
  expect(replayedFirst).toBeDefined()
  expect((replayedFirst?.sequence ?? 0) > (heldFirst?.sequence ?? 0)).toBe(true)
  // Every held event is replayed exactly once: the two provenances carry the same total.
  const totalOf = (provenance: string): number =>
    afterSubscribe.filter((event) => event.provenance === provenance).reduce((total, event) => total + event.count, 0)
  expect(totalOf('replayed')).toBe(totalOf('held'))

  // With a subscriber attached the command's notify is `live`; with none, `dropped`.
  trace.send('S', 'H', 'prompt "/enso-late-notify", subscribed')
  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/enso-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })
  trace.send('S', 'H', 'unsubscribe()')
  unsubscribe()
  trace.send('S', 'H', 'prompt "/enso-late-notify", nobody subscribed')
  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/enso-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })
  const notifies = hosted
    .emittedEvents()
    .filter(
      (event) =>
        event.type === 'extension-ui-request' &&
        event.name === 'notify' &&
        event.provenance !== 'held' &&
        event.provenance !== 'replayed',
    )
    .map((event) => event.provenance)
  trace.send('S', 'H', 'emittedEvents()')
  trace.reply('H', 'S', `its notify rows since: ${notifies.join(', ')}`)
  expect(notifies).toEqual(['live', 'dropped'])
  expect(trace.diagram()).toMatchSnapshot('flow follow-snapshot-frames: the host, held until the first subscriber')
})

// #96's source tag: the subscriber is TOLD which events are a replay of the session's own
// start. multi-account's two startup notices arrive `replayed`; a notice the same extension
// emits during a run arrives `live`. This is what lets the browser group the first without
// guessing from position — and the guess would have swallowed a run's early refusal.
// @pins follow-snapshot-frames/held-until-first-subscriber
test("⚠ subscribe delivers startup records with origin `session-start` and a run's with `run` (#96)", async () => {
  const hosted = await hostedSession([lateNotifyProbe])
  const deliveries: Array<[string, string]> = []
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'extension-ui-request' && observation.method === 'notify') {
      deliveries.push([String(observation.message).slice(0, 16), observation.origin])
    }
  })
  // Everything replayed so far came from session_start — multi-account's notices among them.
  expect(deliveries.length).toBeGreaterThan(0)
  expect(deliveries.every(([, origin]) => origin === 'session-start')).toBe(true)
  expect(deliveries.some(([message]) => message.startsWith('pi-multi-account'))).toBe(true)

  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/enso-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })
  expect(deliveries.at(-1)).toEqual(['late notify', 'run'])
})

// ── resume (#95): the thread id IS pi's session id ────────────────────────────

/**
 * A stored session under `threadId`, the way pi leaves one: created with the id, a user and
 * an assistant message appended — pi flushes on the first assistant message, so the file
 * exists after this.
 *
 * ⚠ IN THE SCRATCH AGENT DIR, EXPLICITLY. pi's default session dir comes from
 * `PI_CODING_AGENT_DIR`, which the host sets when it is created; a test that stores a session
 * before any host exists would otherwise write into the operator's real `~/.pi/agent` (it
 * did, once, run in isolation). A host is created first so the env — and pi's own idea of the
 * session dir — is the scratch one, then that dir is passed rather than assumed.
 */
function storeSession(threadId: string, userText: string, assistantText: string, directory = repoRoot): string {
  return storeTurns(threadId, [[userText, assistantText]], directory).file
}

/**
 * A stored session of whole turns (`stored-session.ts`), after a host is created: the host sets
 * `PI_CODING_AGENT_DIR` to the scratch one, which is where the writer files it.
 */
function storeTurns(
  threadId: string,
  turns: ReadonlyArray<readonly [string, string]>,
  directory = repoRoot,
  /** When the messages say they were sent — `now` unless a test needs an old thread. */
  at: () => number = Date.now,
): { file: string; userEntryIds: string[] } {
  hostWith()
  return writeStoredSession({ cwd: directory, threadId, turns, at })
}

// @pins resume/one-id
test('⚠ createSession(threadId) OPENS the session file already under that id — the branch is the stored one, not a fresh file', async () => {
  const threadId = crypto.randomUUID()
  const file = storeSession(threadId, 'what was I doing?', 'fixing the login bug')
  const host = hostWith()
  // Never asked where a NEW session would go (PR #399 review): a stale answer — a removed project
  // the thread was once named for — must not stand between a thread and its own file.
  const hosted = await host.createSession(threadId, () => {
    throw new Error('a thread with a session file was asked for a new directory')
  })
  openSessions.push(hosted)
  const inspection = hosted.inspect()
  expect(inspection.sessionId).toBe(threadId)
  expect(inspection.sessionFile).toBe(file)
  // The transcript of ours (L2): the file's messages, decoded below the seam.
  const roles = inspection.entries.flatMap((entry) => (entry.kind === 'message' ? [entry.role] : []))
  expect(roles.slice(0, 2)).toEqual(['user', 'assistant'])
})

// @pins resume/one-id
test('createSession(threadId) with no file under that id CREATES the session under it, so the file it flushes is found next time', async () => {
  const threadId = crypto.randomUUID()
  const hosted = await hostWith().createSession(threadId, () => repoRoot)
  openSessions.push(hosted)
  expect(hosted.inspect().sessionId).toBe(threadId)
  // Nothing flushed yet (no assistant message): not listed — there is nothing to come back to.
  expect((await hostWith().listSessions()).some((stored) => stored.id === threadId)).toBe(false)
})

// @pins resume/rail-listing resume/looking-builds-nothing
test('listSessions names stored sessions newest first with the first user message; readStoredThread reads one without building pi', async () => {
  const older = crypto.randomUUID()
  const newer = crypto.randomUUID()
  storeSession(older, 'older question', 'older answer')
  await new Promise((resolve) => setTimeout(resolve, 20))
  storeSession(newer, 'newer question', 'newer answer')
  const host = hostWith()
  const listed = await host.listSessions()
  const ids = listed.map((stored) => stored.id)
  expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
  expect(listed.find((stored) => stored.id === newer)).toMatchObject({
    firstMessage: 'newer question',
    messageCount: 2,
    cwd: repoRoot,
  })
  const transcript = (await host.readStoredThread(older))?.transcript
  expect(transcript?.some((entry) => entry.kind === 'message' && entry.role === 'assistant')).toBe(true)
  expect(await host.readStoredThread('never-stored')).toBeUndefined()
})

// #670: two runs in a row could not tell their threads apart, and nothing renamed one. A name is
// pi's own `session_info` — what `/name` writes — so the file keeps it for every later read.
test('⚠ a name given to a stored thread is in its file: the listing, a cold read, and a host started later all carry it; a live thread names itself the same way (#670)', async () => {
  const stored = crypto.randomUUID()
  storeSession(stored, 'Write a small CLI converter, approach A', 'done')
  expect(await hostWith().renameThread(stored, 'Approach A: regex')).toEqual({ kind: 'renamed' })
  // A host started afterwards has nothing but the file to go on.
  const later = hostWith()
  expect((await later.listSessions()).find((row) => row.id === stored)).toMatchObject({
    name: 'Approach A: regex',
    firstMessage: 'Write a small CLI converter, approach A',
  })
  expect((await later.readStoredThread(stored))?.name).toBe('Approach A: regex')
  // Renamed again, the newest name is the name.
  await later.renameThread(stored, 'Approach A (kept)')
  expect((await hostWith().listSessions()).find((row) => row.id === stored)?.name).toBe('Approach A (kept)')
  // A blank name is no name: pi trims it and reads an empty one as a clear, so the title shows —
  // the listing, a cold read and a live session alike (PR #722 review; pinned, as Enso relies on it).
  const blank = crypto.randomUUID()
  storeSession(blank, 'a thread named with spaces', 'done')
  await hostWith().renameThread(blank, '   ')
  expect((await hostWith().listSessions()).find((row) => row.id === blank)?.name).toBeUndefined()
  expect((await hostWith().readStoredThread(blank))?.name).toBeUndefined()
  const blankLive = await hostWith().createSession(blank, () => repoRoot)
  openSessions.push(blankLive)
  expect(blankLive.inspect().name).toBeUndefined()

  const live = crypto.randomUUID()
  storeSession(live, 'approach B', 'done')
  const host = hostWith()
  const hosted = await host.createSession(live, () => repoRoot)
  openSessions.push(hosted)
  expect(hosted.inspect().name).toBeUndefined()
  await host.renameThread(live, 'Approach B: a parser')
  expect(hosted.inspect().name).toBe('Approach B: a parser')
  expect((await hostWith().listSessions()).find((row) => row.id === live)?.name).toBe('Approach B: a parser')
  expect(await host.renameThread('never-stored', 'x')).toMatchObject({ kind: 'no-thread' })

  // A fork at the first prompt holds no message (#433): pi holds such a file back from writing
  // until a reply comes. The name is written to it all the same.
  const source = crypto.randomUUID()
  const { userEntryIds } = storeTurns(source, [['the first prompt', 'its reply']])
  const forked = await hostWith().forkThread(source, userEntryIds[0] ?? '')
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  expect(await hostWith().renameThread(forked.threadId, 'a fork to try later')).toEqual({ kind: 'renamed' })
  expect((await hostWith().listSessions()).find((row) => row.id === forked.threadId)).toMatchObject({
    messageCount: 0,
    name: 'a fork to try later',
  })
})

// #395: the host serves the server's projects and nothing else. A session pi keeps for another
// directory is invisible here — and, the part that matters, its id is not free: building under it
// is a refusal, never a fresh session beside the stored one in a directory nobody chose.
test('⚠ a stored session in a directory the host does not serve is not listed, not read, and not reopened or replaced (#395)', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'enso-unserved-'))
  const threadId = crypto.randomUUID()
  storeSession(threadId, 'made elsewhere', 'still elsewhere', elsewhere)
  const host = hostWith()
  expect((await host.listSessions()).some((stored) => stored.id === threadId)).toBe(false)
  expect(await host.readStoredThread(threadId)).toBeUndefined()
  const refused = host.createSession(threadId, () => repoRoot)
  await expect(refused).rejects.toBeInstanceOf(SessionDirectoryRefused)
  await expect(refused).rejects.toThrow(`${elsewhere} is not a project this server runs sessions in`)
})

// ── fork (#433): pi's `/fork` at a user message, from the file ─────────────────

/** A fork's session file as pi reads it back: its header, and its branch as role/text pairs. */
function readFork(host: AgentHost, forkThreadId: string): Promise<{ parentSession: unknown; branch: string[] }> {
  return host.listSessions().then((listed) => {
    const file = listed.find((stored) => stored.id === forkThreadId)?.path
    if (file === undefined) throw new Error(`the fork ${forkThreadId} is not listed`)
    const opened = SessionManager.open(file)
    const branch = transcriptTexts(opened.getBranch())
    return { parentSession: opened.getHeader()?.parentSession, branch }
  })
}

/** A branch's messages as `role: text` — what a fork is checked to hold. */
function transcriptTexts(branch: readonly SessionEntry[]): string[] {
  return branch.flatMap((entry) => {
    if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return []
    const { content } = entry.message
    const text =
      typeof content === 'string' ? content : content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    return [`${entry.message.role}: ${text}`]
  })
}

test("⚠ forking a cold thread at turn two's prompt gives a new thread holding turn one, naming its parent, with turn two's words to send again; the source is untouched", async () => {
  const source = crypto.randomUUID()
  const { file, userEntryIds } = storeTurns(source, [
    ['first question', 'first answer'],
    ['second question', 'second answer'],
  ])
  const before = readFileSync(file)
  const host = hostWith()
  const forked = await host.forkThread(source, userEntryIds[1] ?? '')
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  expect(forked.threadId).not.toBe(source)
  expect(forked.prefill).toBe('second question')
  expect(await readFork(host, forked.threadId)).toEqual({
    parentSession: file,
    branch: ['user: first question', 'assistant: first answer'],
  })
  expect(readFileSync(file).equals(before)).toBe(true)
  // The rail's relation: the listing names the parent by its thread id.
  const listed = await host.listSessions()
  expect(listed.find((stored) => stored.id === forked.threadId)?.parentThreadId).toBe(source)
  expect(listed.find((stored) => stored.id === source)?.parentThreadId).toBeUndefined()
})

// ── The project folders (#552) ────────────────────────────────────────────────────────────────

// ⚠ With a projects folder, a thread's session is filed under ITS PROJECT'S id — not under pi's
// cwd-encoded directory — and is listed, resumed and forked from there; a fork's parent is found
// by its file NAME when the path the header names has moved (the migration moves it).
test("⚠ a thread's session lives under ENSO_HOME/projects/<id>/sessions, is resumed from there, and its fork files beside it (#552)", async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'enso-projects-'))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    projectsDir,
    extensionFactories: [fauxModelExtension(createFauxCore())],
  })
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => repoRoot)
  openSessions.push(hosted)
  await runPrompt(hosted, 'first')
  const file = hosted.inspect().sessionFile
  if (file === null) throw new Error('the session was not flushed')
  const expectedDir = projectSessionsDir(projectsDir, projectIdOf(realpathOrSelf(repoRoot)))
  expect(dirname(file)).toBe(expectedDir)
  expect(hosted.inspect().sessionDir).toBe(expectedDir)
  hosted.runtime.dispose()

  // Listed from the project folder, and resumed from it — the same file.
  expect((await host.listSessions()).find((stored) => stored.id === threadId)?.path).toBe(file)
  const resumed = await host.createSession(threadId, () => {
    throw new Error('a thread with a file was asked for a directory')
  })
  openSessions.push(resumed)
  expect(resumed.inspect().sessionFile).toBe(file)
  resumed.runtime.dispose()

  // A fork of it files beside it, naming the parent by thread id.
  const userEntryId = SessionManager.open(file)
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'user')?.id
  const forked = await host.forkThread(threadId, userEntryId ?? '')
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  const listed = await host.listSessions()
  const fork = listed.find((stored) => stored.id === forked.threadId)
  expect(dirname(fork?.path ?? '')).toBe(expectedDir)
  expect(fork?.parentThreadId).toBe(threadId)

  // The parent moved to a directory the fork's header does NOT name (the reverse of what the
  // launcher's migration does, same effect): the path misses, and the fork still finds its
  // parent — by the file's name, read off the listing of pi's own session directories.
  const elsewhere = join(agentDir, 'sessions', 'moved-by-hand')
  mkdirSync(elsewhere, { recursive: true })
  renameSync(file, join(elsewhere, basename(file)))
  expect((await host.listSessions()).find((stored) => stored.id === forked.threadId)?.parentThreadId).toBe(threadId)
})

test('⚠ with no projects folder, sessions file where pi puts them, and a project folder that holds a thread of a directory this host does not serve is listed to locate but never served (#552)', async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'enso-projects-'))
  const elsewhere = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-other-project-')))
  // A thread of ANOTHER project, already in its folder — as another server of the same home would leave it.
  const other = crypto.randomUUID()
  writeStoredSession({
    cwd: elsewhere,
    threadId: other,
    turns: [['q', 'a']],
    at: Date.now,
    sessionDir: projectSessionsDir(projectsDir, projectIdOf(elsewhere)),
  })
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    projectsDir,
  })
  expect((await host.listSessions()).some((stored) => stored.id === other)).toBe(false)
  expect(await host.readStoredThread(other)).toBeUndefined()
  // "Not yours", not "none": a create under that id is refused as not served, never built fresh.
  await expect(host.createSession(other, () => repoRoot)).rejects.toThrow(/not a project this server/)
})

test("⚠ a thread whose file sits in BOTH its project folder and pi's legacy directory (a copy the migration kept) lists once, as the project folder's — on every call (#552)", async () => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'enso-projects-'))
  // ⚠ The host FIRST: creating it pins `PI_CODING_AGENT_DIR` to the scratch agent dir, where the
  // legacy copy below is filed by default (`stored-session.ts`'s rule — unpinned, it lands in the operator's `~/.pi/agent`).
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    projectsDir,
  })
  const threadId = crypto.randomUUID()
  const inProject = writeStoredSession({
    cwd: repoRoot,
    threadId,
    turns: [
      ['the project folder has two turns', 'yes'],
      ['second', 'answer'],
    ],
    sessionDir: projectSessionsDir(projectsDir, projectIdOf(realpathOrSelf(repoRoot))),
  })
  // The legacy copy: same id, SAME FILE NAME (what `kept` means), where pi files by cwd — written
  // later, so it is the newer file; the choice must not follow modification time. pi names a file
  // by its creation time, so the copy is written aside and renamed to the project copy's name.
  const aside = writeStoredSession({ cwd: repoRoot, threadId, turns: [['the legacy copy has one', 'yes']] })
  const legacyFile = join(dirname(aside.file), basename(inProject.file))
  expect(legacyFile.startsWith(agentDir)).toBe(true)
  renameSync(aside.file, legacyFile)
  for (let call = 0; call < 3; call += 1) {
    const listed = (await host.listSessions()).filter((stored) => stored.id === threadId)
    expect(listed.map((stored) => stored.path)).toEqual([inProject.file])
  }
  // And the read is the project folder's copy: two user turns, not the legacy copy's one.
  const transcript = (await host.readStoredThread(threadId))?.transcript ?? []
  expect(transcript.filter((entry) => entry.kind === 'message' && entry.role === 'user')).toHaveLength(2)
})

// ── #551 slice 2: each thread in its own tree ──────────────────────────────────────────────────

/** git in a fixture checkout, hermetic: no user or system config, a fixed identity. */
function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: dirname(Bun.which('git') ?? '/usr/bin/git'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    encoding: 'utf8',
  }).trim()
}

/** A checkout with a commit, then a dirty edit, an untracked file and an ignored `.env` — the state a user leaves. */
function dirtyCheckout(): string {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-tree-project-')))
  fixtureGit(project, 'init', '--quiet')
  writeFileSync(join(project, '.gitignore'), '.env\n')
  writeFileSync(join(project, 'a.txt'), 'committed\n')
  fixtureGit(project, 'add', '--all')
  fixtureGit(project, 'commit', '--quiet', '-m', 'one')
  writeFileSync(join(project, 'a.txt'), 'dirty\n')
  writeFileSync(join(project, 'notes.md'), 'untracked\n')
  writeFileSync(join(project, '.env'), 'SECRET=1\n')
  return project
}

/**
 * A host that gives every new thread a worktree — or `tree` — serving `project` and its trees; `user`
 * is the user's config, the user tier of the project's tree settings (#754).
 */
function treeHost(
  project: string,
  extensionFactories: InlineExtension[] = [],
  tree: 'worktree' | 'copy' | 'off' = 'worktree',
  user: EnsoConfig = { threads: { tree } },
): { host: AgentHost; projectsDir: string } {
  // ⚠ The run's ENSO_HOME's projects folder (the preload's `<scratch>/enso-home`, which `tmpdir()`
  // names), not a folder of the test's own: the run-context extension files each run's snapshot in
  // `ENSO_HOME/projects/<id>/snapshots/`, and the host's stores must be the same ones — as they are
  // in production, where both resolve ENSO_HOME. Threads and trees are named by fresh ids.
  const projectsDir = ensoProjectsDir(join(tmpdir(), 'enso-home'))
  const host = createAgentHost({
    servesDirectory: (directory) =>
      realpathOrSelf(directory) === project || treeProjectId(projectsDir, directory) === projectIdOf(project),
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    projectsDir,
    threadSettings: { user, userPath: join(tmpdir(), 'enso-home', 'config.json'), canonical: (key) => key },
    extensionFactories,
  })
  return { host, projectsDir }
}

// ⚠ The acceptance's first item: two threads on one project each run in a tree of their own,
// minted at the checkout's CURRENT state, and the guard's boundary follows the tree — one thread's
// write into the other's tree is refused, with no rule of its own.
test("⚠ two threads on one project each get their own worktree at the checkout's current state; a write into the other's tree is refused; the checkout is untouched (#551)", async () => {
  const project = dirtyCheckout()
  const statusBefore = fixtureGit(project, 'status', '--porcelain')
  const core = createFauxCore()
  core.setResponses(Array.from({ length: 2 }, (_, index) => faux.fauxAssistantMessage(`reply ${index + 1}`)))
  const { host, projectsDir } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const first = await host.createSession(crypto.randomUUID(), () => project)
  const second = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(first, second)
  await runPrompt(first, 'one')
  await runPrompt(second, 'two')
  const firstTree = first.inspect().cwd
  const secondTree = second.inspect().cwd
  expect(dirname(firstTree)).toBe(projectTreesDir(projectsDir, projectIdOf(project)))
  expect(secondTree).not.toBe(firstTree)
  // The checkout as the user left it: the edit and the untracked file, never the ignored secret.
  expect(readFileSync(join(firstTree, 'a.txt'), 'utf8')).toBe('dirty\n')
  expect(readFileSync(join(firstTree, 'notes.md'), 'utf8')).toBe('untracked\n')
  expect(existsSync(join(firstTree, '.env'))).toBe(false)
  expect(fixtureGit(project, 'worktree', 'list')).toContain(firstTree)
  // One thread's file is not the other's.
  writeFileSync(join(firstTree, 'a.txt'), 'first thread\n')
  expect(readFileSync(join(secondTree, 'a.txt'), 'utf8')).toBe('dirty\n')
  // The boundary follows the tree: into the other thread's tree is outside this one's workspace.
  const crossed = await second.probeToolCall('write', { path: join(firstTree, 'a.txt'), content: 'x' })
  expect(crossed).toMatchObject({ block: true })
  expect(crossed?.reason).toContain(`outside the workspace (${secondTree})`)
  const own = await second.probeToolCall('write', { path: join(secondTree, 'a.txt'), content: 'x' })
  expect(own?.reason ?? '').not.toContain('outside the workspace')
  // Nothing of it reached the checkout.
  expect(fixtureGit(project, 'status', '--porcelain')).toBe(statusBefore)
  expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('dirty\n')
})

// ── #754: a new tree prepared by the project's settings ───────────────────────────────────────

/** `project`'s shared tier (`.enso/config.json`) setting `threads`. */
function sharedThreads(project: string, threads: EnsoConfig['threads']): void {
  mkdirSync(join(project, '.enso'), { recursive: true })
  writeFileSync(join(project, '.enso', 'config.json'), JSON.stringify({ threads }))
}

/** The custom entries of a thread's branch, by type, in order. */
function customTypesOf(hosted: HostedThread): string[] {
  return hosted.inspect().entries.flatMap((entry) => {
    if (entry.kind === 'custom') return [entry.customType]
    return entry.kind === 'message' && entry.role === 'user' ? ['user'] : []
  })
}

// ⚠ #749: a bare worktree has none of the checkout's ignored files, so the project's install step
// and hook could not run in it. A trusted project's shared tier says how its trees are prepared.
test("⚠ a new thread in a trusted project gets its shared tier's copy and setup in its tree before its first run, recorded right after the tree (#754)", async () => {
  const project = dirtyCheckout()
  sharedThreads(project, { copy: ['.env'], setup: ['test -f .env && echo prepared > setup.txt', 'echo done'] })
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran')])
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await runPrompt(hosted, 'first')
  const tree = hosted.inspect().cwd
  expect(tree).not.toBe(project)
  expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('SECRET=1\n')
  expect(readFileSync(join(tree, 'setup.txt'), 'utf8')).toBe('prepared\n')
  expect(existsSync(join(project, 'setup.txt'))).toBe(false)
  // Recorded right after the tree, before the first message reached the model.
  const types = customTypesOf(hosted)
  const treeAt = types.indexOf(ENSO_THREAD_TREE_ENTRY)
  expect(types[treeAt + 1]).toBe(ENSO_TREE_SETUP_ENTRY)
  expect(types.indexOf('user')).toBeGreaterThan(treeAt + 1)
  const recorded = await host.threadTree(threadId)
  expect(recorded?.setup).toMatchObject({
    ok: true,
    copied: ['.env'],
    missing: [],
    tiers: { setup: 'shared', copy: 'shared' },
  })
  expect(recorded?.setup?.steps.map((step) => step.exitCode)).toEqual([0, 0])
})

// The issue's rule: a failed setup is shown on the thread with its output, and the thread opens,
// so it can be fixed from there.
test('⚠ a failing setup still lets the thread run: the failure and its output are on its branch, the rest did not run (#754)', async () => {
  const project = dirtyCheckout()
  sharedThreads(project, { setup: ['echo broken >&2; exit 7', 'touch never.txt'] })
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran anyway')])
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await runPrompt(hosted, 'first')
  const tree = hosted.inspect().cwd
  expect(tree).not.toBe(project)
  expect(hosted.inspect().entries.some((entry) => entry.kind === 'message' && entry.role === 'assistant')).toBe(true)
  expect(existsSync(join(tree, 'never.txt'))).toBe(false)
  const setup = (await host.threadTree(threadId))?.setup
  expect(setup?.ok).toBe(false)
  expect(setup?.steps).toHaveLength(1)
  expect(setup?.steps[0]).toMatchObject({ command: 'echo broken >&2; exit 7', exitCode: 7, output: 'broken\n' })
})

// ⚠ The project tiers are read only once the project is trusted: an untrusted checkout's config
// runs no command, and its mode does not apply.
test("⚠ an untrusted project's setup is not run, and nothing is recorded (#754)", async () => {
  const project = dirtyCheckout()
  sharedThreads(project, { setup: ['touch ran.txt'] })
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran')])
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, false)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await runPrompt(hosted, 'first')
  const tree = hosted.inspect().cwd
  expect(tree).not.toBe(project)
  expect(existsSync(join(tree, 'ran.txt'))).toBe(false)
  expect(customTypesOf(hosted)).not.toContain(ENSO_TREE_SETUP_ENTRY)
  expect((await host.threadTree(threadId))?.setup).toBeUndefined()
})

// The page's "New threads run in: off", end to end: written to the project's local tier as the page
// writes it (the user's own config says worktree), a trusted project's new thread runs in its checkout
// and leaves no worktree or branch in the repository.
test("⚠ a trusted project's tier saying trees off wins over the user's worktree: the thread runs in the checkout (#754)", async () => {
  const project = dirtyCheckout()
  expect(writeProjectThreadSettings(project, { tier: 'local', threads: { tree: 'off' } })).toEqual({ kind: 'written' })
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran')])
  const { host } = treeHost(project, [fauxModelExtension(core)], 'worktree')
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await runPrompt(hosted, 'first')
  expect(realpathOrSelf(hosted.inspect().cwd)).toBe(realpathOrSelf(project))
  expect(await host.threadTree(threadId)).toBeUndefined()
  expect(fixtureGit(project, 'branch', '--list', 'enso/*').trim()).toBe('')
})

// ⚠ Found live: a project's first thread mints its tree at its first run, and the trust question
// is asked by that run's session — after the tree exists. Untrusted at the mint, the shared setup
// was skipped, and "Trust project" never brought it back: the first thread of every project ran
// without its install. The answer prepares the tree, before the run it was asked for.
test('⚠ "Trust project" answered at the first run prepares the tree minted before it, before the run starts (#754)', async () => {
  const project = dirtyCheckout()
  sharedThreads(project, { setup: ['echo prepared > setup.txt'] })
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran')])
  const { host } = treeHost(project, [fauxModelExtension(core)])
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  const asked = untilObservation(hosted, isTrustQuestion)
  await promptAnswering(hosted, [], 'Trust project')
  await asked
  const tree = hosted.inspect().cwd
  expect(tree).not.toBe(project)
  expect(readFileSync(join(tree, 'setup.txt'), 'utf8')).toBe('prepared\n')
  expect((await host.threadTree(threadId))?.setup).toMatchObject({ ok: true, tiers: { setup: 'shared' } })
  // Before the reply: the run the question held started on a prepared tree.
  const types = customTypesOf(hosted)
  const assistantAt = hosted
    .inspect()
    .entries.findIndex((entry) => entry.kind === 'message' && entry.role === 'assistant')
  const setupAt = hosted
    .inspect()
    .entries.findIndex((entry) => entry.kind === 'custom' && entry.customType === ENSO_TREE_SETUP_ENTRY)
  expect(types).toContain(ENSO_TREE_SETUP_ENTRY)
  expect(setupAt).toBeLessThan(assistantAt)
})

// ⚠ PR #561 review: a thread only BUILT — a preview looked at, a permission checked, a model chosen —
// must leave nothing in the user's repository or the rail; the tree comes with the first run, and
// keeps what was chosen before it. pi writes a session's file only at its first message, so the
// file is written at the move: a thread disposed before its first reply is found again on its tree.
test('⚠ a new thread gets its tree at its first run, not its build: built and disposed it leaves nothing; its first run keeps the mode chosen before it; rebuilt, it opens on its tree (#551)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses(Array.from({ length: 2 }, (_, index) => faux.fauxAssistantMessage(`reply ${index + 1}`)))
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const looked = await host.createSession(threadId, () => project)
  expect(looked.inspect().cwd).toBe(project)
  looked.runtime.dispose()
  expect(fixtureGit(project, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(fixtureGit(project, 'branch', '--list', 'enso/*')).toBe('')
  expect((await host.listSessions()).some((stored) => stored.id === threadId)).toBe(false)

  const hosted = await host.createSession(threadId, () => project)
  await switchMode(hosted, 'plan')
  await runPrompt(hosted, 'first')
  const tree = hosted.inspect().cwd
  expect(tree).not.toBe(project)
  expect(fixtureGit(project, 'worktree', 'list')).toContain(tree)
  // What was chosen in the checkout build is the tree build's too.
  expect(hosted.runtime.permissionModeState().mode).toBe('plan')
  hosted.runtime.dispose()
  const again = await host.createSession(threadId, () => {
    throw new Error('a thread on its tree was asked for a new directory')
  })
  openSessions.push(again)
  expect(again.inspect().cwd).toBe(tree)
  expect(fixtureGit(project, 'worktree', 'list').split('\n')).toHaveLength(2)
})

/** What a project's repository holds of its threads' trees: the worktrees beside the checkout, and the `enso/*` branches. */
function treesIn(project: string): { worktrees: number; branches: string } {
  return {
    worktrees: fixtureGit(project, 'worktree', 'list').split('\n').length - 1,
    branches: fixtureGit(project, 'branch', '--list', 'enso/*'),
  }
}

// ⚠ PR #561 review: a thread's tree and branch are named by its id, so a move that failed after the
// mint and left the tree behind refused every later mint — the thread could never run again.
test('⚠ a move whose build on the tree fails is undone — no worktree, branch or file left — and the next run mints again (#551)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran')])
  // On the checkout build only: an entry the next build cannot read — the build on the tree throws.
  let poisoned = false
  const poison: InlineExtension = {
    name: 'enso-host-unreadable-system-prompt',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', (_event, extensionContext) => {
        if (poisoned || extensionContext.cwd !== project) return
        poisoned = true
        pi.appendEntry(ENSO_SYSTEM_PROMPT_ENTRY, { not: 'a system prompt' })
      })
    },
  }
  const { host } = treeHost(project, [fauxModelExtension(core), poison])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await expect(runPrompt(hosted, 'first')).rejects.toThrow('its build on the tree failed')
  expect(treesIn(project)).toEqual({ worktrees: 0, branches: '' })
  expect((await host.listSessions()).some((stored) => stored.id === threadId)).toBe(false)
  expect(hosted.inspect().cwd).toBe(project)
  expect(core.state.callCount).toBe(0)
  // Tried again — refused for the same unreadable entry, never for a tree left in the way.
  await expect(runPrompt(hosted, 'again')).rejects.toThrow('its build on the tree failed')
  expect(treesIn(project)).toEqual({ worktrees: 0, branches: '' })
})

// ⚠ PR #561 review: the registry disposes busy threads at shutdown. A dispose that comes while the
// tree is minted undoes the mint; one that comes while pi is built on the tree disposes that build
// too — and the run that waited never starts on a pi nothing would dispose. Changes made while the
// thread moves are refused: they would land on the checkout session after it was written.
test('⚠ a dispose while the thread moves stops it: during the mint the tree is undone, during the build no run starts; changes meanwhile are refused (#551)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('should not run')])
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)

  const minting = await host.createSession(crypto.randomUUID(), () => project)
  const duringMint = runPrompt(minting, 'first')
  minting.runtime.dispose()
  await expect(duringMint).rejects.toThrow('was disposed before it ran')
  expect(treesIn(project)).toEqual({ worktrees: 0, branches: '' })

  // The build on the tree held open at its session start, until the test lets it go.
  const building = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const hold: InlineExtension = {
    name: 'enso-host-hold-the-tree-build',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', async (_event, extensionContext) => {
        if (extensionContext.cwd === project) return
        building.resolve()
        await release.promise
      })
    },
  }
  const held = treeHost(project, [fauxModelExtension(core), hold]).host
  const threadId = crypto.randomUUID()
  const moving = await held.createSession(threadId, () => project)
  const duringBuild = runPrompt(moving, 'first')
  await building.promise
  expect(moving.runtime.setSystemPrompt(null)).toContain('is moving onto its tree')
  const modeRefused = Promise.withResolvers<string>()
  moving.runtime.setPermissionMode('plan', {
    onAccepted: () => modeRefused.reject(new Error('accepted')),
    onRejected: modeRefused.resolve,
  })
  expect(await modeRefused.promise).toContain('is moving onto its tree')
  moving.runtime.dispose()
  release.resolve()
  await expect(duringBuild).rejects.toThrow('was disposed before it ran')
  expect(core.state.callCount).toBe(0)
  // The move had finished its file: the thread is found again on its tree.
  const reopened = await held.createSession(threadId, () => {
    throw new Error('a thread on its tree was asked for a new directory')
  })
  openSessions.push(reopened)
  expect(reopened.inspect().cwd).not.toBe(project)
  expect(treesIn(project).worktrees).toBe(1)
})

// The isolation is the point: a thread whose tree cannot be made does not quietly run in the
// checkout instead. The move is tried again at the next run.
test('⚠ a first run whose tree cannot be made is refused with the reason — nothing ran in the checkout — and the next run tries again (#551)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('ran')])
  const { host, projectsDir } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  // Something already sits where the thread's tree goes: the mint refuses.
  const blocking = join(projectTreesDir(projectsDir, projectIdOf(project)), threadId)
  mkdirSync(blocking, { recursive: true })
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await expect(runPrompt(hosted, 'first')).rejects.toThrow(`thread ${threadId} has no tree to run in:`)
  expect(core.state.callCount).toBe(0)
  expect(hosted.inspect().cwd).toBe(project)
  rmSync(blocking, { recursive: true })
  await runPrompt(hosted, 'again')
  expect(hosted.inspect().cwd).toBe(blocking)
  expect(core.state.callCount).toBe(1)
})

/** A faux model's definition, as `registerProvider` takes it: a reasoning model, so it offers levels. */
const fauxModelDefinition = (id: string, name: string): NonNullable<ProviderConfig['models']>[number] => ({
  id,
  name,
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 50_000,
  maxTokens: 1000,
})

/**
 * `core` as a provider of TWO models, and the settings default's stand-in: a session that has recorded
 * no choice of this provider starts on `faux-1` — what pi's `findInitialModel` does with
 * `defaultModel` in a real home. `calledWith` gets the id of the model each request ran on.
 */
function twoFauxModels(core: FauxCore, calledWith: string[]): InlineExtension {
  return {
    name: 'enso-host-faux-two-models',
    factory: (pi: ExtensionAPI) => {
      pi.registerProvider('enso-faux', {
        api: 'enso-faux',
        baseUrl: 'http://faux.invalid',
        apiKey: 'faux',
        streamSimple: (model, context, options) => {
          calledWith.push(model.id)
          return core.streamSimple(model, context, options)
        },
        models: [fauxModelDefinition('faux-1', 'Faux One'), fauxModelDefinition('faux-2', 'Faux Two')],
      })
      pi.on('session_start', async (_event, context) => {
        const chosen = context.sessionManager
          .getBranch()
          .some((entry) => entry.type === 'model_change' && entry.provider === 'enso-faux')
        if (!chosen && !(await pi.setModel(core.getModel()))) throw new Error('pi refused the faux model')
      })
    },
  }
}

/** A thread on the two faux models, configured by `choose` before its first prompt, then run once — on its tree. */
async function firstRunAfter(
  choose: (hosted: HostedThread) => Promise<void>,
): Promise<{ hosted: HostedThread; project: string; calledWith: string[] }> {
  const project = dirtyCheckout()
  const core = faux.createFauxCore({
    provider: 'enso-faux',
    api: 'enso-faux',
    models: [
      { id: 'faux-1', contextWindow: 50_000 },
      { id: 'faux-2', contextWindow: 50_000 },
    ],
  })
  core.setResponses([faux.fauxAssistantMessage('ok')])
  const calledWith: string[] = []
  const { host } = treeHost(project, [twoFauxModels(core, calledWith)])
  new ProjectTrustStore(agentDir).set(project, true)
  const hosted = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(hosted)
  expect(hosted.runtime.modelState().model?.id).toBe('faux-1')
  await choose(hosted)
  await runPrompt(hosted, 'hi')
  return { hosted, project, calledWith }
}

// ⚠ #616, measured on a live run: the Start dialog's model reached the session (`model_change` to
// Haiku) and was undone 119 ms later, when the first run rebuilt the thread on its tree — pi restores
// a session's model and level only once it has messages, and a thread configured before its first
// prompt has none, so the rebuild took the default. The choice must be what the first run runs on.
test('⚠ a model and effort chosen before the first prompt are what the first run runs on, across the move onto its tree (#616)', async () => {
  const { hosted, project, calledWith } = await firstRunAfter(async (thread) => {
    await thread.runtime.runHostCommand({ name: 'model', value: 'enso-faux/faux-2' })
    await thread.runtime.runHostCommand({ name: 'thinking', value: 'high' })
  })
  // The run happened on the tree, and its request went to the chosen model, at the chosen level.
  expect(hosted.inspect().cwd).not.toBe(project)
  expect(calledWith).toEqual(['faux-2'])
  expect(hosted.runtime.modelState()).toMatchObject({
    model: { provider: 'enso-faux', id: 'faux-2' },
    thinkingLevel: 'high',
  })
})

// PR #631 review: the dialog sends no `/model` when the model is left as it was (`applyConfiguration`),
// so the branch holds a level chosen alone. The model it pairs with is the one pi recorded when it
// built the session — a new session's first entries are its model and level — so that is restored too.
test('an effort chosen alone before the first prompt survives the move too, on the model the session started with (#616)', async () => {
  const { hosted, calledWith } = await firstRunAfter(async (thread) => {
    await thread.runtime.runHostCommand({ name: 'thinking', value: 'high' })
  })
  expect(calledWith).toEqual(['faux-1'])
  expect(hosted.runtime.modelState()).toMatchObject({ model: { id: 'faux-1' }, thinkingLevel: 'high' })
})

/**
 * An account's provider, as pi-multi-account registers its Codex one (#688): known as the extension
 * loads, its model list REPLACED on `session_start` by what the account serves. pi's built-in
 * `openai` list is the agent dir's; the account serves `gpt-account` alone.
 */
const accountCatalog: InlineExtension = {
  name: 'enso-host-account-catalog',
  factory: (pi: ExtensionAPI) => {
    pi.registerProvider('openai', { name: 'OpenAI (account)' })
    pi.on('session_start', () => {
      pi.registerProvider('openai', {
        api: 'openai-responses',
        baseUrl: 'http://account.invalid',
        models: [fauxModelDefinition('gpt-account', 'GPT Account')],
      })
    })
  },
}

// ⚠ #688, measured in the arena: the Start dialog offered pi's built-in Codex models, the session's
// list was the account's live catalog, and `…/configure` refused the dialog's own default with a
// 422. The dialog's list for a thread nothing has built is the list a session holds after its start.
test("⚠ the catalogue offers a session's models, not the agent dir's: every one, its first (the dialog's default) included, starts (#688)", async () => {
  const catalogueAgentDir = scratchAgentDir('enso-host-catalogue-')
  writeFileSync(join(catalogueAgentDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-688' } }))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: catalogueAgentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [accountCatalog],
  })
  const offered = async (): Promise<string[]> =>
    (await host.catalogue()).find((row) => row.name === 'model')?.options?.map((option) => option.id) ?? []

  // No thread exists yet — a fresh process, the arena's case — and none is built to answer.
  const beforeAnyThread = await offered()
  expect(beforeAnyThread.filter((id) => id.startsWith('openai/'))).toEqual(['openai/gpt-account'])
  expect(await host.listSessions()).toEqual([])
  expect(readdirSync(catalogueAgentDir)).not.toContain('sessions')

  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  expect(await offered()).toEqual(beforeAnyThread)
  // What the Start dialog sends: its default (the first option) — then any other it offers.
  const dialogDefault = beforeAnyThread[0] ?? 'nothing offered'
  await hosted.runtime.runHostCommand({ name: 'model', value: dialogDefault })
  const started = hosted.runtime.modelState().model
  expect(started === null ? undefined : `${started.provider}/${started.id}`).toBe(dialogDefault)
  for (const id of beforeAnyThread) await hosted.runtime.runHostCommand({ name: 'model', value: id })
})

// #674: pi starts a session on the configured default (`defaultProvider`/`defaultModel`), and the Start
// dialog preselects the `/model` row's value — none until now, so the dialog took its first model,
// whatever the settings named. A default the session's list lacks is no value: preselecting it would
// be the 422 of #688 again.
test('the catalogue’s model row carries the configured default when it is offered, and none when it is not', async () => {
  const modelRowWith = async (settings: Record<string, string> | undefined): Promise<RuntimeCommand | undefined> => {
    const catalogueAgentDir = scratchAgentDir('enso-host-default-')
    writeFileSync(join(catalogueAgentDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-674' } }))
    if (settings !== undefined) writeFileSync(join(catalogueAgentDir, 'settings.json'), JSON.stringify(settings))
    const host = createAgentHost({
      servesDirectory: servesRepoRoot,
      agentDir: catalogueAgentDir,
      permissionRulesPath,
      harnessPackageDir: harnessDir,
      extensionFactories: [accountCatalog],
    })
    return (await host.catalogue()).find((row) => row.name === 'model')
  }
  expect((await modelRowWith({ defaultProvider: 'openai', defaultModel: 'gpt-account' }))?.value).toBe(
    'openai/gpt-account',
  )
  // A built-in model the account's list replaced, and no settings at all: no value, the first is taken.
  expect((await modelRowWith({ defaultProvider: 'openai', defaultModel: 'gpt-5.5' }))?.value).toBeUndefined()
  expect((await modelRowWith(undefined))?.value).toBeUndefined()
  // Half a default is none, as for pi (`findInitialModel` uses the pair only when both are set).
  expect((await modelRowWith({ defaultModel: 'gpt-account' }))?.value).toBeUndefined()
})

// ⚠ PR #561 review: a prompt that finds the thread held JOINS the holder (#75), and pi starts a run
// for it when none streams — so the restore's lease alone would let a run read a half-restored tree.
test('⚠ a prompt while the thread restores its files is refused with that reason, and admitted once the restore is done (#551)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses(Array.from({ length: 3 }, (_, index) => faux.fauxAssistantMessage(`reply ${index + 1}`)))
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await runPrompt(hosted, 'first')
  const first = hosted.inspect().entries.find((entry) => entry.kind === 'message' && entry.role === 'user')?.id ?? ''
  const restoring = host.restoreThreadAt(threadId, first)
  // Past the lookups, into the git of it.
  await Bun.sleep(0)
  const refused = Promise.withResolvers<string>()
  hosted.runtime.prompt(
    { message: 'during' },
    { onAccepted: () => refused.reject(new Error('admitted')), onRejected: refused.resolve },
  )
  expect(await refused.promise).toBe(`thread ${threadId} is restoring its files; prompt again once that is done`)
  // …and so is a mode change (#618): the mode route now tells a held thread's runtime directly, so
  // this refusal is what keeps a mode entry from being written while the files are put back.
  const modeRefused = Promise.withResolvers<string>()
  hosted.runtime.setPermissionMode(hosted.runtime.permissionModeState().available[0] ?? 'default', {
    onAccepted: () => modeRefused.reject(new Error('accepted')),
    onRejected: modeRefused.resolve,
  })
  expect(await modeRefused.promise).toBe(`thread ${threadId} is restoring its files; prompt again once that is done`)
  expect((await restoring).kind).toBe('restored')
  await runPrompt(hosted, 'after')
})

// ⚠ #502 meets #551: every tree is a fresh path, so trust keyed by the path would ask on every
// new thread and a "Trust project" answer would trust one tree. It is the project's.
test('⚠ a thread on its tree is trusted by its project\'s answer, and "Trust project" there trusts the project, not the tree (#551)', async () => {
  const trusted = yoloRepository()
  fixtureGit(trusted, 'init', '--quiet')
  fixtureGit(trusted, 'commit', '--quiet', '--allow-empty', '-m', 'one')
  new ProjectTrustStore(agentDir).set(trusted, true)
  const trustedCore = createFauxCore()
  trustedCore.setResponses([faux.fauxAssistantMessage('hi')])
  const onTree = await treeHost(trusted, [fauxModelExtension(trustedCore)]).host.createSession(
    crypto.randomUUID(),
    () => trusted,
  )
  openSessions.push(onTree)
  await runPrompt(onTree, 'no question')
  expect(onTree.inspect().cwd).not.toBe(trusted)
  expect(await writeAsks(onTree)).toBe(false)

  const asking = yoloRepository()
  fixtureGit(asking, 'init', '--quiet')
  fixtureGit(asking, 'commit', '--quiet', '--allow-empty', '-m', 'one')
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('hi')])
  const answered = await treeHost(asking, [fauxModelExtension(core)]).host.createSession(
    crypto.randomUUID(),
    () => asking,
  )
  openSessions.push(answered)
  // The question names the project its answer is stored for, never the tree's own path.
  const asked = untilObservation(answered, isTrustQuestion)
  await promptAnswering(answered, [], 'Trust project')
  const title = String(((await asked) as { dialog?: { title?: unknown } }).dialog?.title)
  expect(title).toStartWith(`Trust the project ${asking}?`)
  expect(new ProjectTrustStore(agentDir).get(asking)).toBe(true)
  expect(new ProjectTrustStore(agentDir).get(answered.inspect().cwd)).toBeNull()
})

// ⚠ The rest of the acceptance through the real harness: each run records the tree's snapshot; a
// fork's tree is at the parent's snapshot AT THE FORK POINT, not the parent's files now; a restore
// brings a turn's files back, keeps the replaced ones as the safety, and is recorded.
test("⚠ a fork's tree is the parent's at the fork point; a restore brings a turn's files back and keeps the replaced ones; a thread in its checkout has nothing to restore (#551)", async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses(Array.from({ length: 4 }, (_, index) => faux.fauxAssistantMessage(`reply ${index + 1}`)))
  const { host } = treeHost(project, [fauxModelExtension(core)])
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  new ProjectTrustStore(agentDir).set(project, true)
  await runPrompt(hosted, 'first')
  const tree = hosted.inspect().cwd
  // The agent's edit between the turns.
  writeFileSync(join(tree, 'a.txt'), 'agent edit\n')
  await runPrompt(hosted, 'second')
  const entries = hosted.inspect().entries
  const userEntry = (text: string): string => {
    const found = entries.find(
      (entry) =>
        entry.kind === 'message' &&
        entry.role === 'user' &&
        entry.parts.some((part) => part.type === 'text' && part.text === text),
    )
    if (found === undefined) throw new Error(`no user entry "${text}"`)
    return found.id
  }
  const snapshots = entries.flatMap((entry) =>
    entry.kind === 'custom' ? [readEnsoRunContext(entry.customType, entry.data)?.snapshot?.hash].filter(Boolean) : [],
  )
  expect(new Set(snapshots).size).toBe(2)
  hosted.runtime.dispose()

  // Forks: at "second" the tree held the edit; at "first" it did not.
  const atSecond = await host.forkThread(threadId, userEntry('second'))
  const atFirst = await host.forkThread(threadId, userEntry('first'))
  if (atSecond.kind !== 'forked' || atFirst.kind !== 'forked') {
    throw new Error(`a fork was refused: ${JSON.stringify([atSecond, atFirst])}`)
  }
  const forkedSecond = await host.createSession(atSecond.threadId, () => project)
  const forkedFirst = await host.createSession(atFirst.threadId, () => project)
  openSessions.push(forkedSecond, forkedFirst)
  expect(forkedSecond.inspect().cwd).not.toBe(tree)
  // Its branch in the user's repository names the fork's thread (PR #561 review), not the tree's directory.
  expect(fixtureGit(project, 'branch', '--list', `enso/${atSecond.threadId}`)).toContain(`enso/${atSecond.threadId}`)
  expect(readFileSync(join(forkedSecond.inspect().cwd, 'a.txt'), 'utf8')).toBe('agent edit\n')
  expect(readFileSync(join(forkedFirst.inspect().cwd, 'a.txt'), 'utf8')).toBe('dirty\n')
  expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('agent edit\n')

  // Restore the parent to "first": the files come back; the edit is kept as the safety.
  writeFileSync(join(tree, 'later.txt'), 'made after\n')
  const restored = await host.restoreThreadAt(threadId, userEntry('first'))
  if (restored.kind !== 'restored') throw new Error(`restore refused: ${restored.reason}`)
  expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('dirty\n')
  expect(existsSync(join(tree, 'later.txt'))).toBe(false)
  expect(restored.safety).not.toBe(restored.hash)
  const stored = await host.readStoredThread(threadId)
  expect(
    stored?.transcript.some((entry) => entry.kind === 'custom' && entry.customType === ENSO_TREE_RESTORED_ENTRY),
  ).toBe(true)

  // Undo (#565): the files the restore replaced come back — the edit and the file made after —
  // and that is a restore too, so undoing again puts the first restore back.
  const undone = await host.undoLastRestore(threadId, restored.safety)
  if (undone.kind !== 'restored') throw new Error(`undo refused: ${undone.reason}`)
  expect(undone.hash).toBe(restored.safety)
  expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('agent edit\n')
  expect(readFileSync(join(tree, 'later.txt'), 'utf8')).toBe('made after\n')
  // ⚠ The first restore's undo, pressed again: a later restore (the undo) replaced those files —
  // refused, and nothing moves (PR #561 review).
  expect((await host.undoLastRestore(threadId, restored.safety)).kind).toBe('superseded')
  expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('agent edit\n')
  const redone = await host.undoLastRestore(threadId, undone.safety)
  // The undo's own safety: the restored files, snapshotted again as a commit of their own.
  expect(redone).toMatchObject({ kind: 'restored', hash: undone.safety })
  expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('dirty\n')
  expect(existsSync(join(tree, 'later.txt'))).toBe(false)
  // A tree thread with no restore has nothing to undo.
  expect((await host.undoLastRestore(atFirst.threadId, restored.safety)).kind).toBe('no-restore')

  // A thread in its checkout has no tree to restore — said as that, not as a missing thread.
  const plainCore = createFauxCore()
  plainCore.setResponses([faux.fauxAssistantMessage('hi')])
  const plainHost = hostWith([fauxModelExtension(plainCore)])
  const plain = await plainHost.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(plain)
  await runPrompt(plain, 'hello')
  const plainUser = plain.inspect().entries.find((entry) => entry.kind === 'message' && entry.role === 'user')?.id ?? ''
  expect((await plainHost.restoreThreadAt(plain.inspect().sessionId, plainUser)).kind).toBe('no-tree')
})

/** The id of the user message that says `text`, on `entries`. */
function userEntryOf(entries: HostedThreadInspection['entries'], text: string): string {
  const found = entries.find(
    (entry) =>
      entry.kind === 'message' &&
      entry.role === 'user' &&
      entry.parts.some((part) => part.type === 'text' && part.text === text),
  )
  if (found === undefined) throw new Error(`no user entry "${text}"`)
  return found.id
}

/** A `retire` for a thread the test has already disposed: the host's own suite drives no registry. */
const NOTHING_LIVE = (): boolean => true

/** A forced delete confirming the work the preview showed, as the dialog's "Delete anyway" sends it (PR #572 review). */
async function deleteAsPreviewed(host: AgentHost, threadId: string): Promise<ThreadDeleteOutcome> {
  const read = await host.previewThreadDelete(threadId)
  const work = read.kind === 'preview' ? read.preview.holdsWork : null
  return host.deleteThread(threadId, {
    force: true,
    ...(work === null ? {} : { confirmedWork: sha256Of(work) }),
    retire: NOTHING_LIVE,
  })
}

// ⚠ #652, measured twice in the arena: a restore put the files back and left the conversation, so
// pi's next turn worked from files that were no longer there — an agent had to tell it, and once only
// the stale-write guard caught it. The next request now says so, once, through the real host.
test('⚠ the request after a restore tells pi which prompt the files went back to, once; a prompt with no restore before it says nothing (#652)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  // Each reply records the request it answered: what the model was sent, as text, per message.
  const sent: string[][] = []
  type SentContent = string | ReadonlyArray<{ readonly type: string; readonly text?: string }>
  const replying =
    (text: string) =>
    (context: { readonly messages: ReadonlyArray<{ readonly content: SentContent }> }): unknown => {
      sent.push(
        context.messages.map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : []))
                .join(' '),
        ),
      )
      return faux.fauxAssistantMessage(text)
    }
  core.setResponses(['one', 'two', 'three', 'four', 'five'].map(replying))
  const { host } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  await runPrompt(hosted, 'add priorities')
  writeFileSync(join(hosted.inspect().cwd, 'a.txt'), 'priorities\n')
  await runPrompt(hosted, 'add due dates')
  // The agent's edit during that round: the files at the restore are no prompt's start.
  writeFileSync(join(hosted.inspect().cwd, 'a.txt'), 'due dates\n')
  const restored = await host.restoreThreadAt(threadId, userEntryOf(hosted.inspect().entries, 'add priorities'))
  if (restored.kind !== 'restored') throw new Error(`restore refused: ${JSON.stringify(restored)}`)

  await runPrompt(hosted, 'try another way')
  const afterRestore = sent[2] ?? []
  const notes = afterRestore.filter((text) => text.startsWith('Note from Enso'))
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('how they were when prompt 1 began ("add priorities")')
  expect(notes[0]).toContain('Read a file again before you rely on it or edit it.')
  // Nothing before the restore carried one, and the next request does not repeat it.
  expect([...(sent[0] ?? []), ...(sent[1] ?? [])].some((text) => text.startsWith('Note from Enso'))).toBe(false)
  await runPrompt(hosted, 'and once more')
  expect((sent[3] ?? []).filter((text) => text.startsWith('Note from Enso'))).toHaveLength(1)
  // An idle thread after a restore is not a torn one: the branch ends on the reply, not on the note.
  const last = hosted.inspect().entries.at(-1)
  expect(last?.kind === 'message' && last.role === 'assistant').toBe(true)

  // Undo puts back files that were no prompt's start: said as files changed outside this conversation.
  const undone = await host.undoLastRestore(threadId, restored.safety)
  if (undone.kind !== 'restored') throw new Error(`undo refused: ${JSON.stringify(undone)}`)
  await runPrompt(hosted, 'after the undo')
  const afterUndo = (sent[4] ?? []).filter((text) => text.startsWith('Note from Enso'))
  expect(afterUndo).toHaveLength(2)
  expect(afterUndo[1]).toContain('back from an earlier restore (an undo)')
})

// #571: a delete removes what the thread has on disk — its session file and its store, which
// run-context mints for every thread, tree or not — and the id stays refused, so a page still
// showing it cannot prompt a new thread into being under it.
test('⚠ deleting a thread in its checkout removes its session file and its snapshot store, and its id is never built again; the checkout is untouched (#571)', async () => {
  const project = dirtyCheckout()
  const statusBefore = fixtureGit(project, 'status', '--porcelain')
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('one')])
  const { host, projectsDir } = treeHost(project, [fauxModelExtension(core)], 'off')
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  await runPrompt(hosted, 'first')
  const file = hosted.inspect().sessionFile ?? ''
  const store = join(projectSnapshotsDir(projectsDir, projectIdOf(project)), threadId)
  expect(existsSync(file) && existsSync(join(store, 'HEAD'))).toBe(true)
  // The preview (#571): a thread in its checkout takes no tree with it, and nothing leans on its store.
  expect(await host.previewThreadDelete(threadId)).toEqual({
    kind: 'preview',
    preview: { tree: null, size: null, holdsWork: null, keptFor: [] },
  })

  let retired = 0
  const retire = (): boolean => {
    retired += 1
    hosted.runtime.dispose()
    return true
  }
  expect(await host.deleteThread(threadId, { force: false, retire })).toEqual({ kind: 'deleted' })
  expect(retired).toBe(1)
  expect(existsSync(file) || existsSync(store)).toBe(false)
  expect((await host.listSessions()).some((stored) => stored.id === threadId)).toBe(false)
  expect(await host.readStoredThread(threadId)).toBeUndefined()
  await expect(host.createSession(threadId, () => project)).rejects.toBeInstanceOf(ThreadDeleted)
  expect((await host.deleteThread(threadId, { force: false, retire: NOTHING_LIVE })).kind).toBe('no-thread')
  expect(fixtureGit(project, 'status', '--porcelain')).toBe(statusBefore)
})

// PR #572 review: the id was claimed only after an await, so a second delete from another tab ran
// the whole delete again beside the first, and the first one's `finally` released the claim early.
test('two deletes of one thread at once: one deletes it, the other is refused as busy (#571)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('one')])
  const { host } = treeHost(project, [fauxModelExtension(core)], 'off')
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  await runPrompt(hosted, 'first')
  hosted.runtime.dispose()
  const outcomes = await Promise.all([
    host.deleteThread(threadId, { force: false, retire: NOTHING_LIVE }),
    host.deleteThread(threadId, { force: false, retire: NOTHING_LIVE }),
  ])
  expect(outcomes.map((outcome) => outcome.kind).toSorted()).toEqual(['busy', 'deleted'])
})

// PR #572 review: the tombstone was checked only before a build's awaits, so a build already under
// way finished after the delete and came back live — the registry's `retire` cannot see a build —
// and its next prompt wrote the deleted session file again. A session the registry never held
// (here: one the test keeps) must not run on a deleted id either.
test('a build under way when its thread is deleted is refused when it finishes, and a session still held admits no prompt (#571)', async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('one'), faux.fauxAssistantMessage('two')])
  const building = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let holdNext = false
  const hold: InlineExtension = {
    name: 'enso-host-hold-a-build',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', async () => {
        if (!holdNext) return
        holdNext = false
        building.resolve()
        await release.promise
      })
    },
  }
  const { host } = treeHost(project, [fauxModelExtension(core), hold], 'off')
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const held = await host.createSession(threadId, () => project)
  await runPrompt(held, 'first')
  const file = held.inspect().sessionFile ?? ''

  holdNext = true
  const rebuilt = host.createSession(threadId, () => project)
  await building.promise
  expect(await host.deleteThread(threadId, { force: false, retire: NOTHING_LIVE })).toEqual({ kind: 'deleted' })
  release.resolve()
  await expect(rebuilt).rejects.toBeInstanceOf(ThreadDeleted)

  const refused = Promise.withResolvers<string>()
  held.runtime.prompt({ message: 'after the delete' }, { onAccepted: () => undefined, onRejected: refused.resolve })
  expect(await refused.promise).toContain('deleted')
  held.runtime.dispose()
  expect(existsSync(file)).toBe(false)
})

test('⚠ deleting a thread on its worktree: one holding work is refused, naming it, with nothing removed and the thread not retired; forced, the worktree, its branch, its store and its session go, and the checkout is untouched (#571)', async () => {
  const project = dirtyCheckout()
  const statusBefore = fixtureGit(project, 'status', '--porcelain')
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('one')])
  const { host, projectsDir } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  await runPrompt(hosted, 'first')
  const tree = hosted.inspect().cwd
  const file = hosted.inspect().sessionFile ?? ''
  const store = join(projectSnapshotsDir(projectsDir, projectIdOf(project)), threadId)
  writeFileSync(join(tree, 'work.md'), 'not yet anywhere\n')

  let retired = false
  const refused = await host.deleteThread(threadId, {
    force: false,
    retire: () => {
      retired = true
      return true
    },
  })
  expect(refused.kind).toBe('holds-work')
  expect(refused.kind === 'deleted' ? '' : refused.reason).toContain('work.md')
  expect(retired).toBe(false)
  expect([existsSync(tree), existsSync(file), existsSync(join(store, 'HEAD'))]).toEqual([true, true, true])

  // PR #572 review: force takes the work the user was SHOWN, and nothing more. Forced without
  // naming it, or naming a list the tree has since outgrown, is refused with the list as it is now.
  const reasonOf = (outcome: Awaited<ReturnType<AgentHost['deleteThread']>>): string =>
    outcome.kind === 'deleted' ? '' : outcome.reason
  const shown = reasonOf(refused)
  expect((await host.deleteThread(threadId, { force: true, retire: NOTHING_LIVE })).kind).toBe('holds-work')
  writeFileSync(join(tree, 'more.md'), 'written after the list was shown\n')
  const outgrown = await host.deleteThread(threadId, {
    force: true,
    confirmedWork: sha256Of(shown),
    retire: NOTHING_LIVE,
  })
  expect(outgrown.kind).toBe('holds-work')
  expect(reasonOf(outgrown)).toContain('more.md')
  expect(existsSync(join(tree, 'more.md')) && existsSync(file)).toBe(true)

  const forced = await host.deleteThread(threadId, {
    force: true,
    confirmedWork: sha256Of(reasonOf(outgrown)),
    retire: () => {
      hosted.runtime.dispose()
      return true
    },
  })
  expect(forced).toEqual({ kind: 'deleted' })
  expect(existsSync(tree) || existsSync(store) || existsSync(file)).toBe(false)
  expect(fixtureGit(project, 'worktree', 'list')).not.toContain(tree)
  expect(fixtureGit(project, 'branch', '--list', `enso/${threadId}`)).toBe('')
  expect(fixtureGit(project, 'status', '--porcelain')).toBe(statusBefore)
})

// #571, #573: the fork's turns before the fork point were snapshotted by the PARENT; the fork's
// history in the project's object store reaches them, so the parent's store goes with the parent.
test("⚠ deleting a forked parent removes its store, and the fork still restores to a turn the parent took — after the delete's collection of what only the parent reached (#571, #573)", async () => {
  const project = dirtyCheckout()
  const core = createFauxCore()
  core.setResponses(Array.from({ length: 3 }, (_, at) => faux.fauxAssistantMessage(`reply ${at + 1}`)))
  const { host, projectsDir } = treeHost(project, [fauxModelExtension(core)])
  new ProjectTrustStore(agentDir).set(project, true)
  const parentId = crypto.randomUUID()
  const parent = await host.createSession(parentId, () => project)
  await runPrompt(parent, 'first')
  const parentTree = parent.inspect().cwd
  writeFileSync(join(parentTree, 'a.txt'), 'agent edit\n')
  await runPrompt(parent, 'second')
  const atSecond = userEntryOf(parent.inspect().entries, 'second')
  parent.runtime.dispose()
  const forked = await host.forkThread(parentId, atSecond)
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  const fork = await host.createSession(forked.threadId, () => project)
  const snapshots = projectSnapshotsDir(projectsDir, projectIdOf(project))

  // Before deleting, the preview says what goes and what stays: the tree with its branch and its
  // size on disk (#578, as `du` counts it), the work in it, and the fork its snapshots are kept for
  // — deleting nothing.
  const preview = await host.previewThreadDelete(parentId)
  expect(preview).toEqual({
    kind: 'preview',
    preview: {
      tree: { kind: 'worktree', path: parentTree, branch: `enso/${parentId}` },
      size: { kind: 'measured', bytes: expect.any(Number) },
      holdsWork: expect.stringContaining('a.txt'),
      keptFor: [{ threadId: forked.threadId }],
    },
  })
  const du = Number(execFileSync('du', ['-sk', parentTree], { encoding: 'utf8' }).split('\t')[0]) * 1024
  const measured =
    preview.kind === 'preview' && preview.preview.size?.kind === 'measured' ? preview.preview.size.bytes : -1
  expect(Math.abs(measured - du)).toBeLessThan(1024)

  // The trees listing (#578): both threads' trees under the project, by thread, with their sizes,
  // and the project's snapshot object store.
  const listing = await host.listTrees()
  const listed = listing.projects.find((entry) => entry.projectId === projectIdOf(project))
  expect(listed?.objectStore).toMatchObject({ kind: 'measured' })
  const byThread = new Map(listed?.trees.map((tree) => [tree.threadId, [tree.kind, tree.size.kind]]))
  expect(byThread).toEqual(
    new Map([
      [parentId, ['worktree', 'measured']],
      [forked.threadId, ['worktree', 'measured']],
    ]),
  )
  expect(listed?.trees.find((tree) => tree.threadId === parentId)?.holdsWork).toContain('a.txt')
  // A tree directory no thread records (a mint or a delete that stopped partway) is listed too —
  // named, with its size, and no thread to delete it through.
  const stray = join(dirname(parentTree), 'stray-tree')
  mkdirSync(stray)
  writeFileSync(join(stray, 'left.txt'), 'left behind\n')
  const withStray = (await host.listTrees()).projects.find((entry) => entry.projectId === projectIdOf(project))
  expect(withStray?.trees.find((tree) => tree.path === stray)).toEqual({
    threadId: null,
    path: stray,
    kind: 'copy',
    branch: null,
    size: { kind: 'measured', bytes: expect.any(Number) },
    holdsWork: null,
  })
  rmSync(stray, { recursive: true })
  expect(existsSync(parentTree) && existsSync(join(snapshots, parentId, 'HEAD'))).toBe(true)
  // Past the collection's one-hour grace, so the delete's collection prunes what nothing reaches.
  const then = new Date(Date.now() - 2 * 60 * 60_000)
  for (const entry of readdirSync(join(snapshots, '.objects'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), then, then)
  }
  expect(await deleteAsPreviewed(host, parentId)).toEqual({ kind: 'deleted' })
  expect(existsSync(parentTree) || existsSync(join(snapshots, parentId))).toBe(false)
  // "first" was the parent's turn: its snapshot is in the fork's history.
  const forkTree = fork.inspect().cwd
  writeFileSync(join(forkTree, 'a.txt'), 'fork edit\n')
  const restored = await host.restoreThreadAt(forked.threadId, userEntryOf(fork.inspect().entries, 'first'))
  if (restored.kind !== 'restored') throw new Error(`restore refused: ${restored.reason}`)
  expect(readFileSync(join(forkTree, 'a.txt'), 'utf8')).toBe('dirty\n')

  fork.runtime.dispose()
  expect(await deleteAsPreviewed(host, forked.threadId)).toEqual({ kind: 'deleted' })
  expect(existsSync(join(snapshots, forked.threadId)) || existsSync(join(snapshots, parentId))).toBe(false)
})

// #447: a fork copies its source's messages with their times, and pi's `modified` is the last
// message's — so a fork taken now of a thread idle for hours read as hours old and sorted with it.
test('a fork of a thread idle for hours lists as made now, and sorts above a thread active since', async () => {
  const hoursAgo = Date.now() - 3 * 60 * 60 * 1000
  const source = crypto.randomUUID()
  const { userEntryIds } = storeTurns(
    source,
    [
      ['old question', 'old answer'],
      ['later question', 'later answer'],
    ],
    repoRoot,
    () => hoursAgo,
  )
  const active = crypto.randomUUID()
  storeTurns(active, [['recent question', 'recent answer']])
  // ⚠ A listing orders by millisecond, and a tie has no order. Warm, storing `active` and forking
  // fit in ONE millisecond (measured: about half of 200 reruns tied, and it failed a gate run), so
  // the fork is made on a clock set a second later — the runtime stamps the fork's header from it.
  setSystemTime(new Date(Date.now() + 1000))
  try {
    const host = hostWith()
    const forkedAt = Date.now()
    const forked = await host.forkThread(source, userEntryIds[1] ?? '')
    if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
    // pi writes a fork's file only once it holds an assistant message; this one copies one.
    const listed = await host.listSessions()
    const index = (id: string): number => listed.findIndex((stored) => stored.id === id)
    expect(listed[index(forked.threadId)]?.modified.getTime()).toBeGreaterThanOrEqual(forkedAt - 1000)
    expect(index(forked.threadId)).toBeLessThan(index(active))
  } finally {
    setSystemTime()
  }
})

test('⚠ forking at the first prompt gives an EMPTY thread that names its parent — listed untitled, and it resumes under its id (#433)', async () => {
  const source = crypto.randomUUID()
  const { file, userEntryIds } = storeTurns(source, [['only question', 'only answer']])
  const before = readFileSync(file)
  const host = hostWith()
  const forked = await host.forkThread(source, userEntryIds[0] ?? '')
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  expect(forked.prefill).toBe('only question')
  expect(await readFork(host, forked.threadId)).toEqual({ parentSession: file, branch: [] })
  expect(readFileSync(file).equals(before)).toBe(true)
  const listed = (await host.listSessions()).find((stored) => stored.id === forked.threadId)
  expect(listed).toMatchObject({ parentThreadId: source, messageCount: 0, firstMessage: '' })
  // pi would not have written it (no assistant message); resuming must OPEN it, not start a fresh session.
  const hosted = await host.createSession(forked.threadId, () => {
    throw new Error('a fork with a session file was asked for a new directory')
  })
  openSessions.push(hosted)
  expect(hosted.inspect().sessionFile).toBe(listed?.path ?? '')
})

test('forking a LIVE thread forks what its file holds, as a cold one does, and leaves the live session as it was (#433)', async () => {
  const source = crypto.randomUUID()
  const { userEntryIds } = storeTurns(source, [
    ['live first', 'live answer'],
    ['live second', 'live second answer'],
  ])
  const host = hostWith()
  const live = await host.createSession(source, () => repoRoot)
  openSessions.push(live)
  const forked = await host.forkThread(source, userEntryIds[1] ?? '')
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  expect(forked.prefill).toBe('live second')
  expect((await readFork(host, forked.threadId)).branch).toEqual(['user: live first', 'assistant: live answer'])
  expect(live.inspect().sessionId).toBe(source)
})

// ── a cold thread's recorded model (#434) ────────────────────────────────────

test('⚠ a stored read reports the LAST model and thinking level on the branch path — a change on an abandoned branch is ignored (#434)', async () => {
  const threadId = crypto.randomUUID()
  const { file } = storeTurns(threadId, [['first question', 'first answer']])
  const more = SessionManager.open(file)
  more.appendModelChange('anthropic', 'claude-early')
  more.appendThinkingLevelChange('low')
  more.appendModelChange('openai', 'gpt-kept')
  const branchPoint = more.appendThinkingLevelChange('high')
  // A later change that the leaf's path will NOT hold: pi restores neither.
  more.appendModelChange('google', 'gemini-abandoned')
  more.appendThinkingLevelChange('xhigh')
  more.branch(branchPoint)
  more.appendMessage({ role: 'user', content: 'on the kept branch', timestamp: Date.now() })

  const stored = await hostWith().readStoredThread(threadId)
  expect(stored?.recordedModel).toEqual({ model: { provider: 'openai', modelId: 'gpt-kept' }, thinkingLevel: 'high' })
})

// PR #438 review: pi restores the model from the last `model_change` OR assistant reply on the path
// (`getSessionContextSettings`), and a reopen that cannot restore the recorded model falls back
// WITHOUT a change entry — only the replies after it say what ran.
test('⚠ a stored branch reports the model its last reply ran on when the reply follows the last change, as pi restores it (#434)', async () => {
  const threadId = crypto.randomUUID()
  const { file } = storeTurns(threadId, [['a question', 'an answer']])
  const stored = SessionManager.open(file)
  stored.appendModelChange('openai', 'gpt-recorded')
  stored.appendMessage({ role: 'user', content: 'after a reopen', timestamp: Date.now() })
  // `storedReply` runs on `anthropic`/`test`: the model pi fell back to, with no change entry.
  stored.appendMessage(storedReply('answered on the fallback'))
  expect((await hostWith().readStoredThread(threadId))?.recordedModel).toEqual({
    model: { provider: 'anthropic', modelId: 'test' },
    thinkingLevel: null,
  })
})

test('a branch that records no reply, no model change and no thinking level has no recorded model; one half alone is reported alone (#434)', () => {
  expect(recordedModelOf([{ type: 'message', message: { role: 'user', content: 'q' } }])).toBeUndefined()
  expect(recordedModelOf([{ type: 'thinking_level_change', thinkingLevel: 'medium' }])).toEqual({
    model: null,
    thinkingLevel: 'medium',
  })
})

test("a fork reports its source's recorded model up to the fork point, not a change the source made after it (#434, #433)", async () => {
  const source = crypto.randomUUID()
  const { file } = storeTurns(source, [['first question', 'first answer']])
  const more = SessionManager.open(file)
  more.appendModelChange('anthropic', 'claude-before-fork')
  more.appendThinkingLevelChange('medium')
  const forkPoint = more.appendMessage({ role: 'user', content: 'second question', timestamp: Date.now() })
  more.appendModelChange('openai', 'gpt-after-fork')
  more.appendThinkingLevelChange('high')

  const host = hostWith()
  const forked = await host.forkThread(source, forkPoint)
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  expect((await host.readStoredThread(forked.threadId))?.recordedModel).toEqual({
    model: { provider: 'anthropic', modelId: 'claude-before-fork' },
    thinkingLevel: 'medium',
  })
  expect((await host.readStoredThread(source))?.recordedModel).toEqual({
    model: { provider: 'openai', modelId: 'gpt-after-fork' },
    thinkingLevel: 'high',
  })
})

test('a fork is refused, with a reason, for a thread with no file or not served, an entry the file lacks, and an entry that is no user message (#433)', async () => {
  const source = crypto.randomUUID()
  storeTurns(source, [['a question', 'an answer']])
  const host = hostWith()
  const assistantEntryId = SessionManager.open(
    (await host.listSessions()).find((stored) => stored.id === source)?.path ?? '',
  )
    .getBranch()
    .find((entry) => entry.type === 'message' && entry.message.role === 'assistant')?.id
  expect(await host.forkThread('never-stored', 'x')).toMatchObject({ kind: 'no-thread' })
  const elsewhere = crypto.randomUUID()
  const { userEntryIds } = storeTurns(elsewhere, [['q', 'a']], mkdtempSync(join(tmpdir(), 'enso-unserved-fork-')))
  expect(await host.forkThread(elsewhere, userEntryIds[0] ?? '')).toMatchObject({ kind: 'no-thread' })
  expect(await host.forkThread(source, 'no-such-entry')).toMatchObject({ kind: 'no-entry' })
  expect(await host.forkThread(source, assistantEntryId ?? '')).toMatchObject({ kind: 'not-a-user-message' })
  // Nothing refused left a file behind.
  expect((await host.listSessions()).filter((stored) => stored.parentThreadId === source)).toEqual([])
})

// ── session usage (#45): pi's totals, live and stored ────────────────────────

/**
 * pi's scripted provider, reached THROUGH the runtime's own install: `@earendil-works/pi-ai` is
 * pi's dependency, not ours, so it is resolved from pi-coding-agent's location rather than
 * declared (the `agent-loop-contract.test.ts` precedent). The two functions used, typed at this
 * one boundary by the extension API that consumes them.
 */
type ProviderConfig = Parameters<ExtensionAPI['registerProvider']>[1]
/** pi's recorded usage, as a session entry carries it. */
type RecordedUsage = Extract<SessionEntry, { type: 'usage' }>['usage']
interface FauxModule {
  createFauxCore(options: { provider: string; api: string; models: Array<{ id: string; contextWindow: number }> }): {
    streamSimple: NonNullable<ProviderConfig['streamSimple']>
    getModel(): Parameters<ExtensionAPI['setModel']>[0]
    setResponses(responses: unknown[]): void
    /** How many requests the provider has answered. */
    readonly state: { readonly callCount: number }
  }
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string; errorMessage?: string }): unknown
  fauxToolCall(name: string, arguments_: Record<string, unknown>, options?: { id?: string }): unknown
}
const piCodingAgentDir = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
const faux: FauxModule = await import(Bun.resolveSync('@earendil-works/pi-ai', piCodingAgentDir))

type FauxCore = ReturnType<FauxModule['createFauxCore']>

/** pi's scripted provider with one model and a 50k window — what a test scripts with `setResponses`. */
function createFauxCore(): FauxCore {
  return faux.createFauxCore({
    provider: 'enso-faux',
    api: 'enso-faux',
    models: [{ id: 'faux-1', contextWindow: 50_000 }],
  })
}

/** An inline extension that registers `core` as a provider and selects its model at session start. */
function fauxModelExtension(core: FauxCore): InlineExtension {
  return {
    name: 'enso-host-faux-model',
    factory: (pi: ExtensionAPI) => {
      // The CONFIG form with a literal key: pi marks the provider configured synchronously, so
      // `setModel` below cannot race its availability refresh (the native form is async — it
      // flaked: `setModel` answered false on some runs).
      pi.registerProvider('enso-faux', {
        api: 'enso-faux',
        baseUrl: 'http://faux.invalid',
        apiKey: 'faux',
        streamSimple: core.streamSimple,
        models: [
          {
            id: 'faux-1',
            name: 'Faux One',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 50_000,
            maxTokens: 1000,
          },
        ],
      })
      pi.on('session_start', async () => {
        if (!(await pi.setModel(core.getModel()))) throw new Error('pi refused the faux model')
      })
    },
  }
}

// ⚠ THE ORDER IS pi's, AND IT IS THE BUG THIS PINS. pi hands `message_end` to listeners BEFORE it
// appends the message to the session (`agent-session.js` `_handleAgentEvent`), so usage read at
// `message_end` is one message short. The host says it at `turn_end` instead; a pi bump that moves
// the append after `turn_end` would show every tab a total one request behind, and fails here.
test("⚠ after a turn the host says the session's usage WITH that turn's spend in it, and pi's window (#45)", async () => {
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('hello there')])
  const fauxModel = fauxModelExtension(core)
  const hosted = await hostedSession([fauxModel])
  const seen: EnsoObservation[] = []
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    seen.push(observation)
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.prompt({ message: 'hi' }, { onAccepted: () => undefined, onRejected: settled.reject })
  await settled.promise
  const answered = seen.findIndex(
    (observation) => observation.kind === 'message-end' && observation.role === 'assistant',
  )
  const spent = seen[answered]
  const after = seen.slice(answered).find((observation) => observation.kind === 'session-usage')
  if (spent?.kind !== 'message-end' || spent.usage === undefined || after?.kind !== 'session-usage') {
    throw new Error(
      `no assistant spend followed by a session-usage: ${seen.map((observation) => observation.kind).join(',')}`,
    )
  }
  expect(after.input).toBe(spent.usage.input)
  expect(after.output).toBe(spent.usage.output)
  expect(after.context?.window).toBe(50_000)
  expect(after.context?.tokens).toBeGreaterThan(0)
  const { kind: _kind, ...said } = after
  expect(said).toEqual(hosted.runtime.sessionUsage())
})

// ⚠ A resumed thread and the tab that watched it accumulate must read ONE total. The file's fold
// (`session-usage.ts`) re-states pi's `getSessionStats` rule; this pins the two equal on a session
// with every kind pi counts — assistant, summarised tool result, a `usage` entry, a compaction —
// and spend on a branch the session has since left.
test("⚠ a stored session's usage is pi's own getSessionStats total — every branch, every kind it counts (#45)", async () => {
  const threadId = crypto.randomUUID()
  const file = storeSession(threadId, 'first question', 'first answer')
  const spend = (input: number, total: number): RecordedUsage => ({
    input,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: input + 9,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  })
  const more = SessionManager.open(file)
  const forkPoint = more.getLeafId()
  if (forkPoint === null) throw new Error('the stored session has no leaf')
  more.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'on the branch left behind' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test',
    usage: spend(10, 0.5),
    stopReason: 'stop',
    timestamp: Date.now(),
  } as never)
  more.branch(forkPoint)
  more.appendMessage({
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read',
    content: [{ type: 'text', text: 'summarised' }],
    isError: false,
    usage: spend(20, 0.25),
    timestamp: Date.now(),
  } as never)
  more.appendUsage('cache_warm', 'anthropic', 'test', spend(30, 0.125))
  more.appendCompaction('summary', null, 100, undefined, false, spend(40, 0.0625))

  const host = hostWith()
  const stored = await host.readStoredThread(threadId)
  if (stored === undefined) throw new Error('the stored session was not found')
  const hosted = await host.createSession(threadId, () => repoRoot)
  openSessions.push(hosted)
  const { context: storedContext, ...fromFile } = stored.usage
  const { context: _liveContext, ...fromPi } = hosted.runtime.sessionUsage()
  expect(fromFile).toEqual(fromPi)
  // Every kind counted, the left branch included: 0.5 + 0.25 + 0.125 + 0.0625 (the first answer spent 0).
  expect(fromFile.cost).toBe(0.9375)
  expect(fromFile.input).toBe(1 + 10 + 20 + 30 + 40)
  // A file does not say which model pi would run, so it does not say the window.
  expect(storedContext).toBeNull()
})

// ── who said a notice (#387 gap 2) ───────────────────────────────────────────

// The acceptance's fixture is a REAL notify: pi-multi-account says it loaded (and how many
// accounts it rotates) at every session start. pi hands every extension the same `ctx.ui`, so the
// notice arrives with no caller; the host tagged pi-multi-account's registrations with the
// extension pi loaded (`notice-sender.ts`), and the notice names it — from where it was said,
// never from what it says.
test('⚠ a vendored extension’s own startup notice names it: pi-multi-account says pi-multi-account (#387)', async () => {
  const hosted = await hostedSession()
  const notice = await untilObservation(
    hosted,
    (observation) => observation.kind === 'extension-ui-request' && observation.method === 'notify',
  )
  expect(notice).toMatchObject({ kind: 'extension-ui-request', method: 'notify', sender: 'pi-multi-account' })
})

// ── the agent asks (#12) ─────────────────────────────────────────────────────

const DATABASE_QUESTION = {
  header: 'Database',
  question: 'Which database?',
  options: [
    { label: 'Postgres', description: 'relational, a server' },
    { label: 'SQLite', description: 'embedded, a file' },
  ],
  multiSelect: false,
}

const CHECKS_QUESTION = {
  header: 'Checks',
  question: 'Which checks?',
  options: [
    { label: 'lint', description: 'style' },
    { label: 'types', description: 'the compiler' },
    { label: 'tests', description: 'behaviour' },
  ],
  multiSelect: true,
}

/**
 * A hosted session whose faux model calls `ask_user` with `questions`, prompted and held at the
 * question it asks: the observations so far, that question as it arrived, and the run's settle.
 */
async function askedQuestionnaire(questions: readonly unknown[]): Promise<{
  hosted: HostedThread
  core: FauxCore
  events: EnsoObservation[]
  question: Extract<EnsoObservation, { kind: 'extension-ui-request' }>
  settled: Promise<void>
}> {
  const core = createFauxCore()
  core.setResponses([
    faux.fauxAssistantMessage(faux.fauxToolCall(ASK_USER_TOOL_NAME, { questions })),
    faux.fauxAssistantMessage('Understood.'),
  ])
  const hosted = await hostedSession([fauxModelExtension(core)])
  const events = collectEvents(hosted)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  const asked = untilObservation(
    hosted,
    (observation) => observation.kind === 'extension-ui-request' && observation.blocking,
  )
  hosted.runtime.prompt({ message: 'set up storage' }, { onAccepted: () => undefined, onRejected: settled.reject })
  const question = await asked
  if (question.kind !== 'extension-ui-request') throw new Error('unreachable: matched on kind')
  return { hosted, core, events, question, settled: settled.promise }
}

/** What `ask_user` returned to the model, once the run has settled. */
function askUserText(events: EnsoObservation[]): string {
  const result = events.find((event) => event.kind === 'tool-result' && event.toolName === ASK_USER_TOOL_NAME)
  if (result?.kind !== 'tool-result') {
    throw new Error(`no ask_user result: ${events.map((event) => event.kind).join(',')}`)
  }
  expect(result.isError).toBe(false)
  return result.text
}

// ⚠⚠ The escalation channel end to end, without a wire: the MODEL calls `ask_user`, the tool hands
// `custom` its questionnaire component, the host lifts it — and the whole questionnaire must arrive
// as ONE `questionnaire` dialog, the card's input, carrying exactly what the model asked. The
// answers then have to reach the model as the tool's result, in plain words. A regression anywhere
// on that path (the tool asking one prompt at a time, the lift not recognising the component, the
// mapper not treating the kind as blocking) fails here.
test('⚠⚠ the agent asks through ask_user: its questionnaire is one dialog, and the answers are its tool result (#12)', async () => {
  const { hosted, core, events, question, settled } = await askedQuestionnaire([DATABASE_QUESTION, CHECKS_QUESTION])
  expect(question.blocking).toBe(true)
  expect(question.dialog).toEqual({
    method: 'questionnaire',
    title: '2 questions',
    questions: [DATABASE_QUESTION, CHECKS_QUESTION],
  })
  hosted.runtime.answerDialog({
    id: question.id,
    answers: [{ selected: ['Postgres'] }, { selected: ['lint', 'tests'], other: 'e2e' }],
  })
  await settled
  expect(askUserText(events)).toBe(
    [
      'The user answered:',
      '- Which database? → Postgres',
      '- Which checks? → lint, tests, in their own words: "e2e"',
    ].join('\n'),
  )
  // An answer carries the run on: the model is asked again, with the answers.
  expect(core.state.callCount).toBe(2)
})

// The card's Cancel is a real decline for every kind of question — the multi-choice one included,
// which the adopted vendor could only read as "none of these" (#376 review). ⚠ And the decline
// ENDS THE RUN (#379, #465): the model is not asked again, so it cannot pick for the user or route
// around the question — the next move is the user's.
test('⚠ a declined ask_user questionnaire reaches the model as a decline, and the run ends there (#12, #379)', async () => {
  const { hosted, core, events, question, settled } = await askedQuestionnaire([CHECKS_QUESTION])
  hosted.runtime.answerDialog({ id: question.id, cancelled: true })
  await settled
  expect(askUserText(events)).toBe('The user declined to answer and chose nothing.')
  expect(core.state.callCount).toBe(1)
})

/** A hosted session whose faux model sends ONE batch of `calls`, then would reply: how many requests it answered. */
async function requestsAfterBatch(calls: readonly unknown[]): Promise<number> {
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage([...calls]), faux.fauxAssistantMessage('Carrying on.')])
  const hosted = await plainWorkspaceSession([fauxModelExtension(core)])
  await runPrompt(hosted, 'tidy up')
  return core.state.callCount
}

// ⚠⚠ #465, #189: asking must be cheaper than working around a refusal. An authorization refusal
// from the real guard sets pi's `terminate`, and pi's real loop ends the run once EVERY call of the
// batch set it — so a batch the guard refused whole hands the turn back to the user, and the model
// never gets the turn in which it would try another route. A batch where something else ran goes
// on (pi's rule, `shouldTerminateToolBatch`): the model reads the refusal and its ask line then. A
// redirect (`curl`) keeps the run, so the model can take the route it names (`web_fetch`).
test('⚠⚠ a batch the guard refused whole ends the run; a batch where a call ran, or a redirect, goes on (#465)', async () => {
  const refused = faux.fauxToolCall('write', { path: '/etc/enso-465-probe', content: 'x' })
  expect(await requestsAfterBatch([refused])).toBe(1)
  expect(await requestsAfterBatch([refused, faux.fauxToolCall('read', { path: 'package.json' })])).toBe(2)
  expect(await requestsAfterBatch([faux.fauxToolCall('bash', { command: 'curl https://example.com' })])).toBe(2)
})

/** The tools a request offered the model: pi's system messages' `toolsAdded` / `toolsRemoved`, folded in order. */
function declaredTools(request: unknown): string[] {
  const messages = (request as { messages?: { role?: string; toolsAdded?: unknown; toolsRemoved?: unknown }[] })
    .messages
  const names = (tools: unknown): string[] =>
    Array.isArray(tools) ? tools.map((tool: { name?: unknown }) => String(tool.name)) : []
  const offered = new Set<string>()
  for (const message of messages ?? []) {
    if (message.role !== 'system') continue
    for (const name of names(message.toolsRemoved)) offered.delete(name)
    for (const name of names(message.toolsAdded)) offered.add(name)
  }
  return [...offered]
}

/**
 * A probe that opens a halting incident the way the guard announces one (#467): once `read` has
 * returned in this run, it appends the opening and announces it on the bus the report extension
 * listens to. The guard itself is not told, so this pins the report turn, not the guard's window.
 */
function incidentOpener(): InlineExtension {
  return {
    name: 'enso-host-incident-opener',
    factory: (pi: ExtensionAPI) => {
      pi.on('tool_result', (event) => {
        if (event.toolName !== 'read') return
        const opened: EnsoIncidentOpened = {
          incidentId: 'incident-report-e2e',
          signals: [{ signal: 'denial-retry', toolCallId: event.toolCallId, detail: 'probe', after: [] }],
          halted: true,
          suspended: ['execute', 'network', 'write'],
        }
        pi.appendEntry(ENSO_INCIDENT_OPENED_ENTRY, opened)
        pi.events.emit(ENSO_INCIDENT_OPENED_CHANNEL, opened)
      })
    },
  }
}

// ⚠⚠ #467 through pi's real loop and the real report extension: the request arrives as a follow-up
// in the SAME run once the model stops, with the report tool the only one on offer; a report
// missing a field is rejected by pi's schema check; a complete one is recorded and ends the run.
test('⚠⚠ the report turn: asked in the same run with only the report tool; a missing field is rejected; a report is recorded and ends the run (#467)', async () => {
  const core = createFauxCore()
  const requests: unknown[] = []
  const counted: FauxCore = {
    ...core,
    streamSimple: (...call: Parameters<FauxCore['streamSimple']>) => {
      requests.push(call[1])
      return core.streamSimple(...call)
    },
  }
  const report = {
    task: { text: 'Read the manifest.', evidence: [{ ref: 'prompt', quote: 'read the manifest' }] },
    denied: { text: 'The read.', evidence: [{ ref: 'read-1', quote: 'package.json' }] },
    tried: { text: 'Nothing else.', evidence: [{ ref: 'read-1', quote: 'package.json' }] },
    whyThatAlternative: 'none',
    recognisedAsBypass: 'no',
    shouldHaveDone: 'asked',
    sufficientAuthorization: 'none',
    patternToAvoid: 'none',
    uncharitableRead: 'none',
  }
  const { uncharitableRead: _missing, ...incomplete } = report
  core.setResponses([
    faux.fauxAssistantMessage(faux.fauxToolCall('read', { path: 'package.json' }, { id: 'read-1' })),
    faux.fauxAssistantMessage('Read it.'),
    faux.fauxAssistantMessage(faux.fauxToolCall(ENSO_INCIDENT_REPORT_TOOL_NAME, incomplete)),
    faux.fauxAssistantMessage(faux.fauxToolCall(ENSO_INCIDENT_REPORT_TOOL_NAME, report)),
    faux.fauxAssistantMessage('never asked: the report ended the run'),
  ])
  const hosted = await plainWorkspaceSession([fauxModelExtension(counted), incidentOpener()])
  const seen = collectEvents(hosted)
  await runPrompt(hosted, 'Please read the manifest.')

  expect(core.state.callCount).toBe(4)
  // What the model was offered: pi declares the loadout in system messages, added and removed.
  expect(declaredTools(requests[0])).not.toContain(ENSO_INCIDENT_REPORT_TOOL_NAME)
  expect(declaredTools(requests[0])).toContain('read')
  expect(declaredTools(requests[2])).toEqual([ENSO_INCIDENT_REPORT_TOOL_NAME])
  const reportResults = seen.flatMap((observation) =>
    observation.kind === 'tool-result' && observation.toolName === ENSO_INCIDENT_REPORT_TOOL_NAME
      ? [observation.isError]
      : [],
  )
  expect(reportResults).toEqual([true, false])
  const recorded = seen.flatMap((observation) =>
    observation.kind === 'custom-entry' && observation.customType === ENSO_INCIDENT_REPORT_ENTRY
      ? [observation.data as EnsoIncidentReport]
      : [],
  )
  expect(recorded).toEqual([
    expect.objectContaining({ incidentId: 'incident-report-e2e', submission: 1, mismatches: [] }),
  ])
})

// ⚠⚠ #466 end to end, through the real guard the harness loads: a stored thread whose branch holds
// a halted incident is resumed — the guard rebuilds the suspension from the RECORD, whatever the
// config says now, so a web_search the engine allows is refused as suspended — and the host's
// resolution, appended and announced on the bus, lifts it in the LIVE guard, with no reload.
test('⚠⚠ a resumed thread’s recorded incident suspends in the real guard, and the host’s resolution lifts it live (#466)', async () => {
  const threadId = crypto.randomUUID()
  const file = storeSession(threadId, 'fetch it', 'refused, and stopped')
  const opened: EnsoIncidentOpened = {
    incidentId: 'incident-e2e',
    signals: [],
    halted: true,
    suspended: ['execute', 'network', 'write'],
  }
  SessionManager.open(file).appendCustomEntry(ENSO_INCIDENT_OPENED_ENTRY, opened)
  const hosted = await hostWith().createSession(threadId, () => repoRoot)
  openSessions.push(hosted)
  const refusal = await hosted.probeToolCall('web_search', { query: 'x' })
  expect(refusal).toEqual({ block: true, reason: expect.stringContaining('incident-e2e') })

  expect(
    hosted.runtime.resolveIncident('incident-e2e', { classification: 'false-positive', outcome: 'resume' }),
  ).toBeUndefined()
  expect((await hosted.probeToolCall('web_search', { query: 'x' }))?.block).toBe(false)
})

// ⚠⚠ If the user says stop, it's stop — also while the AGENT is asking. The question holds the run
// from inside the tool's `execute`, and pi's abort waits for the run: the stop settles the question
// as it begins (#376), so this returns, with the one question settled as `aborted` and none open.
test('⚠⚠ Stop while ask_user waits stops the run and leaves no question open (#12)', async () => {
  const { hosted, events, question, settled } = await askedQuestionnaire([DATABASE_QUESTION, CHECKS_QUESTION])
  await hosted.runtime.abort()
  await settled
  expect(hosted.runtime.openDialogs()).toEqual([])
  expect(events.filter((event) => event.kind === 'extension-ui-request' && event.blocking)).toHaveLength(1)
  expect(events.filter((event) => event.kind === 'dialog-settled')).toEqual([
    { kind: 'dialog-settled', id: question.id, outcome: 'aborted' },
  ])
})

// ── a provider's refusal (#340) ──────────────────────────────────────────────

/** The body the Anthropic SDK puts in `errorMessage` for a 429 — pi's providers keep it verbatim. */
const RATE_LIMITED =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}'

// ⚠ Before #340 a refused request reached the feed as its SHAPE only — a `run-ended` that will
// retry, no tokens — and the page read `idle · $0.0000` for two hours. The fact must be on the
// feed: the failed attempt as `provider-refused` (status, provider, model, the provider's own
// message), pi's retry as `provider-retry`, and the reply that follows must still arrive — the
// refusal is said BESIDE the failed message's `message-end`, never instead of it.
test('⚠ a provider refusal is on the feed: the failed attempt, pi’s retry, then the reply that got through (#340)', async () => {
  const core = createFauxCore()
  core.setResponses([
    faux.fauxAssistantMessage('', { stopReason: 'error', errorMessage: RATE_LIMITED }),
    faux.fauxAssistantMessage('hello after the retry'),
  ])
  // Its own agent dir: pi's retry waits `baseDelayMs` first, and one millisecond keeps the suite fast
  // without touching the settings the other tests share.
  const retryAgentDir = scratchAgentDir('enso-host-retry-')
  writeFileSync(join(retryAgentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1 } }))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: retryAgentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxModelExtension(core)],
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  const events = collectEvents(hosted)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.prompt({ message: 'hi' }, { onAccepted: () => undefined, onRejected: settled.reject })
  await settled.promise

  const kinds = events.map((event) => event.kind)
  const refused = events.find((event) => event.kind === 'provider-refused')
  expect(refused).toEqual({
    kind: 'provider-refused',
    provider: 'enso-faux',
    // #387: a provider an extension registered is named by the live session's own catalogue —
    // pi-ai's built-in one does not know it. This one registered no display name, so pi's is its id.
    providerName: 'enso-faux',
    model: 'faux-1',
    status: 429,
    message: RATE_LIMITED,
  })
  expect(events.find((event) => event.kind === 'provider-retry')).toMatchObject({ attempt: 1, delayMs: 1 })
  // in order: the refusal, then pi's retry, then the reply's text (the failed attempt streams an
  // empty delta of its own, which is not the reply)
  const firstText = events.findIndex((event) => event.kind === 'text-delta' && event.delta.length > 0)
  expect(kinds.indexOf('provider-refused')).toBeLessThan(kinds.indexOf('provider-retry'))
  expect(kinds.indexOf('provider-retry')).toBeLessThan(firstText)
  // and the failed message still ended as a message — its accounting role is unchanged
  expect(kinds.slice(0, kinds.indexOf('provider-refused')).at(-1)).toBe('message-end')
  // and pi's end of the retry says it got through (#380 review)
  expect(events.find((event) => event.kind === 'provider-retry-ended')).toEqual({
    kind: 'provider-retry-ended',
    success: true,
    attempt: 1,
  })
  // #381: pi keeps the failed attempt on the branch, and the transcript says it was one — the
  // reload's source, so a resumed thread says the refusal instead of an empty reply
  const replies = hosted
    .inspect()
    .entries.filter((entry) => entry.kind === 'message' && entry.role === 'assistant')
    .map((entry) => (entry.kind === 'message' ? { refusal: entry.refusal, parts: entry.parts } : undefined))
  expect(replies).toEqual([
    {
      refusal: { provider: 'enso-faux', model: 'faux-1', status: 429, message: RATE_LIMITED },
      parts: expect.any(Array),
    },
    { refusal: undefined, parts: [{ type: 'text', text: 'hello after the retry' }] },
  ])
})

/** Anthropic's sentence for a policy stop (`stop_details.explanation`) — pi keeps it as the error message. */
const POLICY_STOP =
  "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy."

// #384: a provider's policy stops a response it had ALREADY begun — HTTP 200, text streamed, then
// `stop_reason: "refusal"` — so the error carries no status, only the provider's own stop reason pi
// keeps, and the attempt spent output of its own. Both must reach the feed: the stop reason is what
// classes it, and the attempt's output is what the page must not mistake for a reply getting through.
test('⚠ a policy stop mid-stream is on the feed with the provider’s stop reason and the output the attempt spent (#384)', async () => {
  const core = createFauxCore()
  const stopped = faux.fauxAssistantMessage('Here is how you would find the AWS credentials on', {
    stopReason: 'error',
    errorMessage: POLICY_STOP,
  }) as { rawStopReason?: string }
  stopped.rawStopReason = 'refusal'
  core.setResponses([stopped])
  const hosted = await hostedSession([fauxModelExtension(core)])
  const events = collectEvents(hosted)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.prompt(
    { message: 'where are the aws credentials' },
    { onAccepted: () => undefined, onRejected: settled.reject },
  )
  await settled.promise

  const refused = events.find((event) => event.kind === 'provider-refused')
  const ended = events.find((event) => event.kind === 'message-end' && event.role === 'assistant')
  if (refused?.kind !== 'provider-refused' || ended?.kind !== 'message-end')
    throw new Error('no refused attempt on the feed')
  expect(refused).toMatchObject({ providerStopReason: 'refusal', message: POLICY_STOP })
  expect(refused.status).toBeUndefined()
  expect(refused.output).toBeGreaterThan(0)
  expect(refused.output).toBe(ended.usage?.output)
  // said BEFORE the turn's usage, which already counts the attempt's output — the page's mark must add it
  const kinds = events.map((event) => event.kind)
  expect(kinds.indexOf('provider-refused')).toBeLessThan(kinds.lastIndexOf('session-usage'))
})

// #380 review: the two-hour case ENDS with pi giving up — and before, the feed's last word was the
// retry, so the page read as if one were still coming. The end must be on the feed, with the error.
test('⚠ a run that runs out of retries ends with pi giving up, and its last error, on the feed', async () => {
  const core = createFauxCore()
  const refused = (): ReturnType<typeof faux.fauxAssistantMessage> =>
    faux.fauxAssistantMessage('', { stopReason: 'error', errorMessage: RATE_LIMITED })
  core.setResponses([refused(), refused()])
  const retryAgentDir = scratchAgentDir('enso-host-retry-')
  writeFileSync(join(retryAgentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1, maxRetries: 1 } }))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: retryAgentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxModelExtension(core)],
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  const events = collectEvents(hosted)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.prompt({ message: 'hi' }, { onAccepted: () => undefined, onRejected: settled.reject })
  await settled.promise

  const kinds = events.map((event) => event.kind).filter((kind) => kind.startsWith('provider-'))
  expect(kinds).toEqual(['provider-refused', 'provider-retry', 'provider-refused', 'provider-retry-ended'])
  expect(events.find((event) => event.kind === 'provider-retry-ended')).toEqual({
    kind: 'provider-retry-ended',
    success: false,
    attempt: 1,
    finalError: RATE_LIMITED,
  })
})

/** pi's extension OAuth config, derived from `registerProvider` itself — no vendor subpath import. */
type FauxOAuthConfig = NonNullable<Parameters<ExtensionAPI['registerProvider']>[1]['oauth']>
type OAuthLoginCallbacks = Parameters<FauxOAuthConfig['login']>[0]
type OAuthCredentials = Awaited<ReturnType<FauxOAuthConfig['login']>>

const LOGIN_PAGE = 'https://login.faux.invalid/oauth/authorize?client_id=enso&state=388'

/**
 * An extension-registered OAuth provider — the path a pi-multi-account slot takes: pi's composer
 * turns `onAuth` into an `auth_url` event and `onManualCodeInput` into its bare "Paste the
 * authorization code" prompt. The login waits for the pasted code, as a callback server would.
 */
const fauxOAuthProvider: InlineExtension = {
  name: 'enso-host-faux-oauth',
  factory: (pi: ExtensionAPI) => {
    pi.registerProvider('faux-oauth', {
      api: 'enso-faux',
      baseUrl: 'http://faux.invalid',
      models: [
        {
          id: 'faux-oauth-1',
          name: 'Faux OAuth One',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 50_000,
          maxTokens: 1000,
        },
      ],
      oauth: {
        name: 'Faux OAuth',
        login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
          callbacks.onAuth({ url: LOGIN_PAGE, instructions: 'A browser window should open. Complete login to finish.' })
          const code = await callbacks.onManualCodeInput?.()
          if (code === undefined) throw new Error('no manual code input')
          return { access: code, refresh: 'refresh', expires: Date.now() + 3_600_000 }
        },
        refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => credentials,
        getApiKey: (credentials: OAuthCredentials): string => credentials.access,
      },
    })
  },
}

// ⚠ #388: a browser login from the web opened nothing, repeated pi's terminal sentence ("A browser
// window should open"), and asked a bare "Paste the authorization code" with the URL somewhere
// else. The line must carry the URL in our words, and the code question must LINK the login page.
test('⚠ a browser login from the web: the URL in our words, and a code question that links the login page (#388)', async () => {
  const loginAgentDir = mkdtempSync(join(tmpdir(), 'enso-host-login-'))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: loginAgentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxOAuthProvider],
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  const events = collectEvents(hosted)
  const asked = untilObservation(hosted, (event) => event.kind === 'extension-ui-request' && event.method === 'input')
  const settled = Promise.withResolvers<void>()
  hosted.runtime.startHostFlow(
    { name: 'login', value: 'faux-oauth/oauth' },
    { onAccepted: (): void => undefined, onRejected: settled.reject, onSettled: settled.resolve },
  )
  await asked

  const [question] = hosted.runtime.openDialogs()
  expect(question?.dialog).toMatchObject({
    method: 'input',
    title: 'Finish logging in to Faux OAuth',
    link: { url: LOGIN_PAGE, label: 'Open login page' },
  })
  const lines = (): string[] =>
    events.flatMap((event) =>
      event.kind === 'extension-ui-request' && event.method === 'notify' && event.message !== undefined
        ? [event.message]
        : [],
    )
  expect(lines()).toContain(`To log in to Faux OAuth, open ${LOGIN_PAGE}`)
  expect(lines().some((line) => line.includes('A browser window should open'))).toBe(false)

  hosted.runtime.answerDialog({ id: question?.id ?? '', value: 'the-code' })
  await settled.promise
  expect(lines().some((line) => line.startsWith('Logged in to Faux OAuth.'))).toBe(true)
})

/**
 * A browser login that finishes BY ITS CALLBACK while its code question is still open — the live
 * case from #389: pi's Codex login races a local callback server against the pasted code, and
 * pi-multi-account's bridge (`index.ts:263-264`) and pi's composer (`provider-composer.js:173`)
 * both drop the prompt's abort signal, so nothing withdraws the question when the callback wins.
 */
const callbackWinsProvider: InlineExtension = {
  name: 'enso-host-faux-oauth-callback',
  factory: (pi: ExtensionAPI) => {
    pi.registerProvider('faux-callback', {
      api: 'enso-faux',
      baseUrl: 'http://faux.invalid',
      models: [
        {
          id: 'faux-callback-1',
          name: 'Faux Callback One',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 50_000,
          maxTokens: 1000,
        },
      ],
      oauth: {
        name: 'Faux Callback',
        login: async (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
          callbacks.onAuth({ url: LOGIN_PAGE })
          // Asked and never awaited: the callback below wins the race, as the browser redirect does.
          void callbacks.onManualCodeInput?.().catch((): undefined => undefined)
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
          return { access: 'from-callback', refresh: 'refresh', expires: Date.now() + 3_600_000 }
        },
        refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => credentials,
        getApiKey: (credentials: OAuthCredentials): string => credentials.access,
      },
    })
  },
}

// ⚠ #389 live: the login finished ("Logged in to …") and its "Finish logging in" card stayed open,
// with the status bar saying a question was waiting. A login's questions end with the login.
test('⚠ a login that finishes by its callback withdraws the code question it left open (#389)', async () => {
  const loginAgentDir = mkdtempSync(join(tmpdir(), 'enso-host-login-callback-'))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: loginAgentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [callbackWinsProvider],
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  const withdrawn = untilObservation(hosted, (event) => event.kind === 'dialog-settled')
  const settled = Promise.withResolvers<void>()
  hosted.runtime.startHostFlow(
    { name: 'login', value: 'faux-callback/oauth' },
    { onAccepted: (): void => undefined, onRejected: settled.reject, onSettled: settled.resolve },
  )
  await settled.promise
  expect(await withdrawn).toMatchObject({ kind: 'dialog-settled', outcome: 'aborted' })
  expect(hosted.runtime.openDialogs()).toEqual([])
})

// #391: the Start-a-session dialog offers the effort of the model CHOSEN in it, before anything is
// applied — so every `/model` option carries that model's levels, decided by pi's own rule
// (`getSupportedThinkingLevels`), not the session's current model's.
test('each /model option carries the levels pi decides for THAT model (#391)', async () => {
  const twoModels: InlineExtension = {
    name: 'enso-host-two-models',
    factory: (pi: ExtensionAPI) => {
      const base = {
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 50_000,
        maxTokens: 1000,
      }
      pi.registerProvider('enso-levels', {
        api: 'enso-faux',
        baseUrl: 'http://faux.invalid',
        apiKey: 'faux',
        models: [
          { ...base, id: 'plain', name: 'Plain', reasoning: false },
          { ...base, id: 'deep', name: 'Deep', reasoning: true },
        ],
      })
    },
  }
  const hosted = await hostedSession([twoModels])
  const modelRow = hosted.runtime
    .listCommands()
    .find((command) => command.source === 'host' && command.name === 'model')
  const levelsOf = (id: string): readonly string[] | undefined =>
    modelRow?.options?.find((option) => option.id === `enso-levels/${id}`)?.thinkingLevels
  expect(levelsOf('plain')).toEqual(['off'])
  const deep = levelsOf('deep') ?? []
  expect(deep).toContain('off')
  expect(deep).toContain('high')
  // `xhigh` is offered only to a model that maps it explicitly — pi's rule, carried as it decides.
  expect(deep).not.toContain('xhigh')
})

// ── the run context and the fork point (#435) ────────────────────────────────

/** Run one prompt on `hosted` and wait for it to settle. */
async function runPrompt(hosted: HostedThread, message: string): Promise<void> {
  const settled = Promise.withResolvers<void>()
  const unsubscribe = hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.prompt({ message }, { onAccepted: () => undefined, onRejected: settled.reject })
  await settled.promise.finally(unsubscribe)
}

/** The `enso-run-context` records on a stored session's branch, oldest first. */
function runContextsOf(file: string): EnsoRunContext[] {
  return SessionManager.open(file)
    .getBranch()
    .flatMap((entry) => {
      const recorded = entry.type === 'custom' ? readEnsoRunContext(entry.customType, entry.data) : undefined
      return recorded === undefined ? [] : [recorded]
    })
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex')

// ⚠ THE ACCEPTANCE (#435): the REAL extension, loaded last from the manifest, under pi's faux
// provider. Two runs with nothing changed write one entry; a changed context file writes a second
// that names the new hash — and neither ever reaches the model.
test('⚠ two runs with nothing changed record one run context; a changed AGENTS.md records a second naming its hash — and the model never sees either (#435)', async () => {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-lineage-project-')))
  const agentsFile = join(project, 'AGENTS.md')
  writeFileSync(agentsFile, 'Use tabs.\n')
  const core = createFauxCore()
  core.setResponses([
    faux.fauxAssistantMessage('one'),
    faux.fauxAssistantMessage('two'),
    faux.fauxAssistantMessage('three'),
  ])
  const requests: unknown[] = []
  const watched: FauxCore = {
    ...core,
    streamSimple: (...call: Parameters<FauxCore['streamSimple']>) => {
      requests.push(call[1])
      return core.streamSimple(...call)
    },
  }
  const host = createAgentHost({
    servesDirectory: (directory) => realpathOrSelf(directory) === project,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxModelExtension(watched)],
  })
  const threadId = crypto.randomUUID()
  const first = await host.createSession(threadId, () => project)
  openSessions.push(first)
  await runPrompt(first, 'first')
  await runPrompt(first, 'second')
  const file = first.inspect().sessionFile
  if (file === null) throw new Error('the session was not flushed after two replies')
  const once = runContextsOf(file)
  expect(once).toHaveLength(1)
  expect(once[0]?.contextFiles).toEqual([{ path: agentsFile, sha256: sha256Of('Use tabs.\n') }])
  expect(once[0]?.git).toBeNull()
  // The policy the engine reads is linked under the agent dir: the mode's rules must yield a hash.
  // A policy the recorder cannot read records `mode: null` instead, and this goes red (#496).
  expect(once[0]?.mode).toEqual({ rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  first.runtime.dispose()

  // pi reads context files when a session is built: the change is seen by the resumed session.
  writeFileSync(agentsFile, 'Use spaces.\n')
  const resumed = await host.createSession(threadId, () => project)
  openSessions.push(resumed)
  await runPrompt(resumed, 'third')
  const twice = runContextsOf(file)
  expect(twice).toHaveLength(2)
  expect(twice[1]?.contextFiles).toEqual([{ path: agentsFile, sha256: sha256Of('Use spaces.\n') }])
  const [firstRecord] = once
  const [, secondRecord] = twice
  if (firstRecord === undefined || secondRecord === undefined) throw new Error('a run context is missing')
  // The tree, as a snapshot (#551): the real extension minted the thread's store under the run's
  // ENSO_HOME — the preload's `<scratch>/enso-home`, which `tmpdir()` names since the preload
  // repointed TMPDIR at the scratch; never the operator's — beside the project's sessions, and the
  // edited AGENTS.md is a new snapshot holding the new text, out of the project's own tree.
  const runHome = join(tmpdir(), 'enso-home')
  const storeDir = join(projectSnapshotsDir(ensoProjectsDir(runHome), projectIdOf(project)), threadId)
  expect(existsSync(join(storeDir, 'HEAD'))).toBe(true)
  expect(firstRecord.snapshot).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{40}$/) })
  expect(secondRecord.snapshot).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{40}$/) })
  expect(secondRecord.snapshot).not.toEqual(firstRecord.snapshot)
  const snapshotEnvironment = { PATH: dirname(Bun.which('git') ?? '/usr/bin/git') }
  expect(
    await snapshotPaths(snapshotEnvironment, { directory: storeDir, tree: project }, secondRecord.snapshot?.hash ?? ''),
  ).toContain('AGENTS.md')
  expect(existsSync(join(project, '.git'))).toBe(false)
  // Nothing else changed: the second record is the first with the new hash and the new snapshot.
  const asFirst: EnsoRunContext = {
    ...secondRecord,
    contextFiles: firstRecord.contextFiles,
    ...(firstRecord.snapshot === undefined ? {} : { snapshot: firstRecord.snapshot }),
  }
  expect(asFirst).toEqual(firstRecord)
  // The live fork point reads the latest.
  expect((await resumed.forkPoint()).conditions.runContext).toEqual(secondRecord)

  // pi's context builder skips custom entries: no request carried the record or its hashes.
  expect(requests).toHaveLength(3)
  const sent = JSON.stringify(requests)
  expect(sent).toContain('Use spaces.')
  expect(sent).not.toContain(ENSO_RUN_CONTEXT_ENTRY)
  expect(sent).not.toContain(sha256Of('Use tabs.\n'))
  expect(sent).not.toContain(sha256Of('Use spaces.\n'))
})

test('⚠ two forks of one thread, one of them run under a changed context file, show fork points that differ outside identity only in that field (#435)', async () => {
  const source = crypto.randomUUID()
  const { file } = storeTurns(source, [
    ['first question', 'first answer'],
    ['second question', 'second answer'],
  ])
  const recorded: EnsoRunContext = {
    git: { revision: 'f00d', dirty: false },
    config: { hash: sha256Of('{}'), sources: [] },
    skills: [{ name: 'tdd', path: '/skills/tdd/SKILL.md' }],
    contextFiles: [{ path: '/repo/AGENTS.md', sha256: sha256Of('v1') }],
    mode: null,
  }
  const opened = SessionManager.open(file)
  opened.appendModelChange('anthropic', 'claude-x')
  opened.appendCustomEntry(ENSO_RUN_CONTEXT_ENTRY, recorded)
  const forkAt = opened.appendMessage({ role: 'user', content: 'third question', timestamp: Date.now() })
  const host = hostWith()
  const plain = await host.forkThread(source, forkAt)
  const changed = await host.forkThread(source, forkAt)
  if (plain.kind !== 'forked' || changed.kind !== 'forked') throw new Error('a fork was refused')
  const changedFile = (await host.listSessions()).find((stored) => stored.id === changed.threadId)?.path ?? ''
  const changedContext = { ...recorded, contextFiles: [{ path: '/repo/AGENTS.md', sha256: sha256Of('v2') }] }
  SessionManager.open(changedFile).appendCustomEntry(ENSO_RUN_CONTEXT_ENTRY, changedContext)

  const plainPoint = await host.readStoredForkPoint(plain.threadId)
  const changedPoint = await host.readStoredForkPoint(changed.threadId)
  if (plainPoint === undefined || changedPoint === undefined) throw new Error('a fork has no fork point')
  expect(plainPoint.identity).toMatchObject({ threadId: plain.threadId, parentThreadId: source })
  expect(changedPoint.identity).toMatchObject({ threadId: changed.threadId, parentThreadId: source })
  expect(plainPoint.conditions).toEqual({
    model: { provider: 'anthropic', modelId: 'claude-x' },
    thinkingLevel: null,
    mode: 'default',
    cwd: repoRoot,
    runContext: recorded,
    systemPrompt: null,
  })
  expect(changedPoint.conditions).toEqual({ ...plainPoint.conditions, runContext: changedContext })
  // PR #439 review: a newest record that does not read (another schema's) is unknown — never the
  // older one presented as current.
  SessionManager.open(changedFile).appendCustomEntry(ENSO_RUN_CONTEXT_ENTRY, { schema: 'next' })
  expect((await host.readStoredForkPoint(changed.threadId))?.conditions.runContext).toBeNull()
  // A thread held nowhere has no fork point; nothing is built to answer.
  expect(await host.readStoredForkPoint('never-stored')).toBeUndefined()
})

// ── Continue on a torn tail (#436) ───────────────────────────────────────────
// ⚠⚠ THESE PIN pi'S PRIVATE RUN LIFECYCLE. `continueRun` calls `AgentSession._runAgentPrompt`
// through one cast (the host's module header): a pi bump that renames or reshapes it — or a raw
// `agent.continue()` in its place, which never settles and leaves `isStreaming` false — goes red here.

/** A stored assistant reply: text, then any tool calls — the shape a killed run leaves on disk. */
function storedReply(text: string, calls: ReadonlyArray<{ id: string; name: string; arguments: object }> = []): never {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }, ...calls.map((call) => ({ type: 'toolCall', ...call }))],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length === 0 ? 'stop' : 'toolUse',
    timestamp: Date.now(),
  } as never
}

/** A cold thread whose last run was cut off as `tail` says: one whole turn, then the torn one. */
function storeTornThread(
  tail: 'unanswered-prompt' | 'tool-call-without-result' | 'tool-results-without-reply' | 'complete',
): {
  threadId: string
  file: string
} {
  const threadId = crypto.randomUUID()
  const { file } = storeTurns(threadId, [['first question', 'first answer']])
  const stored = SessionManager.open(file)
  if (tail === 'complete') return { threadId, file }
  stored.appendMessage({ role: 'user', content: 'second question', timestamp: Date.now() })
  if (tail !== 'unanswered-prompt') {
    stored.appendMessage(
      storedReply('reading it', [{ id: 'call-torn', name: 'read', arguments: { path: 'package.json', limit: 1 } }]),
    )
  }
  if (tail === 'tool-results-without-reply') {
    stored.appendMessage({
      role: 'toolResult',
      toolCallId: 'call-torn',
      toolName: 'read',
      content: [{ type: 'text', text: '{' }],
      isError: false,
      timestamp: Date.now(),
    } as never)
  }
  return { threadId, file }
}

/** What a faux request was sent: each message's role and its text. */
type SentContext = { messages: Array<{ role: string; content: unknown }> }
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('')
}

/** The stored branch of `file` as `role[isError]: text` lines — messages only, tool results included. */
function storedMessages(file: string): string[] {
  return SessionManager.open(file)
    .getBranch()
    .flatMap((entry) => {
      if (entry.type !== 'message') return []
      const { message } = entry
      if (message.role === 'toolResult')
        return [`toolResult${message.isError ? '[isError]' : ''}: ${textOf(message.content)}`]
      if (message.role !== 'user' && message.role !== 'assistant') return []
      return [`${message.role}: ${textOf(message.content)}`]
    })
}

/** A cold thread opened by a fresh host under the faux provider — the rail's resume path. */
async function resumeTorn(threadId: string, core: FauxCore): Promise<HostedThread> {
  const hosted = await hostWith([fauxModelExtension(core)]).createSession(threadId, () => repoRoot)
  openSessions.push(hosted)
  return hosted
}

test('⚠⚠ Continue answers an unanswered prompt from the stored state: one copy of the prompt, one settled after run-ended, and a prompt enqueued mid-run is answered in the same run (#436)', async () => {
  const { threadId, file } = storeTornThread('unanswered-prompt')
  const core = createFauxCore()
  const asked = Promise.withResolvers<SentContext>()
  const gate = Promise.withResolvers<void>()
  core.setResponses([
    async (context: SentContext) => {
      asked.resolve(context)
      await gate.promise
      return faux.fauxAssistantMessage('continued answer')
    },
    faux.fauxAssistantMessage('answer to what was typed'),
  ])
  const hosted = await resumeTorn(threadId, core)
  const seen: EnsoObservation[] = []
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    seen.push(observation)
    if (observation.kind === 'settled') settled.resolve()
  })
  let accepted = false
  hosted.runtime.continueRun({ onAccepted: () => (accepted = true), onRejected: settled.reject })
  expect(accepted).toBe(true)

  // The model sees the stored context exactly: the unanswered prompt last, once, and nothing new.
  const sent = await asked.promise
  const userTexts = sent.messages.filter((message) => message.role === 'user').map((message) => textOf(message.content))
  expect(userTexts).toEqual(['first question', 'second question'])
  // pi's own system messages (instructions, not turns) may trail it; the last TURN is the prompt.
  expect(sent.messages.findLast((message) => message.role !== 'system')?.role).toBe('user')

  // Mid-run the thread is RUNNING to pi: a prompt is queued behind the run, not lost.
  const queued = Promise.withResolvers<void>()
  hosted.runtime.prompt(
    { message: 'typed during continue', admission: 'enqueue' },
    { onAccepted: queued.resolve, onRejected: queued.reject },
  )
  await queued.promise
  gate.resolve()
  await settled.promise
  await nextTick()

  const kinds = seen.map((observation) => observation.kind)
  expect(kinds.filter((kind) => kind === 'settled')).toHaveLength(1)
  expect(kinds.indexOf('settled')).toBeGreaterThan(kinds.lastIndexOf('run-ended'))
  expect(kinds).toContain('run-ended')
  const messages = storedMessages(file)
  expect(messages.filter((line) => line === 'user: second question')).toHaveLength(1)
  expect(messages.slice(-4)).toEqual([
    'user: second question',
    'assistant: continued answer',
    'user: typed during continue',
    'assistant: answer to what was typed',
  ])
})

// ⚠ THE ACCEPTANCE (#445): the REAL recorder under pi's private run lifecycle. A Continue emits no
// `before_agent_start`; pi's `agent_start` still fires for it, and the record written there reads
// git, the config and the mode NOW, and carries the skills and context files from the last record —
// the transcript's sections, which a Continue does not patch. The stored record names a skill no
// loader could produce: re-reading the loader would lose it; carrying the record keeps it.
test('⚠ a continued run records what moved since the torn prompt, carrying its skills and context files (#445)', async () => {
  const { threadId, file } = storeTornThread('unanswered-prompt')
  const stale: EnsoRunContext = {
    git: null,
    config: { hash: sha256Of('the config at the torn prompt'), sources: [] },
    skills: [{ name: 'stored-skill', path: '/skills/stored.md' }],
    contextFiles: [{ path: '/repo/AGENTS.md', sha256: sha256Of('v1') }],
    mode: { rulesHash: sha256Of('the rules at the torn prompt') },
  }
  SessionManager.open(file).appendCustomEntry(ENSO_RUN_CONTEXT_ENTRY, stale)
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('continued answer')])
  const hosted = await resumeTorn(threadId, core)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.continueRun({ onAccepted: () => undefined, onRejected: settled.reject })
  await settled.promise
  await nextTick()

  const records = runContextsOf(file)
  expect(records).toHaveLength(2)
  const [, continued] = records
  // The prompt's facts are the transcript's — the stored record's, unchanged.
  expect(continued?.skills).toEqual(stale.skills)
  expect(continued?.contextFiles).toEqual(stale.contextFiles)
  // The session's facts are read at the Continue: the real policy's rules, not the stale hash.
  expect(continued?.mode).toEqual({ rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  expect(continued?.mode).not.toEqual(stale.mode)
  expect(continued?.config.hash).not.toBe(stale.config.hash)
  expect(storedMessages(file).at(-1)).toBe('assistant: continued answer')
})

test('⚠ Continue closes a tool call left without its result with an error result, then runs on (#436)', async () => {
  const { threadId, file } = storeTornThread('tool-call-without-result')
  const core = createFauxCore()
  const asked = Promise.withResolvers<SentContext>()
  core.setResponses([
    (context: SentContext) => {
      asked.resolve(context)
      return faux.fauxAssistantMessage('continuing after the lost result')
    },
  ])
  const hosted = await resumeTorn(threadId, core)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.continueRun({ onAccepted: () => undefined, onRejected: settled.reject })
  const turns = (await asked.promise).messages.filter((message) => message.role !== 'system')
  expect(turns.at(-1)?.role).toBe('toolResult')
  await settled.promise
  expect(storedMessages(file).slice(-4)).toEqual([
    'user: second question',
    'assistant: reading it',
    `toolResult[isError]: ${LOST_TOOL_RESULT_TEXT}`,
    'assistant: continuing after the lost result',
  ])
})

// PR #442 review: the tail a kill leaves most often on a tool-using turn — the results are stored,
// the reply to them is not. The model is asked with the results last and nothing added.
test('⚠ Continue answers tool results that never got their reply, adding nothing before the model (#436)', async () => {
  const { threadId, file } = storeTornThread('tool-results-without-reply')
  const core = createFauxCore()
  const asked = Promise.withResolvers<SentContext>()
  core.setResponses([
    (context: SentContext) => {
      asked.resolve(context)
      return faux.fauxAssistantMessage('the reply the results were waiting for')
    },
  ])
  const hosted = await resumeTorn(threadId, core)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.subscribe((observation) => {
    if (observation.kind === 'settled') settled.resolve()
  })
  hosted.runtime.continueRun({ onAccepted: () => undefined, onRejected: settled.reject })
  const turns = (await asked.promise).messages.filter((message) => message.role !== 'system')
  expect(turns.at(-1)?.role).toBe('toolResult')
  await settled.promise
  expect(storedMessages(file).slice(-4)).toEqual([
    'user: second question',
    'assistant: reading it',
    'toolResult: {',
    'assistant: the reply the results were waiting for',
  ])
})

test('⚠ a thread that ends on a reply is refused — nothing runs, nothing is written (#436)', async () => {
  const { threadId, file } = storeTornThread('complete')
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('a second answer to nothing')])
  const hosted = await resumeTorn(threadId, core)
  const seen = collectEvents(hosted)
  const before = readFileSync(file, 'utf8')
  const refusals: string[] = []
  hosted.runtime.continueRun({
    onAccepted: () => refusals.push('accepted'),
    onRejected: (reason) => refusals.push(reason),
  })
  await nextTick()
  expect(refusals).toEqual([NOTHING_TO_CONTINUE])
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(seen.filter((observation) => observation.kind === 'turn-start' || observation.kind === 'settled')).toEqual([])
  expect(core.state.callCount).toBe(0)
})

test('Continue on a thread that is running is refused; the run in flight is untouched (#436)', async () => {
  const core = createFauxCore()
  const gate = Promise.withResolvers<void>()
  const asked = Promise.withResolvers<void>()
  core.setResponses([
    async () => {
      asked.resolve()
      await gate.promise
      return faux.fauxAssistantMessage('done')
    },
  ])
  const hosted = await hostedSession([fauxModelExtension(core)])
  const run = runPrompt(hosted, 'hi')
  await asked.promise
  const refusals: string[] = []
  hosted.runtime.continueRun({
    onAccepted: () => refusals.push('accepted'),
    onRejected: (reason) => refusals.push(reason),
  })
  expect(refusals).toEqual(['the thread is running; continue when it settles'])
  gate.resolve()
  await run
})

// ── incidents (#466): a human's resolution, through pi, and what an ended or forked thread keeps.

/** A halted opening, as the guard records one when the risk reaches `incident`. */
function openingOf(incidentId: string): EnsoIncidentOpened {
  return { incidentId, signals: [], halted: true, suspended: ['execute', 'network', 'write'] }
}

/**
 * An inline extension standing in for the guard: its pi appends an opening as the guard would, and
 * it records every resolution the host emits on the channel the guard listens on.
 */
function incidentProbe(): { extension: InlineExtension; open: (incidentId: string) => void; heard: unknown[] } {
  const heard: unknown[] = []
  let api: ExtensionAPI | undefined
  const extension: InlineExtension = {
    name: 'enso-host-incident-probe',
    factory: (pi: ExtensionAPI) => {
      api = pi
      pi.events.on(ENSO_INCIDENT_RESOLVED_CHANNEL, (record) => heard.push(record))
    },
  }
  const open = (incidentId: string): void => {
    if (api === undefined) throw new Error('the incident probe never loaded')
    api.appendEntry(ENSO_INCIDENT_OPENED_ENTRY, openingOf(incidentId))
  }
  return { extension, open, heard }
}

/** The incidents a session file's branch folds to — what a resume, the guard and the snapshot read. */
function storedIncidents(file: string): EnsoSessionIncidents {
  return sessionIncidentsOf(
    SessionManager.open(file)
      .getBranch()
      .flatMap((entry) => (entry.type === 'custom' ? [{ customType: entry.customType, data: entry.data }] : [])),
  )
}

test('⚠⚠ a resolution is recorded through pi — on the branch, on the channel the live guard hears, on the feed the page folds; a superseded or unknown incident is refused (#466)', async () => {
  const probe = incidentProbe()
  const hosted = await hostedSession([probe.extension])
  const seen = collectEvents(hosted)
  probe.open('incident-1')
  const record: EnsoIncidentResolved = {
    incidentId: 'incident-1',
    classification: 'false-positive',
    outcome: 'resume',
    suspended: [],
  }

  expect(hosted.runtime.resolveIncident('incident-1', { classification: 'false-positive', outcome: 'resume' })).toBe(
    undefined,
  )
  expect(probe.heard).toEqual([record])
  const resolvedOnFeed = seen.flatMap((observation) =>
    observation.kind === 'custom-entry' && observation.customType === ENSO_INCIDENT_RESOLVED_ENTRY
      ? [observation.data]
      : [],
  )
  expect(resolvedOnFeed).toEqual([record])
  const branch = sessionIncidentsOf(
    hosted.inspect().entries.flatMap((entry) => (entry.kind === 'custom' ? [entry] : [])),
  )
  expect(branch.incidents.map((incident) => incident.resolutions)).toEqual([[record]])

  probe.open('incident-2')
  const resume = { classification: 'agent-error', outcome: 'resume' } as const
  expect(hosted.runtime.resolveIncident('incident-1', resume)).toBe('a later incident supersedes this one')
  expect(hosted.runtime.resolveIncident('incident-9', resume)).toBe('no such incident on this thread')
  expect(probe.heard).toEqual([record])
})

test('⚠ a thread a resolution ended admits no prompt and no continue — the model is never asked, and a resume refuses the same (#466)', async () => {
  const core = createFauxCore()
  core.setResponses([faux.fauxAssistantMessage('first answer'), faux.fauxAssistantMessage('never sent')])
  const probe = incidentProbe()
  const hosted = await hostedSession([fauxModelExtension(core), probe.extension])
  // One reply first, so the file is written and a resume has something to open.
  await runPrompt(hosted, 'hi')
  probe.open('incident-end')
  expect(
    hosted.runtime.resolveIncident('incident-end', { classification: 'confirmed-bypass', outcome: 'end-thread' }),
  ).toBe(undefined)

  const refusals: string[] = []
  const outcome = { onAccepted: () => refusals.push('accepted'), onRejected: (reason: string) => refusals.push(reason) }
  hosted.runtime.prompt({ message: 'go on' }, outcome)
  hosted.runtime.continueRun(outcome)
  const resumed = await hostWith([fauxModelExtension(createFauxCore())]).createSession(
    hosted.inspect().sessionId,
    () => repoRoot,
  )
  openSessions.push(resumed)
  resumed.runtime.prompt({ message: 'go on after a restart' }, outcome)

  expect(refusals).toHaveLength(3)
  for (const reason of refusals) expect(reason).toContain('incident incident-end')
  expect(core.state.callCount).toBe(1)
})

/**
 * A stored thread of two turns, then `records` appended to its file as custom entries, then a third
 * prompt — so a fork at the second prompt is taken before the records, and one at the third after.
 */
function storedWithRecords(records: ReadonlyArray<readonly [customType: string, data: object]>): {
  threadId: string
  before: string
  after: string
} {
  const threadId = crypto.randomUUID()
  const { file, userEntryIds } = storeTurns(threadId, [
    ['first question', 'first answer'],
    ['second question', 'second answer'],
  ])
  const stored = SessionManager.open(file)
  for (const [customType, data] of records) stored.appendCustomEntry(customType, data)
  const after = stored.appendMessage({ role: 'user', content: 'third question', timestamp: Date.now() })
  return { threadId, before: userEntryIds[1] ?? '', after }
}

/** The fork's session file, by its thread id. */
async function forkFile(host: AgentHost, source: string, entryId: string): Promise<string> {
  const forked = await host.forkThread(source, entryId)
  if (forked.kind !== 'forked') throw new Error(`the fork was refused: ${forked.reason}`)
  const file = (await host.listSessions()).find((stored) => stored.id === forked.threadId)?.path
  if (file === undefined) throw new Error(`the fork ${forked.threadId} is not listed`)
  return file
}

test('⚠ a fork taken BEFORE an open incident inherits it as its own, pointing at the source; one taken after holds the one it copied (#466)', async () => {
  const { threadId, before, after } = storedWithRecords([[ENSO_INCIDENT_OPENED_ENTRY, openingOf('source-incident')]])
  const host = hostWith()

  // At the second prompt: the fork holds turn one only — the source's incident is not on it.
  const inherited = storedIncidents(await forkFile(host, threadId, before))
  const opened = openIncidentOf(inherited)?.opened
  expect(opened).toMatchObject({
    signals: [],
    halted: true,
    suspended: ['execute', 'network', 'write'],
    inheritedFrom: { threadId, incidentId: 'source-incident' },
  })
  expect(opened?.incidentId).not.toBe('source-incident')

  // After it: the fork copied the opening, still open, and gets no second one — the fold would
  // ignore it, but the file would hold a record neither writer meant.
  const copied = SessionManager.open(await forkFile(host, threadId, after))
    .getBranch()
    .flatMap((entry) =>
      entry.type === 'custom' && entry.customType === ENSO_INCIDENT_OPENED_ENTRY ? [entry.data] : [],
    )
  expect(copied).toEqual([openingOf('source-incident')])
})

test('a fork of a thread whose incident was resolved inherits nothing (#466)', async () => {
  const { threadId, before } = storedWithRecords([
    [ENSO_INCIDENT_OPENED_ENTRY, openingOf('settled-incident')],
    [
      ENSO_INCIDENT_RESOLVED_ENTRY,
      { incidentId: 'settled-incident', classification: 'false-positive', outcome: 'resume', suspended: [] },
    ],
  ])
  const forked = storedIncidents(await forkFile(hostWith(), threadId, before))
  expect(forked).toEqual({ incidents: [], suspended: [], ended: false })
})

// ── #443: a library system prompt, through pi's own loader, fixed for the session's life.

const PI_DEFAULT_PREAMBLE_START = 'You are an expert coding assistant operating inside pi'

/** The system head a request carried: pi sends it as the first message, folded into sections. */
function systemHeadOf(request: unknown): { readonly sections: Record<string, string> } {
  const [head] = (request as { messages: Array<{ role: string; sections?: Record<string, string> }> }).messages
  if (head?.role !== 'system' || head.sections === undefined) throw new Error('the request carries no system head')
  return { sections: head.sections }
}

/** A host over a fresh project whose faux model records every request it answers. */
function recordingHost(replies: number): { host: AgentHost; project: string; requests: unknown[] } {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-library-prompt-')))
  const core = createFauxCore()
  core.setResponses(Array.from({ length: replies }, (_, index) => faux.fauxAssistantMessage(`reply ${index + 1}`)))
  const requests: unknown[] = []
  const watched: FauxCore = {
    ...core,
    streamSimple: (...call: Parameters<FauxCore['streamSimple']>) => {
      requests.push(call[1])
      return core.streamSimple(...call)
    },
  }
  const host = createAgentHost({
    servesDirectory: (directory) => realpathOrSelf(directory) === project,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxModelExtension(watched)],
  })
  return { host, project, requests }
}

function choiceOf(mode: EnsoSystemPromptMode, text: string): EnsoSystemPromptChoice {
  return { id: `a-${mode}`, name: `A ${mode} prompt`, mode, sha256: sha256Of(text), text }
}

function systemPromptEntriesOf(file: string): unknown[] {
  return SessionManager.open(file)
    .getBranch()
    .flatMap((entry) => (entry.type === 'custom' && entry.customType === ENSO_SYSTEM_PROMPT_ENTRY ? [entry.data] : []))
}

test("⚠⚠ a system prompt set at start is the first request's preamble in place of pi's, the second request's head is the first's, and a resume keeps it (#443)", async () => {
  const { host, project, requests } = recordingHost(3)
  const choice = choiceOf('system', '# Reviewer\nRead the diff; say what breaks.')
  const threadId = crypto.randomUUID()
  const first = await host.createSession(threadId, () => project)
  openSessions.push(first)
  expect(first.runtime.setSystemPrompt(choice)).toBeUndefined()
  // Choosing what the session already runs is no change and no refusal.
  expect(first.runtime.setSystemPrompt(choice)).toBeUndefined()
  await runPrompt(first, 'one')
  await runPrompt(first, 'two')
  const [one, two] = requests.map(systemHeadOf)
  expect(one?.sections.preamble).toBe(choice.text)
  // pi's own tools, rules and docs are gone with its preamble; what it adds after them stays.
  expect(Object.keys(one?.sections ?? {})).not.toContain('tools')
  expect(one?.sections.cwd).toContain(project)
  expect(JSON.stringify(one)).not.toContain(PI_DEFAULT_PREAMBLE_START)
  // Fixed for the session: the second request's head is the first's, byte for byte.
  expect(two).toEqual(one)
  expect(first.runtime.setSystemPrompt(choiceOf('append', 'other'))).toContain(
    `already sent the system prompt ${choice.name} and keeps it for its whole life`,
  )

  const file = first.inspect().sessionFile
  if (file === null) throw new Error('the session was not flushed after two replies')
  expect(systemPromptEntriesOf(file)).toEqual([choice])
  first.runtime.dispose()

  // The resumed session is built from the log: the same head, and no system message that patches it.
  const resumed = await host.createSession(threadId, () => project)
  openSessions.push(resumed)
  await runPrompt(resumed, 'three')
  expect(systemHeadOf(requests[2])).toEqual(systemHeadOf(requests[0]))
  const systemMessages = SessionManager.open(file)
    .getBranch()
    .filter((entry) => entry.type === 'message' && entry.message.role === 'system')
  expect(systemMessages).toHaveLength(1)
  // The model never sees the record.
  expect(JSON.stringify(requests)).not.toContain(ENSO_SYSTEM_PROMPT_ENTRY)

  // The fork point names it — live, stored, and on a fork, whose branch carries the record — by
  // name and hash, never its text.
  const named = { id: choice.id, name: choice.name, mode: choice.mode, sha256: choice.sha256 }
  expect((await resumed.forkPoint()).conditions.systemPrompt).toEqual(named)
  expect((await host.readStoredForkPoint(threadId))?.conditions.systemPrompt).toEqual(named)
  const second = SessionManager.open(file)
    .getBranch()
    .find(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        JSON.stringify(entry.message.content).includes('two'),
    )
  const fork = await host.forkThread(threadId, second?.id ?? '')
  if (fork.kind !== 'forked') throw new Error(`the fork was refused: ${fork.kind}`)
  expect((await host.readStoredForkPoint(fork.threadId))?.conditions.systemPrompt).toEqual(named)
})

test("an append prompt keeps every pi section and adds its text after them; a session that already sent pi's default refuses one (#443)", async () => {
  const { host, project, requests } = recordingHost(2)
  const appended = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(appended)
  const choice = choiceOf('append', 'Always answer in haiku.')
  // Before the first request a choice may be replaced: the request carries the last one only.
  expect(appended.runtime.setSystemPrompt(choiceOf('system', 'Replaced before it was sent.'))).toBeUndefined()
  expect(appended.runtime.setSystemPrompt(choice)).toBeUndefined()
  await runPrompt(appended, 'one')
  const head = systemHeadOf(requests[0])
  expect(JSON.stringify(head)).not.toContain('Replaced before it was sent.')
  expect(head.sections.preamble?.startsWith(PI_DEFAULT_PREAMBLE_START)).toBe(true)
  expect(Object.keys(head.sections)).toEqual(expect.arrayContaining(['tools', 'rules', 'docs', 'cwd', 'addendum']))
  expect(head.sections.addendum).toBe(`<addendum>\n${choice.text}\n</addendum>`)

  const unchosen = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(unchosen)
  await runPrompt(unchosen, 'one')
  expect(unchosen.runtime.setSystemPrompt(choice)).toContain("already sent pi's default system prompt")
  expect(systemHeadOf(requests[1]).sections.addendum).toBeUndefined()
})

test("⚠ pi's default chosen after a library prompt, before the first request, replaces it — in the request, in the log, and on resume (#443)", async () => {
  const { host, project, requests } = recordingHost(2)
  const threadId = crypto.randomUUID()
  const first = await host.createSession(threadId, () => project)
  openSessions.push(first)
  // A Start that applied a prompt and was refused at a later step, retried with pi's default.
  const choice = choiceOf('system', 'Chosen, then taken back.')
  expect(first.runtime.setSystemPrompt(choice)).toBeUndefined()
  expect(first.runtime.setSystemPrompt(null)).toBeUndefined()
  await runPrompt(first, 'one')
  const head = systemHeadOf(requests[0])
  expect(JSON.stringify(head)).not.toContain(choice.text)
  expect(head.sections.preamble?.startsWith(PI_DEFAULT_PREAMBLE_START)).toBe(true)
  expect(first.runtime.setSystemPrompt(choice)).toContain("already sent pi's default system prompt")

  const file = first.inspect().sessionFile
  if (file === null) throw new Error('the session was not flushed after a reply')
  expect(systemPromptEntriesOf(file)).toEqual([choice, null])
  first.runtime.dispose()

  const resumed = await host.createSession(threadId, () => project)
  openSessions.push(resumed)
  await runPrompt(resumed, 'two')
  expect(systemHeadOf(requests[1])).toEqual(head)
})

test("a thread whose recorded system prompt does not read is refused by name before anything is built, never given pi's default (#443)", async () => {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-library-prompt-')))
  let extensionsLoaded = 0
  const host = createAgentHost({
    servesDirectory: (directory) => realpathOrSelf(directory) === project,
    agentDir,
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [{ name: 'enso-host-load-probe', factory: (): void => void (extensionsLoaded += 1) }],
  })
  const threadId = crypto.randomUUID()
  const manager = SessionManager.create(project, undefined, { id: threadId })
  manager.appendCustomEntry(ENSO_SYSTEM_PROMPT_ENTRY, { id: 'x', mode: 'session' })
  manager.appendMessage({ role: 'user', content: 'hi', timestamp: Date.now() })
  manager.appendMessage(faux.fauxAssistantMessage('hello') as never)
  expect(manager.getSessionFile()).toBeDefined()
  await expect(host.createSession(threadId, () => project)).rejects.toThrow(
    `its ${ENSO_SYSTEM_PROMPT_ENTRY} entry does not read as a system prompt`,
  )
  expect(extensionsLoaded).toBe(0)
})

/** What the Context tab prices a request's system prompt at: every `system:` element, tools included. */
function contextSystemTokens(hosted: HostedThread, request: number): number {
  const detail = hosted.branchRequestDetail(request)
  if (detail === undefined) throw new Error(`the branch has no request ${request}`)
  return detail.elements
    .filter((element) => element.key.startsWith('system:'))
    .reduce((sum, element) => sum + element.tokens, 0)
}

/** A preview on a fresh thread, then its first request made with the same prompt: both halves of the comparison. */
async function previewThenRun(
  candidate: EnsoSystemPromptChoice | null,
): Promise<{ preview: EnsoSystemPromptPreview; contextTotal: number }> {
  const { host, project } = recordingHost(1)
  const hosted = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(hosted)
  const outcome = hosted.previewSystemPrompt(candidate)
  if (outcome.kind !== 'preview') throw new Error(`no preview: ${outcome.kind}`)
  if (candidate !== null && hosted.runtime.setSystemPrompt(candidate) !== undefined) throw new Error('not set')
  await runPrompt(hosted, 'one')
  return { preview: outcome.preview, contextTotal: contextSystemTokens(hosted, 1) }
}

const sectionNames = (preview: EnsoSystemPromptPreview): string[] => preview.sections.map((section) => section.name)

test("⚠⚠ a system prompt's preview totals what the Context tab prices its first request at; the preamble is the library's and pi's tools section is gone (#443)", async () => {
  const candidate = choiceOf('system', "# Reviewer\n\n<tools>\nnot pi's\n</tools>\n\nSay what breaks.")
  const { preview, contextTotal } = await previewThenRun(candidate)
  expect(preview.totalTokens).toBe(contextTotal)
  expect(preview.prompt).toEqual({ id: candidate.id, name: candidate.name, mode: 'system' })
  expect(preview.sections[0]).toMatchObject({ name: 'preamble', origin: 'library', text: candidate.text })
  expect(sectionNames(preview)).not.toContain('tools')
  expect(preview.tools.length).toBeGreaterThan(0)
})

test("⚠ an append prompt's preview totals the same as its first request; every pi section stays and the addendum is the library's (#443)", async () => {
  const { preview, contextTotal } = await previewThenRun(choiceOf('append', 'Always answer in haiku.'))
  expect(preview.totalTokens).toBe(contextTotal)
  expect(preview.sections.find((section) => section.name === 'addendum')).toMatchObject({ origin: 'library' })
  expect(sectionNames(preview)).toEqual(expect.arrayContaining(['preamble', 'tools', 'rules', 'docs', 'cwd']))
})

test("pi's default, previewed, is pi's own rendering — every section pi's — and totals what its first request is priced at (#443)", async () => {
  const { preview, contextTotal } = await previewThenRun(null)
  expect(preview.totalTokens).toBe(contextTotal)
  expect(preview.prompt).toBeNull()
  expect(preview.sections[0]?.text.startsWith(PI_DEFAULT_PREAMBLE_START)).toBe(true)
  expect(preview.sections.map((section) => section.origin)).toEqual(preview.sections.map(() => 'pi'))
})

test("a preview changes nothing: the thread's own prompt is what its request carries, and a preview of another after it still answers (#443)", async () => {
  const { host, project, requests } = recordingHost(1)
  const hosted = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(hosted)
  const own = choiceOf('system', 'Mine.')
  expect(hosted.runtime.setSystemPrompt(own)).toBeUndefined()
  const other = hosted.previewSystemPrompt(choiceOf('system', 'Only previewed.'))
  if (other.kind !== 'preview') throw new Error(`no preview: ${other.kind}`)
  expect(other.preview.sections[0]).toMatchObject({ name: 'preamble', text: 'Only previewed.' })
  await runPrompt(hosted, 'one')
  expect(systemHeadOf(requests[0]).sections.preamble).toBe('Mine.')
  // pi's default, previewed on a thread that runs its own: a preview, not a refusal.
  expect(hosted.previewSystemPrompt(null)).toMatchObject({ kind: 'preview', preview: { prompt: null } })
})

test("the thread's context names the system prompt its branch records — live and from the file (#443)", async () => {
  const { host, project } = recordingHost(1)
  const threadId = crypto.randomUUID()
  const hosted = await host.createSession(threadId, () => project)
  openSessions.push(hosted)
  expect(hosted.branchContext().systemPrompt).toBeNull()
  const choice = choiceOf('append', 'Always answer in haiku.')
  expect(hosted.runtime.setSystemPrompt(choice)).toBeUndefined()
  await runPrompt(hosted, 'one')
  const named = { id: choice.id, name: choice.name, mode: 'append' as const, sha256: choice.sha256 }
  expect(hosted.branchContext().systemPrompt).toEqual(named)
  hosted.runtime.dispose()
  expect((await host.readStoredThreadContext(threadId))?.context.systemPrompt).toEqual(named)
})

// ⚠ #443: the terminal has no Enso host — pi loads the harness package and nothing else. The
// harness's system-prompt extension is what carries a web-started thread's prompt there.
// Both modes: `system` reaches pi as the custom preamble, `append` as the addendum — two paths in pi.
const terminalCases: { mode: EnsoSystemPromptMode; text: string; section: 'preamble' | 'addendum' }[] = [
  { mode: 'system', text: '# Reviewer\nRead the diff; say what breaks.', section: 'preamble' },
  { mode: 'append', text: 'Always answer in haiku.', section: 'addendum' },
]
test.each(terminalCases)(
  '⚠⚠ a thread started with a $mode prompt in the web and resumed by pi alone (the terminal) runs the recorded prompt; the log gains no system message (#443)',
  async ({ mode, text, section }) => {
    const core = createFauxCore()
    core.setResponses([faux.fauxAssistantMessage('one'), faux.fauxAssistantMessage('two')])
    const requests: unknown[] = []
    const watched: FauxCore = {
      ...core,
      streamSimple: (...call: Parameters<FauxCore['streamSimple']>) => {
        requests.push(call[1])
        return core.streamSimple(...call)
      },
    }
    const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-library-prompt-')))
    const host = createAgentHost({
      servesDirectory: (directory) => realpathOrSelf(directory) === project,
      agentDir,
      permissionRulesPath,
      harnessPackageDir: harnessDir,
      extensionFactories: [fauxModelExtension(watched)],
    })
    const threadId = crypto.randomUUID()
    const web = await host.createSession(threadId, () => project)
    const choice = choiceOf(mode, text)
    expect(web.runtime.setSystemPrompt(choice)).toBeUndefined()
    await runPrompt(web, 'one')
    const file = web.inspect().sessionFile
    if (file === null) throw new Error('the web session was not flushed')
    web.runtime.dispose()

    // pi alone, as `scripts/enso.ts` runs it: the harness package, no host, no loader of ours.
    const services = await createAgentSessionServices({
      cwd: project,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        additionalExtensionPaths: [harnessDir],
        extensionFactories: [fauxModelExtension(watched)],
      },
    })
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.open(file) })
    await session.bindExtensions({ mode: 'rpc', onError: () => undefined })
    await session.prompt('two')
    session.dispose()

    const [first, second] = requests.map(systemHeadOf)
    const applied = section === 'preamble' ? choice.text : `<addendum>\n${choice.text}\n</addendum>`
    expect(first?.sections[section]).toBe(applied)
    expect(second).toEqual(first ?? { sections: {} })
    const systemMessages = SessionManager.open(file)
      .getBranch()
      .filter((entry) => entry.type === 'message' && entry.message.role === 'system')
    expect(systemMessages).toHaveLength(1)
  },
)

/**
 * A device-code login (#348): it shows a code, then waits on the provider with no question to
 * cancel — the wait only ever ends on the signal, as a real poll's does when it is aborted. It
 * rejects with a sentence of its own, not pi's "Login cancelled", so the host must know the cancel
 * by its signal.
 */
const fauxDeviceCodeProvider: InlineExtension = {
  name: 'enso-host-faux-device-code',
  factory: (pi: ExtensionAPI) => {
    pi.registerProvider('faux-device', {
      api: 'enso-faux',
      baseUrl: 'http://faux.invalid',
      models: [],
      oauth: {
        name: 'Faux Device',
        login: (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
          callbacks.onDeviceCode({ userCode: 'B599-2E10', verificationUri: 'https://faux.invalid/device' })
          return new Promise((_resolve, reject) => {
            callbacks.signal?.addEventListener('abort', () => reject(new Error('device poll interrupted')))
          })
        },
        refreshToken: async (credentials: OAuthCredentials): Promise<OAuthCredentials> => credentials,
        getApiKey: (credentials: OAuthCredentials): string => credentials.access,
      },
    })
  },
}

// ⚠ #348: a login holds no run lease, so nothing marked the thread as having something to stop,
// and a device-code wait ran until the provider's own expiry. Stop now cancels it: the wait ends,
// the thread says so, nothing is stored, and the `login` observation brackets the wait.
test('⚠ Stop cancels a login waiting on its provider: said as cancelled, nothing stored, the wait bracketed (#348)', async () => {
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: mkdtempSync(join(tmpdir(), 'enso-host-login-cancel-')),
    permissionRulesPath,
    harnessPackageDir: harnessDir,
    extensionFactories: [fauxDeviceCodeProvider],
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => repoRoot)
  openSessions.push(hosted)
  const events = collectEvents(hosted)
  const waiting = untilObservation(hosted, (event) => event.kind === 'login' && event.waiting)
  const settled = Promise.withResolvers<void>()
  hosted.runtime.startHostFlow(
    { name: 'login', value: 'faux-device/oauth' },
    { onAccepted: (): void => undefined, onRejected: settled.reject, onSettled: settled.resolve },
  )
  await waiting
  expect(hosted.runtime.loginInProgress()).toEqual({ provider: 'Faux Device' })

  expect(hosted.runtime.cancelLogin()).toBe(true)
  await settled.promise
  const lines = events.flatMap((event) =>
    event.kind === 'extension-ui-request' && event.method === 'notify' && event.message !== undefined
      ? [event.message]
      : [],
  )
  expect(lines).toContain('Login to Faux Device cancelled.')
  expect(lines.some((line) => line.startsWith('Failed to log in'))).toBe(false)
  expect(events.filter((event) => event.kind === 'login')).toEqual([
    { kind: 'login', provider: 'Faux Device', waiting: true },
    { kind: 'login', provider: 'Faux Device', waiting: false },
  ])
  expect(hosted.runtime.loginInProgress()).toBeUndefined()
  expect(hosted.runtime.cancelLogin()).toBe(false)
  // Nothing stored: `/logout` offers no Faux Device credential.
  const logout = hosted.runtime.listCommands().find((command) => command.name === 'logout')
  expect(logout?.options?.map((option) => option.id) ?? []).not.toContain('faux-device')
})
