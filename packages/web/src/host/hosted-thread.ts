import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionError,
  type InlineExtension,
  initTheme,
  type PromptOptions,
  ProjectTrustStore,
  VERSION as PI_VERSION,
} from '@earendil-works/pi-coding-agent'
import {
  type DialogAnswer,
  ENSO_INCIDENT_RESOLVED_CHANNEL,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_LOG_EVENTS,
  ENSO_PROJECT_TRUST_ENTRY,
  ENSO_RUN_STOPPED_ENTRY,
  ENSO_SYSTEM_PROMPT_ENTRY,
  type EnsoIncidentResolution,
  type EnsoHostCommandRun,
  type EnsoOpenDialog,
  type EnsoPermissionCheckRequest,
  type EnsoPromptAdmission,
  type EnsoSystemPromptChoice,
  ensoLogger,
  incidentResolutionRefusal,
  incidentResolvedOf,
  type PromptOutcome,
  type PromptRequest,
  type RuntimeCommand,
  recordedSystemPrompt,
  THREAD_PROJECT_TRUST,
  type ThreadRuntime,
} from '@enso/core'
import { getPermissionsService } from '@gotgenes/pi-permission-system'
import { type ContinuationLead, continuationLead, NO_RUN_LIFECYCLE, NOTHING_TO_CONTINUE } from './continuation.ts'
import { createEventChannel } from './event-channel.ts'
import { createEnsoExtensionUiContext } from './extension-ui-context.ts'
import { decideHostCommand, HOST_VIEW_ROWS, HostCommandRefused, hostCommandRows } from './host-commands.ts'
import { createHostFlowRuns, type ProviderAccounts } from './host-flow-runs.ts'
import { type HostedThread, logReads, stopRunSettlingDialogs, type ToolCallVerdict } from './live-thread.ts'
import { attributeNotices, ENSO_SENDER } from './notice-sender.ts'
import { createPermissionCallQuestions, permissionVerdictOf } from './permission-call-questions.ts'
import { appendedMode, modeCommand } from './permission-mode-adapter.ts'
import {
  createTrustGate,
  hostedProjectTrust,
  PROJECT_TRUST_OPTIONS,
  projectTrustedNotice,
  projectTrustQuestion,
} from './project-trust.ts'
import { builtinProviderName, providerRefusalOf } from './provider-refusal.ts'
import { restoreNoteExtension } from './restore-note.ts'
import { toRpcWireEvent } from './session-events.ts'
import { loginFactsOf, type SessionModels, selectionBeforeFirstMessage } from './session-models.ts'
import { growsSessionSpend, liveSessionUsage } from './session-usage.ts'
import type { StoredThreads } from './stored-threads.ts'
import { previewOnSession } from './system-prompt-preview.ts'
import { decideSystemPrompt, withSystemPrompt } from './system-prompt.ts'
import { createThreadAnnouncements } from './thread-announcements.ts'
import { runtimeLogOf, type ThreadLog } from './thread-log.ts'
import type { TreeMaking } from './thread-tree-making.ts'
import { treeRecordOf } from './thread-trees.ts'

