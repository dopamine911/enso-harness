import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type ExtensionError,
  type InlineExtension,
  initTheme,
  ModelRuntime,
  VERSION as PI_VERSION,
  type PromptOptions,
  ProjectTrustStore,
  type SessionEntry,
  type SessionInfo,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import {
  type DialogAnswer,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_RESOLVED_CHANNEL,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_LOG_EVENTS,
  ENSO_PROJECT_TRUST_ENTRY,
  ENSO_SYSTEM_PROMPT_ENTRY,
  type EnsoForkPoint,
  type EnsoIncidentOpened,
  type EnsoIncidentResolution,
  type EnsoHostCommandRun,
  type EnsoModelState,
  type EnsoObservation,
  type EnsoLoginInProgress,
  type EnsoOpenDialog,
  type EnsoPermissionCheckRequest,
  type EnsoPermissionModeName,
  type EnsoPermissionModeState,
  type EnsoPermissionVerdict,
  type EnsoPromptAdmission,
  type EnsoRecordedModel,
  type EnsoRiskThresholds,
  type EnsoSessionIncidents,
  type EnsoSessionUsage,
  type EnsoSystemPromptChoice,
  type EnsoSystemPromptPreview,
  type EnsoThreadEvent,
  type EnsoTranscriptEntry,
  ensoLogger,
  customEntriesOf,
  transcriptEntryOf,
  type HostFlowOutcome,
  incidentResolutionRefusal,
  incidentResolvedOf,
  type PromptOutcome,
  type PromptRequest,
  modeAgentName,
  openIncidentOf,
  type RuntimeCommand,
  readRecordedMode,
  recordedPermissionMode,
  recordedSystemPrompt,
  sessionIncidentsOf,
  THREAD_PROJECT_TRUST,
  type ThreadRuntime,
  DEFAULT_GUARD_POLICY,
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_RESTORED_ENTRY,
  isEnsoProjectId,
  type ThreadTreeKind,
  type ThreadTreeRecord,
} from '@enso/core'
import {
  ensoHome,
  ensoSecretsPath,
  findRepoRoot,
  projectSessionsDir,
  projectSnapshotsDir,
  realpathOrSelf,
} from '@enso/core/paths'
import { describePermissionPolicy, preparePermissionPolicy } from '@enso/core/permission-rules'
import { knownSecretValues, quarantineSecrets } from '@enso/core/secrets'
import {
  disposeThreadTree,
  holdingReason,
  inventoryThreadTree,
  mintThreadTree,
  releaseThreadStore,
  restoreThreadTree,
  sweepOrphanedStores,
  treeKindFor,
} from '@enso/core/thread-tree'
import { getPermissionsService } from '@gotgenes/pi-permission-system'
import { type BranchContext, type BranchRequestDetail, branchContext, branchRequestDetail } from './branch-context.ts'
import { type BranchEval, branchEval } from './branch-eval.ts'
import { type BranchIncidentHistory, branchIncidentHistory } from './branch-incident-history.ts'
import { type BranchJudgeCases, branchJudgeCases, type JudgeCaseInputs } from './branch-judge-cases.ts'
import { type BranchStats, branchStats } from './branch-stats.ts'
import { type ContinuationLead, continuationLead, NO_RUN_LIFECYCLE, NOTHING_TO_CONTINUE } from './continuation.ts'
import { createEventTail, describeObservation } from './event-tail.ts'
import { createEnsoExtensionUiContext } from './extension-ui-context.ts'
import { forkPointOf } from './fork-point.ts'
import {
  catalogueRows,
  decideHostCommand,
  HOST_VIEW_ROWS,
  HostCommandRefused,
  hostCommandRows,
} from './host-commands.ts'
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
  loginCodeQuestion,
  loginDoneText,
  loginOptions,
  logoutDoneText,
  logoutOptions,
  type StoredCredentialFacts,
} from './host-flows.ts'
import { mapPiEvent } from './map-events.ts'
import { attributeNotices, ENSO_SENDER } from './notice-sender.ts'
import {
  freshPermissionModeState,
  livePermissionModeState,
  modeCommand,
  storedPermissionModeState,
} from './permission-mode-adapter.ts'
import {
  createTrustGate,
  hostedProjectTrust,
  PROJECT_TRUST_OPTIONS,
  projectTrustedNotice,
  projectTrustQuestion,
} from './project-trust.ts'
import { builtinProviderName, providerRefusalOf } from './provider-refusal.ts'
import type { RuntimeEvent } from './runtime-event.ts'
import { toRpcWireEvent } from './session-events.ts'
import { growsSessionSpend, liveSessionUsage, storedSessionUsage } from './session-usage.ts'
import { previewOf, renderedUnder } from './system-prompt-preview.ts'
import { decideSystemPrompt, hasSentRequest, withSystemPrompt } from './system-prompt.ts'
import {
  hasEntry,
  lastRestoreOf,
  projectIdOfCwd,
  sessionDirectoryFor,
  snapshotAtEntry,
  treeLocation,
  treeRecordOf,
} from './thread-trees.ts'
import { recordedModelOf, transcriptOf } from './transcript.ts'

const log = ensoLogger('host')

/**
 * pi, hosted IN THIS PROCESS (#69) — the web server's replacement for spawning
 * `pi --mode rpc` per prompt.
 *
 * pi's own rpc docs: "If you're building a Node.js application, consider using
 * `AgentSession` directly … instead of spawning a subprocess." This module is that: one
 * `createAgentSessionServices` + `createAgentSessionFromServices` per hosted session, the
 * harness package loaded through the SAME loader path the CLI's `-e <dir>` uses, and our
 * `ExtensionUIContext` bound so dialogs reach the browser (#27) and the extensions' `hasUI` is true.
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
 * ⚠⚠ …AND SO IS ONE `authErrorPatterns` ENTRY (#341). With no Cursor login, multi-account's own
 * Cursor proxy throws "No Cursor account is logged in for this request" and answers it as
 * `500 server_error` (`cursor/proxy.ts`), and its classifier reads the `500` as TRANSIENT: the
 * thread said "temporary error … send a new message to retry" to someone who can only fix it by
 * logging in (reproduced on a fresh `ENSO_HOME`, 1.23.2). The entry makes it an AUTH failure —
 * "authorization is invalid. Run /login …", no automatic resume. The vendor's list only grows
 * (`patternsWithDefaults`), so this adds to its defaults and to anything the operator listed.
 * Tied to the proxy's wording: if that changes, behaviour falls back to today's, and
 * `agent-host.test.ts` goes red against the real proxy. Leaves when the proxy answers 401.
 *
 * ⚠⚠ …AND `includeCursor: false`, UNLESS THE OPERATOR SET IT. multi-account ships its Cursor
 * provider inside the package, so its default (`true`) registers `cursor` and a spare
 * `cursor-account-2` whether or not anyone has a Cursor login, and publishes both into pi's
 * `models.json` with a placeholder key (`cursor-proxy`) against its loopback proxy. pi reads a key
 * as a credential, so every Cursor model was offered as usable — in the Start dialog, in the model
 * picker, and as the default model #341 lost two hours to. Cursor is opt-in here: `"includeCursor":
 * true` in the file turns it back on and is kept. The vendor never removes a Cursor publication
 * (`dropOwnLoopbackPublications` skips them), so with Cursor off the seed also drops the ones it
 * left in `models.json` — by the test the vendor applies to its other loopback publications
 * (`slot-proxy.ts#isOwnLoopbackPublication`): the placeholder key against a loopback `baseUrl`. An
 * operator's `modelOverrides`, which the vendor carries into every republication, are theirs and
 * stay, as `{ modelOverrides }` alone (the vendor's own collapse; pi accepts an overrides-only
 * entry, and for Cursor it offers no model); the route and its placeholder credential go.
 *
 * ⚠⚠ THE PERMISSION ENGINE READS `ENSO_HOME/permissions.json` THROUGH A LINK (#446, #496), prepared
 * first. The engine reads its policy from `<agentDir>/extensions/pi-permission-system/config.json`
 * and takes no path from the environment, so `preparePermissionPolicy`
 * (`@enso/core/permission-rules`) links that path to the user's file, seeds the file when it holds
 * no policy, and writes the mode agents (`<agentDir>/agents/enso-mode-*.md`) the mode presets live
 * in. It runs after `PI_CODING_AGENT_DIR` names the agent dir and before the first services: the
 * engine reads both when the extension loads, per session.
 *
 * ⚠⚠ EVERY THREAD IS A MULTI-ACCOUNT ROOT: `PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS=1` (#351).
 * pi-multi-account keeps ONE root session per process for terminal pi — a lease on
 * `globalThis[Symbol.for('pi-multi-account:active-root-session')]` — and a session that starts
 * while it is held goes passive: accounts register, automatic failover is off. Here every thread
 * is a session in this one process and an idle one stays live for 30 minutes
 * (`thread-registry.ts`), so the thread in use would usually be the passive one. Since 1.23.2 the
 * extension skips the lease for a multi-session host that says so (Sarrius/pi-multi-account#73,
 * asked for from here): the host sets the switch before the first session, and every
 * `session_start` becomes an independent root with its own failover. Not `PI_WEB_SESSION`,
 * pi-web's own marker — other extensions read it to mean pi-web. The switch is read per session
 * (the extension's factory), so it stays set; every `bash` child inherits it, which is harmless —
 * a terminal pi started from a tool would treat its own in-process sessions as roots too.
 * `__tests__/agent-host.test.ts` builds two concurrent threads and goes red if either is passive.
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
 * an extension is the only honest listener for a model change. pi (0.87.1; re-read at 0.99.2, line numbers 0.87.1's) announces a model
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
 *
 * ⚠ A FORK IS TAKEN FROM THE FILE, OUTSIDE ANY RUNTIME (#433). `forkThread` opens the source's
 * session file (`SessionManager.open`, building nothing — #86) and forks it the way pi's `/fork`
 * does at its default position `before` (`AgentSessionRuntime.fork`, `agent-session-runtime.js`
 * :174): the entry must be a user message; the new session's branch ends at that message's
 * PARENT (`createBranchedSession`), or is empty when the message is the root (`create` +
 * `newSession({ parentSession })`); the message's text comes back to prefill the composer. A live
 * source and a cold one fork alike — a live thread's file holds every entry its memory does once
 * flushed, and one never flushed has no file to fork. Stated non-coverage: outside a runtime pi's
 * `session_before_fork` extension hook does not fire; no loaded extension handles it today. pi
 * writes a session file only at its first assistant message, so a fork whose branch holds none
 * (the empty one above) would have no file — nothing to list, nothing naming its parent, and a
 * resume under its id would create a fresh session. The host writes such a fork's entries the way
 * pi's first flush does (`_persist`: one JSON line per entry, `wx`), and pi appends to it from
 * then on as to any flushed file.
 *
 * A FORK POINT IS READ OFF THE BRANCH (#435). `forkPoint` (live) and `readStoredForkPoint` (cold,
 * one open, nothing built) walk the same branch with `fork-point.ts`: the session id, the leaf,
 * the parent the listing resolves (#433), then the recorded model and level (#434), the last
 * mode, the cwd and the latest `enso-run-context` the harness's `run-context` extension wrote.
 *
 * ⚠⚠ CONTINUE RUNS ON pi'S PRIVATE RUN LIFECYCLE (#436). `continueRun` resumes a torn thread from
 * exactly its stored state — no new user message — by calling `AgentSession._runAgentPrompt(lead)`
 * (`agent-session.js:1078`, `private` in `agent-session.d.ts:403`, an ordinary method at run time)
 * through ONE cast (`PiRunLifecycle`). pi (0.87.1, and still 0.99.2) has no public continue that runs inside that
 * lifecycle, and the lifecycle is what makes it a run: `session.agent.continue()` alone persists the
 * reply and fires the guards, but never emits `agent_settled` (the route releases the lease on
 * `settled`, so the thread stayed busy forever), leaves `isStreaming` false (a prompt enqueued during
 * it was accepted and lost, with a spurious `settled` mid-run), skips auto-retry, and lets `abort()`
 * resolve before the run stopped (the spike on #436). `_runAgentPrompt` is what `prompt()` itself
 * ends in (`:1331`). Whether the tail CAN be continued is decided here, not by pi
 * (`continuation.ts`): the lifecycle would answer a completed reply again. The accepted differences
 * from a prompt: no `input` or `before_agent_start` for the continued turn — so no permission-mode
 * reminder and no pi-multi-account last-moment account preflight (the harness's `enso-run-context`
 * IS re-checked, from `agent_start`, #445); no auth preflight (missing credentials become a stored
 * error reply, and the run settles); no pre-prompt compaction check (the post-run one still runs);
 * and the first request reuses the system prompt the transcript holds. `agent-host.test.ts` pins the lifecycle
 * through the real host and pi's faux provider, so a pi bump that renames or reshapes the method is
 * a red test, not a silent break. The cast leaves when pi ships a public `AgentSession.continue()`.
 */

