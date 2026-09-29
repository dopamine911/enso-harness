import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
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
  ENSO_OPERATOR_DENIAL_ENTRY,
  ENSO_SYSTEM_PROMPT_ENTRY,
  type EnsoForkPoint,
  type EnsoHostCommandRun,
  type EnsoModelState,
  type EnsoObservation,
  type EnsoLoginInProgress,
  type EnsoOpenDialog,
  type EnsoPermissionModeState,
  type EnsoPromptAdmission,
  type EnsoRecordedModel,
  type EnsoSessionUsage,
  type EnsoSystemPromptChoice,
  type EnsoSystemPromptPreview,
  type EnsoThreadEvent,
  type EnsoTranscriptEntry,
  ensoLogger,
  type HostFlowOutcome,
  type PromptOutcome,
  type PromptRequest,
  type RuntimeCommand,
  recordedSystemPrompt,
  type ThreadRuntime,
} from '@enso/core'
import { ensoHome, ensoSecretsPath, findRepoRoot } from '@enso/core/paths'
import { describePermissionRules, preparePermissionRules } from '@enso/core/permission-rules'
import { quarantineSecrets } from '@enso/core/secrets'
import { type BranchContext, type BranchRequestDetail, branchContext, branchRequestDetail } from './branch-context.ts'
import { type BranchEval, branchEval } from './branch-eval.ts'
import { type BranchStats, branchStats } from './branch-stats.ts'
import { type ContinuationLead, continuationLead, NO_RUN_LIFECYCLE, NOTHING_TO_CONTINUE } from './continuation.ts'
import { createEventTail, describeObservation } from './event-tail.ts'
import { createEnsoExtensionUiContext } from './extension-ui-context.ts'
import { forkPointOf } from './fork-point.ts'
import { decideHostCommand, HOST_VIEW_ROWS, HostCommandRefused, hostCommandRows } from './host-commands.ts'
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
  PICC_PERMISSION_MODES,
  persistedPermissionMode,
  piccModeCommand,
  readPiccPersistedMode,
  storedPermissionModeState,
} from './permission-mode-adapter.ts'
import { builtinProviderName, providerRefusalOf } from './provider-refusal.ts'
import type { RuntimeEvent } from './runtime-event.ts'
import { toRpcWireEvent } from './session-events.ts'
import { growsSessionSpend, liveSessionUsage, storedSessionUsage } from './session-usage.ts'
import { previewOf, renderedUnder } from './system-prompt-preview.ts'
import { decideSystemPrompt, hasSentRequest, withSystemPrompt } from './system-prompt.ts'
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
 * ⚠⚠ `PICC_PERMISSION_MODES_CONFIG_PATH` IS PINNED TO `ENSO_HOME/permissions.json` (#446), and
 * the file is prepared first. Unpinned, picc reads its user rules from a `config.json` inside its
 * own `node_modules` directory; and a file with no rules makes it import Claude Code's
 * `~/.claude/settings.json` into that file, every time it is empty. It reads both when the
 * extension loads, per session, so the pin and the seed come before the first services.
 * `preparePermissionRules` (`@enso/core/permission-rules`) says what is kept and seeded.
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
 * the parent the listing resolves (#433), then the recorded model and level (#434), picc's last
 * mode, the cwd and the latest `enso-run-context` the harness's `run-context` extension wrote.
 *
 * ⚠⚠ CONTINUE RUNS ON pi'S PRIVATE RUN LIFECYCLE (#436). `continueRun` resumes a torn thread from
 * exactly its stored state — no new user message — by calling `AgentSession._runAgentPrompt(lead)`
 * (`agent-session.js:1078`, `private` in `agent-session.d.ts:403`, an ordinary method at run time)
 * through ONE cast (`PiRunLifecycle`). pi 0.87.1 has no public continue that runs inside that
 * lifecycle, and the lifecycle is what makes it a run: `session.agent.continue()` alone persists the
 * reply and fires the guards, but never emits `agent_settled` (the route releases the lease on
 * `settled`, so the thread stayed busy forever), leaves `isStreaming` false (a prompt enqueued during
 * it was accepted and lost, with a spurious `settled` mid-run), skips auto-retry, and lets `abort()`
 * resolve before the run stopped (the spike on #436). `_runAgentPrompt` is what `prompt()` itself
 * ends in (`:1331`). Whether the tail CAN be continued is decided here, not by pi
 * (`continuation.ts`): the lifecycle would answer a completed reply again. The accepted differences
 * from a prompt: no `input` or `before_agent_start` for the continued turn — so no picc mode
 * reminder, no pi-multi-account last-moment account preflight, and the harness's `enso-run-context`
 * is not re-checked for it; no auth preflight (missing credentials become a stored error reply, and
 * the run settles); no pre-prompt compaction check (the post-run one still runs); and the first
 * request reuses the system prompt the transcript holds. `agent-host.test.ts` pins the lifecycle
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
   * The permission rules file (`ENSO_HOME/permissions.json`, #446) — see the module header.
   * REQUIRED, never defaulted: forgetting it would mean picc's `node_modules` copy, and Claude
   * Code's settings imported into it.
   */
  permissionRulesPath: string
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
 * entry under the id; `not-a-user-message` — pi forks only at a user message.
 */
export type ThreadForkOutcome =
  | { readonly kind: 'forked'; readonly threadId: string; readonly prefill: string }
  | { readonly kind: 'no-thread' | 'no-entry' | 'not-a-user-message'; readonly reason: string }

/**
 * Stop: tell the runtime, then settle every pending question as `aborted` WHILE it stops, and
 * refuse any question asked before it has — then wait for it.
 *
 * The runtime is told FIRST because its loop must hold the abort signal when a blocked
 * `tool_call` handler returns (picc's permission prompt): pi's `abort()` raises the signal
 * synchronously, before its first `await` (`agent-session.js` `abort` → `agent.abort()`), so
 * the dialogs can settle as soon as the call has begun. They must not wait for it to finish:
 * a question asked from a tool's `execute` (ask_user) holds the run, pi's `abort()` waits for
 * the run to go idle, and a stop that settled dialogs only afterwards waited on the card for
 * ever (#376 review, reproduced: single-choice and multi-select both). The refusal covers the
 * tool that ignores the signal and asks again — ask_user's multi-select loop asks the next
 * option — which would otherwise open a fresh question the stop then waits on.
 *
 * If the user says stop, it's stop (Daniel, 2026-09-16); the cards drop, the run ends. A stop
 * must stop (thread-registry.test.ts's rule, one layer down): the dialogs settle even if the
 * runtime's abort rejects — the rejection still propagates, the cards still drop. Exported so
 * that path is pinned against a stop that rejects, which the real runtime's is not made to do.
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
  /**
   * Fork a stored thread at one of its user messages, as pi's `/fork` does (#433; the module
   * header): a new session file naming the source as its parent, holding everything before that
   * message, and the message's text to prefill with. The source's file is not written; nothing is
   * built for either thread (#86).
   */
  forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome>
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): EnsoPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState
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

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { agentDir, harnessPackageDir, servesDirectory } = options

  // Order matters, and it is the module header's ⚠⚠ items: env before any pi module can
  // be imported by the loader, the proxy pin and the independent-roots switch before the first
  // session_start, and the secrets out of the environment before anything can inherit it (#89).
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS = '1'
  seedMultiAccountConfig(agentDir)
  // The rules picc reads when it loads, before the first services exist (#446). An unreadable file
  // refuses to start the host: picc would read it as empty and import Claude Code's into it.
  const permissionRules = preparePermissionRules(options.permissionRulesPath)
  if (permissionRules.kind === 'unreadable') {
    throw new Error(
      `${permissionRules.path} is unreadable (${permissionRules.reason}); fix it or remove it — a removed file is seeded with Enso's default deny rules (#446)`,
    )
  }
  process.env.PICC_PERMISSION_MODES_CONFIG_PATH = permissionRules.path
  log.info(describePermissionRules(permissionRules))
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
  if (quarantine.misplaced.length > 0) {
    log.warn(
      'the root .env defines {misplaced} — bun autoloads .env into every bun child, so a tool can still read it there. Move it to {secretsFile} (#89); it is not read from .env',
      { misplaced: quarantine.misplaced, secretsFile: ensoSecretsPath(ensoHome(environment)) },
    )
  }
  // The theme registry pi's UI code consults; harmless without a terminal, required once.
  initTheme()

  /**
   * pi's listing, through its API — never a directory scan: the file naming is pi's to
   * change, and `listAll` reads each file's header for the id and the directory. Every session
   * this host ever built is under the ONE agent dir (the env pin above), whatever its directory,
   * so `listAll` is the whole set; cost is one parse per file, paid per call. Sessions pi has not
   * flushed yet (no assistant message) have no file and are not listed — there is nothing to
   * come back to.
   */
  async function everySession(): Promise<StoredThread[]> {
    const listed = await SessionManager.listAll()
    // A fork's header names its parent by FILE (#433); the thread is that file's session id, read
    // off the same listing. A parent file that is gone names no thread, so the fork carries none.
    const idByPath = new Map(listed.map((info) => [resolve(info.path), info.id]))
    return listed
      .map((info) => {
        const parentThreadId =
          info.parentSessionPath === undefined ? undefined : idByPath.get(resolve(info.parentSessionPath))
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
    const path = await storedSessionPath(threadId)
    return path === undefined ? undefined : branchRequestDetail(SessionManager.open(path).getBranch(), request)
  }

  async function forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome> {
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session file in a project this server serves` }
    }
    const source = SessionManager.open(located.path)
    const entry = source.getEntry(entryId)
    if (entry === undefined) return { kind: 'no-entry', reason: `thread ${threadId} has no entry ${entryId}` }
    if (entry.type !== 'message' || entry.message.role !== 'user') {
      return { kind: 'not-a-user-message', reason: `entry ${entryId} is not a user message; a fork starts at one` }
    }
    const prefill = userMessageText(entry.message.content)
    // pi's `before`: the fork holds everything up to the message's parent — or nothing, naming its parent.
    let fork: SessionManager
    if (entry.parentId === null) {
      fork = SessionManager.create(source.getCwd(), source.getSessionDir())
      fork.newSession({ parentSession: located.path })
    } else {
      source.createBranchedSession(entry.parentId)
      fork = source
    }
    writeUnflushedSession(fork)
    return { kind: 'forked', threadId: fork.getSessionId(), prefill }
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
    const path = await storedSessionPath(threadId)
    return path === undefined ? undefined : branchEval(SessionManager.open(path).getBranch())
  }

  async function createSession(threadId: string, newSessionDirectory: () => string): Promise<HostedThread> {
    // Resolved BEFORE the services so a bad id fails before anything is built. A file under this
    // id decides the directory — pi fixed it at creation — and one this host does not serve is a
    // refusal, never a fresh session beside it under the same id. Only a thread with no file asks
    // where a new one goes, so a stale answer to that question cannot block a resume.
    const located = await locate(threadId)
    const cwd = located?.cwd ?? newSessionDirectory()
    if (!servesDirectory(cwd)) {
      throw new SessionDirectoryRefused(`thread ${threadId}: ${cwd} is not a project this server runs sessions in`)
    }
    // One session file per thread, under the agent dir pi resolves from the env the host set at creation —
    // the same default `pi --mode rpc` used, so picc's persisted "modes" entry and the
    // transcript land where the TUI's would. Opened when the thread already has a file
    // (#95), created under the thread's id when not. Retained: `permissionModeState()`
    // below walks its branch, the same walk picc's `restoreState` does.
    const sessionManager =
      located === undefined
        ? SessionManager.create(cwd, undefined, { id: threadId })
        : SessionManager.open(located.path)
    // The thread's system prompt (#443): the one its branch recorded, else pi's default until a
    // Start chooses one (`setSystemPrompt` below). An entry that does not read refuses the build —
    // never pi's default in its place, which would rewrite the prompt the thread started with. Read
    // BEFORE the services, as the directory is: a thread refused builds nothing.
    const recorded = recordedSystemPrompt(sessionManager.getBranch())
    if (recorded.kind === 'unreadable') {
      throw new Error(`thread ${threadId}: its ${ENSO_SYSTEM_PROMPT_ENTRY} entry does not read as a system prompt`)
    }
    let systemPrompt: EnsoSystemPromptChoice | undefined = recorded.kind === 'chosen' ? recorded.choice : undefined
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

    const ui = createEnsoExtensionUiContext({
      emit,
      threadId,
      // The operator pressed No on a permission prompt (#441): picc turns it into an ordinary error
      // result, so the fact is written here, on the branch, where the eval reads it.
      onOperatorDenial: (denial) => sessionManager.appendCustomEntry(ENSO_OPERATOR_DENIAL_ENTRY, denial),
    })

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
        // L3 (#162 workstream 4): the mode extension persisted a mode. Above this seam no
        // surface knows that entry's shape, so the host says what the mode is now, as its
        // own event; the mapper carries it as the `permission-mode` observation.
        if (wire.type === 'entry_appended' && readPiccPersistedMode(wire.entry) !== undefined) {
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
      continueRun(outcome: PromptOutcome): void {
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
      branchEval: () => branchEval(sessionManager.getBranch()),
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

  return {
    createSession,
    listSessions,
    storedThreadDirectory: async (threadId: string) => (await locate(threadId))?.cwd,
    readStoredThread,
    readStoredThreadStats,
    readStoredThreadContext,
    readStoredThreadEval,
    readStoredRequestDetail,
    readStoredForkPoint,
    forkThread,
    freshPermissionMode: freshPermissionModeState,
    storedPermissionMode: storedPermissionModeState,
  }
}