/**
 * One live thread (#69): pi built on the thread's log — one `createAgentSessionServices` and one
 * `createAgentSessionFromServices`, the harness package loaded through the same loader path the
 * CLI's `-e <dir>` uses, and our `ExtensionUIContext` bound so dialogs reach the browser (#27) and
 * the extensions' `hasUI` is true — its events mapped to observations, and the `ThreadRuntime` the
 * server drives it through.
 *
 * ⚠⚠ ONE SERVICES OBJECT PER SESSION, NEVER SHARED (#69). Two sessions created from one services
 * object share their extension INSTANCES: one closure receives `session_start` twice, so thread A's
 * read tracker would authorise thread B's writes and A's `/mode` would apply to B. A services object
 * is created per session and never reused, whatever it costs in reload time.
 *
 * ⚠ `bindExtensions` IS CALLED EXACTLY ONCE PER SESSION. Every call emits `session_start` (the
 * guards reset their read tracker on it; multi-account resets thirteen failover guards). Without the
 * call, `session_start` never fires and `ctx.hasUI` is false.
 *
 * ⚠ THE HOST LOADS ONE EXTENSION OF ITS OWN, `<inline:enso-model-watch>` (#338 slice 2), because an
 * extension is the only honest listener for a model change. pi (1.1.0) announces a model switch to
 * extensions ALONE: `AgentSession.setModel` (`dist/core/agent-session.js:1946`) writes the
 * `model_change` entry through `appendModelChange` (:1953) with no session event — `entry_appended`
 * is emitted for custom entries, boundary drafts, context edits, cache-warm and virtual-model-state
 * entries, never for a model change — and then `_emitModelSelect` (:1962) puts `model_select` on the
 * EXTENSION runner. The thinking level is the other way round: `setThinkingLevel` (:2052) emits
 * `thinking_level_changed` on the session stream (:2064). The host hears each where it is said,
 * re-reads `modelState()` and emits its own `model` event once per change — so a failover swap by
 * pi-multi-account (`pi.setModel`, `index.ts:4031`) reaches the feed the same way a `/model` from the
 * palette does. The watcher registers nothing else and is listed in `loadedExtensionPaths`.
 *
 * A FORK POINT IS READ OFF THE BRANCH (#435). `forkPoint` (live) and `readStoredForkPoint` (cold, one
 * open, nothing built) walk the same branch with `fork-point.ts`: the session id, the leaf, the parent
 * the listing resolves (#433), then the recorded model and level (#434), the last mode, the cwd and
 * the latest `enso-run-context` the harness's `run-context` extension wrote.
 *
 * ⚠⚠ CONTINUE RUNS ON pi'S PRIVATE RUN LIFECYCLE (#436). `continueRun` resumes a torn thread from
 * exactly its stored state — no new user message — by calling `AgentSession._runAgentPrompt(lead)`
 * (`agent-session.js:1380`, `private` in `agent-session.d.ts:520`, an ordinary method at run time)
 * through ONE cast (`PiRunLifecycle`). pi (1.1.0) has no public continue that runs inside that
 * lifecycle, and the lifecycle is what makes it a run: `session.agent.continue()` alone persists the
 * reply and fires the guards, but never emits `agent_settled` (the route releases the lease on
 * `settled`, so the thread would stay busy), leaves `isStreaming` false (a prompt enqueued during it
 * would be accepted and lost), skips auto-retry, and lets `abort()` resolve before the run stopped.
 * `_runAgentPrompt` is what `prompt()` itself ends in (`:1331`). Whether the tail CAN be continued is
 * decided here, not by pi (`continuation.ts`): the lifecycle would answer a completed reply again. The
 * accepted differences from a prompt: no `input` or `before_agent_start` for the continued turn — so
 * no permission-mode reminder and no pi-multi-account last-moment account preflight (the harness's
 * `enso-run-context` IS re-checked, from `agent_start`, #445); no auth preflight (missing credentials
 * become a stored error reply, and the run settles); no pre-prompt compaction check (the post-run one
 * still runs); and the first request reuses the system prompt the transcript holds.
 * `agent-host.test.ts` pins the lifecycle through the real host and pi's faux provider, so a pi bump
 * that renames or reshapes the method is a red test. The cast leaves when pi ships a public
 * `AgentSession.continue()`.
 */

const log = ensoLogger('host')

/**
 * The agent runtime this build is bound to, by version.
 *
 * The ONE place outside this host that needs pi's version is the log bundle's `about` (#132),
 * and it takes this string rather than the import — the vendor gate (#145) keeps the import
 * inside `host/`, and in this glue file rather than `agent-host.ts` (#811).
 */
export const AGENT_RUNTIME_VERSION: string = PI_VERSION

/** The theme registry pi's UI code consults; harmless without a terminal, required once, before any thread is built. */
export function prepareRuntimeTheme(): void {
  initTheme()
}

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
 * (`findInitialModel` in `dist/core/sdk.js:104`, `setModel`) is a registered, authenticated one;
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

/**
 * The one member of pi's private run lifecycle `continueRun` calls (#436, module header): run the
 * agent from `messages` with retry, compaction recovery, queued prompts and `agent_settled`.
 */
interface PiRunLifecycle {
  _runAgentPrompt(messages: ContinuationLead): Promise<void>
}

/** `RuntimeCommand` with `description` present only when pi supplied one (`exactOptionalPropertyTypes`). */
function describeCommand(
  name: string,
  source: RuntimeCommand['source'],
  description: string | undefined,
): RuntimeCommand {
  return description === undefined ? { name, source } : { name, source, description }
}

