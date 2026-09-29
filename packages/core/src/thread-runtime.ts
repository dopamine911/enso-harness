import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import type { EnsoOpenDialog, EnsoQuestionAnswer } from './dialog.ts'
import type { EnsoLoginInProgress, EnsoObservation } from './observation.ts'
import type { EnsoPermissionModeState } from './permission-mode.ts'
import type { EnsoSystemPromptChoice } from './prompt-library.ts'

/**
 * The thread runtime: the contract the host implements for one thread, and the shapes that
 * cross it (`docs/glossary.md` → Thread, Control).
 *
 * This is the seam a runtime replacement would re-implement — prompt, abort, answer, subscribe,
 * clear the queue, dispose — with one fake in the tests as its second implementation today.
 *
 * ⓘ HISTORY. Until #69 the web server spawned the runtime in its RPC mode and spoke JSONL
 * to it; that transport is deleted, and until #162 workstream 4 (L2) the EVENT SHAPE that
 * mode defined survived as what `subscribe` handed out — the runtime's own fields, mapped
 * to observations above this seam. Now the host maps below it: a subscriber receives
 * `EnsoObservation` and nothing of the runtime's. The module was called `pi-rpc.ts` until
 * #165 renamed it: the wire is gone, the contract is ours, and a name that says a vendor's
 * transport describes neither.
 *
 * ⚠ ONE SCHEMA BELOW CARRIES FUNCTIONS: `ThreadRuntime`. TypeBox can express that, and its
 * validator does check `typeof === "function"` — but it serialises to `{"type":
 * "function"}`, a TypeBox extension rather than standard JSON Schema, so it is NOT usable
 * by an OpenAPI consumer. Declared as a schema anyway, by decision: one rule ("every shape
 * in this repo is a schema in this package") the next session can follow without judgement
 * beats a finer rule that is correct and needs explaining.
 */

/**
 * Base64 image content, accepted by `prompt`, `steer` and `follow_up`.
 *
 * @group Thread runtime
 */
export const PromptImageContent = Type.Object({
  type: Type.Literal('image'),
  data: Type.String(),
  mimeType: Type.String(),
})
/** @group Thread runtime */
export type PromptImageContent = Static<typeof PromptImageContent>

/**
 * What to do when a prompt arrives while the agent is already streaming — ZEN's two words,
 * not the runtime's (#216).
 *
 * ⚠ IT WAS `StreamingBehavior = 'steer' | 'followUp'`: pi's own option name and pi's own
 * literals, declared as an Enso schema and published on `EnsoPromptBody`, so the vendor's model
 * was the only vocabulary the wire accepted — and `docs/seams/thread-runtime.md` said the
 * opposite in the same breath. The vendor gate cannot see that class of leak: no import, no
 * vendor word. pi's spelling is produced in ONE place now, `host/agent-host.ts`, which is
 * where a vendor word belongs; a runtime that admits prompts differently becomes a host
 * change, which is this seam's whole promise.
 *
 * `interrupt` — take the prompt at the next step boundary. `enqueue` — after the run settles.
 * Two because the runtime has two; a third is a literal here and a mapping there.
 *
 * @group Thread runtime
 */
export const EnsoPromptAdmission = Type.Union([Type.Literal('interrupt'), Type.Literal('enqueue')])
/** @group Thread runtime */
export type EnsoPromptAdmission = Static<typeof EnsoPromptAdmission>

/**
 * One choice a `host` command offers (#338 slice 2): `id` is what `POST …/command` sends back,
 * `label` what the row shows, `detail` a dimmer second column (a model's provider).
 *
 * @group Thread runtime
 */
export const HostCommandOption = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String(),
  detail: Type.Optional(Type.String()),
  /**
   * On a `/model` option only (#391): the thinking levels THAT model supports, as the runtime
   * decides them — so a page can offer the effort for a model before switching to it (the
   * Start-a-session dialog applies everything at once). The `thinking` row's own options are the
   * CURRENT model's.
   */
  thinkingLevels: Type.Optional(Type.Array(Type.String())),
})
/** @group Thread runtime */
export type HostCommandOption = Static<typeof HostCommandOption>

