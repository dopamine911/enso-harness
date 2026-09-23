import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionError,
  type InlineExtension,
  initTheme,
  VERSION as PI_VERSION,
  type PromptOptions,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import {
  type DialogAnswer,
  type EnsoHostCommandRun,
  type EnsoModelState,
  type EnsoObservation,
  type EnsoOpenDialog,
  type EnsoPermissionModeState,
  type EnsoPromptAdmission,
  type EnsoSessionUsage,
  type EnsoThreadEvent,
  type EnsoTranscriptEntry,
  ensoLogger,
  type HostFlowOutcome,
  type PromptOutcome,
  type PromptRequest,
  type RuntimeCommand,
  type ThreadRuntime,
} from '@enso/core'
import { findRepoRoot } from '@enso/core/paths'
import { quarantineSecrets } from '@enso/core/secrets'
import { type BranchStats, branchStats } from './branch-stats.ts'
import { createEventTail, describeObservation } from './event-tail.ts'
import { createEnsoExtensionUiContext } from './extension-ui-context.ts'
import { decideHostCommand, HostCommandRefused, hostCommandRows } from './host-commands.ts'
import {
  authEventText,
  compactDoneText,
  decideHostFlow,
  FlowCancelled,
  type HostAuthEvent,
  type HostAuthType,
  hostFlowRows,
  isCompactionRefusal,
  isFlowCancelled,
  type LoginProviderFacts,
  loginDoneText,
  loginOptions,
  logoutDoneText,
  logoutOptions,
  type StoredCredentialFacts,
} from './host-flows.ts'
import { mapPiEvent } from './map-events.ts'
import {
  freshPermissionModeState,
  PICC_PERMISSION_MODES,
  persistedPermissionMode,
  piccModeCommand,
  readPiccPersistedMode,
  storedPermissionModeState,
} from './permission-mode-adapter.ts'
import type { RuntimeEvent } from './runtime-event.ts'
import { toRpcWireEvent } from './session-events.ts'
import { growsSessionSpend, liveSessionUsage, storedSessionUsage } from './session-usage.ts'
import { transcriptOf } from './transcript.ts'

const log = ensoLogger('host')

/**
 * pi, hosted IN THIS PROCESS (#69) — the web server's replacement for spawning
 * `pi --mode rpc` per prompt.
 *
 * pi's own rpc docs: "If you're building a Node.js application, consider using
 * `AgentSession` directly … instead of spawning a subprocess." This module is that: one
 * `createAgentSessionServices` + `createAgentSessionFromServices` per hosted session, the
 * harness package loaded through the SAME loader path the CLI's `-e <dir>` uses, and our
 * `ExtensionUIContext` bound so dialogs reach the browser (#27) and picc's `hasUI` is true.
 *
 * ⚠⚠ ONE SERVICES OBJECT PER SESSION, NEVER SHARED. Spike receipt (2026-09-05, #69): two
 * sessions created from ONE services object share their extension INSTANCES — the probe
 * factory ran once and that single closure received `session_start` twice. Shared closures
 * mean thread A's read tracker authorises thread B's writes and A's `/mode` applies to B.
 * Two services objects gave two instances. So a services object is created per session and
 * never reused, whatever it costs in reload time (~10ms warm; the first load pays ~700ms).
 *
 * ⚠⚠ `PI_CODING_AGENT_DIR` MUST BE SET BEFORE THE FIRST SERVICES. pi-multi-account reads it
 * at MODULE IMPORT (`index.ts:752`) and derives `auth.json`, `settings.json`, `models.json`
 * from it. Spike receipt: unset, it read the operator's REAL `~/.pi/agent` — two real
 * accounts, real credentials — the exact isolation defect the first live run had (see
 * `server/index.ts`'s history). Set on `process.env` here, once, at host creation.
 *
 * ⚠⚠ `childProxy: false` IS SEEDED INTO THE AGENT DIR'S `provider-failover.json`. Spike
 * receipt: with the default `childProxy: true`, the SECOND session in one process hangs in
 * `session_start` forever — multi-account binds a fixed loopback port (41977), the second
 * instance hits EADDRINUSE, and its fallback `server.listen(0)` relies on a `listening`
 * listener that Bun (unlike Node 24) does not re-fire after an error. The proxy exists so
 * processes spawned WITHOUT the extension can ride the rotation's account; this server
 * spawns none. Read-merge-write: multi-account writes its defaults only when the file is
 * absent, and its user-facing commands read-merge-write the same file.
 *
 * ⚠⚠ EVERY THREAD IS A MULTI-ACCOUNT ROOT: THE HOST HOLDS ITS LEASE SLOT EMPTY (#351).
 * pi-multi-account ≥1.22 keeps ONE root session per process — `globalThis[Symbol.for('pi-multi-
 * account:active-root-session')]`, taken at `session_start`, released at `session_shutdown` —
 * and a session that starts while it is held goes passive for its WHOLE life (the flag is never
 * reset): accounts register, automatic failover is off. Built upstream for in-process subagents.
 * Here every thread is a session in this one process and an idle one stays live for 30 minutes
 * (`thread-registry.ts`), so the thread in use was usually the passive one. At host creation the
 * slot becomes an accessor that always reads `undefined` and ignores writes
 * (`holdMultiAccountLeaseEmpty`), so every `session_start` finds no root and becomes one — 1.21's
 * behaviour, including what 1.21 already did: concurrent roots write the same `auth.json` and
 * state file. Installed ONCE rather than cleared per session: a per-session delete raced at
 * microtask granularity — `session_start` handlers are awaited in turn, so a second thread's
 * build could interleave between one thread's delete and its acquire. The release cannot remove
 * the accessor: it deletes only when the slot holds its own owner (`index.ts:11361`), which the
 * getter never returns. Coupled to an upstream private symbol until Sarrius/pi-multi-account#73
 * ships a switch; `__tests__/agent-host.test.ts` goes red on a rename (a concurrent thread would
 * start passive again).
 *
 * ⚠ `bindExtensions` IS CALLED EXACTLY ONCE PER SESSION. Every call emits `session_start`
 * (the guards reset their read tracker on it; multi-account resets thirteen failover
 * guards). Without the call, `session_start` never fires and `ctx.hasUI` is false.
 *
 * ⚠⚠ SECRETS ARE QUARANTINED AT HOST CREATION, before the first session (#89). pi runs in
 * this process and every `bash` child inherits this process's environment, which bun's
 * `.env` autoload had filled with `TAVILY_API_KEY`; `bash env` printed it into a
 * transcript. `quarantineSecrets` deletes every secret-shaped name and every name the
 * secrets file defines. The extensions that need a key read `.enso/secrets.env` directly
 * (`readSecret`) — see `@enso/core`'s secrets.ts for why the root `.env` is the wrong place.
 *
 * ⚠ THE HOST LOADS ONE EXTENSION OF ITS OWN, `<inline:enso-model-watch>` (#338 slice 2), because
 * an extension is the only honest listener for a model change. pi 0.87.1 announces a model
 * switch to extensions ALONE: `AgentSession.setModel` (`dist/core/agent-session.js:1645`)
 * writes the `model_change` entry through `sessionManager.appendModelChange` (:1652) with no
 * session event — `entry_appended` is emitted for custom entries from the extension API's
 * `appendEntry` (:2419), for boundary drafts (:487) and for context edits (:680), never for a
 * model change — and then `_emitModelSelect` (:1661) puts `model_select` on the EXTENSION
 * runner. The thinking level is the other way round: `setThinkingLevel` (:1751) emits
 * `thinking_level_changed` on the session stream (:1763). The host hears each
 * where it is said, re-reads `modelState()` and emits its own `model` event once per change —
 * so a failover swap by pi-multi-account (`pi.setModel`, `index.ts:4031`) reaches the feed the
 * same way a `/model` from the palette does. The watcher registers nothing else and is listed in
 * `loadedExtensionPaths` like every extension pi loaded.
 */