/** What building a live thread reads from the host (#801). */
export interface HostedThreadHost {
  readonly agentDir: string
  readonly harnessPackageDir: string
  /** Test seam: inline extensions loaded beside the harness (`AgentHostOptions.extensionFactories`). */
  readonly extensionFactories: readonly InlineExtension[]
  /** The models a thread with no session is offered (#688): each bound session's list becomes it. */
  readonly catalogueModels: SessionModels
  /** The log of each thread built here (#551): a build registers its own, a dispose drops it. */
  readonly liveLogs: Map<string, ThreadLog>
  readonly deletingThreads: ReadonlySet<string>
  readonly deletedThreads: ReadonlySet<string>
  readonly restoringTrees: ReadonlySet<string>
  readonly judgeCaseInputs: StoredThreads['judgeCaseInputs']
  readonly locate: StoredThreads['locate']
  readonly prepareTreeOnTrust: TreeMaking['prepareTreeOnTrust']
}

/** pi built on `threadLog` — a thread's whole session, events flowing, extensions bound. */
export async function buildHostedThread(
  threadId: string,
  threadLog: ThreadLog,
  host: HostedThreadHost,
): Promise<HostedThread> {
  const {
    agentDir,
    harnessPackageDir,
    extensionFactories,
    catalogueModels,
    liveLogs,
    deletingThreads,
    deletedThreads,
    restoringTrees,
    judgeCaseInputs,
    locate,
    prepareTreeOnTrust,
  } = host
  const { cwd } = threadLog
  liveLogs.set(threadId, threadLog)
  // The thread's system prompt (#443): the one its branch recorded, else pi's default until a
  // Start chooses one (`setSystemPrompt` below). An entry that does not read refuses the build —
  // never pi's default in its place, which would rewrite the prompt the thread started with. Read
  // BEFORE the services, as the directory is: a thread refused builds nothing.
  const recorded = recordedSystemPrompt(threadLog.transcript())
  if (recorded.kind === 'unreadable') {
    throw new Error(`thread ${threadId}: its ${ENSO_SYSTEM_PROMPT_ENTRY} entry does not read as a system prompt`)
  }
  let systemPrompt: EnsoSystemPromptChoice | undefined = recorded.kind === 'chosen' ? recorded.choice : undefined
  // The watcher's handler is bound after the session exists (`announceModelState` below);
  // `model_select` cannot fire before it — only the session's own methods emit it.
  let onModelSelect = (): void => undefined
  // The host's own hold on pi's extension API (#466): a resolution is appended through it, so pi
  // emits `entry_appended` and every follower folds the record live, and emitted on its event bus,
  // where the guard listens. Re-set on each load — a reload (`trustGate`) binds a new API.
  let hostApi: ExtensionAPI | undefined
  const modelWatch: InlineExtension = {
    name: MODEL_WATCH_EXTENSION_NAME,
    factory: (pi: ExtensionAPI): void => {
      hostApi = pi
      pi.on('model_select', () => onModelSelect())
    },
  }
  // Where each permission card stands among its call's questions (#728), asked of this session's engine.
  const callQuestions = createPermissionCallQuestions(
    (surface, value, agentName) =>
      getPermissionsService(threadLog.threadId)?.checkPermission(surface, value, agentName).state,
  )
  // Trust before anything loads (#502): pi's `trust.json`, the thread's own record, the default —
  // else untrusted, and asked before the first run (`trustGate` below). ⚠ Keyed by the PROJECT: a
  // thread on a tree (#551) is trusted as its checkout is, never as a path no one trusted.
  const trustDirectory = treeRecordOf(threadLog.transcript())?.project ?? cwd
  const projectTrust = hostedProjectTrust(cwd, trustDirectory, agentDir, threadLog.transcript())
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: projectTrust.settingsManager,
    resourceLoaderOptions: {
      // The isolation triple `scripts/enso.ts` documents, expressed as loader options:
      // no discovery (`--no-extensions`), no ~/.agents skills (`--no-skills`), and the
      // harness package as the one extension source (`-e <dir>` — pi resolves a
      // directory's `pi` manifest for extensions, skills, prompts AND themes). Inline
      // extensions load after the manifest's: the host's watcher, its restore note (#652) and
      // its ear for the engine's questions (#728) first, then any probes.
      noExtensions: true,
      noSkills: true,
      additionalExtensionPaths: [harnessPackageDir],
      extensionFactories: [modelWatch, restoreNoteExtension, callQuestions.extension, ...extensionFactories],
      // Who said a notice (#387): each extension's registrations get a context whose
      // `ui.notify` names that extension, read off the path pi loaded it from.
      extensionsOverride: (loaded) => attributeNotices(loaded, harnessPackageDir),
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

  const { session } = await createAgentSessionFromServices({
    services: { ...services, resourceLoader: withSystemPrompt(services.resourceLoader, () => systemPrompt) },
    sessionManager: runtimeLogOf(threadLog),
    ...selectionBeforeFirstMessage(threadLog.choiceBeforeFirstMessage(), services.modelRuntime),
  })

  // The event fan-out (`event-channel.ts`): observations to subscribers, the emitted tail (#97).
  const channel = createEventChannel()
  const { emit } = channel

  const ui = createEnsoExtensionUiContext({
    emit,
    threadId,
    selectTitle: callQuestions.selectTitle,
  })

  // The open trust decision, asked before a run (#502). A Trust is recorded where its answer says —
  // pi's `trust.json` for the project, the thread's branch for the thread — then applied to pi and
  // the session reloaded, so the engine binds the project's rules and modes before the run starts.
  const trustGate = createTrustGate({
    open: projectTrust.open,
    // The project the answer is stored for (#551): a tree's own path is not a place the user knows.
    ask: () => ui.uiContext.select(projectTrustQuestion(trustDirectory), [...PROJECT_TRUST_OPTIONS]),
    apply: async (answer) => {
      if (answer === 'untrusted') return
      if (answer === 'project') new ProjectTrustStore(agentDir).set(trustDirectory, true)
      else threadLog.record(ENSO_PROJECT_TRUST_ENTRY, THREAD_PROJECT_TRUST)
      projectTrust.settingsManager.setProjectTrusted(true)
      // "Trust this thread" trusts no project: a project's setup is read under the project's own answer.
      if (answer === 'project') await prepareTreeOnTrust(threadId, threadLog)
      await session.reload()
      ui.notifyFrom(ENSO_SENDER, projectTrustedNotice(answer), 'info')
    },
  })

  // The thread's state NOW and the events that say it once per change (`thread-announcements.ts`),
  // over pi's live readings.
  const { currentPermissionModeState, currentModelState, announceSessionUsage, announceModelState } =
    createThreadAnnouncements({
      readings: {
        model: () => {
          const { model } = session
          const placeholder =
            model === undefined || (model.provider === PLACEHOLDER_MODEL.provider && model.id === PLACEHOLDER_MODEL.id)
          return placeholder ? undefined : { provider: model.provider, id: model.id, name: model.name }
        },
        thinkingLevel: () => session.thinkingLevel,
        availableThinkingLevels: () => session.getAvailableThinkingLevels(),
        usage: () => liveSessionUsage(session.getSessionStats()),
        registeredCommands: () =>
          session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
      },
      threadLog,
      emit,
    })
  onModelSelect = announceModelState

  // ── The flows (#338 slices 3–4; `host-flow-runs.ts` runs them, `host-flows.ts` has the words) ──
  // pi's model runtime and dialogs, in the flows' own terms: the thread's accounts and its conversation.
  const accounts: ProviderAccounts = {
    providerName: (providerId) => session.modelRuntime.getProvider(providerId)?.name ?? providerId,
    loginFacts: () => loginFactsOf(session.modelRuntime),
    credentials: (signal) => session.modelRuntime.listCredentials({ signal }),
    logIn: async (providerId, authType, interaction) => {
      await session.modelRuntime.login(providerId, authType, {
        signal: interaction.signal,
        prompt: (prompt): Promise<string> => interaction.ask(prompt),
        notify: interaction.notify,
      })
    },
    logOut: (providerId, signal) => session.modelRuntime.logout(providerId, { signal }),
    async chooseFirstModelIfNone(providerId) {
      if (currentModelState().model !== null) return undefined
      const candidate = session.modelRuntime.getAvailableSnapshot().find((model) => model.provider === providerId)
      if (candidate === undefined) return undefined
      await session.setModel(candidate, { persist: true })
      return candidate.id
    },
    async refreshModels(providerId, signal) {
      const refresh = await session.modelRuntime.refresh({ providers: [providerId], signal })
      return !(refresh.aborted || refresh.errors.size > 0)
    },
    compact: () => session.compact(),
  }
  const flows = createHostFlowRuns({
    threadId,
    accounts,
    conversation: {
      askInput: (question, signal) => ui.askHostInput(question, signal),
      select: (message, labels, signal) =>
        ui.uiContext.select(message, [...labels], signal === undefined ? undefined : { signal }),
      input: (message, placeholder, signal) =>
        ui.uiContext.input(message, placeholder, signal === undefined ? undefined : { signal }),
      notify: (text, level) => ui.notifyFrom(ENSO_SENDER, text, level),
    },
    emit,
    announceModelState,
  })

  // ⚠ SUBSCRIBE BEFORE BINDING (#88). Extensions persist state during `session_start` — any
  // `pi.appendEntry` there — and pi emits `entry_appended` to whoever is listening at that moment.
  // Subscribed after `bindExtensions` returned, those entries would go to nobody: the
  // held-until-first-subscriber buffer sits behind THIS subscription. The `ui` notifies cross
  // regardless because `ui` binds `emit` directly. Nothing session_start emits is run progress
  // (`agent_settled` comes from the run loop only), so replaying it into the first run's pump is inert.
  const unsubscribeSession = session.subscribe((event) => {
    try {
      const wire = toRpcWireEvent(event)
      emit(wire)
      // L3 (#162 workstream 4): an `active_agent` entry was appended — a mode was set (#496).
      // Above this seam no surface knows that entry's shape, so the host says what the mode is
      // now, as its own event; the mapper carries it as the `permission-mode` observation.
      if (wire.type === 'entry_appended' && appendedMode(wire.entry) !== undefined) {
        emit({ type: 'permission_mode', ...currentPermissionModeState() })
      }
      // The thinking half of the model state — the module header says why the model half
      // arrives through the watcher extension instead.
      if (wire.type === 'thinking_level_changed') announceModelState()
      // A run the operator stopped (#766) is recorded where a re-read finds it: one entry per
      // stop, appended through the host's extension API so pi also emits `entry_appended` and
      // every follower says it live. pi skips `custom` entries in context: the model never sees it.
      if (event.type === 'agent_settled' && event.aborted) hostApi?.appendEntry(ENSO_RUN_STOPPED_ENTRY, {})
      // #340: the provider refused the request — said beside the failed message's own
      // `message_end`, which stays the accounting boundary it always was.
      // The provider named as a reader knows it (#387): the session's own catalogue first — an
      // extension may have registered the provider — then pi's built-in one.
      const refusal = providerRefusalOf(
        event,
        (providerId) => session.modelRuntime.getProvider(providerId)?.name ?? builtinProviderName(providerId),
      )
      if (refusal !== undefined) emit({ type: 'provider_refused', ...refusal })
      if (growsSessionSpend(event)) announceSessionUsage()
    } catch (error) {
      log.error('a session event could not be emitted: {error}', { threadId, error })
    }
  })

  // Bound ONCE — see the module header. An extension handler that throws (a throwing session_start
  // included) is routed to `onError` and `bindExtensions` still resolves; it crosses as the same
  // `extension_error` record the rpc mode emits.
  await session.bindExtensions({
    uiContext: ui.uiContext,
    mode: EXTENSION_MODE_RPC,
    onError: (error: ExtensionError) => {
      emit({ type: 'extension_error', extensionPath: error.extensionPath, event: error.event, error: error.error })
    },
  })
  // This session's runtime, its extensions' providers registered, is the catalogue's list now (#688).
  catalogueModels.adopt(session.modelRuntime)
  // The model the session STARTS with is on the feed too, not only later changes: no extension is
  // relied on to re-apply it at `session_start` (pi-multi-account follows the branch and calls
  // nothing). Deduped, so an extension's own switch is not said twice.
  announceModelState()

  let disposed = false
  function startPrompt(request: PromptRequest, outcome: PromptOutcome): void {
    let accepted = false
    // ⚠ Fire-and-forget, exactly as pi's rpc mode does: `prompt()` resolves only when
    // the whole run finishes, and awaiting it in front of the drain loop is the
    // original `/mode` hang. Acceptance is the preflight callback; completion is `agent_settled`.
    // @invariant prompt-run-settle/late-rejection-dropped A rejection after acceptance never reaches the feed.
    // It is dropped here on purpose: pi's own rpc-mode handler does the same (dist/modes/rpc/rpc-mode.js,
    // `case "prompt"`), and pi's `_runAgentPrompt` emits `agent_settled` from a `finally`, so the run
    // still terminates; only the error text is lost. Model and tool errors never reach this path: the
    // agent loop turns them into an assistant message with `stopReason: "error"`, carried as usual.
    // @unpinned no host test drives pi's preflight to success and then rejects the prompt.
    void session
      .prompt(request.message, {
        ...(request.images === undefined ? {} : { images: [...request.images] }),
        ...(request.admission === undefined ? {} : { streamingBehavior: STREAMING_BEHAVIOR_OF[request.admission] }),
        source: PROMPT_SOURCE_RPC,
        // pi ≥ 0.99 calls this only for an ACCEPTED prompt, with how it was dispatched
        // (`started`, `queued` or `handled`); a rejected one never calls it and rejects below.
        preflightResult: () => {
          accepted = true
          outcome.onAccepted()
        },
      })
      .catch((error: unknown) => {
        if (!accepted) outcome.onRejected(error instanceof Error ? error.message : String(error))
      })
  }

  function startContinue(outcome: PromptOutcome): void {
    // The run lifecycle's own two states a run cannot start in; the route's lease refuses a
    // run it knows of first — this is the seam's lock. See the module header (#436).
    if (session.isStreaming || session.isCompacting) {
      outcome.onRejected('the thread is running; continue when it settles')
      return
    }
    const lead = continuationLead(session.agent.state.messages)
    if (lead === undefined) {
      outcome.onRejected(NOTHING_TO_CONTINUE)
      return
    }
    // ⚠⚠ The one cast onto pi's private run lifecycle — the module header says why. Checked
    // BEFORE acceptance: an `async` method can only fail synchronously by not being there, and a
    // pi build without it must refuse, not answer 202 to a run that never starts.
    const lifecycle = session as unknown as Partial<PiRunLifecycle>
    if (typeof lifecycle._runAgentPrompt !== 'function') {
      outcome.onRejected(NO_RUN_LIFECYCLE)
      return
    }
    outcome.onAccepted()
    void lifecycle._runAgentPrompt(lead).catch((error: unknown) => {
      log.error('a continued run failed: {error}', { threadId, error })
    })
  }

  /**
   * Start a run, or refuse it: an ended thread (#466 decision 8) admits none — read off the branch
   * at each call, since the ending is a record and a resume refuses the same way — and ⚠ is
   * refused before the trust question, so it asks nothing either. Then the open trust decision
   * (#502): the run waits on the question, never the reverse.
   */
  function admitRun(outcome: PromptOutcome, start: () => void): void {
    const incidents = threadLog.incidents()
    if (incidents.ended) {
      const ending = incidents.incidents.at(-1)?.opened.incidentId
      outcome.onRejected(
        `incident ${ending}'s resolution ended thread ${threadId}; it admits no prompt — fork it to go on`,
      )
      return
    }
    // A delete holds the thread, or has deleted it (#571; a session the registry never held
    // outlives the delete) — nothing more may run on it, nor write its file again.
    if (deletingThreads.has(threadId) || deletedThreads.has(threadId)) {
      outcome.onRejected(`thread ${threadId} is being deleted, or was deleted`)
      return
    }
    // ⚠ The restore route leases the thread, but a prompt that finds it held JOINS the holder
    // (#75) — and pi starts a run for a prompt when none is streaming. So the host refuses it here
    // while the tree is half put back (#551).
    if (restoringTrees.has(threadId)) {
      outcome.onRejected(`thread ${threadId} is restoring its files; prompt again once that is done`)
      return
    }
    trustGate.run(start, (reason) => outcome.onRejected(reason))
  }

  const runtime: ThreadRuntime = {
    prompt(request: PromptRequest, outcome: PromptOutcome): void {
      admitRun(outcome, () => startPrompt(request, outcome))
    },
    continueRun(outcome: PromptOutcome): void {
      admitRun(outcome, () => startContinue(outcome))
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
      commands.push(
        ...hostCommandRows(
          currentModelState(),
          session.modelRuntime.getAvailableSnapshot(),
          getSupportedThinkingLevels,
        ),
      )
      commands.push(...flows.rows())
      commands.push(...HOST_VIEW_ROWS)
      return commands
    },
    loginInProgress: flows.loginInProgress,
    cancelLogin: flows.cancelLogin,
    startHostFlow: flows.startHostFlow,
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
            if (error instanceof Error && /no api key/i.test(error.message)) throw new HostCommandRefused(error.message)
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
    setSystemPrompt(choice: EnsoSystemPromptChoice | null): string | undefined {
      const decision = decideSystemPrompt(systemPrompt, choice, threadLog.hasSentRequest())
      if (decision.kind === 'refused') return decision.reason
      if (decision.kind === 'same') return undefined
      systemPrompt = choice ?? undefined
      // Recorded BEFORE the first request, so the log says what the request will carry; pi
      // flushes it with the first assistant message, as it does the model and the mode. pi's
      // default is recorded too (`null`): it replaces a choice this branch already records.
      threadLog.record(ENSO_SYSTEM_PROMPT_ENTRY, choice)
      // pi re-reads the loader when it rebuilds the prompt; the same tools make it rebuild.
      session.setActiveToolsByName(session.getActiveToolNames())
      if (choice === null) log.info("system prompt set to pi's default", { threadId })
      else
        log.info('system prompt {id} set ({mode})', {
          threadId,
          id: choice.id,
          mode: choice.mode,
          sha256: choice.sha256,
        })
      return undefined
    },
    resolveIncident(incidentId: string, resolution: EnsoIncidentResolution): string | undefined {
      const refusal = incidentResolutionRefusal(threadLog.incidents(), incidentId, resolution)
      if (refusal !== undefined) return refusal
      if (hostApi === undefined) throw new Error(`thread ${threadId}: the host's extension API was never bound`)
      const record = incidentResolvedOf(incidentId, resolution)
      // The record first, then the live guard: were the guard told first, a failed append would
      // leave a lifted suspension no file records (⚠ #466: the records are the authority).
      hostApi.appendEntry(ENSO_INCIDENT_RESOLVED_ENTRY, record)
      hostApi.events.emit(ENSO_INCIDENT_RESOLVED_CHANNEL, record)
      // ⚠ The day's one record of a resolution (#468): the guard's live application logs at debug.
      log.info(ENSO_LOG_EVENTS.incidentResolved, {
        threadId,
        incidentId,
        classification: record.classification,
        outcome: record.outcome,
      })
      return undefined
    },
    setPermissionMode(mode: string, outcome: PromptOutcome): void {
      // Only a mode the extension registers a command for — the runtime treats an unknown
      // slash command as ORDINARY TEXT and would send it to the model as a chat message.
      // Found by the first test that drove this path against the real extension rather
      // than the fake (#162 exit criteria); the route refuses earlier (422), this is the seam's own lock.
      if (!currentPermissionModeState().available.includes(mode)) {
        outcome.onRejected(`mode ${mode} is not one this thread offers`)
        return
      }
      // The extension's command, as the prompt path runs any extension command: fire-and-
      // forget, acceptance is completion, and the change arrives as `permission_mode`.
      runtime.prompt({ message: modeCommand(mode) }, outcome)
    },
    subscribe: channel.subscribe,
    abort(): Promise<void> {
      // A compaction in flight is the run Stop is stopping (#338 slice 4): pi's `abort()` does
      // not cancel it — `abortCompaction()` does, and is a no-op when none is running.
      session.abortCompaction()
      // A run still waiting on the trust question (#502) is dropped, and the question asked again.
      trustGate.abort()
      return stopRunSettlingDialogs(
        () => session.abort(),
        (stopping) => {
          ui.refuseDialogsUntil(stopping)
          ui.abortAllDialogs()
        },
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
      if (liveLogs.get(threadId) === threadLog) liveLogs.delete(threadId)
      flows.dispose()
      trustGate.abort()
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
    emittedEvents: channel.recent,
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
    projectTrust: () => ({ directory: trustDirectory, trusted: projectTrust.settingsManager.isProjectTrusted() }),
    checkPermission: (request: EnsoPermissionCheckRequest) =>
      permissionVerdictOf(threadLog.threadId, threadLog.everyEntry(), request),
    ...logReads({ threadLog, listCommands: () => runtime.listCommands(), locate, judgeCaseInputs }),
    previewSystemPrompt: (candidate: EnsoSystemPromptChoice | null) =>
      previewOnSession(
        {
          session,
          resourceLoader: services.resourceLoader,
          kept: () => systemPrompt,
          setChoice: (choice) => {
            systemPrompt = choice
          },
        },
        candidate,
      ),
  }
}