/** The agent dir's multi-account config file, and the keys this host seeds in it. */
const MULTI_ACCOUNT_CONFIG_FILENAME = 'provider-failover.json'
const MULTI_ACCOUNT_CHILD_PROXY_KEY = 'childProxy'
const MULTI_ACCOUNT_AUTH_PATTERNS_KEY = 'authErrorPatterns'
const MULTI_ACCOUNT_INCLUDE_CURSOR_KEY = 'includeCursor'
/** Matched case-insensitively as a substring of the error text — see the module header (#341). */
const MULTI_ACCOUNT_AUTH_PATTERNS: readonly string[] = ['account is logged in for this request']

/**
 * pi's provider registry in the agent dir, and how multi-account publishes a Cursor slot into it:
 * a Cursor slot id (`cursor-bridge.ts#isCursorProviderId`), the placeholder key
 * (`cursor-bridge.ts#CURSOR_PROXY_PLACEHOLDER_KEY`) and a loopback `baseUrl`.
 */
const PI_MODELS_FILENAME = 'models.json'
const CURSOR_SLOT_ID = /^cursor(-account-\d+)?$/
const CURSOR_PROXY_PLACEHOLDER_KEY = 'cursor-proxy'
const CURSOR_LOOPBACK_PREFIX = 'http://127.0.0.1:'

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

/**
 * The one member of pi's private run lifecycle `continueRun` calls (#436, module header): run the
 * agent from `messages` with retry, compaction recovery, queued prompts and `agent_settled`.
 */
interface PiRunLifecycle {
  _runAgentPrompt(messages: ContinuationLead): Promise<void>
}

/**
 * A login while it runs (#388): whose, the page its flow announced (the code prompt links to it),
 * and the end of its questions — see `runLogin`.
 */
interface LoginInProgress {
  readonly providerName: string
  authUrl: string | undefined
  readonly questions: AbortController
  /**
   * Stop, for this login only (#348): aborting it ends the provider wait (a device-code poll, a
   * browser callback). `flowsAbort` is the SESSION's and final; this one leaves the session be.
   */
  readonly cancel: AbortController
}

export interface AgentHostOptions {
  /**
   * Which directories this host may run a session in and serve stored sessions from — the
   * server's projects (#395). REQUIRED, never defaulted: with no sandbox (#24) a session's
   * directory is its blast radius, and "every directory" must not be what forgetting it means.
   * A stored session whose own directory fails it is not listed, not read, and not resumed.
   */
  servesDirectory: (directory: string) => boolean
  /** Scratch config dir — the operator's own packages and credentials stay invisible. */
  agentDir: string
  /** The enso harness pi package directory; loaded as the ONLY extension source. */
  harnessPackageDir: string
  /**
   * The permission policy file (`ENSO_HOME/permissions.json`, #446, #496) — see the module header.
   * REQUIRED, never defaulted: forgetting it would run the engine on whatever its own config path
   * held, not the user's policy.
   */
  permissionRulesPath: string
  /**
   * The project folders (`ENSO_HOME/projects`, #552): a thread's session is filed under its
   * project's `sessions/` — `projectSessionsDir(projectsDir, projectIdOf(cwd))` — whatever cwd it
   * runs in, and every project's folder is listed beside pi's own session directories. Absent, pi
   * files sessions where it does by default (`<agentDir>/sessions/<encoded-cwd>/`): tests, and a
   * launcher that has not set a home.
   */
  projectsDir?: string
  /**
   * Each new thread's own tree (#551), per project (canonical path): `'worktree'` — a worktree of
   * the checkout under `ENSO_HOME/projects/<id>/trees/`, on its own branch, at the checkout's
   * current state — or `'copy'` (also what a project that is no repository's top level gets);
   * `'off'`, or no function at all, runs threads in the checkout itself, as before #551: tests, and
   * a launcher without a home. Needs `projectsDir`. A thread already on a tree stays on it whatever
   * this says.
   */
  threadTree?: (project: string) => ThreadTreeKind | 'off'
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
  /** The branch as the session eval reads it (#441): the transcript and the turns' usage. */
  branchEval(): BranchEval
  /** The branch's incident history (#468): records, their entries as stored, and a replay under `thresholds`. */
  branchIncidentHistory(thresholds: EnsoRiskThresholds): BranchIncidentHistory
  /** The branch's judge cases (#469): each call the judge would be asked about, and its redacted state. */
  branchJudgeCases(thresholds: EnsoRiskThresholds): BranchJudgeCases
  /** The branch's context, request by request (#361): what each was assembled from, by pi's own assembly. */
  branchContext(): BranchContext
  /**
   * The system prompt the next request would carry under `candidate` — pi's default for `null` —
   * section by section (#443). Changes nothing: the thread keeps its own choice. `busy` while a run
   * is in flight; `unsplittable` when pi's rendering does not split back into itself.
   */
  previewSystemPrompt(candidate: EnsoSystemPromptChoice | null): SystemPromptPreviewOutcome
  /** One request's context, element by element (#361 phase 3); undefined for a turn the branch does not have. */
  branchRequestDetail(request: number | 'next'): BranchRequestDetail | undefined
  /** The branch's fork point (#435): identity, then what it runs under — the manifest's live half. */
  forkPoint(): Promise<EnsoForkPoint>
  /**
   * What the loaded extensions would say about a tool call, through the runtime's own hook
   * runner — the verdict a model's call would meet, without a model. Inspection, like the
   * rest of this interface: the guards' contract is pinned in their own suite against a
   * hand-built ExtensionAPI; this is the one place the REAL runner, the real load order and
   * the real participants are asked together (docs/flows/guarded-tool-call.md, stated gap).
   * Runs no tool: a pass here is the hook's silence, not an execution.
   */
  probeToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallVerdict | undefined>
  /**
   * The permission engine's own verdict for a value on a surface, in this thread's mode NOW (#474):
   * what a call carrying it would meet, the pattern that decided it and where that rule came from
   * (`global`, the user's file; `agent`, the mode's preset). Asked of the engine the session runs —
   * never a second matcher. `undefined` when the engine has published no service for the session.
   */
  checkPermission(request: EnsoPermissionCheckRequest): EnsoPermissionVerdict | undefined
}

/**
 * The `/login` facts pi's model runtime knows about each provider — a session's, or the
 * catalogue's over the agent dir alone (#484); one reading, so the two lists cannot drift.
 */
function loginFactsOf(modelRuntime: ModelRuntime): LoginProviderFacts[] {
  return modelRuntime.getProviders().map((provider) => {
    const status = modelRuntime.getProviderAuthStatus(provider.id)
    return {
      id: provider.id,
      name: provider.name,
      offersOAuth: provider.auth.oauth !== undefined,
      offersApiKeyLogin: provider.auth.apiKey?.login !== undefined,
      configuredVia: status.configured ? (status.label ?? status.source) : undefined,
    }
  })
}

/** A refusal from the `tool_call` hook, as the runtime's runner returns it — nothing when every handler passed. */
export interface ToolCallVerdict {
  readonly block: boolean
  readonly reason: string | undefined
}

/** What a preview answers (#443): the preview, or why there is none. */
export type SystemPromptPreviewOutcome =
  | { readonly kind: 'preview'; readonly preview: EnsoSystemPromptPreview }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unsplittable' }

/** One of pi's session files in a directory this host serves, as pi lists it (#95). */
export interface StoredThread {
  /** pi's session id — the thread id it was created under. */
  readonly id: string
  readonly path: string
  /** The directory the session runs in — pi's header records it at creation, and it never changes (#395). */
  readonly cwd: string
  readonly modified: Date
  readonly messageCount: number
  /** The first user message, verbatim; empty for a session with none. */
  readonly firstMessage: string
  /**
   * The thread it was forked from (#433): its header's `parentSession` file, as that file's
   * session id. Absent for a thread that is no fork, and for one whose parent file is gone.
   */
  readonly parentThreadId?: string
}

/**
 * A fork (#433), or why not. The refusals are the host's to decide and the route's to say:
 * `no-thread` — no session file under the id in a served project; `no-entry` — the file has no
 * entry under the id; `not-a-user-message` — pi forks only at a user message; `tree-refused` — the
 * fork's own tree could not be minted (#551), so no fork was made.
 */
export type ThreadForkOutcome =
  | { readonly kind: 'forked'; readonly threadId: string; readonly prefill: string }
  | { readonly kind: 'no-thread' | 'no-entry' | 'not-a-user-message' | 'tree-refused'; readonly reason: string }

/**
 * What restoring a thread's tree to an entry's snapshot answers (#551): the restored hash and the
 * safety snapshot of the files it replaced, or why nothing was restored.
 */
export type ThreadRestoreOutcome =
  | { readonly kind: 'restored'; readonly hash: string; readonly safety: string }
  | {
      readonly kind: 'no-thread' | 'no-entry' | 'no-tree' | 'no-snapshot' | 'no-restore' | 'superseded'
      readonly reason: string
    }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * What deleting a thread answers (#571): deleted — its session file, its tree and its store, or the
 * store kept for the forks that lean on it — or why nothing was deleted. `holds-work` is the
 * tree's inventory refusing (forceable); `busy`, a run, a move, a restore or another delete holding
 * the thread; `refused`, a removal that failed.
 */
export type ThreadDeleteOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'no-thread' | 'busy' | 'holds-work' | 'refused'; readonly reason: string }

/** A thread deleted, or being deleted, is never built again under its id (#571): a stale page's prompt is refused. */
export class ThreadDeleted extends Error {
  override readonly name = 'ThreadDeleted'
}