/** The agent dir's multi-account config file, and the one key this host must pin in it. */
const MULTI_ACCOUNT_CONFIG_FILENAME = 'provider-failover.json'
const MULTI_ACCOUNT_CHILD_PROXY_KEY = 'childProxy'
/** pi-multi-account's per-process root lease — held empty from host creation (module header). */
const MULTI_ACCOUNT_ROOT_LEASE = Symbol.for('pi-multi-account:active-root-session')

/**
 * The host's own extension (see the module header): named so `loadedExtensionPaths` says what
 * it is, and exported so the load receipt's pin can name it beside the manifest's entries.
 */
const MODEL_WATCH_EXTENSION_NAME = 'enso-model-watch'
export const MODEL_WATCH_EXTENSION_PATH = `<inline:${MODEL_WATCH_EXTENSION_NAME}>`

/**
 * pi's stand-in when no model could be chosen — `@earendil-works/pi-agent-core`
 * `dist/agent.js:18` `DEFAULT_MODEL`, substituted by `createMutableAgentState` (:40) so
 * `AgentSession.model` is typed optional but never is. Every model pi actually selects
 * (`findInitialModel` in `dist/core/sdk.js:99`, `setModel`) is a registered, authenticated one;
 * the placeholder means "none", and the seam says `null` for it (#338 slice 2).
 */
const PLACEHOLDER_MODEL = { provider: 'unknown', id: 'unknown' }

/** pi's `InputSource` for prompts that arrive over a wire rather than a keyboard. */
const PROMPT_SOURCE_RPC = 'rpc'

/**
 * Enso's admission word → pi's `streamingBehavior` literal (#216). THE ONLY PLACE the vendor's
 * spelling is produced on the prompt path: the wire, the route, the registry and the browser
 * all speak `interrupt`/`enqueue`, and a runtime that names its two differently is this table
 * and nothing else. A third admission is a literal in `@enso/core` and a row here.
 *
 * ⚠ The value type is pi's own (`PromptOptions['streamingBehavior']`), never restated: pi
 * renaming or widening its literals is then a compile error in this table, which is the one
 * place that should care.
 */
const STREAMING_BEHAVIOR_OF: Record<EnsoPromptAdmission, NonNullable<PromptOptions['streamingBehavior']>> = {
  interrupt: 'steer',
  enqueue: 'followUp',
}

/** The `ExtensionMode` we bind — `ctx.mode` as extensions see it. rpc is the truthful one: no terminal, a remote surface. */
const EXTENSION_MODE_RPC = 'rpc'

export interface AgentHostOptions {
  /** The tree pi reads and writes. One per server, never from a request (see `server/index.ts`). */
  cwd: string
  /** Scratch config dir — the operator's own packages and credentials stay invisible. */
  agentDir: string
  /** The enso harness pi package directory; loaded as the ONLY extension source. */
  harnessPackageDir: string
  /**
   * The environment the secrets quarantine (#89) scrubs — `process.env` in production, the
   * one pi and every `bash` child inherit. A seam so the quarantine is testable without a
   * test ever touching `process.env` (the repo's rule for tests). The agent-dir pin is not
   * on this seam: it is a process fact pi-multi-account reads at import.
   */
  environment?: Record<string, string | undefined>
  /**
   * Test seam: inline extensions loaded BESIDE the harness. A test can register a probe that
   * asks a dialog on `session_start`, or throws there, and observe what the host does — with
   * no model, no key, no network. Never set in production.
   */
  extensionFactories?: readonly InlineExtension[]
}

/**
 * What pi's session for one hosted thread actually contains, read straight off the
 * `SessionManager` (#86).
 *
 * Everything a run shows the browser is derived from the event stream; this is the source those
 * views derive from, for a human or an agent to cross-check against.
 */
export interface HostedThreadInspection {
  readonly sessionId: string
  readonly cwd: string
  readonly sessionDir: string
  /** The session file once pi has flushed it; null while the session lives only in memory. */
  readonly sessionFile: string | null
  /** The branch, root to leaf, as the transcript of ours (L2): the runtime's entry shapes stay in `transcript.ts`. */
  readonly entries: readonly EnsoTranscriptEntry[]
  /** Slash commands this session registers. */
  readonly commands: readonly string[]
}

