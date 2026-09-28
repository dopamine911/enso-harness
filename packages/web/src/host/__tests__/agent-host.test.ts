import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type InlineExtension,
  type SessionEntry,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_TOOL_NAME,
  ENSO_RUN_CONTEXT_ENTRY,
  type EnsoObservation,
  type EnsoRunContext,
  readEnsoRunContext,
} from '@enso/core'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import { findRepoRoot, harnessPackageDir, realpathOrSelf } from '@enso/core/paths'
import type { LogRecorder } from '@logtape/testing/recorder'
import {
  type AgentHost,
  createAgentHost,
  type HostedThread,
  MODEL_WATCH_EXTENSION_PATH,
  SessionDirectoryRefused,
  seedMultiAccountConfig,
  stopRunSettlingDialogs,
} from '../agent-host.ts'
import { LOST_TOOL_RESULT_TEXT, NOTHING_TO_CONTINUE } from '../continuation.ts'
import { readPiccPersistedMode, storedPermissionModeState } from '../permission-mode-adapter.ts'
import { recordedModelOf } from '../transcript.ts'

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
const agentDir = mkdtempSync(join(tmpdir(), 'enso-host-agent-'))
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
  'picc-permission-modes/index.ts',
  'pi-multi-account/index.ts',
  'extensions/ask-user/index.ts',
  'extensions/run-context/index.ts',
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
  createAgentHost({ servesDirectory: servesRepoRoot, agentDir: hostAgentDir, harnessPackageDir: harnessDir })
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

test("exactly the manifest's extensions load, in order, then the host's own model watcher, with no load errors", async () => {
  const hosted = await hostedSession()
  const loaded = hosted.loadedExtensionPaths
  // The last is not the manifest's: it is the host's listener for pi's `model_select`, the
  // only place a model swap is announced (#338 slice 2; `agent-host.ts` header). Listed, not hidden.
  expect(loaded).toHaveLength(MANIFEST_EXTENSION_MARKERS.length + 1)
  MANIFEST_EXTENSION_MARKERS.forEach((marker, index) => {
    expect(loaded[index]?.endsWith(marker)).toBe(true)
  })
  expect(loaded[MANIFEST_EXTENSION_MARKERS.length]).toBe(MODEL_WATCH_EXTENSION_PATH)
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
// during that hook — picc writes its opening `modes` entry there — and pi emits
// `entry_appended` for it to whoever is subscribed AT THAT MOMENT. Subscribing after
// `bindExtensions` returned meant those entries were emitted to nobody: the held-until-
// first-subscriber buffer sits behind the host's subscription, so nothing put them in it.
// Found by the #86 drawer: two `modes` entries on the branch, one `custom-entry` in the browser.
test('⚠ an entry an extension persists during session_start reaches the first subscriber (#88)', async () => {
  const probe: InlineExtension = {
    name: 'enso-host-startup-entry-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', () => {
        pi.appendEntry('probe-startup', { seen: true }) // the same call picc makes for `modes`
      })
    },
  }
  const hosted = await hostedSession([probe])
  const events = collectEvents(hosted)
  const entries = events.flatMap((event) => (event.kind === 'custom-entry' ? [event] : []))
  const probeEntry = entries.find((entry) => entry.customType === 'probe-startup')
  expect(probeEntry?.data).toEqual({ seen: true })
  // And the one that matters in production: picc's opening mode, persisted at session start,
  // is the transcript's first `Mode:` line only if it crosses — it is what #88 was missing.
  const openingMode = entries.find((entry) => entry.customType === 'modes')
  expect(openingMode?.data).toMatchObject({ mode: 'default' })
})

// ⚠ L3 (#162 workstream 4). Above the host no surface reads the vendor's `modes` entry any
// more; the HOST says the mode, as its own event, right after the entry it saw. This is the
// real extension persisting at session_start and the real host answering — the whole
// reason the browser can fold `permission-mode` alone.
test("⚠ the host emits permission-mode after the vendor's modes entry — mode and the modes it registered", async () => {
  const hosted = await hostedSession()
  const events = collectEvents(hosted)
  const isVendorModeEntry = (event: EnsoObservation): boolean =>
    event.kind === 'custom-entry' &&
    readPiccPersistedMode({ customType: event.customType, data: event.data }) !== undefined
  const entryIndex = events.findIndex(isVendorModeEntry)
  expect(entryIndex).toBeGreaterThanOrEqual(0)
  const following = events[entryIndex + 1]
  expect(following).toMatchObject({ kind: 'permission-mode', mode: 'default' })
  const available = following?.kind === 'permission-mode' ? following.available : undefined
  expect(available).toEqual(hosted.runtime.permissionModeState().available)
  expect(available).toContain('default')
  // Another extension's custom entry is not a mode: no permission-mode follows it.
  const probeEntries = events.filter((event) => event.kind === 'custom-entry' && !isVendorModeEntry(event))
  for (const probe of probeEntries) {
    expect(events[events.indexOf(probe) + 1]?.kind).not.toBe('permission-mode')
  }
})

