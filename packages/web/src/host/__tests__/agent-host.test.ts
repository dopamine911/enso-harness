import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type InlineExtension,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { LogRecorder } from '@logtape/testing/recorder'
import { findRepoRoot, harnessPackageDir, type ZenObservation } from '@zen/core'
import { recordZenLogs, releaseZenLogs } from '@zen/core/log-recorder'
import { type AgentHost, createAgentHost, type HostedThread, seedMultiAccountChildProxyOff } from '../agent-host.ts'
import { readPiccPersistedMode, storedPermissionModeState } from '../permission-mode-adapter.ts'

/**
 * The in-process host against the REAL harness package (#69) — every extension the manifest
 * names loads, and inline probe extensions observe what the host does. No model, no key, no
 * network: nothing here prompts. What is asserted are the spike's receipts, pinned:
 *
 *   - the isolation env is set before the first services (else multi-account reads ~/.pi/agent) —
 *     proven by WHERE multi-account resolved its config, not by reading the env back
 *   - `childProxy: false` is seeded (else the second session in a process hangs under Bun)
 *   - exactly the manifest's five extensions load, with no load errors
 *   - `session_start` fires exactly once per session, and two sessions do not share closures
 *   - a dialog an extension opens reaches a subscriber as an `extension-ui-request` observation and its
 *     answer resolves the extension's promise — the #27 round trip without a wire
 *   - a throwing `session_start` becomes an `extension-error` observation; the host stays usable
 */

const repoRoot = findRepoRoot(import.meta.url)
const harnessDir = harnessPackageDir(repoRoot)
const agentDir = mkdtempSync(join(tmpdir(), 'zen-host-agent-'))
const openSessions: HostedThread[] = []

let logs: LogRecorder
beforeAll(async () => {
  logs = await recordZenLogs()
})
afterAll(async () => {
  for (const hosted of openSessions) hosted.runtime.dispose()
  await releaseZenLogs()
})

/** The five extension path suffixes the harness manifest declares, in load order. */
const MANIFEST_EXTENSION_MARKERS = [
  'extensions/logging/index.ts',
  'extensions/guards/index.ts',
  'extensions/web-fetch/index.ts',
  'extensions/web-search/index.ts',
  'picc-permission-modes/index.ts',
  'pi-multi-account/index.ts',
]

/** Collect every event a session emits, from its first subscriber on (the host replays what came before). */
/** Everything the runtime says to its subscriber — observations, since L2 (#162 workstream 4). */
function collectEvents(hosted: HostedThread): ZenObservation[] {
  const events: ZenObservation[] = []
  hosted.runtime.subscribe((observation) => events.push(observation))
  return events
}

function hostWith(extensionFactories: InlineExtension[] = []): AgentHost {
  return createAgentHost({
    cwd: repoRoot,
    agentDir,
    harnessPackageDir: harnessDir,
    extensionFactories,
  })
}

async function hostedSession(extensionFactories: InlineExtension[] = []): Promise<HostedThread> {
  const hosted = await hostWith(extensionFactories).createSession(crypto.randomUUID())
  openSessions.push(hosted)
  return hosted
}

/**
 * How long an awaited observation may take before the test fails BY NAME. Generous on purpose:
 * the vendor's persistence is a few microtasks on any machine, and the deadline exists so a
 * missing observation is a named failure rather than a stale assertion — not to time it.
 */
const OBSERVATION_DEADLINE_MILLISECONDS = 5000

/** Resolves with the first observation matching `matches`, or rejects at the deadline — never a tick count. */
function untilObservation(hosted: HostedThread, matches: (event: ZenObservation) => boolean): Promise<ZenObservation> {
  const { promise, resolve, reject } = Promise.withResolvers<ZenObservation>()
  const timer = setTimeout(
    () => reject(new Error(`no matching observation within ${OBSERVATION_DEADLINE_MILLISECONDS}ms`)),
    OBSERVATION_DEADLINE_MILLISECONDS,
  )
  const unsubscribe = hosted.runtime.subscribe((observation) => {
    if (!matches(observation)) return
    clearTimeout(timer)
    unsubscribe()
    resolve(observation)
  })
  return promise
}