export interface HostedThread {
  readonly runtime: ThreadRuntime
  /** How many extensions the loader found — the load receipt a caller may assert. */
  readonly loadedExtensionPaths: readonly string[]
  /**
   * Read-only view of the session as pi holds it. Deliberately here and NOT on
   * `ThreadRuntime`: that is the run contract, pinned by the one fake and the refusal-path
   * tests, and inspection is a host concern.
   */
  inspect(): HostedThreadInspection
  /** The emitted tail (#97): what the host's `emit` funnel saw, with provenance. A fresh copy per call. */
  emittedEvents(): EnsoThreadEvent[]
  /** The branch analysed (#45 phase 2): per request, per turn, per tool, off pi's own entries. */
  branchStats(): BranchStats
  /**
   * What the loaded extensions would say about a tool call, through the runtime's own hook
   * runner — the verdict a model's call would meet, without a model. Inspection, like the
   * rest of this interface: the guards' contract is pinned in their own suite against a
   * hand-built ExtensionAPI; this is the one place the REAL runner, the real load order and
   * the real participants are asked together (docs/flows/guarded-tool-call.md, stated gap).
   * Runs no tool: a pass here is the hook's silence, not an execution.
   */
  probeToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallVerdict | undefined>
}

/** A refusal from the `tool_call` hook, as the runtime's runner returns it — nothing when every handler passed. */
export interface ToolCallVerdict {
  readonly block: boolean
  readonly reason: string | undefined
}

/** One of pi's session files for this workspace, as pi lists it (#95). */
export interface StoredThread {
  /** pi's session id — the thread id it was created under. */
  readonly id: string
  readonly path: string
  readonly modified: Date
  readonly messageCount: number
  /** The first user message, verbatim; empty for a session with none. */
  readonly firstMessage: string
}

/**
 * Stop: the runtime FIRST, so its loop holds the abort signal when a blocked `tool_call`
 * handler returns — then every pending question settles as `aborted`, and the handler DOES
 * return.
 *
 * Before this, Stop during a permission question waited on the card: the loop awaited the
 * handler, the handler awaited the human. If the user says stop, it's stop (Daniel,
 * 2026-09-16); the card drops, the run ends.
 *
 * A stop must stop (thread-registry.test.ts's rule, one layer down): the dialogs settle even
 * if the runtime's abort rejects — the rejection still propagates, the cards still drop.
 * Exported so that path is pinned against a stop that rejects, which the real runtime's is
 * not made to do.
 */
export async function stopRunThenSettleDialogs(
  stopRuntime: () => Promise<void>,
  settleDialogs: () => void,
): Promise<void> {
  try {
    await stopRuntime()
  } finally {
    settleDialogs()
  }
}

export interface AgentHost {
  /**
   * A session for this thread, with its own services, extensions bound, events flowing.
   *
   * ⚠ THE THREAD ID IS PI'S SESSION ID (#95). A session file already under that id is
   * OPENED — the thread idled out, or the server restarted, and the user came back;
   * otherwise a fresh session is CREATED with the id. So resume needs no id mapping and
   * no index file: pi's own listing is the one source, and a page-owned thread finds its
   * own file again across a server restart.
   */
  createSession(threadId: string): Promise<HostedThread>
  /** The tree every session this host builds runs in — the launch argument, one per server (`server/index.ts`). */
  readonly cwd: string
  /** pi's session files for this workspace, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * A stored session, read-only — no pi session is built, nothing is written (#86's rule:
   * looking must not build): its branch as the transcript of ours, and pi's totals over the
   * whole file (#45). `undefined` when no file has that id.
   */
  readStoredThread(threadId: string): Promise<StoredThreadRead | undefined>
  /**
   * A stored thread analysed (#45 phase 2) — pi's totals over the whole file and the branch's
   * per-turn stats, from one open, building nothing (#86). `undefined` when no file has that id.
   */
  readStoredThreadStats(threadId: string): Promise<StoredThreadStats | undefined>
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): EnsoPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState
}

/** One stored session as `readStoredThread` reads it — both halves from one open of the file. */
export interface StoredThreadRead {
  /** The branch, root to leaf. */
  readonly transcript: EnsoTranscriptEntry[]
  /** Every usage in the file, on every branch, by pi's rule (`session-usage.ts`); no context. */
  readonly usage: EnsoSessionUsage
}

/** A stored thread as `readStoredThreadStats` reads it. */
export interface StoredThreadStats {
  readonly usage: EnsoSessionUsage
  readonly branch: BranchStats
}

/**
 * The agent runtime this build is bound to, by version.
 *
 * The ONE place outside this host that needs pi's version is the log bundle's `about` (#132),
 * and it takes this string rather than the import — the vendor gate (#145) keeps the import
 * inside `host/`.
 */
export const AGENT_RUNTIME_VERSION: string = PI_VERSION

/**
 * Pin `childProxy: false` in the agent dir's multi-account config — see the module header.
 *
 * Creates the file if absent; otherwise reads, sets the one key, writes. Any other key the
 * operator set is preserved verbatim.
 */
export function seedMultiAccountChildProxyOff(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })
  const configPath = join(agentDir, MULTI_ACCOUNT_CONFIG_FILENAME)
  let existing: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  }
  if (existing[MULTI_ACCOUNT_CHILD_PROXY_KEY] === false) return
  writeFileSync(configPath, `${JSON.stringify({ ...existing, [MULTI_ACCOUNT_CHILD_PROXY_KEY]: false }, null, '\t')}\n`)
}

/**
 * Make multi-account's root-lease slot a permanent vacancy — see the module header. Idempotent:
 * `configurable`, so a second host in the process redefines it to the same thing.
 */
function holdMultiAccountLeaseEmpty(): void {
  Object.defineProperty(globalThis, MULTI_ACCOUNT_ROOT_LEASE, {
    configurable: true,
    get: (): undefined => undefined,
    set: (): void => undefined,
  })
}