/**
 * The model a session runs and how hard it thinks (#338 slice 2, the control half of #44):
 * `model` is `null` when the session has none pi will run (no provider authenticated);
 * `thinkingLevel` is pi's — one of `availableThinkingLevels`, which the current model decides
 * (`off` for a model that cannot reason).
 *
 * @group Thread runtime
 */
export const EnsoModelChoice = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
})
/** @group Thread runtime */
export type EnsoModelChoice = Static<typeof EnsoModelChoice>
/** @group Thread runtime */
export const EnsoModelState = Type.Object({
  model: Type.Union([EnsoModelChoice, Type.Null()]),
  thinkingLevel: Type.String(),
  availableThinkingLevels: Type.Array(Type.String()),
})
/** @group Thread runtime */
export type EnsoModelState = Static<typeof EnsoModelState>

/**
 * What a stored thread's branch RECORDS it last ran on (#434): the model of the last `model_change`
 * or assistant reply on the path to the leaf, and the last `thinking_level_change` — pi's own
 * restore rule when the session is opened (PR #438 review). Not an `EnsoModelState`: nothing is
 * built for a cold read (#86), so there is no display name and no available levels, and the page
 * labels it recorded, not live. A half the branch never recorded is `null`; a branch that records
 * neither has no recorded model at all.
 *
 * @group Thread runtime
 */