const nextTick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

test("⚠ childProxy is pinned off in the agent dir's multi-account config, other keys preserved", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'zen-host-seed-'))
  const configPath = join(scratch, 'provider-failover.json')
  // absent → created with just the pin
  seedMultiAccountChildProxyOff(scratch)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ childProxy: false })
  // present with the operator's keys → merged, not clobbered
  writeFileSync(configPath, JSON.stringify({ childProxy: true, showUsage: false, providerOrder: ['anthropic'] }))
  seedMultiAccountChildProxyOff(scratch)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    childProxy: false,
    showUsage: false,
    providerOrder: ['anthropic'],
  })
  // and creating a host seeds it in the host's own agent dir — before any session exists
  const hostAgentDir = mkdtempSync(join(tmpdir(), 'zen-host-seed-at-boot-'))
  createAgentHost({ cwd: repoRoot, agentDir: hostAgentDir, harnessPackageDir: harnessDir })
  expect(existsSync(join(hostAgentDir, 'provider-failover.json'))).toBe(true)
  expect(JSON.parse(readFileSync(join(hostAgentDir, 'provider-failover.json'), 'utf8'))).toEqual({ childProxy: false })
})

// ⚠ #89. pi runs in this process and every `bash` child inherits its environment, so a
// secret still in `process.env` at host creation reaches the model's tools. The host
// quarantines at creation — before any session — and says which names it removed
// (never values). This test plants a secret-shaped variable and checks it is gone.
test('⚠ creating a host removes secret-shaped variables from its environment, naming them, before any session', () => {
  const environment: Record<string, string | undefined> = { PATH: '/usr/bin', PLANTED_API_KEY: 'must-not-survive' }
  logs.clear()
  createAgentHost({
    cwd: repoRoot,
    agentDir: mkdtempSync(join(tmpdir(), 'zen-host-quarantine-')),
    harnessPackageDir: harnessDir,
    environment,
  })
  expect(environment).toEqual({ PATH: '/usr/bin' })
  const notice = logs.find({ rawMessage: /#89/ })
  expect(notice?.properties.removed).toEqual(['PLANTED_API_KEY'])
  // The NAME is the record; the value never was.
  expect(JSON.stringify(notice)).not.toContain('must-not-survive')
})

test("exactly the manifest's five extensions load, in order, with no load errors", async () => {
  const hosted = await hostedSession()
  const loaded = hosted.loadedExtensionPaths
  expect(loaded).toHaveLength(MANIFEST_EXTENSION_MARKERS.length)
  MANIFEST_EXTENSION_MARKERS.forEach((marker, index) => {
    expect(loaded[index]?.endsWith(marker)).toBe(true)
  })
  logs.assertNotLogged({ rawMessage: /failed to load/ })
})

test('⚠ multi-account resolved its config inside the scratch agent dir, not ~/.pi/agent — the env was set first', async () => {
  const hosted = await hostedSession()
  const events = collectEvents(hosted)
  // The startup notify is emitted during session_start — before any subscriber existed —
  // and replayed to the first one. Its text names the config path multi-account resolved.
  const startupNotify = events.find(
    (event) =>
      event.kind === 'extension-ui-request' &&
      event.method === 'notify' &&
      String(event.message).includes('provider-failover.json'),
  )
  expect(startupNotify?.kind === 'extension-ui-request' ? startupNotify.message : undefined).toContain(agentDir)
})

test('⚠ session_start fires exactly once per session, and two sessions do not share an extension instance', async () => {
  let factoryRuns = 0
  const startsPerInstance: number[] = []
  const probe: InlineExtension = {
    name: 'zen-host-probe',
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
    name: 'zen-host-dialog-probe',
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
    name: 'zen-host-cancel-probe',
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
    name: 'zen-host-throwing-probe',
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
  expect(String((error as { extensionPath?: unknown })?.extensionPath)).toContain('zen-host-throwing-probe')
})

// ⚠ THE HOST MUST BE LISTENING WHILE session_start RUNS (#88). Extensions persist state
// during that hook — picc writes its opening `modes` entry there — and pi emits
// `entry_appended` for it to whoever is subscribed AT THAT MOMENT. Subscribing after
// `bindExtensions` returned meant those entries were emitted to nobody: the held-until-
// first-subscriber buffer sits behind the host's subscription, so nothing put them in it.
// Found by the #86 drawer: two `modes` entries on the branch, one `custom-entry` in the browser.
test('⚠ an entry an extension persists during session_start reaches the first subscriber (#88)', async () => {
  const probe: InlineExtension = {
    name: 'zen-host-startup-entry-probe',
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
  const isVendorModeEntry = (event: ZenObservation): boolean =>
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
  const { promise: settled, resolve } = Promise.withResolvers<'accepted' | string>()
  hosted.runtime.setPermissionMode('no-such-mode', { onAccepted: () => resolve('accepted'), onRejected: resolve })
  const outcome = await settled
  expect(outcome).toBe('mode no-such-mode is not one this thread offers')
  await nextTick()
  expect(hosted.runtime.permissionModeState().mode).toBe('default')
  // nothing was prompted: no message boundary, no text, no run
  expect(events.some((event) => event.kind === 'message-start' || event.kind === 'text-delta')).toBe(false)
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
  name: 'zen-host-late-notify-probe',
  factory: (pi: ExtensionAPI) => {
    pi.registerCommand('zen-late-notify', {
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
  const firstSubscriberEvents: ZenObservation[] = []
  const unsubscribeFirst = hosted.runtime.subscribe((observation) => firstSubscriberEvents.push(observation))
  // Startup records were replayed to the first subscriber.
  expect(
    firstSubscriberEvents.some((event) => event.kind === 'extension-ui-request' && event.method === 'notify'),
  ).toBe(true)
  unsubscribeFirst()

  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/zen-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })

  const secondSubscriberEvents: ZenObservation[] = []
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
      { message: '/zen-late-notify' },
      { onAccepted: resolve, onRejected: (reason: string) => reject(new Error(reason)) },
    )
  })
  unsubscribe()
  await new Promise<void>((resolve, reject) => {
    hosted.runtime.prompt(
      { message: '/zen-late-notify' },
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
      { message: '/zen-late-notify' },
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
function storeSession(threadId: string, userText: string, assistantText: string): string {
  hostWith()
  const sessionDir = SessionManager.inMemory(repoRoot).getSessionDir()
  const stored = SessionManager.create(repoRoot, sessionDir, { id: threadId })
  stored.appendMessage({ role: 'user', content: userText, timestamp: Date.now() })
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
  const file = stored.getSessionFile()
  if (file === undefined) throw new Error('pi did not flush the stored session')
  return file
}

test('⚠ createSession(threadId) OPENS the session file already under that id — the branch is the stored one, not a fresh file', async () => {
  const threadId = crypto.randomUUID()
  const file = storeSession(threadId, 'what was I doing?', 'fixing the login bug')
  const host = hostWith()
  const hosted = await host.createSession(threadId)
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
  const hosted = await hostWith().createSession(threadId)
  openSessions.push(hosted)
  expect(hosted.inspect().sessionId).toBe(threadId)
  // Nothing flushed yet (no assistant message): not listed — there is nothing to come back to.
  expect((await hostWith().listSessions()).some((stored) => stored.id === threadId)).toBe(false)
})

test('listSessions names stored sessions newest first with the first user message; readTranscript reads one without building pi', async () => {
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
  })
  const transcript = await host.readTranscript(older)
  expect(transcript?.some((entry) => entry.kind === 'message' && entry.role === 'assistant')).toBe(true)
  expect(await host.readTranscript('never-stored')).toBeUndefined()
})