// L3 step C's MECHANISM, at the host and against the real vendor extension: `setPermissionMode`
// runs the vendor's per-mode slash command as a prompt, the extension persists its `modes`
// entry, the host emits `permission-mode`, and `permissionModeState()` moves. Until this test the
// path was exercised only through the fake, which implements `setPermissionMode` itself — the
// one function whose whole job is this seam was executed by no test (#162 exit criteria).
test('⚠ setPermissionMode runs the vendor command: the modes entry, the permission-mode observation and the state all say the new mode', async () => {
  const hosted = await hostedSession()
  const events = collectEvents(hosted)
  expect(hosted.runtime.permissionModeState().mode).toBe('default')
  const { promise: accepted, resolve: onAccepted, reject: onRejected } = Promise.withResolvers<void>()
  // Wait for the OBSERVATION, not a tick count: acceptance is the command's completion, and the
  // vendor's persistence may land any number of turns later.
  const modeChanged = untilObservation(hosted, (event) => event.kind === 'permission-mode' && event.mode === 'plan')
  hosted.runtime.setPermissionMode('plan', {
    onAccepted,
    onRejected: (reason: string): void => onRejected(new Error(reason)),
  })
  await accepted
  const change = await modeChanged
  expect(change).toMatchObject({ kind: 'permission-mode', mode: 'plan' })
  expect(events).toContain(change)
  expect(hosted.runtime.permissionModeState().mode).toBe('plan')
  // The vendor persisted it: a cold read of the transcript agrees with the live state.
  expect(storedPermissionModeState(hosted.inspect().entries).mode).toBe('plan')
})