/**
 * Stop: tell the runtime, then settle every pending question WHILE it stops, then wait for it.
 *
 * @invariant dialog-ask-answer-settled/stop-stops Stop stops: the run's abort settles every pending dialog as `aborted`.
 * The runtime is told FIRST so its loop holds the abort signal when a blocked `tool_call` handler returns
 * (a permission prompt): pi's `abort()` raises it synchronously, before its first `await`
 * (`agent-session.js` `abort` → `agent.abort()`). Then, while the runtime winds down, `abortAllDialogs()`
 * resolves each pending question to its cancel value with the glossary's outcome for exactly this,
 * `aborted`, and every follower hears `dialog-settled`; `refuseDialogsUntil` answers any question asked
 * before the stop finishes with its cancel value, showing nothing (ask_user's multi-select asks the next
 * option). Never only after the abort resolves: a question from a tool's `execute` (ask_user) holds the
 * run, pi's `abort()` waits for idle, and such a stop waited on the card for ever (#376 review). Before
 * 2026-09-16 the host settled nothing on abort, and the vendor's permission prompt passes no signal of its
 * own, so Stop during it waited on a human (decided, Daniel: if the user says stop, it's stop).
 *
 * A stop must stop (thread-registry.test.ts's rule, one layer down): the dialogs settle even if the
 * runtime's abort rejects; the rejection still propagates, the cards still drop. Exported so that path
 * is pinned against a stop that rejects, which the real runtime's is not made to do.
 */
export async function stopRunSettlingDialogs(
  stopRuntime: () => Promise<void>,
  settleDialogs: (stopping: Promise<void>) => void,
): Promise<void> {
  const stopping = stopRuntime()
  settleDialogs(stopping)
  await stopping
}

/**
 * The host will not run this thread where it would have to: its stored session, or its new one,
 * is in a directory the server does not serve (#395). A refusal the server decided — never a
 * fault — so the routes answer it with its reason rather than as a failed request.
 */
export class SessionDirectoryRefused extends Error {
  override readonly name = 'SessionDirectoryRefused'
}

export interface AgentHost {
  /**
   * A session for this thread, with its own services, extensions bound, events flowing.
   *
   * ⚠ THE THREAD ID IS PI'S SESSION ID (#95). A session file already under that id is
   * OPENED, in the directory its header records — the thread idled out, or the server
   * restarted, and the user came back; otherwise a fresh session is CREATED with the id in
   * `newSessionDirectory`. So resume needs no id mapping and no index file: pi's own listing is
   * the one source, and a page-owned thread finds its own file again across a server restart.
   * Either directory must pass `servesDirectory`, or nothing is built: `SessionDirectoryRefused`.
   *
   * `newSessionDirectory` is asked only when there is no session file under the id (PR #399
   * review). A thread that has one never depends on where a NEW thread would go: a project it
   * was once named for can be removed, or its directory deleted, and it still resumes.
   */
  createSession(threadId: string, newSessionDirectory: () => string): Promise<HostedThread>
  /** pi's session files in the directories this host serves, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * The directory of the session file under this id — WHETHER OR NOT this host serves it —
   * `undefined` when there is no file. What lets a reader tell "a thread that was never stored"
   * from "a thread whose project is gone" (PR #399 review): `readStoredThread` answers `undefined`
   * for both.
   */
  storedThreadDirectory(threadId: string): Promise<string | undefined>
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
  /** A stored thread's context, request by request (#361) — one open, nothing built (#86). */
  readStoredThreadContext(threadId: string): Promise<StoredThreadContext | undefined>
  /** One request of a stored thread, element by element (#361 phase 3); undefined for no file or no such turn. */
  readStoredRequestDetail(threadId: string, request: number | 'next'): Promise<BranchRequestDetail | undefined>
  /**
   * A stored thread's fork point (#435): identity and run conditions off its branch, one open,
   * nothing built (#86); undefined for no file in a served project.
   */
  readStoredForkPoint(threadId: string): Promise<EnsoForkPoint | undefined>
  /** A stored thread as the session eval reads it (#441): one open, nothing built (#86); undefined for no file. */
  readStoredThreadEval(threadId: string): Promise<BranchEval | undefined>
  /** A stored thread's incident history (#468): one open, nothing built (#86); undefined for no file. */
  readStoredIncidentHistory(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchIncidentHistory | undefined>
  /** A stored thread's judge cases (#469): one open, nothing built (#86); undefined for no file. */
  readStoredJudgeCases(threadId: string, thresholds: EnsoRiskThresholds): Promise<BranchJudgeCases | undefined>
  /**
   * Fork a stored thread at one of its user messages, as pi's `/fork` does (#433; the module
   * header): a new session file naming the source as its parent, holding everything before that
   * message, and the message's text to prefill with. The source's file is not written; nothing is
   * built for either thread (#86).
   */
  forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome>
  /** Restore the thread's tree to the snapshot recorded at or before `entryId` (#551); the conversation is unchanged. */
  restoreThreadAt(threadId: string, entryId: string): Promise<ThreadRestoreOutcome>
  /** Undo the thread's last restore (#565): its tree back to that restore's safety snapshot, itself recorded as a restore. */
  undoLastRestore(threadId: string, safety: string): Promise<ThreadRestoreOutcome>
  /**
   * Delete the thread (#571): its tree through the inventory (`force` deletes a tree holding work
   * too), its store — kept, orphaned, while a fork leans on it — then every session file under its
   * id. `retire` disposes the live session and refuses a busy one: the registry's, which the host
   * does not hold. Hard: nothing is kept to undo it.
   */
  deleteThread(
    threadId: string,
    options: { readonly force: boolean; readonly retire: () => boolean },
  ): Promise<ThreadDeleteOutcome>
  /** Whether a NEW thread in `project` gets a tree of its own (#551): a projects folder, and trees not `off` for it. */
  mintsTreesIn(project: string): boolean
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): EnsoPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState
  /**
   * The host rows a thread with no session can be offered (#484): `/model` with every model pi
   * could run right now, `/login`, and `/logout` when something is stored — read from pi's own
   * auth and models files in the agent dir, NOTHING BUILT (#86). No `value` (a thread with no
   * session has no current model), no `/thinking` (its levels are the chosen model's, carried on
   * each `/model` option), and none of a session's rows: `/compact`, the views, pi's extension
   * commands. Read afresh per call, so a login through one thread shows at once.
   */
  catalogue(): Promise<RuntimeCommand[]>
}

/** One stored session as `readStoredThread` reads it — both halves from one open of the file. */
export interface StoredThreadRead {
  /** The directory the session runs in (#395), from its header. */
  readonly cwd: string
  /** The branch, root to leaf. */
  readonly transcript: EnsoTranscriptEntry[]
  /** Every usage in the file, on every branch, by pi's rule (`session-usage.ts`); no context. */
  readonly usage: EnsoSessionUsage
  /** What the branch records it last ran on (#434); `undefined` when it records neither a model nor a level. */
  readonly recordedModel: EnsoRecordedModel | undefined
}

/** A stored thread as `readStoredThreadStats` reads it. */
export interface StoredThreadStats {
  readonly usage: EnsoSessionUsage
  readonly branch: BranchStats
}

/** A stored thread as `readStoredThreadContext` reads it. */
export interface StoredThreadContext {
  readonly usage: EnsoSessionUsage
  readonly context: BranchContext
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
 * Seed the agent dir's multi-account config — see the module header: pin `childProxy: false`, add
 * Enso's `authErrorPatterns` to the operator's (#341), and turn Cursor off unless the operator
 * set `includeCursor` — then, with Cursor off, drop the Cursor slots multi-account left in pi's
 * `models.json`.
 *
 * Creates the file if absent; otherwise reads, sets what is missing, writes — and only when
 * something changed. Every other key, and every entry the operator listed, is kept verbatim;
 * a pattern already there in any case is not added twice (the vendor compares them that way).
 */
export function seedMultiAccountConfig(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })
  const configPath = join(agentDir, MULTI_ACCOUNT_CONFIG_FILENAME)
  let existing: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  }
  const listed = existing[MULTI_ACCOUNT_AUTH_PATTERNS_KEY]
  // Kept as the operator wrote it, non-strings included (the vendor skips those; the file is theirs).
  const operatorEntries: readonly unknown[] = Array.isArray(listed) ? listed : []
  const missingPatterns = MULTI_ACCOUNT_AUTH_PATTERNS.filter(
    (pattern) =>
      !operatorEntries.some((known) => typeof known === 'string' && known.toLowerCase() === pattern.toLowerCase()),
  )
  // The vendor reads `includeCursor ?? true`, so `null` is as unset as absent.
  const operatorCursor = existing[MULTI_ACCOUNT_INCLUDE_CURSOR_KEY]
  const cursorUnset = operatorCursor === undefined || operatorCursor === null
  if (existing[MULTI_ACCOUNT_CHILD_PROXY_KEY] !== false || missingPatterns.length > 0 || cursorUnset) {
    const seeded = {
      ...existing,
      [MULTI_ACCOUNT_CHILD_PROXY_KEY]: false,
      [MULTI_ACCOUNT_AUTH_PATTERNS_KEY]: [...operatorEntries, ...missingPatterns],
      ...(cursorUnset ? { [MULTI_ACCOUNT_INCLUDE_CURSOR_KEY]: false } : {}),
    }
    writeFileSync(configPath, `${JSON.stringify(seeded, null, '\t')}\n`)
  }
  // …and by truthiness (`if (!config.includeCursor)`), so this does too — unset included.
  if (!operatorCursor) dropCursorPublications(agentDir)
}

/** A `models.json` entry multi-account published for a Cursor slot: the placeholder key against a loopback `baseUrl`. */
function isCursorPublication(providerId: string, entry: unknown): entry is Record<string, unknown> {
  if (!CURSOR_SLOT_ID.test(providerId) || typeof entry !== 'object' || entry === null) return false
  const record = entry as Record<string, unknown>
  return (
    record.apiKey === CURSOR_PROXY_PLACEHOLDER_KEY &&
    typeof record.baseUrl === 'string' &&
    record.baseUrl.startsWith(CURSOR_LOOPBACK_PREFIX)
  )
}

/** What of a Cursor publication is the operator's: its `modelOverrides`, when there are any. */
function operatorOverlay(publication: Record<string, unknown>): { modelOverrides: object } | undefined {
  const overrides = publication.modelOverrides
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return undefined
  return Object.keys(overrides).length > 0 ? { modelOverrides: overrides } : undefined
}

/**
 * Remove multi-account's Cursor publications from pi's `models.json` — see the module header: each
 * route goes, an operator's `modelOverrides` stay. Every other provider and key is kept verbatim;
 * the file is written only when a publication was found.
 */