export const EnsoRecordedModel = Type.Object(
  {
    model: Type.Union([
      Type.Object(
        { provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    thinkingLevel: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Thread runtime */
export type EnsoRecordedModel = Static<typeof EnsoRecordedModel>

/**
 * How full the context window is, as pi reckons it (#45): pi's `getContextUsage()`, never a
 * number of ours. `tokens` is pi's estimate — the latest assistant request's usage plus what
 * has been added since — and `null` right after a compaction, until the next response says.
 *
 * @group Thread runtime
 */
export const EnsoContextUsage = Type.Object(
  {
    tokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    /** The current model's window; a model with none declared has no context usage at all. */
    window: Type.Number({ exclusiveMinimum: 0 }),
    percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Thread runtime */
export type EnsoContextUsage = Static<typeof EnsoContextUsage>

/**
 * What a thread's session has spent, and how full its context is (#45) — pi's session totals,
 * which stay authoritative: every usage pi recorded in the session, on every branch, including
 * the model calls behind a compaction or a branch summary (`getSessionStats`). So a reload, a
 * resume, or a second tab reads the same total the first tab saw accumulate.
 *
 * `context` is `null` when the thread is not live — a file does not say which model pi would
 * run, so it does not say the window — or when the model declares none.
 *
 * @group Thread runtime
 */
export const EnsoSessionUsage = Type.Object(
  {
    /** Dollars, summed from each usage's `cost.total`; `0` for a provider that reports none. */
    cost: Type.Number({ minimum: 0 }),
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    context: Type.Union([EnsoContextUsage, Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Thread runtime */
export type EnsoSessionUsage = Static<typeof EnsoSessionUsage>

/**
 * One entry from pi's `get_commands`.
 *
 * ⚠ `source` matters for a reason the field name does not convey: these are the ONLY
 * commands invokable over rpc. pi's docs are explicit that built-in TUI commands
 * (`/settings`, `/hotkeys`, …) are excluded and "would not execute if sent via `prompt`" —
 * so a `/`-prefixed message absent from this list is not a command at all, it is prose the
 * model will try to answer. See `session.ts` for why that has to be refused rather than
 * forwarded.
 *
 * @group Thread runtime
 */
export const RuntimeCommand = Type.Object({
  name: Type.String(),
  /** pi's three, plus `host` — ours, declared by kind (#338 slice 2). */
  source: Type.Union([Type.Literal('extension'), Type.Literal('prompt'), Type.Literal('skill'), Type.Literal('host')]),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  /**
   * `host` rows only (#338): what the row IS, not what widget draws it. `select` — one of many
   * `options`, the second step filters them (`/model`); `level` — one of a few ordered `options`,
   * chosen in place (`/thinking`); `flow` — chosen like a `select`, but the choice STARTS
   * something rather than applying it: `/login` and `/logout` (slice 3) run as dialog flows,
   * their questions and progress arriving on the feed, the route answering 202 when the flow has
   * begun; `action` — runs with no value (`/compact`, slice 4); `view` — the PAGE does it: opens
   * what the row names over the chat (`/context`, #361) or forks at the last prompt (`/fork`,
   * #433) through its own route, and nothing is posted to `…/command`. The palette
   * renders by kind; nothing is per-command UI.
   */
  kind: Type.Optional(
    Type.Union([
      Type.Literal('select'),
      Type.Literal('level'),
      Type.Literal('flow'),
      Type.Literal('action'),
      Type.Literal('view'),
    ]),
  ),
  /** `host` rows: the current choice, as an `options[].id`. Absent when the list is `remembered` — a thread with no live session has no current value to show. */
  value: Type.Optional(Type.String()),
  /** `host` rows with `kind: 'select' | 'level'`: what may be chosen. */
  options: Type.Optional(Type.Array(HostCommandOption)),
})
/** @group Thread runtime */
export type RuntimeCommand = Static<typeof RuntimeCommand>

/**
 * `POST /api/threads/:id/command` (#338 slice 2): run a `host` command. `value` is one of the
 * row's `options[].id` for `select`/`level`; absent for `action`.
 *
 * @group Thread runtime
 */
export const EnsoHostCommandRun = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    value: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Thread runtime */
export type EnsoHostCommandRun = Static<typeof EnsoHostCommandRun>

/**
 * `POST /api/threads/:id/configure` (#391): a new session's settings, applied together — the
 * Start-a-session dialog's Start. `model` is a `/model` option id, `thinking` a level THAT model
 * supports, `mode` a permission mode the thread offers, `systemPrompt` a library prompt (#443). The
 * server applies them under one lease, the system prompt first (it is the one a session can take
 * only before its first request) and then the rest in this order (the effort a model allows depends
 * on the model); a value equal to the current one is left alone. The first prompt is not part of
 * it: it goes through the chat's own send.
 *
 * @group Thread runtime
 */
export const EnsoSessionConfiguration = Type.Object(
  {
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(Type.String({ minLength: 1 })),
    mode: Type.Optional(Type.String({ minLength: 1 })),
    /**
     * A library prompt's id (#443), `system` or `append`, or `null` for pi's default. Applied FIRST.
     * Absent leaves the session's as it is; `null` is how a Start retried after a later step refused
     * goes back to pi's default over a prompt the first attempt already applied.
     */
    systemPrompt: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false },
)
/** @group Thread runtime */
export type EnsoSessionConfiguration = Static<typeof EnsoSessionConfiguration>

/**
 * Why a configuration was refused (#391): the STEP that refused and the runtime's reason. The
 * steps before it applied; the ones after it did not run. Answered as a 422 body.
 *
 * @group Thread runtime
 */
export const EnsoConfigurationRefusal = Type.Object({
  step: Type.Union([
    Type.Literal('systemPrompt'),
    Type.Literal('model'),
    Type.Literal('thinking'),
    Type.Literal('mode'),
  ]),
  reason: Type.String(),
})
/** @group Thread runtime */
export type EnsoConfigurationRefusal = Static<typeof EnsoConfigurationRefusal>

const commandValidator = Compile(RuntimeCommand)

/** @group Thread runtime */
export function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  return commandValidator.Check(value)
}

/**
 * What `GET /api/threads/:id/commands` answers (#338): the slash commands a thread can run,
 * for the palette that lists them.
 *
 * ⚠ `source` is HONEST ABOUT WHERE THE LIST CAME FROM, because looking must not build (#86).
 * A thread has no session until its first prompt, and a session is the only thing that can be
 * asked what it registers. So a live thread answers `live`; a thread without a live session
 * (never built, or idled out — the server cannot tell) answers `remembered` — the list the most
 * recently built session in this process registered, which every session builds from the same
 * sources under the same configuration (the harness package's extensions; the prompt templates
 * and skills under the agent directory as they stood at that build) — or `none` before any
 * session has been built. The palette shows the list either way and says which it is.
 *
 * @group Thread runtime
 */
export const EnsoThreadCommands = Type.Object(
  {
    threadId: Type.String(),
    commands: Type.Array(RuntimeCommand),
    source: Type.Union([Type.Literal('live'), Type.Literal('remembered'), Type.Literal('none')]),
  },
  { additionalProperties: false },
)
/** @group Thread runtime */
export type EnsoThreadCommands = Static<typeof EnsoThreadCommands>

/**
 * ── The thread runtime contract (#69) ───────────────────────────────────────────────────
 *
 * What the web server needs from a thread's runtime, whatever hosts it. Today the host is
 * in-process (`packages/web/src/host/agent-host.ts`); the shape is what the server used to
 * obtain from the RPC subprocess, lifted one level: typed events in, typed commands out,
 * no wire.
 *
 * ⚠ ACCEPTANCE AND COMPLETION ARE SEPARATE SIGNALS, deliberately. `prompt` reports
 * acceptance through `onAccepted` — pi's `preflightResult(true)`, which fires when the
 * prompt was accepted OR, for an extension command, when the command has COMPLETED (the
 * command runs inside prompt preflight; `/mode`'s unanswered dialog once blocked it for the
 * whole pre-#27 hang). Completion of an ordinary run is the `agent_settled` EVENT, never a
 * callback. The streaming loop's slash-command quick-close depends on that exact split.
 */

/**
 * An answer to a blocking dialog, keyed to the request id the `extension_ui_request` carried.
 *
 * ⚠ THE ARMS ARE MUTUALLY EXCLUSIVE, and the `?: never` members are what says so (#225). Without
 * them the union is untagged — `{ id, cancelled: true, confirmed: true }` satisfies two arms at
 * once — and a reader can only ask whether a key EXISTS, never what it holds. `answerThreadDialog`
 * asked exactly that and skipped `validateDialogAnswer` for anything carrying a `cancelled` key,
 * which is the select-injection fence (`dialog.ts`) open for an answer that also carried a value.
 * With the arms disjoint, `answer.cancelled === true` narrows, so every reader tests the VALUE.
 *
 * @group Thread runtime
 */
export type DialogAnswer = { id: string } & (
  | { cancelled: true; value?: never; confirmed?: never; answers?: never }
  | { value: string; cancelled?: never; confirmed?: never; answers?: never }
  | { confirmed: boolean; cancelled?: never; value?: never; answers?: never }
  | { answers: EnsoQuestionAnswer[]; cancelled?: never; value?: never; confirmed?: never }
)

/** @group Thread runtime */
export interface PromptRequest {
  message: string
  images?: readonly PromptImageContent[]
  /** How the runtime should take it when a run is already streaming; the host maps it. */
  admission?: EnsoPromptAdmission
}

/**
 * What a `flow` or `action` host command reports (#338 slices 3–4): `PromptOutcome`'s two signals
 * plus the end. The route reads them differently by kind — a `flow` (login) releases the thread's
 * lease on acceptance, an `action` (compaction) on settle — see `startHostFlow`.
 *
 * @group Thread runtime
 */
export interface HostFlowOutcome extends PromptOutcome {
  /** The work ended — completed, failed, or cancelled. Fires exactly once, after `onAccepted`. */
  onSettled: () => void
}

/** @group Thread runtime */
export interface PromptOutcome {
  /** Preflight accepted the prompt (or an extension command finished). NOT run completion. */
  onAccepted: () => void
  /** Preflight rejected the prompt before acceptance; the run never started. */
  onRejected: (reason: string) => void
}

/**
 * ⚠ Function-bearing — the one schema the module header's rule is written for.
 *
 * @group Thread runtime
 */
export const ThreadRuntime = Type.Object({
  /** Fire a prompt. Never awaits the run — see the section header. */
  prompt: Type.Unsafe<(request: PromptRequest, outcome: PromptOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * Continue a torn thread from exactly its stored state (#436): no new user message. Shaped like
   * `prompt` — fire-and-forget, acceptance through `outcome`, completion the thread's own
   * `settled`. Rejected before anything runs when a run is in flight or the stored tail is not
   * one a run can continue from (a completed reply); the reason says which.
   */
  continueRun: Type.Unsafe<(outcome: PromptOutcome) => void>(Type.Function([Type.Unknown()], Type.Void())),
  /**
   * Deliver a human's answer (or cancellation) to a pending blocking dialog. Never throws:
   * an unknown or already-settled id is reported through the host's problem channel, so
   * callers do not wrap this in a try/catch.
   */
  answerDialog: Type.Unsafe<(response: DialogAnswer) => void>(Type.Function([Type.Unknown()], Type.Void())),
  /**
   * Every question a blocking dialog is waiting on, oldest first — what the follow's
   * snapshot lists (#114), and what an answer is validated against (#112: a select's value
   * handed to the extension VERBATIM is an injection seam unless the server checks it).
   * Empty once answered, cancelled, or never asked.
   */
  openDialogs: Type.Unsafe<() => EnsoOpenDialog[]>(Type.Function([], Type.Unknown())),
  /**
   * The slash commands this session can run — extension commands, prompt templates, skills, and
   * the host's own (`source: 'host'`, #338 slice 2: `/model`, `/thinking`, each with its current
   * `value` and its `options`). Synchronous: read off the live registry and the session, no
   * round trip.
   */
  listCommands: Type.Unsafe<() => RuntimeCommand[]>(Type.Function([], Type.Unknown())),
  /** The model and thinking level this session runs with now (#338 slice 2). Synchronous. */
  modelState: Type.Unsafe<() => EnsoModelState>(Type.Function([], Type.Unknown())),
  /** What the session has spent and how full its context is, now (#45). Synchronous. */
  sessionUsage: Type.Unsafe<() => EnsoSessionUsage>(Type.Function([], Type.Unknown())),
  /**
   * Run a `host` command (#338 slice 2): `model` with an `options[].id` (`provider/id`),
   * `thinking` with a level. Resolves when applied; the change itself arrives on the feed as a
   * `model` observation, for every follower. REJECTS with a reason a reader can act on — an
   * unknown model, a level this model does not offer, a provider with no credentials (pi's
   * `setModel` refuses that) — and the route says it as 422.
   */
  runHostCommand: Type.Unsafe<(run: EnsoHostCommandRun) => Promise<void>>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /**
   * Start a `flow` host command (#338 slice 3): `login` with a `provider/authType` option,
   * `logout` with a provider. Fire-and-forget like `prompt`, and for the same reason: a login
   * may wait minutes on a device code, and the route must not. `outcome.onAccepted` fires once
   * the flow has begun (the route's 202); `onRejected(reason)` before that for an option the
   * host cannot start (the route's 422); `onSettled` when the work ends. ⚠ THE LEASE FOLLOWS THE
   * KIND. A `flow` (login) is not a run: its lease is released on acceptance, as a mode change's
   * is — holding it marked the thread busy for the whole device-code wait (slice-3 smoke) — and
   * the flow lives on the session until pi's own expiry, Stop (`cancelLogin`, #348), or the
   * session's disposal. An `action`
   * (compaction, slice 4) REWRITES THE BRANCH and is run-shaped: the lease is held until
   * `onSettled`, so the composer is closed, a prompt is 409 (pi itself refuses one mid-compaction,
   * `agent-session.js:1227`), and Stop reaches it (`abort` calls `abortCompaction`). The work's
   * questions are the same blocking dialogs an extension asks (`extension-ui-request`), its
   * progress is `notify` lines, and its result is a `model` observation and a final notify.
   */
  startHostFlow: Type.Unsafe<(run: EnsoHostCommandRun, outcome: HostFlowOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * The login waiting on its provider, if one is (#348). A login holds no lease, so the registry
   * cannot see it as busy: this is what the follow's snapshot carries, and what Stop asks for when
   * no run is in flight. A `login` observation says when it starts and stops waiting.
   */
  loginInProgress: Type.Unsafe<() => EnsoLoginInProgress | undefined>(Type.Function([], Type.Unknown())),
  /**
   * Cancel the login in progress (#348) — Stop, when no run is in flight. `true` when one was:
   * it then settles as a cancelled login ("Login to X cancelled."), its questions withdrawn and
   * nothing stored. `false` when there was none.
   */
  cancelLogin: Type.Unsafe<() => boolean>(Type.Function([], Type.Unknown())),
  /**
   * The permission-mode receipt a run starts with (#84): picc's CURRENT mode for this
   * session, computed the way picc itself restores it — the last persisted `modes` entry
   * in the session branch, else the initial `default` — and the modes this session may
   * switch to, picc's set intersected with the commands actually registered. picc keeps
   * the live value in a closure with no getter, so this is the only honest read.
   * Synchronous: it walks the in-memory branch and registry, no round trip — and it is
   * deliberately NOT `listCommands`, whose call count the refusal path's tests pin.
   */
  permissionModeState: Type.Unsafe<() => EnsoPermissionModeState>(Type.Function([], Type.Unknown())),
  /**
   * Switch the mode (L3 step C, #162 workstream 4). The host translates to whatever its mode
   * extension accepts — for picc, the per-mode slash command, run as a prompt the same way
   * `prompt` runs one — so the caller says a mode and never a command. Fire-and-forget like
   * `prompt`: acceptance is `outcome.onAccepted` (an extension command's acceptance IS its
   * completion), the change itself is the `permission_mode` event on the feed, and a
   * rejection after acceptance is lost the same way. The caller has already checked the
   * mode is one `permissionModeState().available` offers.
   */
  setPermissionMode: Type.Unsafe<(mode: string, outcome: PromptOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * Fix the session's system prompt to a library prompt (#443) — or to pi's default, `null` — before
   * its first request: the choice is recorded in the thread's log, the next request carries it, and
   * a resume reads it back; until then another choice replaces it. `undefined` when it applied, or
   * when the same prompt is already this session's; else the refusal's reason — a session that has
   * already sent a request keeps the prompt it sent (a system head rewritten mid-session throws the
   * prompt cache away). Synchronous.
   */
  setSystemPrompt: Type.Unsafe<(choice: EnsoSystemPromptChoice | null) => string | undefined>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /**
   * Receive every observation of this thread (L2, #162 workstream 4): the runtime's events
   * mapped to `EnsoObservation` BELOW this seam, plus what the host itself observes — a
   * dialog it opened, an extension's error, a mode its extension persisted. Nothing of the
   * runtime's own event shape reaches a subscriber. Observations emitted before the FIRST
   * subscriber are buffered and replayed to it, so nothing an extension says at start-up is
   * lost; with no subscriber after that, they are dropped (#69 PR 2 — a held `settled` would
   * end the next run). A replayed observation carries `origin: 'session-start'` where the kind
   * has an origin (#96), so the browser can group start-up chatter without guessing from
   * position in the stream. Returns the unsubscribe.
   *
   * ⚠ `Type.Unsafe` keeps the schema for uniformity and the precise type for consumers; a
   * schema change must be mirrored in the annotation by hand.
   */
  subscribe: Type.Unsafe<(onObservation: (observation: EnsoObservation) => void) => () => void>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /** Abort the in-flight run and wait until the agent is idle. The session survives. */
  abort: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
  /**
   * Drop every prompt waiting behind the run and return the texts, interrupting first (#75,
   * clear-and-restore): the runtime also emits the queue observation every follower reads.
   * The stop route hands the texts back to the tab that stopped, so nothing typed is lost and
   * nothing runs unasked on the next turn. ZEN's two words (#216) — the host maps them.
   */
  clearQueue: Type.Unsafe<() => { interrupting: string[]; enqueued: string[] }>(Type.Function([], Type.Unknown())),
  /** Cancel pending dialogs, tell extensions the session is shutting down, release the session. Idempotent. */
  dispose: Type.Unsafe<() => void>(Type.Function([], Type.Void())),
})
/** @group Thread runtime */
export type ThreadRuntime = Static<typeof ThreadRuntime>