// ⚠ Found by this test's first run: the runtime treats an unknown slash command as ordinary
// text, so `setPermissionMode('no-such-mode')` was ACCEPTED and would have gone to the model
// as the chat message "/no-such-mode". The route refuses earlier (422, `changeThreadMode`);
// the host now refuses too, so the seam cannot be misused from any caller.
test('setPermissionMode with a mode the vendor registers no command for is rejected at the host, never prompted', async () => {
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

test('⚠ through the runtime, the real guards refuse a write outside the workspace with their reason; a read inside passes', async () => {
  const hosted = await hostedSession()
  const refused = await hosted.probeToolCall('write', { path: '/etc/passwd', content: 'x' })
  expect(refused).toMatchObject({ block: true })
  expect(refused?.reason).toContain('/etc/passwd')
  const passed = await hosted.probeToolCall('read', { path: 'package.json' })
  expect(passed).toBeUndefined()
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
  const hosted = await hostedSession([laterExtension])
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
test("⚠ Stop stops: the run's abort settles a pending dialog as `aborted` — the card drops, the extension resumes with its cancel value", async () => {
  let outcome: unknown = 'unsettled'
  const probe: InlineExtension = {
    name: 'enso-host-abort-dialog-probe',
    factory: (pi: ExtensionAPI) => {
      pi.on('session_start', (_event, extensionContext) => {
        void extensionContext.ui.confirm('Still here?', 'after an abort').then((answer) => {
          outcome = answer
        })
      })
    },
  }
  const hosted = await hostedSession([probe])
  const events = collectEvents(hosted)
  const openBefore = hosted.runtime.openDialogs()
  expect(openBefore).toHaveLength(1)
  const dialogId = openBefore[0]?.id ?? ''
  const settled = untilObservation(hosted, (event) => event.kind === 'dialog-settled')
  await hosted.runtime.abort()
  expect(await settled).toEqual({ kind: 'dialog-settled', id: dialogId, outcome: 'aborted' })
  expect(hosted.runtime.openDialogs()).toHaveLength(0)
  // confirm's cancel value is `false`: the extension resumed and was told no
  expect(outcome).toBe(false)
  expect(events.filter((event) => event.kind === 'dialog-settled')).toHaveLength(1)
  // an answer arriving after the abort is the "already settled" path: reported, not thrown, nothing moves
  hosted.runtime.answerDialog({ id: dialogId, confirmed: true })
  await nextTick()
  expect(outcome).toBe(false)
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

test("listCommands is synchronous and names picc's /mode", async () => {
  const hosted = await hostedSession()
  const commands = hosted.runtime.listCommands()
  expect(commands.some((command) => command.name === 'mode' && command.source === 'extension')).toBe(true)
})

function noopListener(): void {
  // A subscriber that only exists so the host has one: the tail records the delivery, not this.
}

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
test("⚠ the emitted tail records each event's provenance: held at startup, replayed to the first subscriber, live, dropped (#97)", async () => {
  const hosted = await hostedSession([lateNotifyProbe])
  const atStartup = hosted.emittedEvents()
  // Before anyone subscribes every startup record is `held` — picc's `modes` entry among them.
  expect(atStartup.length).toBeGreaterThan(0)
  expect(atStartup.every((event) => event.provenance === 'held')).toBe(true)
  expect(atStartup.some((event) => event.type === 'custom-entry' && event.name === 'modes')).toBe(true)

  const unsubscribe = hosted.runtime.subscribe(noopListener)
  // The replay is recorded as it happens, in the held order, after the held rows.
  const afterSubscribe = hosted.emittedEvents()
  const heldModes = afterSubscribe.find((event) => event.provenance === 'held' && event.name === 'modes')
  const replayedModes = afterSubscribe.find((event) => event.provenance === 'replayed' && event.name === 'modes')
  expect(heldModes).toBeDefined()
  expect(replayedModes).toBeDefined()
  expect((replayedModes?.sequence ?? 0) > (heldModes?.sequence ?? 0)).toBe(true)
  // Every held event is replayed exactly once: the two provenances carry the same total.
  const totalOf = (provenance: string): number =>
    afterSubscribe.filter((event) => event.provenance === provenance).reduce((total, event) => total + event.count, 0)
  expect(totalOf('replayed')).toBe(totalOf('held'))

  // With a subscriber attached the command's notify is `live`; with none, `dropped`.
  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/enso-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })
  unsubscribe()
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
  expect(notifies).toEqual(['live', 'dropped'])
})

// #96's source tag: the subscriber is TOLD which events are a replay of the session's own
// start. multi-account's two startup notices arrive `replayed`; a notice the same extension
// emits during a run arrives `live`. This is what lets the browser group the first without
// guessing from position — and the guess would have swallowed a run's early refusal.
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

/** A stored session of whole turns, each a user message and pi's reply — its file, and each turn's user entry id. */
function storeTurns(
  threadId: string,
  turns: ReadonlyArray<readonly [string, string]>,
  directory = repoRoot,
): { file: string; userEntryIds: string[] } {
  hostWith()
  const sessionDir = SessionManager.inMemory(directory).getSessionDir()
  const stored = SessionManager.create(directory, sessionDir, { id: threadId })
  const userEntryIds = turns.map(([userText, assistantText]) => {
    const userEntryId = stored.appendMessage({ role: 'user', content: userText, timestamp: Date.now() })
    stored.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
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
      stopReason: 'stop',
      timestamp: Date.now(),
    } as never)
    return userEntryId
  })
  const file = stored.getSessionFile()
  if (file === undefined) throw new Error('pi did not flush the stored session')
  return { file, userEntryIds }
}

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

test('createSession(threadId) with no file under that id CREATES the session under it, so the file it flushes is found next time', async () => {
  const threadId = crypto.randomUUID()
  const hosted = await hostWith().createSession(threadId, () => repoRoot)
  openSessions.push(hosted)
  expect(hosted.inspect().sessionId).toBe(threadId)
  // Nothing flushed yet (no assistant message): not listed — there is nothing to come back to.
  expect((await hostWith().listSessions()).some((stored) => stored.id === threadId)).toBe(false)
})

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
  fauxToolCall(name: string, arguments_: Record<string, unknown>): unknown
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
  return { hosted, events, question, settled: settled.promise }
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
  const { hosted, events, question, settled } = await askedQuestionnaire([DATABASE_QUESTION, CHECKS_QUESTION])
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
})

// The card's Cancel is a real decline for every kind of question — the multi-choice one included,
// which the adopted vendor could only read as "none of these" (#376 review).
test('a declined ask_user questionnaire reaches the model as a decline, and the run settles (#12)', async () => {
  const { hosted, events, question, settled } = await askedQuestionnaire([CHECKS_QUESTION])
  hosted.runtime.answerDialog({ id: question.id, cancelled: true })
  await settled
  expect(askUserText(events)).toBe('The user declined to answer and chose nothing.')
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
  const retryAgentDir = mkdtempSync(join(tmpdir(), 'enso-host-retry-'))
  writeFileSync(join(retryAgentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1 } }))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: retryAgentDir,
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
  const retryAgentDir = mkdtempSync(join(tmpdir(), 'enso-host-retry-'))
  writeFileSync(join(retryAgentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1, maxRetries: 1 } }))
  const host = createAgentHost({
    servesDirectory: servesRepoRoot,
    agentDir: retryAgentDir,
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
  // The real picc is loaded: its `modes` entry must yield a rules hash. A picc that renamed its
  // persisted rule fields records `mode: null` instead, and this goes red (PR #440 review).
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
  // Nothing else changed: the second record is the first with the new hash.
  expect({ ...secondRecord, contextFiles: firstRecord.contextFiles }).toEqual(firstRecord)
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
  expect(sent.messages.filter((message) => message.role !== 'system').at(-1)?.role).toBe('user')

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