/** `RuntimeCommand` with `description` present only when pi supplied one (`exactOptionalPropertyTypes`). */
function describeCommand(
  name: string,
  source: RuntimeCommand['source'],
  description: string | undefined,
): RuntimeCommand {
  return description === undefined ? { name, source } : { name, source, description }
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { cwd, agentDir, harnessPackageDir } = options

  // Order matters, and it is the module header's ⚠⚠ items: env before any pi module can
  // be imported by the loader, the proxy pin and the empty lease slot before the first
  // session_start, and the secrets out of the environment before anything can inherit it (#89).
  process.env.PI_CODING_AGENT_DIR = agentDir
  seedMultiAccountChildProxyOff(agentDir)
  holdMultiAccountLeaseEmpty()
  // The secrets file is a fact about THIS checkout (the harness), not about the tree pi
  // operates on — `cwd` may be anywhere, a tmpdir in tests — so it resolves from here.
  const quarantine = quarantineSecrets(options.environment ?? process.env, findRepoRoot(import.meta.url))
  if (quarantine.removed.length > 0) {
    log.info('secrets kept out of the tool environment (#89): {removed}', { removed: quarantine.removed })
  }
  if (quarantine.misplaced.length > 0) {
    log.warn(
      'the root .env defines {misplaced} — bun autoloads .env into every bun child, so a tool can still read it there. Move it to .enso/secrets.env (#89); it is not read from .env',
      { misplaced: quarantine.misplaced },
    )
  }
  // The theme registry pi's UI code consults; harmless without a terminal, required once.
  initTheme()

  /**
   * pi's listing, through its API — never a directory scan: the file naming is pi's to
   * change, and `list` reads each file's header for the id. Cost is one parse per file,
   * paid per call; a workspace with dozens of sessions is milliseconds. Sessions pi has
   * not flushed yet (no assistant message) have no file and are not listed — there is
   * nothing to come back to.
   */
  async function listSessions(): Promise<StoredThread[]> {
    const listed = await SessionManager.list(cwd)
    return listed
      .map((info) => ({
        id: info.id,
        path: info.path,
        modified: info.modified,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
      }))
      .sort((first, second) => second.modified.getTime() - first.modified.getTime())
  }

  async function storedSessionPath(threadId: string): Promise<string | undefined> {
    return (await listSessions()).find((stored) => stored.id === threadId)?.path
  }

  async function readStoredThread(threadId: string): Promise<StoredThreadRead | undefined> {
    const path = await storedSessionPath(threadId)
    if (path === undefined) return undefined
    // `open` loads the file into memory and writes nothing until an append.
    const stored = SessionManager.open(path)
    return { transcript: transcriptOf(stored.getBranch()), usage: storedSessionUsage(stored.getEntries()) }
  }

  async function readStoredThreadStats(threadId: string): Promise<StoredThreadStats | undefined> {
    const path = await storedSessionPath(threadId)
    if (path === undefined) return undefined
    const stored = SessionManager.open(path)
    return { usage: storedSessionUsage(stored.getEntries()), branch: branchStats(stored.getBranch()) }
  }

  async function createSession(threadId: string): Promise<HostedThread> {
    // Resolved BEFORE the services so a bad id fails before anything is built.
    const storedPath = await storedSessionPath(threadId)
    // The watcher's handler is bound after the session exists (`announceModelState` below);
    // `model_select` cannot fire before it — only the session's own methods emit it.
    let onModelSelect = (): void => undefined
    const modelWatch: InlineExtension = {
      name: MODEL_WATCH_EXTENSION_NAME,
      factory: (pi: ExtensionAPI): void => {
        pi.on('model_select', () => onModelSelect())
      },
    }
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        // The isolation triple `scripts/enso.ts` documents, expressed as loader options:
        // no discovery (`--no-extensions`), no ~/.agents skills (`--no-skills`), and the
        // harness package as the one extension source (`-e <dir>` — pi resolves a
        // directory's `pi` manifest for extensions, skills, prompts AND themes). Inline
        // extensions load after the manifest's: the host's watcher first, then any probes.
        noExtensions: true,
        noSkills: true,
        additionalExtensionPaths: [harnessPackageDir],
        extensionFactories: [modelWatch, ...(options.extensionFactories ?? [])],
      },
    })
    for (const diagnostic of services.diagnostics) {
      log.warn('pi {type}: {message}', { threadId, type: diagnostic.type, message: diagnostic.message })
    }
    const extensionsResult = services.resourceLoader.getExtensions()
    log.debug('pi extensions loaded: {count}', {
      threadId,
      count: extensionsResult.extensions.length,
      paths: extensionsResult.extensions.map((extension) => extension.path),
    })
    for (const loadError of extensionsResult.errors) {
      // pi does not throw on a resource that fails to load; the failure would otherwise be
      // silent and the symptom unrelated (the vendor-links incident, `server/index.ts`).
      log.error('pi extension failed to load: {path}: {error}', {
        threadId,
        path: loadError.path,
        error: loadError.error,
      })
    }

    // One session file per thread, under the agent dir pi resolves from the env set above —
    // the same default `pi --mode rpc` used, so picc's persisted "modes" entry and the
    // transcript land where the TUI's would. Opened when the thread already has a file
    // (#95), created under the thread's id when not. Retained: `permissionModeState()`
    // below walks its branch, the same walk picc's `restoreState` does.
    const sessionManager =
      storedPath === undefined
        ? SessionManager.create(cwd, undefined, { id: threadId })
        : SessionManager.open(storedPath)
    const { session } = await createAgentSessionFromServices({ services, sessionManager })

    // ── The event fan-out. Records emitted before the FIRST subscriber (everything an
    // extension says during session_start — multi-account's startup notify, a dialog a
    // probe opens) are held and replayed, so the browser sees them exactly as it saw
    // pi's unsolicited startup stdout over the pipe.
    //
    // ⚠ Held ONLY until the first subscriber, never between runs. The session now lives
    // across runs (#69 PR 2) and each run subscribes its own pump. Holding between runs
    // would replay an aborted run's `agent_settled` into the NEXT run's pump — which would
    // end that run before its first token (the disconnect-then-prompt race). Events with
    // nobody listening after the first subscriber are dropped, like status heartbeats
    // were when no rpc client was reading the pipe.
    // Subscribers receive OBSERVATIONS (L2, #162 workstream 4): the runtime's event is mapped
    // here, at delivery, and its shape never leaves the host.
    const listeners = new Set<(observation: EnsoObservation) => void>()
    const heldUntilFirstSubscriber: RuntimeEvent[] = []
    let hasHadSubscriber = false
    // The emitted tail (#97): every event through this funnel, with HOW it was delivered.
    // Recorded at the one place all of them pass, so the record and the delivery cannot
    // disagree — a held record's later replay is recorded again, as `replayed`, when it
    // actually reaches a subscriber (see `subscribe`).
    const emitted = createEventTail()
    function emit(event: RuntimeEvent): void {
      if (listeners.size === 0) {
        if (!hasHadSubscriber) {
          heldUntilFirstSubscriber.push(event)
          // Described as the observation it will become when replayed.
          const described = describeObservation(mapPiEvent(event, 'replayed'))
          emitted.record(described.type, described.name, 'held')
          return
        }
        const described = describeObservation(mapPiEvent(event, 'live'))
        emitted.record(described.type, described.name, 'dropped')
        return
      }
      const observation = mapPiEvent(event, 'live')
      const described = describeObservation(observation)
      emitted.record(described.type, described.name, 'live')
      for (const listener of listeners) listener(observation)
    }

    const ui = createEnsoExtensionUiContext({ emit, threadId })

    // ⚠ SUBSCRIBE BEFORE BINDING (#88). Extensions persist state during `session_start` —
    // picc writes its opening `modes` entry there — and pi emits `entry_appended` to whoever
    // is listening at that moment. Subscribing after `bindExtensions` returned meant those
    // entries went to nobody: the held-until-first-subscriber buffer sits behind THIS
    // subscription, so nothing put them in it, and the browser saw one `modes` entry where
    // the branch had two. The `ui` notifies always crossed because `ui` binds `emit` directly.
    // Nothing session_start emits is run progress (`agent_settled` comes from the run loop
    // only), so replaying it into the first run's pump is inert.
    /**
     * The mode NOW (#84): picc's own `restoreState` walk over the live branch, re-run on
     * every call — see the walk for why it is never cached (`getBranch()` is one
     * parent-pointer walk that builds a fresh array; the walk is a second linear pass).
     * The dropdown offers picc's modes AS REGISTERED HERE: picc names one command per
     * mode, exactly after it, so the intersection is a name lookup. Read off the registry
     * directly rather than through `listCommands` — that call's count is a contract the
     * refusal path's tests pin, and this is not a refusal lookup.
     */
    function currentPermissionModeState(): EnsoPermissionModeState {
      const mode = persistedPermissionMode(sessionManager.getBranch())
      const registered = new Set(
        session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
      )
      return { mode, available: PICC_PERMISSION_MODES.filter((candidate) => registered.has(candidate)) }
    }

    /**
     * The model and thinking level NOW (#338 slice 2), read off pi's agent state on every call:
     * `model` is `null` for pi's placeholder (see `PLACEHOLDER_MODEL`), the levels are what the
     * current model offers (`getAvailableThinkingLevels` — pi's whole list when there is no model).
     */
    function currentModelState(): EnsoModelState {
      const { model } = session
      const chosen =
        model === undefined || (model.provider === PLACEHOLDER_MODEL.provider && model.id === PLACEHOLDER_MODEL.id)
          ? null
          : { provider: model.provider, id: model.id, name: model.name }
      return {
        model: chosen,
        thinkingLevel: session.thinkingLevel,
        availableThinkingLevels: session.getAvailableThinkingLevels(),
      }
    }

    /**
     * Say the session's totals and context as the host's own event (#45), ONCE per change — pi's
     * `getSessionStats`, whole, never a delta, so a follower applies the latest and cannot
     * double-count. Said after each event `growsSessionSpend` names (`session-usage.ts` says why
     * those and not `message_end`), and on a model change.
     *
     * ⚠ DECLARED ABOVE `announceModelState`, which calls it: `announcedSessionUsage` is a `let`, and
     * a call that ran before this line would throw (PR #357 review).
     */
    let announcedSessionUsage: string | undefined
    function announceSessionUsage(): void {
      const usage = liveSessionUsage(session.getSessionStats())
      const serialized = JSON.stringify(usage)
      if (serialized === announcedSessionUsage) return
      announcedSessionUsage = serialized
      emit({ type: 'session_usage', ...usage })
    }

    /**
     * Say the model state as the host's own event, ONCE per change. A `/model` reaches here up to
     * three times — `thinking_level_changed` when the new model clamps the level, `model_select`,
     * and the command's own call — and every arrival reads the same state; the feed hears one.
     */
    let announcedModelState: string | undefined
    function announceModelState(): void {
      const state = currentModelState()
      const serialized = JSON.stringify(state)
      if (serialized === announcedModelState) return
      announcedModelState = serialized
      emit({ type: 'model', ...state })
      // A new model is a new context window: the usage's `context` moved with it.
      announceSessionUsage()
    }
    onModelSelect = announceModelState

    // ── The flows (#338 slice 3; `host-flows.ts` has the decisions and the words) ──────────
    //
    // ⚠ `listCommands` is synchronous and `listCredentials` is not (the credential store may be a
    // file), so the stored credentials are a CACHE: read once the session is built, re-read after
    // every flow the host itself ran. A credential saved by another process shows up at the next
    // build, not before — said here so nobody debugs it as a bug.
    let storedCredentials: readonly StoredCredentialFacts[] = []
    // Every flow runs under this signal; `dispose` aborts it, so a device-code poll does not
    // outlive the session it was logging in (the lease is not held — see `startHostFlow`).
    const flowsAbort = new AbortController()
    // ONE flow at a time per session (PR #346 review): two logins on one feed would interleave
    // their questions with nothing to tell a reader which is which. The second is refused.
    let flowInProgress: string | undefined
    const providerNameOf = (providerId: string): string =>
      session.modelRuntime.getProvider(providerId)?.name ?? providerId
    async function refreshStoredCredentials(): Promise<void> {
      try {
        const listed = await session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) })
        storedCredentials = listed.map((credential) => ({
          providerId: credential.providerId,
          providerName: providerNameOf(credential.providerId),
          type: credential.type,
        }))
      } catch (error) {
        log.warn('stored credentials could not be listed: {error}', { threadId, error })
      }
    }
    void refreshStoredCredentials()

    function currentLoginOptions(): ReturnType<typeof loginOptions> {
      const facts: LoginProviderFacts[] = session.modelRuntime.getProviders().map((provider) => {
        const status = session.modelRuntime.getProviderAuthStatus(provider.id)
        return {
          id: provider.id,
          name: provider.name,
          offersOAuth: provider.auth.oauth !== undefined,
          offersApiKeyLogin: provider.auth.apiKey?.login !== undefined,
          configuredVia: status.configured ? (status.label ?? status.source) : undefined,
        }
      })
      return loginOptions(facts)
    }

    /**
     * pi asks; the browser answers through the dialog seam. A `secret` is masked (the host's own
     * `askSecret`); a `select` crosses as labels and comes back as the chosen option's id;
     * `text` and `manual_code` are plain inputs. No answer — cancelled, aborted — is pi's own
     * "Login cancelled", which the flow reports as a cancellation, not a failure.
     */
    async function askAuthPrompt(
      prompt: Parameters<Parameters<typeof session.modelRuntime.login>[2]['prompt']>[0],
    ): Promise<string> {
      const signal = prompt.signal
      let answer: string | undefined
      switch (prompt.type) {
        case 'secret':
          answer = await ui.askSecret(prompt.message, prompt.placeholder, signal)
          break
        case 'select': {
          const labels = prompt.options.map((option) => option.label)
          const chosen = await ui.uiContext.select(
            prompt.message,
            labels,
            signal === undefined ? undefined : { signal },
          )
          answer = prompt.options.find((option) => option.label === chosen)?.id
          break
        }
        default:
          answer = await ui.uiContext.input(
            prompt.message,
            prompt.placeholder,
            signal === undefined ? undefined : { signal },
          )
      }
      if (answer === undefined) throw new FlowCancelled()
      return answer
    }

    /**
     * After a login: when the session had no model, the provider's first available one — pi's
     * TUI picks its own per-provider default from a table it does not export; the first is
     * honest and `/model` is one keystroke away. Then the catalog refresh pi's TUI also runs.
     */
    async function settleAfterLogin(providerId: string): Promise<string | undefined> {
      let selected: string | undefined
      if (currentModelState().model === null) {
        const candidate = session.modelRuntime.getAvailableSnapshot().find((model) => model.provider === providerId)
        if (candidate !== undefined) {
          await session.setModel(candidate, { persist: true })
          selected = candidate.id
        }
      }
      const refresh = await session.modelRuntime.refresh({
        providers: [providerId],
        signal: AbortSignal.timeout(15_000),
      })
      if (refresh.aborted || refresh.errors.size > 0) {
        ui.uiContext.notify('Model catalog could not be refreshed; using cached models.', 'warning')
      }
      return selected
    }

    async function runLogin(providerId: string, authType: HostAuthType): Promise<void> {
      const providerName = providerNameOf(providerId)
      try {
        await session.modelRuntime.login(providerId, authType, {
          signal: flowsAbort.signal,
          prompt: askAuthPrompt,
          notify: (event: HostAuthEvent): void => ui.uiContext.notify(authEventText(event), 'info'),
        })
        // The credential IS stored past this line (PR #346 review): what follows can fail —
        // pi refusing the model, the catalog not refreshing — and is said as a warning, never
        // as a failed login that `/logout` would then contradict by listing the credential.
        try {
          const selected = await settleAfterLogin(providerId)
          ui.uiContext.notify(loginDoneText(providerName, authType, selected), 'info')
        } catch (error) {
          // Said ONCE, and neutrally: the throw may be the catalog refresh after the model was
          // selected, so "could not select a model" would be wrong (PR #346 review 3).
          const reason = error instanceof Error ? error.message : String(error)
          ui.uiContext.notify(`Logged in to ${providerName}; post-login setup failed: ${reason}`, 'warning')
        }
      } catch (error) {
        if (isFlowCancelled(error)) ui.uiContext.notify(`Login to ${providerName} cancelled.`, 'info')
        else {
          const reason = error instanceof Error ? error.message : String(error)
          ui.uiContext.notify(`Failed to log in to ${providerName}: ${reason}`, 'error')
        }
      } finally {
        await refreshStoredCredentials()
        announceModelState()
      }
    }

    /**
     * `/compact` (#338 slice 4): pi summarises the context — a model call, seconds to a minute —
     * so it starts and is followed like a login, but the route HOLDS THE LEASE until it settles:
     * compaction rewrites the branch, pi refuses a prompt while it runs (`agent-session.js:1227`),
     * and `compact()` awaits `abort()` before it arms its own guard (:1866–1867), so a prompt in
     * that window would run alongside the summary — the held lease is what forecloses it (PR #347
     * review). Stop reaches it: `abort` below calls `abortCompaction`, and pi's own `dispose`
     * does too (:587). The page's transcript is TanStack's copy of the messages and does not
     * re-read the branch on its own, so the done line says to reload; the next snapshot is the
     * compacted branch.
     */
    async function runCompact(): Promise<void> {
      ui.uiContext.notify('Compacting the context…', 'info')
      try {
        const compacted = await session.compact()
        ui.uiContext.notify(compactDoneText(compacted.tokensBefore, compacted.estimatedTokensAfter), 'info')
      } catch (error) {
        // pi's refusals ("Nothing to compact (session too small)", smoke 2026-09-23) are not
        // failures: said as a warning with pi's reason. Anything else is (PR #347 review).
        const reason = error instanceof Error ? error.message : String(error)
        if (isCompactionRefusal(error)) ui.uiContext.notify(`Compaction did not run: ${reason}`, 'warning')
        else ui.uiContext.notify(`Compaction failed: ${reason}`, 'error')
      }
    }

    function runDecidedFlow(decision: ReturnType<typeof decideHostFlow>): Promise<void> {
      switch (decision.kind) {
        case 'login':
          return runLogin(decision.providerId, decision.authType)
        case 'logout':
          return runLogout(decision.providerId)
        case 'compact':
          return runCompact()
      }
    }

    async function runLogout(providerId: string): Promise<void> {
      const providerName = providerNameOf(providerId)
      const type = storedCredentials.find((credential) => credential.providerId === providerId)?.type
      try {
        await session.modelRuntime.logout(providerId, { signal: AbortSignal.timeout(15_000) })
        ui.uiContext.notify(logoutDoneText(providerName, type), 'info')
      } catch (error) {
        ui.uiContext.notify(
          `Logout from ${providerName} failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        )
      } finally {
        await refreshStoredCredentials()
        announceModelState()
      }
    }

    const unsubscribeSession = session.subscribe((event) => {
      try {
        const wire = toRpcWireEvent(event)
        emit(wire)
        // L3 (#162 workstream 4): the mode extension persisted a mode. Above this seam no
        // surface knows that entry's shape, so the host says what the mode is now, as its
        // own event; the mapper carries it as the `permission-mode` observation.
        if (wire.type === 'entry_appended' && readPiccPersistedMode(wire.entry) !== undefined) {
          emit({ type: 'permission_mode', ...currentPermissionModeState() })
        }
        // The thinking half of the model state — the module header says why the model half
        // arrives through the watcher extension instead.
        if (wire.type === 'thinking_level_changed') announceModelState()
        if (growsSessionSpend(event)) announceSessionUsage()
      } catch (error) {
        log.error('a session event could not be emitted: {error}', { threadId, error })
      }
    })

    // Bound ONCE — see the module header. Errors thrown by an extension handler arrive here
    // (spike receipt: a throwing session_start is routed to onError and bindExtensions
    // resolves; it neither hangs nor rejects), and cross as the same `extension_error`
    // record the rpc mode emitted.
    await session.bindExtensions({
      uiContext: ui.uiContext,
      mode: EXTENSION_MODE_RPC,
      onError: (error: ExtensionError) => {
        emit({ type: 'extension_error', extensionPath: error.extensionPath, event: error.event, error: error.error })
      },
    })
    // The model the session STARTS with is on the feed too, not only later changes. It used to
    // arrive by accident: pi-multi-account 1.21 re-applied its remembered model at `session_start`
    // through `pi.setModel`, which fires `model_select`. From 1.22 it follows the session branch
    // and calls nothing, so a fresh thread's chip read "default until the thread runs" after it
    // had run (live check, 2026-09-23). Deduped, so an extension's own switch is not said twice.
    announceModelState()

    let disposed = false
    const runtime: ThreadRuntime = {
      prompt(request: PromptRequest, outcome: PromptOutcome): void {
        let accepted = false
        // ⚠ Fire-and-forget, exactly as pi's rpc mode does: `prompt()` resolves only when
        // the whole run finishes, and awaiting it in front of the drain loop is the
        // original `/mode` hang. Acceptance is the preflight callback; completion is the
        // `agent_settled` event. A rejection AFTER acceptance is dropped here on purpose —
        // this is pi's own rpc-mode handler line for line (dist/modes/rpc/rpc-mode.js,
        // `case "prompt"`), and pi's `_runAgentPrompt` emits `agent_settled` from a
        // `finally`, so the run still terminates; only the error text is lost. Model and
        // tool errors never reach this path — the agent loop turns them into an assistant
        // message with `stopReason: "error"`, which the stream carries as usual.
        void session
          .prompt(request.message, {
            ...(request.images === undefined ? {} : { images: [...request.images] }),
            ...(request.admission === undefined ? {} : { streamingBehavior: STREAMING_BEHAVIOR_OF[request.admission] }),
            source: PROMPT_SOURCE_RPC,
            preflightResult: (didSucceed: boolean) => {
              if (didSucceed) {
                accepted = true
                outcome.onAccepted()
              }
            },
          })
          .catch((error: unknown) => {
            if (!accepted) outcome.onRejected(error instanceof Error ? error.message : String(error))
          })
      },
      answerDialog(response: DialogAnswer): void {
        ui.answerDialog(response)
      },
      openDialogs(): EnsoOpenDialog[] {
        return ui.openDialogs()
      },
      listCommands(): RuntimeCommand[] {
        // The three sources pi's rpc `get_commands` assembles, in its order — then the host's
        // own two (#338 slice 2), over the models pi could run right now.
        const commands: RuntimeCommand[] = []
        for (const command of session.extensionRunner.getRegisteredCommands()) {
          commands.push(describeCommand(command.invocationName, 'extension', command.description))
        }
        for (const template of session.promptTemplates) {
          commands.push(describeCommand(template.name, 'prompt', template.description))
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push(describeCommand(`skill:${skill.name}`, 'skill', skill.description))
        }
        commands.push(...hostCommandRows(currentModelState(), session.modelRuntime.getAvailableSnapshot()))
        commands.push(...hostFlowRows(currentLoginOptions(), logoutOptions(storedCredentials)))
        return commands
      },
      startHostFlow(run: EnsoHostCommandRun, outcome: HostFlowOutcome): void {
        let decision: ReturnType<typeof decideHostFlow>
        try {
          if (flowInProgress !== undefined)
            throw new HostCommandRefused(`/${flowInProgress} is already in progress here`)
          decision = decideHostFlow(run, currentLoginOptions(), logoutOptions(storedCredentials))
        } catch (error) {
          outcome.onRejected(error instanceof Error ? error.message : String(error))
          return
        }
        outcome.onAccepted()
        flowInProgress = run.name
        const flow = runDecidedFlow(decision)
        void flow.finally(() => {
          flowInProgress = undefined
          outcome.onSettled()
        })
      },
      modelState: currentModelState,
      sessionUsage: () => liveSessionUsage(session.getSessionStats()),
      async runHostCommand(run: EnsoHostCommandRun): Promise<void> {
        const decision = decideHostCommand(run, currentModelState(), session.modelRuntime.getAvailableSnapshot())
        switch (decision.kind) {
          case 'refused':
            throw new HostCommandRefused(decision.reason)
          case 'model':
            // pi refuses a provider with no credentials (`No API key for provider/id`) — its
            // sentence is the reason; the snapshot lists authenticated providers, so it is the
            // rare case of a credential that lapsed between the listing and the choice. That
            // one throw is a refusal; anything else `setModel` throws is a fault, and stays one.
            try {
              await session.setModel(decision.model)
            } catch (error) {
              if (error instanceof Error && /no api key/i.test(error.message))
                throw new HostCommandRefused(error.message)
              throw error
            }
            break
          case 'thinking': {
            // The decision checked the level against this same list; the lookup is how the string
            // becomes pi's `ThinkingLevel` without a cast.
            const level = session.getAvailableThinkingLevels().find((offered) => offered === decision.level)
            if (level !== undefined) session.setThinkingLevel(level)
            break
          }
        }
        // pi's own events have said it by now (see the module header); this is the guarantee
        // that the caller's change is on the feed whatever pi's plumbing did — deduped.
        announceModelState()
      },
      permissionModeState: currentPermissionModeState,
      setPermissionMode(mode: string, outcome: PromptOutcome): void {
        // Only a mode the vendor registers a command for — the runtime treats an unknown
        // slash command as ORDINARY TEXT and would send it to the model as a chat message.
        // Found by the first test that drove this path against the real extension rather
        // than the fake (#162 exit criteria); the route refuses earlier (422), this is the seam's own lock.
        if (!currentPermissionModeState().available.includes(mode)) {
          outcome.onRejected(`mode ${mode} is not one this thread offers`)
          return
        }
        // The vendor's command, as the prompt path runs any extension command: fire-and-
        // forget, acceptance is completion, and the change arrives as `permission_mode`.
        runtime.prompt({ message: piccModeCommand(mode) }, outcome)
      },
      subscribe(onObservation: (observation: EnsoObservation) => void): () => void {
        listeners.add(onObservation)
        hasHadSubscriber = true
        if (heldUntilFirstSubscriber.length > 0) {
          const held = heldUntilFirstSubscriber.splice(0)
          for (const event of held) {
            // The subscriber learns it is a replay (#96): the tail's `replayed` and the
            // observation's `origin` are the same fact, told once here by the mapper.
            const observation = mapPiEvent(event, 'replayed')
            const described = describeObservation(observation)
            emitted.record(described.type, described.name, 'replayed')
            onObservation(observation)
          }
        }
        return () => {
          listeners.delete(onObservation)
        }
      },
      abort(): Promise<void> {
        // A compaction in flight is the run Stop is stopping (#338 slice 4): pi's `abort()` does
        // not cancel it — `abortCompaction()` does, and is a no-op when none is running.
        session.abortCompaction()
        return stopRunThenSettleDialogs(
          () => session.abort(),
          () => ui.abortAllDialogs(),
        )
      },
      clearQueue(): { interrupting: string[]; enqueued: string[] } {
        // The runtime's two lists under Enso's words (#216) — the only place either spelling is
        // translated on this side, as `map-events.ts` is on the observation side.
        const cleared = session.clearQueue()
        return { interrupting: cleared.steering, enqueued: cleared.followUp }
      },
      dispose(): void {
        if (disposed) return
        disposed = true
        flowsAbort.abort()
        ui.cancelAllDialogs()
        unsubscribeSession()
        // `AgentSession.dispose()` does NOT emit session_shutdown — only pi's runtime layer
        // does. multi-account clears its timers on that event ("for ANY reason"), so the
        // host emits it the way `AgentSessionRuntime.dispose` does, then releases.
        void session.extensionRunner
          .emit({ type: 'session_shutdown', reason: 'quit' })
          .catch((error: unknown) => log.error('session_shutdown threw: {error}', { threadId, error }))
          .finally(() => session.dispose())
      },
    }

    return {
      runtime,
      loadedExtensionPaths: extensionsResult.extensions.map((extension) => extension.path),
      emittedEvents: () => emitted.recent(),
      async probeToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallVerdict | undefined> {
        const result = await session.extensionRunner.emitToolCall({
          type: 'tool_call',
          toolName,
          toolCallId: `probe-${crypto.randomUUID()}`,
          input,
        })
        if (result === undefined) return undefined
        return { block: result.block === true, reason: result.reason }
      },
      branchStats: () => branchStats(sessionManager.getBranch()),
      inspect(): HostedThreadInspection {
        // ⚠ `getSessionFile()` names the path pi WILL write, from creation — but pi flushes
        // lazily, holding every entry until the first assistant message. So the path is
        // reported only once the file exists; before that the branch below is the only copy.
        const plannedFile = sessionManager.getSessionFile()
        return {
          sessionId: sessionManager.getSessionId(),
          cwd: sessionManager.getCwd(),
          sessionDir: sessionManager.getSessionDir(),
          sessionFile: plannedFile !== undefined && existsSync(plannedFile) ? plannedFile : null,
          entries: transcriptOf(sessionManager.getBranch()),
          commands: runtime.listCommands().map((command) => command.name),
        }
      },
    }
  }

  return {
    cwd,
    createSession,
    listSessions,
    readStoredThread,
    readStoredThreadStats,
    freshPermissionMode: freshPermissionModeState,
    storedPermissionMode: storedPermissionModeState,
  }
}
