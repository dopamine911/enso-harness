import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionError,
  type InlineExtension,
  initTheme,
  VERSION as PI_VERSION,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import {
  type DialogAnswer,
  findRepoRoot,
  type PromptOutcome,
  type PromptRequest,
  quarantineSecrets,
  type RuntimeCommand,
  type ThreadRuntime,
  type ZenObservation,
  type ZenOpenDialog,
  type ZenPermissionModeState,
  type ZenThreadEvent,
  type ZenTranscriptEntry,
  zenLogger,
} from '@zen/core'
import { createEventTail, describeObservation } from './event-tail.ts'
import { createZenExtensionUiContext } from './extension-ui-context.ts'
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
import { transcriptOf } from './transcript.ts'

const log = zenLogger('host')

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
 * at MODULE IMPORT (`index.ts:714`) and derives `auth.json`, `settings.json`, `models.json`
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
 * ⚠ `bindExtensions` IS CALLED EXACTLY ONCE PER SESSION. Every call emits `session_start`
 * (the guards reset their read tracker on it; multi-account resets thirteen failover
 * guards). Without the call, `session_start` never fires and `ctx.hasUI` is false.
 *
 * ⚠⚠ SECRETS ARE QUARANTINED AT HOST CREATION, before the first session (#89). pi runs in
 * this process and every `bash` child inherits this process's environment, which bun's
 * `.env` autoload had filled with `TAVILY_API_KEY`; `bash env` printed it into a
 * transcript. `quarantineSecrets` deletes every secret-shaped name and every name the
 * secrets file defines. The extensions that need a key read `.zen/secrets.env` directly
 * (`readSecret`) — see `@zen/core`'s secrets.ts for why the root `.env` is the wrong place.
 */

/** The agent dir's multi-account config file, and the one key this host must pin in it. */
const MULTI_ACCOUNT_CONFIG_FILENAME = 'provider-failover.json'
const MULTI_ACCOUNT_CHILD_PROXY_KEY = 'childProxy'

/** pi's `InputSource` for prompts that arrive over a wire rather than a keyboard. */
const PROMPT_SOURCE_RPC = 'rpc'

/** The `ExtensionMode` we bind — `ctx.mode` as extensions see it. rpc is the truthful one: no terminal, a remote surface. */
const EXTENSION_MODE_RPC = 'rpc'

export interface AgentHostOptions {
  /** The tree pi reads and writes. One per server, never from a request (see `server/index.ts`). */
  cwd: string
  /** Scratch config dir — the operator's own packages and credentials stay invisible. */
  agentDir: string
  /** The zen harness pi package directory; loaded as the ONLY extension source. */
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
 * `SessionManager` (#86). Everything a run shows the browser is derived from the event
 * stream; this is the source those views derive from, for a human or an agent to
 * cross-check against.
 */
export interface HostedThreadInspection {
  readonly sessionId: string
  readonly cwd: string
  readonly sessionDir: string
  /** The session file once pi has flushed it; null while the session lives only in memory. */
  readonly sessionFile: string | null
  /** The branch, root to leaf, as the transcript of ours (L2): the runtime's entry shapes stay in `transcript.ts`. */
  readonly entries: readonly ZenTranscriptEntry[]
  /** Slash commands this session registers. */
  readonly commands: readonly string[]
}

export interface HostedThread {
  readonly runtime: ThreadRuntime
  /** How many extensions the loader found — the load receipt a caller may assert. */
  readonly loadedExtensionPaths: readonly string[]
  /**
   * Read-only view of the session as pi holds it. Deliberately here and NOT on
   * `ThreadRuntime`: that is the run contract, pinned by three fakes and the refusal-path
   * tests, and inspection is a host concern.
   */
  inspect(): HostedThreadInspection
  /** The emitted tail (#97): what the host's `emit` funnel saw, with provenance. A fresh copy per call. */
  emittedEvents(): ZenThreadEvent[]
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
 * return. Before this, Stop during a permission question waited on the card: the loop awaited
 * the handler, the handler awaited the human. If the user says stop, it's stop (Daniel,
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
  /** pi's session files for this workspace, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * The transcript of a stored session, read-only — no pi session is built, nothing is
   * written (#86's rule: looking must not build). `undefined` when no file has that id.
   */
  readTranscript(threadId: string): Promise<ZenTranscriptEntry[] | undefined>
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): ZenPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly ZenTranscriptEntry[]): ZenPermissionModeState
}

/**
 * The agent runtime this build is bound to, by version. The ONE place outside this host that
 * needs pi's version is the log bundle's `about` (#132), and it takes this string rather than
 * the import — the vendor gate (#145) keeps the import inside `host/`.
 */
export const AGENT_RUNTIME_VERSION: string = PI_VERSION

/**
 * Pin `childProxy: false` in the agent dir's multi-account config — see the module header.
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
  // be imported by the loader, the proxy pin before the first session_start, and the
  // secrets out of the environment before anything can inherit it (#89).
  process.env.PI_CODING_AGENT_DIR = agentDir
  seedMultiAccountChildProxyOff(agentDir)
  // The secrets file is a fact about THIS checkout (the harness), not about the tree pi
  // operates on — `cwd` may be anywhere, a tmpdir in tests — so it resolves from here.
  const quarantine = quarantineSecrets(options.environment ?? process.env, findRepoRoot(import.meta.url))
  if (quarantine.removed.length > 0) {
    log.info('secrets kept out of the tool environment (#89): {removed}', { removed: quarantine.removed })
  }
  if (quarantine.misplaced.length > 0) {
    log.warn(
      'the root .env defines {misplaced} — bun autoloads .env into every bun child, so a tool can still read it there. Move it to .zen/secrets.env (#89); it is not read from .env',
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

  async function readTranscript(threadId: string): Promise<ZenTranscriptEntry[] | undefined> {
    const path = await storedSessionPath(threadId)
    if (path === undefined) return undefined
    // `open` loads the file into memory and writes nothing until an append.
    return transcriptOf(SessionManager.open(path).getBranch())
  }

  async function createSession(threadId: string): Promise<HostedThread> {
    // Resolved BEFORE the services so a bad id fails before anything is built.
    const storedPath = await storedSessionPath(threadId)
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        // The isolation triple `scripts/zen.mjs` documents, expressed as loader options:
        // no discovery (`--no-extensions`), no ~/.agents skills (`--no-skills`), and the
        // harness package as the one extension source (`-e <dir>` — pi resolves a
        // directory's `pi` manifest for extensions, skills, prompts AND themes).
        noExtensions: true,
        noSkills: true,
        additionalExtensionPaths: [harnessPackageDir],
        ...(options.extensionFactories === undefined ? {} : { extensionFactories: [...options.extensionFactories] }),
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
    const listeners = new Set<(observation: ZenObservation) => void>()
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

    const ui = createZenExtensionUiContext({ emit, threadId })

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
    function currentPermissionModeState(): ZenPermissionModeState {
      const mode = persistedPermissionMode(sessionManager.getBranch())
      const registered = new Set(
        session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
      )
      return { mode, available: PICC_PERMISSION_MODES.filter((candidate) => registered.has(candidate)) }
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
            ...(request.streamingBehavior === undefined ? {} : { streamingBehavior: request.streamingBehavior }),
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
      openDialogs(): ZenOpenDialog[] {
        return ui.openDialogs()
      },
      listCommands(): RuntimeCommand[] {
        // The three sources pi's rpc `get_commands` assembles, in its order.
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
        return commands
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
      subscribe(onObservation: (observation: ZenObservation) => void): () => void {
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
        return stopRunThenSettleDialogs(
          () => session.abort(),
          () => ui.abortAllDialogs(),
        )
      },
      clearQueue(): { steering: string[]; followUp: string[] } {
        return session.clearQueue()
      },
      dispose(): void {
        if (disposed) return
        disposed = true
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
    createSession,
    listSessions,
    readTranscript,
    freshPermissionMode: freshPermissionModeState,
    storedPermissionMode: storedPermissionModeState,
  }
}