function dropCursorPublications(agentDir: string): void {
  const modelsPath = join(agentDir, PI_MODELS_FILENAME)
  if (!existsSync(modelsPath)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8'))
  } catch {
    // pi's file, and pi reports a malformed one when it loads it; there is nothing of ours to drop.
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const models = parsed as Record<string, unknown>
  const providers = models.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
  const entries = Object.entries(providers)
  if (!entries.some(([providerId, entry]) => isCursorPublication(providerId, entry))) return
  const kept = entries.flatMap(([providerId, entry]): [string, unknown][] => {
    if (!isCursorPublication(providerId, entry)) return [[providerId, entry]]
    const overlay = operatorOverlay(entry)
    return overlay === undefined ? [] : [[providerId, overlay]]
  })
  // Staged and renamed over, as the vendor writes it: pi never reads a half-written registry.
  const staging = `${modelsPath}.enso.tmp`
  writeFileSync(staging, `${JSON.stringify({ ...models, providers: Object.fromEntries(kept) }, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(staging, modelsPath)
}

/** `RuntimeCommand` with `description` present only when pi supplied one (`exactOptionalPropertyTypes`). */
function describeCommand(
  name: string,
  source: RuntimeCommand['source'],
  description: string | undefined,
): RuntimeCommand {
  return description === undefined ? { name, source } : { name, source, description }
}

/** A user message's text as pi's `/fork` prefills it (`extractUserMessageText`): its text parts, joined; images dropped. */
function userMessageText(content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
}

/**
 * A fork pi has not written because its branch holds no assistant message (the module header,
 * #433): its header and entries, written as pi's first flush writes them, so the fork is listed,
 * names its parent, and resumes under its id. A file already there — pi wrote it — is left alone.
 */
function writeUnflushedSession(session: SessionManager): void {
  const file = session.getSessionFile()
  if (file === undefined || existsSync(file)) return
  const lines = [session.getHeader(), ...session.getEntries()].map((fileEntry) => `${JSON.stringify(fileEntry)}\n`)
  writeFileSync(file, lines.join(''), { flag: 'wx' })
}

/** A branch's incidents (#466): its custom entries, folded as the guard folds them on replay. */
function branchIncidents(branch: readonly SessionEntry[]): EnsoSessionIncidents {
  return sessionIncidentsOf(customEntriesOf(transcriptOf(branch)))
}

/** The mode one appended entry records, if it is an `active_agent` entry naming one. */
function appendedMode(entry: unknown): EnsoPermissionModeName | undefined {
  const record = transcriptEntryOf(entry, 0)
  return record.kind === 'custom' ? readRecordedMode(record.customType, record.data) : undefined
}

/**
 * The opening a fork records for the source's open incident (#466 decision 5): its own id, so the
 * fork is resolved on its own, and the source's signals, halt, suspension and model (when it named
 * one, #468), pointing back at the source's thread and incident.
 */
function inheritedOpening(sourceThreadId: string, source: EnsoIncidentOpened): EnsoIncidentOpened {
  return {
    incidentId: crypto.randomUUID(),
    signals: source.signals,
    halted: source.halted,
    suspended: source.suspended,
    ...(source.model === undefined ? {} : { model: source.model }),
    inheritedFrom: { threadId: sourceThreadId, incidentId: source.incidentId },
  }
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { agentDir, harnessPackageDir, servesDirectory, projectsDir } = options
  /** Where a thread in `cwd` is filed (#552): its project's `sessions/` — the checkout's or a tree's; pi's default when no projects folder is set. */
  const sessionDirFor = (cwd: string): string | undefined =>
    projectsDir === undefined ? undefined : sessionDirectoryFor(projectsDir, cwd)
  /** The tree kind new threads in `project` get (#551), or none: needs a projects folder to put trees in. */
  const treeKindOf = (project: string): ThreadTreeKind | undefined => {
    const chosen = projectsDir === undefined ? undefined : options.threadTree?.(realpathOrSelf(project))
    return chosen === undefined || chosen === 'off' ? undefined : chosen
  }

  // Order matters, and it is the module header's ⚠⚠ items: env before any pi module can
  // be imported by the loader, the proxy pin and the independent-roots switch before the first
  // session_start, and the secrets out of the environment before anything can inherit it (#89).
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS = '1'
  // This host decides project trust (#502), so the harness's own `.enso/config.json` question follows
  // pi's answer instead of asking a second time (`harness/core/session-config.ts`, which reads it by
  // `@enso/core`'s `ENSO_PROJECT_TRUST_BY_HOST`). Written literally, as the environment inventory reads.
  process.env.ENSO_PROJECT_TRUST_BY_HOST = '1'
  seedMultiAccountConfig(agentDir)
  // The policy the permission engine reads when it loads, before the first services exist (#446,
  // #496). An unreadable file refuses to start the host rather than run under a policy nobody wrote.
  const permissionPolicy = preparePermissionPolicy(options.permissionRulesPath, agentDir)
  if (permissionPolicy.kind === 'unreadable') {
    throw new Error(
      `${permissionPolicy.path} is unreadable (${permissionPolicy.reason}); fix it or remove it — a removed file is seeded with Enso's default policy (#446)`,
    )
  }
  log.info(describePermissionPolicy(permissionPolicy))
  // The secrets file is the USER's (`ENSO_HOME`, #421), and the root `.env` bun autoloads is THIS
  // checkout's — neither is about the trees pi operates in (a session may run anywhere, a tmpdir
  // in tests). Both resolve from the environment and the harness, never from a session's cwd.
  const environment = options.environment ?? process.env
  const quarantine = quarantineSecrets(environment, {
    repoRoot: findRepoRoot(import.meta.url),
    home: ensoHome(environment),
  })
  if (quarantine.removed.length > 0) {
    log.info('secrets kept out of the tool environment (#89): {removed}', { removed: quarantine.removed })
  }

  /**
   * The session manager of each thread a hosted session holds open (#551): the one writer of that
   * thread's file (control plane, invariant 4). A restore appends its record through it, never
   * through a second manager opened beside it on the same file.
   */
  const liveSessionManagers = new Map<string, SessionManager>()

  /**
   * A thread's own tree, minted (#551): at the checkout's current state for a new thread, at the
   * parent's snapshot for a fork. `name` is the tree's directory (the thread's id, or a fresh one
   * for a fork); the store is the thread's (`threadId`). The kind is the host's (`threadTree`),
   * except that a project which is no repository's top level gets a copy.
   */
  async function mintTree(request: {
    readonly threadId: string
    readonly project: string
    readonly name: string
    readonly from: Parameters<typeof mintThreadTree>[0]['from']
    /** A fork of a thread on a tree keeps its source's kind, whatever new threads get now. */
    readonly kind?: ThreadTreeKind | undefined
  }): Promise<{ kind: 'minted'; record: ThreadTreeRecord } | { kind: 'refused'; reason: string }> {
    const requested = request.kind ?? treeKindOf(request.project)
    if (projectsDir === undefined || requested === undefined) {
      return { kind: 'refused', reason: 'this host mints no trees (no projects folder, or trees are off)' }
    }
    const project = realpathOrSelf(request.project)
    const location = treeLocation(projectsDir, project, request.name, request.threadId)
    const kind = await treeKindFor(project, requested, environment)
    const minted = await mintThreadTree({
      project,
      tree: location.tree,
      store: location.store,
      kind,
      branch: location.branch,
      from: request.from,
      environment,
    })
    if (minted.kind === 'refused') {
      log.error('no tree for thread {threadId}: {step} refused — {reason}', { threadId: request.threadId, ...minted })
      return { kind: 'refused', reason: `its tree could not be made (${minted.step}): ${minted.reason}` }
    }
    log.info('thread {threadId} runs in its own tree {tree} ({kind}, base {base})', {
      threadId: request.threadId,
      tree: minted.record.path,
      kind: minted.record.kind,
      base: minted.record.base,
    })
    return minted
  }

  /**
   * The session a new thread built in its checkout moves onto its tree with (#551): everything it
   * holds — what was chosen before its first run — written now as its file under a header naming
   * the tree, opened from that file, and the tree's record appended to it. Written at once, not at
   * pi's first flush (PR #561 review): a thread disposed before its first message would otherwise
   * have no file to be found by, and its next build would mint again over the tree that exists.
   * Opened from the file so pi appends to it, never writes it a second time (its first flush opens
   * the file `wx`). The checkout session is not touched: a move undone leaves it as it was, naming
   * no tree.
   */
  function sessionOnTree(checkoutSession: SessionManager, tree: ThreadTreeRecord): SessionManager {
    const file = checkoutSession.getSessionFile()
    if (file === undefined) throw new Error(`thread ${checkoutSession.getSessionId()} has no session file path`)
    const header = { ...checkoutSession.getHeader(), cwd: tree.path }
    const lines = [header, ...checkoutSession.getEntries()].map((fileEntry) => `${JSON.stringify(fileEntry)}\n`)
    writeFileSync(file, lines.join(''))
    const onTree = SessionManager.open(file)
    onTree.appendCustomEntry(ENSO_THREAD_TREE_ENTRY, tree)
    return onTree
  }

  /** A thread's snapshot store (#551): beside its session, under its project — the checkout's or its tree's. */
  function storeOf(threadId: string, cwd: string): string | undefined {
    return projectsDir === undefined
      ? undefined
      : join(projectSnapshotsDir(projectsDir, projectIdOfCwd(projectsDir, cwd)), threadId)
  }
  if (quarantine.misplaced.length > 0) {
    log.warn(
      'the root .env defines {misplaced} — bun autoloads .env into every bun child, so a tool can still read it there. Move it to {secretsFile} (#89); it is not read from .env',
      { misplaced: quarantine.misplaced, secretsFile: ensoSecretsPath(ensoHome(environment)) },
    )
  }
  // The theme registry pi's UI code consults; harmless without a terminal, required once.
  initTheme()

  /**
   * pi's listing, through its API — never a directory scan of the files: the file naming is pi's
   * to change, and `listAll` reads each file's header for the id and the directory. Two places are
   * listed (#552): pi's default session directories under the ONE agent dir (the env pin above),
   * where the terminal launcher filed sessions before the project folders and where a session of
   * a project whose directory is gone still sits; and every project folder's `sessions/`,
   * registered or not — `locate` must tell "none" from "not yours". Cost is one parse per file,
   * paid per call. Sessions pi has not flushed yet (no assistant message) have no file and are not
   * listed — there is nothing to come back to.
   */
  async function everySession(): Promise<StoredThread[]> {
    const listings = await Promise.all([...projectSessionListings(), SessionManager.listAll()])
    // One entry per thread id. The project folders are listed FIRST, so when the migration kept a
    // legacy copy beside a file the folder already held (same name, same id), the folder's copy is
    // the thread and the legacy one is not listed — one thread, the same one on every call.
    const byId = new Map<string, SessionInfo>()
    for (const info of listings.flat()) if (!byId.has(info.id)) byId.set(info.id, info)
    const listed = [...byId.values()]
    // A fork's header names its parent by FILE (#433); the thread is that file's session id, read
    // off the same listing. The path misses once the parent has moved into its project folder
    // (#552's migration), so the file's NAME — `<timestamp>_<id>.jsonl`, unique by id — is tried
    // next. A parent file that is gone names no thread, so the fork carries none.
    const idByPath = new Map(listed.map((info) => [resolve(info.path), info.id]))
    const idByName = new Map(listed.map((info) => [basename(info.path), info.id]))
    const parentOf = (path: string): string | undefined => idByPath.get(resolve(path)) ?? idByName.get(basename(path))
    return listed
      .map((info) => {
        const parentThreadId = info.parentSessionPath === undefined ? undefined : parentOf(info.parentSessionPath)
        // ⚠ pi's `modified` is the last message's time, and a fork COPIES its source's messages
        // with their timestamps (#447): a fork taken now of a thread idle for hours read as hours
        // old, and sorted with it. The header's `created` is when the fork was made; for any other
        // session it is never later than its last message, so the later of the two changes nothing else.
        const created = info.created.getTime()
        const modified = Number.isNaN(created) ? info.modified : new Date(Math.max(info.modified.getTime(), created))
        return {
          id: info.id,
          path: info.path,
          cwd: info.cwd,
          modified,
          messageCount: info.messageCount,
          // pi says `(no messages)` for a file with none — an empty fork's (#433) — which is no title.
          firstMessage: info.messageCount === 0 ? '' : info.firstMessage,
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
        }
      })
      .sort((first, second) => second.modified.getTime() - first.modified.getTime())
  }

  /**
   * One `listAll` per project folder that has a `sessions/` — every folder, registered or not; none
   * when there is no projects folder. In NAME order, not the filesystem's: `everySession` keeps the
   * first file it sees per thread id, and two folders holding one id (a hand-made copy beside a
   * moved checkout's) must resolve to the same one on every call and on every machine — the
   * lexically first folder's.
   */
  function projectSessionListings(): Promise<SessionInfo[]>[] {
    if (projectsDir === undefined || !existsSync(projectsDir)) return []
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isEnsoProjectId(entry.name))
      .map((entry) => entry.name)
      .toSorted()
      .map((name) => projectSessionsDir(projectsDir, name))
      .filter((directory) => existsSync(directory))
      .map((directory) => SessionManager.listAll(directory))
  }

  async function listSessions(): Promise<StoredThread[]> {
    return (await everySession()).filter((stored) => servesDirectory(stored.cwd))
  }

  /** The thread's session file, served or not — `createSession` must tell "none" from "not yours". */
  async function locate(threadId: string): Promise<StoredThread | undefined> {
    return (await everySession()).find((stored) => stored.id === threadId)
  }

  async function storedSession(threadId: string): Promise<StoredThread | undefined> {
    const located = await locate(threadId)
    return located !== undefined && servesDirectory(located.cwd) ? located : undefined
  }

  async function storedSessionPath(threadId: string): Promise<string | undefined> {
    return (await storedSession(threadId))?.path
  }

  /** A stored thread's branch, root to leaf — one open, nothing built (#86); undefined for no file. */
  async function storedBranch(threadId: string): Promise<SessionEntry[] | undefined> {
    const path = await storedSessionPath(threadId)
    return path === undefined ? undefined : SessionManager.open(path).getBranch()
  }

  async function readStoredThread(threadId: string): Promise<StoredThreadRead | undefined> {
    const located = await storedSession(threadId)
    if (located === undefined) return undefined
    // `open` loads the file into memory and writes nothing until an append.
    const stored = SessionManager.open(located.path)
    const branch = stored.getBranch()
    return {
      cwd: located.cwd,
      transcript: transcriptOf(branch),
      usage: storedSessionUsage(stored.getEntries()),
      recordedModel: recordedModelOf(branch),
    }
  }

  async function readStoredThreadStats(threadId: string): Promise<StoredThreadStats | undefined> {
    const path = await storedSessionPath(threadId)
    if (path === undefined) return undefined
    const stored = SessionManager.open(path)
    return { usage: storedSessionUsage(stored.getEntries()), branch: branchStats(stored.getBranch()) }
  }

  async function readStoredThreadContext(threadId: string): Promise<StoredThreadContext | undefined> {
    const path = await storedSessionPath(threadId)
    if (path === undefined) return undefined
    const stored = SessionManager.open(path)
    return { usage: storedSessionUsage(stored.getEntries()), context: branchContext(stored.getBranch()) }
  }

  async function readStoredRequestDetail(
    threadId: string,
    request: number | 'next',
  ): Promise<BranchRequestDetail | undefined> {
    const branch = await storedBranch(threadId)
    return branch === undefined ? undefined : branchRequestDetail(branch, request)
  }

  async function forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome> {
    if (deletingThreads.has(threadId) || deletedThreads.has(threadId)) {
      return { kind: 'no-thread', reason: `thread ${threadId} is deleted, or being deleted` }
    }
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session file in a project this server serves` }
    }
    const probe = SessionManager.open(located.path)
    const entry = probe.getEntry(entryId)
    if (entry === undefined) return { kind: 'no-entry', reason: `thread ${threadId} has no entry ${entryId}` }
    if (entry.type !== 'message' || entry.message.role !== 'user') {
      return { kind: 'not-a-user-message', reason: `entry ${entryId} is not a user message; a fork starts at one` }
    }
    const prefill = userMessageText(entry.message.content)
    // The fork's own tree (#551): whenever the source runs on one — two threads never share a tree
    // — or new threads get one. Minted at the source's snapshot as that turn began, so the fork's
    // files are the conversation's at the fork point, not the source's files now.
    const sourceTranscript = transcriptOf(probe.getBranch())
    const sourceTree = treeRecordOf(sourceTranscript)
    const plan =
      sourceTree !== undefined || treeKindOf(located.cwd) !== undefined
        ? forkTreePlan(threadId, located.cwd, sourceTree, snapshotAtEntry(sourceTranscript, entryId))
        : undefined
    if (plan?.kind === 'refused') return { kind: 'tree-refused', reason: plan.reason }
    // Opened with the fork's tree as its cwd, so the fork's header — written by pi when it branches
    // — names the tree the fork runs in; the source's own file is not touched.
    const source = plan === undefined ? probe : SessionManager.open(located.path, undefined, plan.cwd)
    // Read off the source's CURRENT branch before `createBranchedSession` turns `source` into the
    // fork: an open incident passes on whatever the fork point (#466 decision 5) — a fork taken
    // from before it would otherwise be a way around its suspension. A resolved or ended one does not.
    const sourceIncident = openIncidentOf(branchIncidents(source.getBranch()))
    // pi's `before`: the fork holds everything up to the message's parent — or nothing, naming its parent.
    let fork: SessionManager
    if (entry.parentId === null) {
      fork = SessionManager.create(source.getCwd(), source.getSessionDir())
      fork.newSession({ parentSession: located.path })
    } else {
      source.createBranchedSession(entry.parentId)
      fork = source
    }
    if (plan !== undefined) {
      const refusal = await giveForkItsTree(fork, plan)
      if (refusal !== undefined) return { kind: 'tree-refused', reason: refusal }
    }
    if (sourceIncident !== undefined) inheritOpenIncident(threadId, fork, sourceIncident)
    writeUnflushedSession(fork)
    return { kind: 'forked', threadId: fork.getSessionId(), prefill }
  }

  /**
   * Mint the fork's tree under the fork's own id (pi picks it only as it branches) and record it on
   * the fork. The reason when it cannot be made: then there is no fork — the file pi may already
   * have written for it goes too, so no thread is left pointing at a tree that does not exist.
   */
  async function giveForkItsTree(
    fork: SessionManager,
    plan: Extract<ReturnType<typeof forkTreePlan>, { kind: 'planned' }>,
  ): Promise<string | undefined> {
    const minted = await mintTree({
      threadId: fork.getSessionId(),
      project: plan.project,
      name: plan.name,
      from: plan.from,
      kind: plan.treeKind,
    })
    if (minted.kind === 'refused') {
      const file = fork.getSessionFile()
      if (file !== undefined && existsSync(file)) unlinkSync(file)
      return `the fork's ${minted.reason}`
    }
    fork.appendCustomEntry(ENSO_THREAD_TREE_ENTRY, minted.record)
    return undefined
  }

  /** The source's open incident, opened again on the fork (#466 decision 5) — unless a fork taken after the opening already holds it, open. */
  function inheritOpenIncident(
    threadId: string,
    fork: SessionManager,
    sourceIncident: NonNullable<ReturnType<typeof openIncidentOf>>,
  ): void {
    if (openIncidentOf(branchIncidents(fork.getBranch())) !== undefined) return
    const opening = inheritedOpening(threadId, sourceIncident.opened)
    fork.appendCustomEntry(ENSO_INCIDENT_OPENED_ENTRY, opening)
    log.info('fork {forkThreadId} inherits incident {sourceIncidentId} as {incidentId}', {
      threadId,
      forkThreadId: fork.getSessionId(),
      sourceIncidentId: sourceIncident.opened.incidentId,
      incidentId: opening.incidentId,
    })
  }

  /**
   * Where a fork's tree comes from (#551): the source's snapshot at the fork entry, in the source's
   * store — or, for a source in its checkout with no snapshot there (a thread from before #551), the
   * checkout as it is now. A source ON a tree with no snapshot at that turn is refused: its files at
   * the fork point were never captured, and the checkout's are not them.
   */
  function forkTreePlan(
    sourceThreadId: string,
    sourceCwd: string,
    sourceTree: ThreadTreeRecord | undefined,
    at: { readonly hash: string; readonly revision: string | null } | undefined,
  ):
    | {
        kind: 'planned'
        cwd: string
        project: string
        name: string
        treeKind: ThreadTreeKind | undefined
        from: Parameters<typeof mintThreadTree>[0]['from']
      }
    | { kind: 'refused'; reason: string } {
    const sourceStore = storeOf(sourceThreadId, sourceCwd)
    if (projectsDir === undefined || sourceStore === undefined) {
      return { kind: 'refused', reason: 'this host has no projects folder to put a tree in' }
    }
    if (sourceTree !== undefined && at === undefined) {
      return { kind: 'refused', reason: `thread ${sourceThreadId} recorded no snapshot of its tree at that turn` }
    }
    const project = sourceTree?.project ?? sourceCwd
    // pi picks the fork's id only when it branches, after the cwd is fixed: the tree's directory
    // gets a name of its own, and the store the fork's id (`mintTree`).
    const name = crypto.randomUUID()
    return {
      kind: 'planned',
      cwd: treeLocation(projectsDir, realpathOrSelf(project), name, name).tree,
      project,
      name,
      treeKind: sourceTree?.kind,
      from:
        at === undefined
          ? { kind: 'checkout' }
          : { kind: 'snapshot', hash: at.hash, revision: at.revision, storeDirectory: sourceStore },
    }
  }

  /**
   * The session a restore reads and records on (#551), with the tree it restores: the live one when
   * the thread is built — the route leases the thread, so it is — else the file.
   */
  async function restoreSession(
    threadId: string,
  ): Promise<
    | { readonly session: SessionManager; readonly live: boolean; readonly tree: ThreadTreeRecord }
    | { readonly kind: 'no-thread' | 'no-tree'; readonly reason: string }
  > {
    const live = liveSessionManagers.get(threadId)
    const located = live === undefined ? await storedSession(threadId) : undefined
    if (live === undefined && located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session in a project this server serves` }
    }
    const session = live ?? SessionManager.open(located?.path ?? '')
    const tree = treeRecordOf(transcriptOf(session.getBranch()))
    if (tree === undefined) {
      return {
        kind: 'no-tree',
        reason: `thread ${threadId} runs in its checkout, not a tree of its own: nothing to restore`,
      }
    }
    return { session, live: live !== undefined, tree }
  }

  /** Threads whose tree a restore is putting back right now: no run is admitted on one (`admitRun`). */
  const restoringTrees = new Set<string>()

  /**
   * Put the thread's tree back to `hash` and record it: the tree's current files are snapshotted
   * first (the safety), and a failed restore puts them back. The files only — the conversation is
   * not changed (its side is `/fork`).
   */
  async function restoreTreeTo(
    threadId: string,
    target: { readonly session: SessionManager; readonly live: boolean; readonly tree: ThreadTreeRecord },
    hash: string,
  ): Promise<ThreadRestoreOutcome> {
    const { session, live, tree } = target
    const store = storeOf(threadId, session.getCwd())
    if (store === undefined) return { kind: 'refused', reason: 'this host has no projects folder' }
    restoringTrees.add(threadId)
    const restored = await restoreThreadTree({ store, tree: tree.path, hash, environment }).finally(() =>
      restoringTrees.delete(threadId),
    )
    if (restored.kind === 'refused') {
      log.error('restore of thread {threadId} to {hash} refused at {step}: {reason}', { threadId, hash, ...restored })
      return { kind: 'refused', reason: `${restored.step}: ${restored.reason}` }
    }
    session.appendCustomEntry(ENSO_TREE_RESTORED_ENTRY, { hash: restored.hash, safety: restored.safety })
    if (!live) writeUnflushedSession(session)
    log.info('thread {threadId} tree restored to {hash}; its files before are {safety}', { threadId, ...restored })
    return { kind: 'restored', hash: restored.hash, safety: restored.safety }
  }

  /** Restore a thread's tree to the snapshot taken as the turn opened by `entryId` began (#551). */
  async function restoreThreadAt(threadId: string, entryId: string): Promise<ThreadRestoreOutcome> {
    const target = await restoreSession(threadId)
    if ('kind' in target) return target
    const transcript = transcriptOf(target.session.getBranch())
    if (!hasEntry(transcript, entryId))
      return { kind: 'no-entry', reason: `thread ${threadId} has no entry ${entryId}` }
    const at = snapshotAtEntry(transcript, entryId)
    if (at === undefined) {
      return { kind: 'no-snapshot', reason: `thread ${threadId} recorded no snapshot of its tree when that turn began` }
    }
    return restoreTreeTo(threadId, target, at.hash)
  }

  /**
   * Undo the thread's last restore (#565): back to the safety snapshot its newest `enso-tree-restored`
   * record names. That is a restore too — recorded, with its own safety — so undoing again re-applies
   * the restore it undid; each undo reverses the restore before it. ⚠ Only when `safety` IS that
   * record's (PR #561 review): an undo pressed on an older restore's notice — or one another tab
   * replaced since — is refused, never applied to a restore it does not name.
   */
  async function undoLastRestore(threadId: string, safety: string): Promise<ThreadRestoreOutcome> {
    const target = await restoreSession(threadId)
    if ('kind' in target) return target
    const last = lastRestoreOf(transcriptOf(target.session.getBranch()))
    if (last === undefined) return { kind: 'no-restore', reason: `thread ${threadId} has no restore to undo` }
    if (last.safety !== safety) {
      return {
        kind: 'superseded',
        reason: `a later restore replaced these files (its safety is ${last.safety.slice(0, 7)}); undo that one instead`,
      }
    }
    return restoreTreeTo(threadId, target, last.safety)
  }

  /**
   * Threads a delete holds right now (#571): no run is admitted (`admitRun`), no session is built
   * (`createSession`), no fork is taken of one; and the ids deleted since the server started, which
   * stay refused — a page still showing one would otherwise prompt a NEW thread into being under it.
   */
  const deletingThreads = new Set<string>()
  const deletedThreads = new Set<string>()

  /** Every session file under `threadId`: the project folders' and pi's own — a legacy copy beside a migrated one too. */
  async function sessionFilesOf(threadId: string): Promise<string[]> {
    const listings = await Promise.all([...projectSessionListings(), SessionManager.listAll()])
    return listings
      .flat()
      .filter((info) => info.id === threadId)
      .map((info) => info.path)
  }

  /**
   * Delete the thread (#571). Fail-closed, in this order: the tree's inventory first (refused, the
   * thread is untouched — not even retired); then the live session retired; then the tree and the
   * store — kept for its forks, orphaned — and the project's orphans swept; the session files last,
   * so a delete that stops partway leaves a thread that still lists and can be deleted again.
   */
  async function deleteThread(
    threadId: string,
    { force, retire }: { readonly force: boolean; readonly retire: () => boolean },
  ): Promise<ThreadDeleteOutcome> {
    if (deletedThreads.has(threadId)) return { kind: 'no-thread', reason: `thread ${threadId} was deleted` }
    if (deletingThreads.has(threadId)) return { kind: 'busy', reason: `thread ${threadId} is being deleted` }
    if (restoringTrees.has(threadId)) {
      return { kind: 'busy', reason: `thread ${threadId} is restoring its files; delete it once that is done` }
    }
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session file in a project this server serves` }
    }
    deletingThreads.add(threadId)
    try {
      const tree = treeRecordOf(transcriptOf(SessionManager.open(located.path).getBranch()))
      const store = storeOf(threadId, located.cwd)
      if (tree !== undefined && store !== undefined && !force) {
        const held = holdingReason(await inventoryThreadTree({ record: tree, store, environment }))
        if (held !== undefined) return { kind: 'holds-work', reason: held }
      }
      if (!retire()) return { kind: 'busy', reason: `thread ${threadId} is running; delete it when it settles` }
      if (tree !== undefined && store !== undefined) {
        const disposed = await disposeThreadTree({ record: tree, store, force, environment })
        if (disposed.kind === 'refused') return { kind: 'holds-work', reason: disposed.reason }
      } else if (store !== undefined && existsSync(store)) {
        releaseThreadStore(store)
      }
      if (store !== undefined) sweepOrphanedStores(dirname(store))
      for (const file of await sessionFilesOf(threadId)) rmSync(file, { force: true })
      deletedThreads.add(threadId)
      log.info('thread {threadId} deleted: session, {tree} and store', {
        threadId,
        tree: tree === undefined ? 'no tree' : `its ${tree.kind} ${tree.path}`,
      })
      return { kind: 'deleted' }
    } catch (error) {
      log.error('thread {threadId} could not be deleted: {error}', { threadId, error })
      return { kind: 'refused', reason: `thread ${threadId} could not be deleted: ${String(error)}` }
    } finally {
      deletingThreads.delete(threadId)
    }
  }

  async function readStoredForkPoint(threadId: string): Promise<EnsoForkPoint | undefined> {
    const located = await storedSession(threadId)
    if (located === undefined) return undefined
    return forkPointOf(SessionManager.open(located.path).getBranch(), {
      threadId,
      cwd: located.cwd,
      parentThreadId: located.parentThreadId,
    })
  }

  async function readStoredThreadEval(threadId: string): Promise<BranchEval | undefined> {
    const branch = await storedBranch(threadId)
    return branch === undefined ? undefined : branchEval(branch)
  }

  async function readStoredIncidentHistory(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchIncidentHistory | undefined> {
    const branch = await storedBranch(threadId)
    return branch === undefined ? undefined : branchIncidentHistory(branch, thresholds)
  }

  /**
   * What a judge case is built from in `cwd` (#469): the guard's default fragments and the user's
   * secret values (`ENSO_HOME`, as the quarantine above reads it), read per call so a key added
   * since is still scrubbed.
   */
  function judgeCaseInputs(cwd: string, thresholds: EnsoRiskThresholds): JudgeCaseInputs {
    return {
      thresholds,
      cwd,
      secretPathFragments: DEFAULT_GUARD_POLICY.secretPathFragments,
      secretValues: knownSecretValues(ensoHome(environment), environment),
    }
  }

  async function readStoredJudgeCases(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchJudgeCases | undefined> {
    const stored = await storedSession(threadId)
    if (stored === undefined) return undefined
    return branchJudgeCases(SessionManager.open(stored.path).getBranch(), judgeCaseInputs(stored.cwd, thresholds))
  }

  async function createSession(threadId: string, newSessionDirectory: () => string): Promise<HostedThread> {
    // Resolved BEFORE the services so a bad id fails before anything is built. A file under this
    // id decides the directory — pi fixed it at creation — and one this host does not serve is a
    // refusal, never a fresh session beside it under the same id. Only a thread with no file asks
    // where a new one goes, so a stale answer to that question cannot block a resume.
    if (deletingThreads.has(threadId) || deletedThreads.has(threadId)) {
      throw new ThreadDeleted(`thread ${threadId} is deleted, or being deleted`)
    }
    const located = await locate(threadId)
    const directory = located?.cwd ?? newSessionDirectory()
    if (!servesDirectory(directory)) {
      throw new SessionDirectoryRefused(
        `thread ${threadId}: ${directory} is not a project this server runs sessions in`,
      )
    }
    // @invariant resume/one-id One id, end to end: a file under the thread's id is OPENED, none means one is created under it.
    // `locate` resolves the id through the same listing `readStoredThread` uses (#95), so the file this later flushes
    // is found next time, and the browser adopts under the history's `threadId` (`thread-stores.ts#adoptThread`). The
    // file sits under the agent dir pi resolves from the env the host set, where `pi --mode rpc` put it, so the mode's
    // `active_agent` entries and the transcript land where the TUI's would; `permissionModeState()` below walks them.
    if (located !== undefined) return buildHosted(threadId, SessionManager.open(located.path))
    const created = SessionManager.create(directory, sessionDirFor(directory), { id: threadId })
    const hosted = await buildHosted(threadId, created)
    // A new thread whose project gives threads a tree (#551) is built in the checkout and gets its
    // tree at its first RUN, not here (PR #561 review): a thread only built — a preview looked at,
    // a permission checked, a model chosen — leaves no worktree, branch or file behind.
    return treeKindOf(directory) === undefined ? hosted : treeOnFirstRun(threadId, directory, hosted, created)
  }

  /**
   * A new thread that moves onto its own tree when it first runs (#551, PR #561 review). Until
   * then it runs nowhere — it is pi built in the checkout, answering previews and permission
   * checks there. At the first `prompt` (or `continueRun`) the tree is minted from the checkout as
   * it is THEN, the session — everything chosen before (model, thinking, mode, system prompt), the
   * tree's record, a header naming the tree — is written as the thread's file, and pi is built
   * again on it; the old build is disposed. Every runtime call goes to the build of the moment,
   * and every observer stays subscribed across the move. Runs that arrive while it moves wait for
   * it. A mint that is refused refuses the run, never runs it in the checkout instead, and the next
   * run tries again.
   *
   * ⚠ A MOVE THAT FAILS AFTER THE MINT IS UNDONE (PR #561 review): the tree and its branch are named
   * by the thread's id, so a tree left behind would refuse every later mint for this thread. Any
   * step failing after the mint — the write, the build, a dispose that came meanwhile — removes the
   * tree, its branch and store, and the file the move wrote, and puts the checkout session back.
   *
   * ⚠ DISPOSE STOPS THE MOVE: a build that finishes after the thread was disposed (the registry's
   * shutdown disposes busy threads too) is disposed in turn, and the run that waited is refused —
   * no pi is left running that nothing would dispose.
   *
   * ⚠ NO CHANGE WHILE IT MOVES: a mode, system prompt, host command or incident resolution would
   * land on the checkout session after its entries were written for the tree, and be lost. The
   * server's control routes cannot reach this (a moving run holds the thread's lease); the wrapper
   * refuses them itself, so no caller can.
   */
  function treeOnFirstRun(
    threadId: string,
    project: string,
    first: HostedThread,
    checkoutSession: SessionManager,
  ): HostedThread {
    let current = first
    let moved = false
    let disposed = false
    let moving: Promise<string | undefined> | undefined
    const observers = new Set<(observation: EnsoObservation) => void>()
    const fanOut = (observation: EnsoObservation): void => {
      for (const observer of observers) observer(observation)
    }
    let unbind = current.runtime.subscribe(fanOut)
    const whileMoving = `thread ${threadId} is moving onto its tree; try again once its first run has started`
    const isMoving = (): boolean => moving !== undefined && !moved

    /**
     * The mint undone: the tree, its branch and store, the file the move wrote; the checkout session
     * back. The live-session entry is touched only while it still holds `treeSession`, the one this
     * move built (a build that threw had set it): the checkout session takes it back, or — the thread
     * disposed meanwhile — it goes. Any other entry is a newer build's under the same id, and stays.
     */
    async function undoMove(tree: ThreadTreeRecord, why: string, treeSession?: SessionManager): Promise<string> {
      const file = checkoutSession.getSessionFile()
      if (file !== undefined && existsSync(file)) unlinkSync(file)
      if (treeSession !== undefined && liveSessionManagers.get(threadId) === treeSession) {
        if (disposed) liveSessionManagers.delete(threadId)
        else liveSessionManagers.set(threadId, checkoutSession)
      }
      const store = storeOf(threadId, tree.path)
      const removed =
        store === undefined ? undefined : await disposeThreadTree({ record: tree, store, force: true, environment })
      if (removed?.kind !== 'disposed') {
        log.error('thread {threadId}: the tree {tree} of a failed move could not be removed: {reason}', {
          threadId,
          tree: tree.path,
          reason: removed?.reason ?? 'no projects folder',
        })
      }
      return why
    }

    async function moveOntoTree(): Promise<string | undefined> {
      const minted = await mintTree({ threadId, project, name: threadId, from: { kind: 'checkout' } })
      if (minted.kind === 'refused') return minted.reason
      if (disposed) return undoMove(minted.record, `thread ${threadId} was disposed before it ran`)
      let next: HostedThread
      let treeSession: SessionManager | undefined
      try {
        treeSession = sessionOnTree(checkoutSession, minted.record)
        next = await buildHosted(threadId, treeSession)
      } catch (error) {
        log.error('thread {threadId} could not be built on its tree: {error}', { threadId, error })
        return undoMove(minted.record, `its build on the tree failed: ${String(error)}`, treeSession)
      }
      if (disposed) {
        next.runtime.dispose()
        return `thread ${threadId} was disposed before it ran`
      }
      unbind()
      const previous = current
      current = next
      unbind = next.runtime.subscribe(fanOut)
      moved = true
      previous.runtime.dispose()
      return undefined
    }
    /** Run `start` on the build on the tree — moving there first, once. */
    function onTree(outcome: PromptOutcome, start: () => void): void {
      if (disposed) {
        outcome.onRejected(`thread ${threadId} was disposed`)
        return
      }
      if (moved) {
        start()
        return
      }
      moving ??= moveOntoTree()
      moving.then(
        (refusal) => {
          if (refusal === undefined) {
            start()
            return
          }
          moving = undefined
          outcome.onRejected(`thread ${threadId} has no tree to run in: ${refusal}`)
        },
        (error: unknown) => {
          moving = undefined
          log.error('thread {threadId} could not move onto its tree: {error}', { threadId, error })
          outcome.onRejected(`thread ${threadId} could not move onto its tree: ${String(error)}`)
        },
      )
    }

    const runtime: ThreadRuntime = {
      prompt: (request, outcome) => onTree(outcome, () => current.runtime.prompt(request, outcome)),
      continueRun: (outcome) => onTree(outcome, () => current.runtime.continueRun(outcome)),
      answerDialog: (response) => current.runtime.answerDialog(response),
      openDialogs: () => current.runtime.openDialogs(),
      listCommands: () => current.runtime.listCommands(),
      modelState: () => current.runtime.modelState(),
      sessionUsage: () => current.runtime.sessionUsage(),
      runHostCommand: (run) =>
        isMoving() ? Promise.reject(new HostCommandRefused(whileMoving)) : current.runtime.runHostCommand(run),
      startHostFlow: (run, outcome) =>
        isMoving() ? outcome.onRejected(whileMoving) : current.runtime.startHostFlow(run, outcome),
      loginInProgress: () => current.runtime.loginInProgress(),
      cancelLogin: () => current.runtime.cancelLogin(),
      permissionModeState: () => current.runtime.permissionModeState(),
      setPermissionMode: (mode, outcome) =>
        isMoving() ? outcome.onRejected(whileMoving) : current.runtime.setPermissionMode(mode, outcome),
      setSystemPrompt: (choice) => (isMoving() ? whileMoving : current.runtime.setSystemPrompt(choice)),
      resolveIncident: (incidentId, resolution) =>
        isMoving() ? whileMoving : current.runtime.resolveIncident(incidentId, resolution),
      subscribe: (observer) => {
        observers.add(observer)
        return () => observers.delete(observer)
      },
      // A Stop while the thread moves stops the run it is about to start.
      abort: async () => {
        await moving
        return current.runtime.abort()
      },
      clearQueue: () => current.runtime.clearQueue(),
      dispose: () => {
        disposed = true
        unbind()
        current.runtime.dispose()
      },
    }
    return {
      runtime,
      get loadedExtensionPaths() {
        return current.loadedExtensionPaths
      },
      inspect: () => current.inspect(),
      emittedEvents: () => current.emittedEvents(),
      branchStats: () => current.branchStats(),
      branchEval: () => current.branchEval(),
      branchIncidentHistory: (thresholds) => current.branchIncidentHistory(thresholds),
      branchJudgeCases: (thresholds) => current.branchJudgeCases(thresholds),
      branchContext: () => current.branchContext(),
      previewSystemPrompt: (candidate) => current.previewSystemPrompt(candidate),
      branchRequestDetail: (request) => current.branchRequestDetail(request),
      forkPoint: () => current.forkPoint(),
      probeToolCall: (toolName, input) => current.probeToolCall(toolName, input),
      checkPermission: (request) => current.checkPermission(request),
    }
  }

  /** pi built on `sessionManager` — a thread's whole session, events flowing, extensions bound. */
  async function buildHosted(threadId: string, sessionManager: SessionManager): Promise<HostedThread> {
    const cwd = sessionManager.getCwd()
    liveSessionManagers.set(threadId, sessionManager)
    // The thread's system prompt (#443): the one its branch recorded, else pi's default until a
    // Start chooses one (`setSystemPrompt` below). An entry that does not read refuses the build —
    // never pi's default in its place, which would rewrite the prompt the thread started with. Read
    // BEFORE the services, as the directory is: a thread refused builds nothing.
    const recorded = recordedSystemPrompt(transcriptOf(sessionManager.getBranch()))
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
    // Trust before anything loads (#502): pi's `trust.json`, the thread's own record, the default —
    // else untrusted, and asked before the first run (`trustGate` below). ⚠ Keyed by the PROJECT: a
    // thread on a tree (#551) is trusted as its checkout is, never as a path no one trusted.
    const trustDirectory = treeRecordOf(transcriptOf(sessionManager.getBranch()))?.project ?? cwd
    const projectTrust = hostedProjectTrust(cwd, trustDirectory, agentDir, transcriptOf(sessionManager.getBranch()))
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: projectTrust.settingsManager,
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
      sessionManager,
    })

    // ── The event fan-out. Subscribers receive OBSERVATIONS (L2, #162 workstream 4): the
    // runtime's event is mapped here, at delivery, and its shape never leaves the host. The
    // emitted tail (#97) records every event through this funnel with HOW it was delivered,
    // at the one place all of them pass, so the record and the delivery cannot disagree.
    const listeners = new Set<(observation: EnsoObservation) => void>()
    const heldUntilFirstSubscriber: RuntimeEvent[] = []
    let hasHadSubscriber = false
    const emitted = createEventTail()
    /**
     * @invariant follow-snapshot-frames/held-until-first-subscriber Held until the first subscriber; never held after.
     * Records emitted before the FIRST subscriber (what an extension says during session_start: multi-account's
     * startup notify, a dialog a probe opens, an extension's `session_start` entry) are held and replayed to it with origin
     * `session-start`, so the browser sees them exactly as it saw pi's startup stdout over the pipe; the replay is
     * recorded again, as `replayed`, when it actually reaches a subscriber (see `subscribe`).
     *
     * Never between runs: the session lives across runs (#69 PR 2) and each run subscribes its own pump, so holding
     * would replay an aborted run's `agent_settled` into the NEXT run's pump and end it before its first token (the
     * disconnect-then-prompt race). Once a subscriber has existed, an event with nobody listening is `dropped`, not
     * queued for the next one, like status heartbeats with no rpc client reading the pipe. That closed #88 (an entry
     * emitted to nobody) without reopening #69 (a settle replayed into the next run's pump).
     */
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

    const ui = createEnsoExtensionUiContext({
      emit,
      threadId,
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
        else sessionManager.appendCustomEntry(ENSO_PROJECT_TRUST_ENTRY, THREAD_PROJECT_TRUST)
        projectTrust.settingsManager.setProjectTrusted(true)
        await session.reload()
        ui.notifyFrom(ENSO_SENDER, projectTrustedNotice(answer), 'info')
      },
    })

    // ⚠ SUBSCRIBE BEFORE BINDING (#88). Extensions persist state during `session_start` — any
    // `pi.appendEntry` there — and pi emits `entry_appended` to whoever
    // is listening at that moment. Subscribing after `bindExtensions` returned meant those
    // entries went to nobody: the held-until-first-subscriber buffer sits behind THIS
    // subscription, so nothing put them in it, and the browser saw one entry where
    // the branch had two. The `ui` notifies always crossed because `ui` binds `emit` directly.
    // Nothing session_start emits is run progress (`agent_settled` comes from the run loop
    // only), so replaying it into the first run's pump is inert.
    /**
     * The mode NOW (#84, #496): the last `active_agent` entry among the session's ENTRIES, the
     * walk the permission engine itself makes, re-run on every call (see the adapter).
     * The dropdown offers the modes AS REGISTERED HERE: the permission-modes extension names
     * one command per mode, exactly after it, so the intersection is a name lookup. Read off
     * the registry directly rather than through `listCommands` — that call's count is a
     * contract the refusal path's tests pin, and this is not a refusal lookup.
     */
    function currentPermissionModeState(): EnsoPermissionModeState {
      const registered = new Set(
        session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
      )
      return livePermissionModeState(transcriptOf(sessionManager.getEntries()), registered)
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
    // The login waiting on its provider, if one is (#348): what `loginInProgress` says and
    // `cancelLogin` ends. Set only between the flow's start and pi storing the credential.
    let waitingLogin: LoginInProgress | undefined
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
      return loginOptions(loginFactsOf(session.modelRuntime))
    }

    /**
     * pi asks; the browser answers through the dialog seam. A `secret` is masked (the host's own
     * `askHostInput`); a `select` crosses as labels and comes back as the chosen option's id; a
     * `manual_code` is asked in our words, with the login page the flow announced as a link on the
     * card (#388: nothing opens a browser from here, and pi's own words never said the paste is
     * the fallback); `text` is a plain input. No answer — cancelled, aborted — is pi's own "Login
     * cancelled", which the flow reports as a cancellation, not a failure.
     */
    async function askAuthPrompt(
      prompt: Parameters<Parameters<typeof session.modelRuntime.login>[2]['prompt']>[0],
      login: LoginInProgress,
    ): Promise<string> {
      // pi's own signal when it passed one, AND the login's: a question outlives neither (#389).
      const signal =
        prompt.signal === undefined ? login.questions.signal : AbortSignal.any([prompt.signal, login.questions.signal])
      let answer: string | undefined
      switch (prompt.type) {
        case 'secret':
          answer = await ui.askHostInput(
            {
              title: prompt.message,
              secret: true,
              ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
            },
            signal,
          )
          break
        case 'manual_code':
          answer = await ui.askHostInput(
            loginCodeQuestion(login.providerName, login.authUrl, prompt.placeholder),
            signal,
          )
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
        ui.notifyFrom(ENSO_SENDER, 'Model catalog could not be refreshed; using cached models.', 'warning')
      }
      return selected
    }

    async function runLogin(providerId: string, authType: HostAuthType): Promise<void> {
      const providerName = providerNameOf(providerId)
      // The page the flow announces (`auth_url`) is remembered for the code prompt that follows it.
      // ⚠ A LOGIN'S QUESTIONS END WITH IT (#389). A browser login races its local callback server
      // against the pasted code; when the callback wins, pi withdraws the code prompt through the
      // prompt's signal — but an extension provider's prompt carries none: pi-multi-account's
      // bridge drops it (`index.ts:263-264`) and pi's composer asks with none
      // (`provider-composer.js:173`). The login finished and its card stayed open, "a question is
      // waiting". So every question is tied to the login too, and withdrawn once it settles.
      const login: LoginInProgress = {
        providerName,
        authUrl: undefined,
        questions: new AbortController(),
        cancel: new AbortController(),
      }
      // ⚠ WAITING IS WHAT STOP CAN END (#348): from here until pi stores the credential. A login
      // holds no lease, so this — the `login` event, and `loginInProgress` for a snapshot — is how
      // a page knows there is something to stop. Said once each way; the second end is a no-op.
      waitingLogin = login
      emit({ type: 'login', provider: providerName, waiting: true })
      const endWaiting = (): void => {
        if (waitingLogin !== login) return
        waitingLogin = undefined
        emit({ type: 'login', provider: providerName, waiting: false })
      }
      try {
        await session.modelRuntime.login(providerId, authType, {
          signal: AbortSignal.any([flowsAbort.signal, login.cancel.signal]),
          prompt: (prompt: Parameters<typeof askAuthPrompt>[0]): Promise<string> => askAuthPrompt(prompt, login),
          notify: (event: HostAuthEvent): void => {
            if (event.type === 'auth_url') login.authUrl = event.url
            ui.notifyFrom(ENSO_SENDER, authEventText(event, providerName), 'info')
          },
        })
        // The credential is stored: the card goes now, not after the catalog refresh below, and
        // there is nothing left for Stop to end.
        login.questions.abort()
        endWaiting()
        // The credential IS stored past this line (PR #346 review): what follows can fail —
        // pi refusing the model, the catalog not refreshing — and is said as a warning, never
        // as a failed login that `/logout` would then contradict by listing the credential.
        try {
          const selected = await settleAfterLogin(providerId)
          ui.notifyFrom(ENSO_SENDER, loginDoneText(providerName, authType, selected), 'info')
        } catch (error) {
          // Said ONCE, and neutrally: the throw may be the catalog refresh after the model was
          // selected, so "could not select a model" would be wrong (PR #346 review 3).
          const reason = error instanceof Error ? error.message : String(error)
          ui.notifyFrom(ENSO_SENDER, `Logged in to ${providerName}; post-login setup failed: ${reason}`, 'warning')
        }
      } catch (error) {
        // Stop's cancel is known by ITS signal, whatever sentence pi's provider throws for it.
        if (login.cancel.signal.aborted || isFlowCancelled(error)) {
          ui.notifyFrom(ENSO_SENDER, `Login to ${providerName} cancelled.`, 'info')
        } else {
          const reason = error instanceof Error ? error.message : String(error)
          ui.notifyFrom(ENSO_SENDER, `Failed to log in to ${providerName}: ${reason}`, 'error')
        }
      } finally {
        login.questions.abort()
        endWaiting()
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
     * does too (:587). The page's transcript is TanStack's copy of the messages; pi's
     * `compaction_end` becomes `branch-compacted` (#348), and the pane re-reads the branch once
     * the thread is idle.
     */
    async function runCompact(): Promise<void> {
      ui.notifyFrom(ENSO_SENDER, 'Compacting the context…', 'info')
      try {
        const compacted = await session.compact()
        ui.notifyFrom(ENSO_SENDER, compactDoneText(compacted.tokensBefore, compacted.estimatedTokensAfter), 'info')
      } catch (error) {
        // pi's refusals ("Nothing to compact (session too small)", smoke 2026-09-23) are not
        // failures: said as a warning with pi's reason. Anything else is (PR #347 review).
        const reason = error instanceof Error ? error.message : String(error)
        if (isCompactionRefusal(error)) ui.notifyFrom(ENSO_SENDER, `Compaction did not run: ${reason}`, 'warning')
        else ui.notifyFrom(ENSO_SENDER, `Compaction failed: ${reason}`, 'error')
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
        ui.notifyFrom(ENSO_SENDER, logoutDoneText(providerName, type), 'info')
      } catch (error) {
        ui.notifyFrom(
          ENSO_SENDER,
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
        // L3 (#162 workstream 4): an `active_agent` entry was appended — a mode was set (#496).
        // Above this seam no surface knows that entry's shape, so the host says what the mode is
        // now, as its own event; the mapper carries it as the `permission-mode` observation.
        if (wire.type === 'entry_appended' && appendedMode(wire.entry) !== undefined) {
          emit({ type: 'permission_mode', ...currentPermissionModeState() })
        }
        // The thinking half of the model state — the module header says why the model half
        // arrives through the watcher extension instead.
        if (wire.type === 'thinking_level_changed') announceModelState()
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
      // BEFORE acceptance (PR #442 review): an `async` method can only fail synchronously by not
      // being there, and a pi build without it must refuse, not answer 202 to a run that never starts.
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
      const incidents = branchIncidents(sessionManager.getBranch())
      if (incidents.ended) {
        const ending = incidents.incidents.at(-1)?.opened.incidentId
        outcome.onRejected(
          `incident ${ending}'s resolution ended thread ${threadId}; it admits no prompt — fork it to go on`,
        )
        return
      }
      // A delete holds the thread (#571): its session is going, and nothing more may run on it.
      if (deletingThreads.has(threadId)) {
        outcome.onRejected(`thread ${threadId} is being deleted`)
        return
      }
      // ⚠ The restore route leases the thread, but a prompt that finds it held JOINS the holder
      // (#75) — and pi starts a run for a prompt when none is streaming. So the host refuses it here
      // while the tree is half put back (#551, PR #561 review).
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
        commands.push(...hostFlowRows(currentLoginOptions(), logoutOptions(storedCredentials)))
        commands.push(...HOST_VIEW_ROWS)
        return commands
      },
      loginInProgress(): EnsoLoginInProgress | undefined {
        return waitingLogin === undefined ? undefined : { provider: waitingLogin.providerName }
      },
      cancelLogin(): boolean {
        if (waitingLogin === undefined) return false
        // The provider's wait first, then its card: the login settles as cancelled either way.
        waitingLogin.cancel.abort()
        waitingLogin.questions.abort()
        return true
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
      setSystemPrompt(choice: EnsoSystemPromptChoice | null): string | undefined {
        const decision = decideSystemPrompt(systemPrompt, choice, hasSentRequest(sessionManager.getBranch()))
        if (decision.kind === 'refused') return decision.reason
        if (decision.kind === 'same') return undefined
        systemPrompt = choice ?? undefined
        // Recorded BEFORE the first request, so the log says what the request will carry; pi
        // flushes it with the first assistant message, as it does the model and the mode. pi's
        // default is recorded too (`null`): it replaces a choice this branch already records.
        sessionManager.appendCustomEntry(ENSO_SYSTEM_PROMPT_ENTRY, choice)
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
        const refusal = incidentResolutionRefusal(branchIncidents(sessionManager.getBranch()), incidentId, resolution)
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
        if (liveSessionManagers.get(threadId) === sessionManager) liveSessionManagers.delete(threadId)
        flowsAbort.abort()
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
      checkPermission(request: EnsoPermissionCheckRequest): EnsoPermissionVerdict | undefined {
        const service = getPermissionsService(sessionManager.getSessionId())
        if (service === undefined) return undefined
        const mode = recordedPermissionMode(transcriptOf(sessionManager.getEntries()))
        const result = service.checkPermission(request.surface, request.value, modeAgentName(mode))
        return {
          mode,
          state: result.state,
          origin: result.origin,
          ...(result.matchedPattern === undefined ? {} : { matchedPattern: result.matchedPattern }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        }
      },
      branchStats: () => branchStats(sessionManager.getBranch()),
      branchEval: () => branchEval(sessionManager.getBranch()),
      branchIncidentHistory: (thresholds: EnsoRiskThresholds) =>
        branchIncidentHistory(sessionManager.getBranch(), thresholds),
      branchJudgeCases: (thresholds: EnsoRiskThresholds) =>
        branchJudgeCases(sessionManager.getBranch(), judgeCaseInputs(sessionManager.getCwd(), thresholds)),
      branchContext: () => branchContext(sessionManager.getBranch()),
      previewSystemPrompt(candidate: EnsoSystemPromptChoice | null): SystemPromptPreviewOutcome {
        if (session.isStreaming || session.isCompacting) return { kind: 'busy' }
        const setChoice = (choice: EnsoSystemPromptChoice | undefined): void => {
          systemPrompt = choice
        }
        const rendered = renderedUnder(session, setChoice, candidate ?? undefined, systemPrompt)
        const window = session.model?.contextWindow
        const preview = previewOf({
          rendered,
          preamble: candidate?.mode === 'system' ? candidate.text : services.resourceLoader.getSystemPrompt(),
          baseAppends: services.resourceLoader.getAppendSystemPrompt(),
          candidate,
          tools: session.agent.state.tools,
          contextWindow: window !== undefined && window > 0 ? window : undefined,
        })
        return preview === undefined ? { kind: 'unsplittable' } : { kind: 'preview', preview }
      },
      branchRequestDetail: (request: number | 'next') => branchRequestDetail(sessionManager.getBranch(), request),
      async forkPoint(): Promise<EnsoForkPoint> {
        const threadId = sessionManager.getSessionId()
        return forkPointOf(sessionManager.getBranch(), {
          threadId,
          cwd: sessionManager.getCwd(),
          parentThreadId: (await locate(threadId))?.parentThreadId,
        })
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

  /**
   * pi's model runtime over the agent dir alone — what `createAgentSessionServices` builds for
   * a session, minus the session (`sdk.js`: `ModelRuntime.create({ authPath, modelsPath })`).
   */
  async function catalogue(): Promise<RuntimeCommand[]> {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    })
    const providerNameOf = (providerId: string): string => modelRuntime.getProvider(providerId)?.name ?? providerId
    const credentials = await modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) })
    const login = loginOptions(loginFactsOf(modelRuntime))
    const logout = logoutOptions(
      credentials.map((credential) => ({
        providerId: credential.providerId,
        providerName: providerNameOf(credential.providerId),
        type: credential.type,
      })),
    )
    return catalogueRows(modelRuntime.getAvailableSnapshot(), getSupportedThinkingLevels, hostFlowRows(login, logout))
  }

  return {
    createSession,
    listSessions,
    storedThreadDirectory: async (threadId: string) => (await locate(threadId))?.cwd,
    readStoredThread,
    readStoredThreadStats,
    readStoredThreadContext,
    readStoredThreadEval,
    readStoredIncidentHistory,
    readStoredJudgeCases,
    readStoredRequestDetail,
    readStoredForkPoint,
    forkThread,
    restoreThreadAt,
    undoLastRestore,
    deleteThread,
    mintsTreesIn: (project: string) => treeKindOf(project) !== undefined,
    freshPermissionMode: freshPermissionModeState,
    storedPermissionMode: storedPermissionModeState,
    catalogue,
  }
}
