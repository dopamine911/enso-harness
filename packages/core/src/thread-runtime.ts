import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import type { ZenOpenDialog } from './dialog.ts'
import type { ZenObservation } from './observation.ts'
import type { ZenPermissionModeState } from './permission-mode.ts'

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
 * `ZenObservation` and nothing of the runtime's. The module was called `pi-rpc.ts` until
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
 * literals, declared as a Zen schema and published on `ZenPromptBody`, so the vendor's model
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
export const ZenPromptAdmission = Type.Union([Type.Literal('interrupt'), Type.Literal('enqueue')])
/** @group Thread runtime */
export type ZenPromptAdmission = Static<typeof ZenPromptAdmission>

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
  source: Type.Union([Type.Literal('extension'), Type.Literal('prompt'), Type.Literal('skill')]),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
})
/** @group Thread runtime */
export type RuntimeCommand = Static<typeof RuntimeCommand>

const commandValidator = Compile(RuntimeCommand)

/** @group Thread runtime */
export function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  return commandValidator.Check(value)
}

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
  | { cancelled: true; value?: never; confirmed?: never }
  | { value: string; cancelled?: never; confirmed?: never }
  | { confirmed: boolean; cancelled?: never; value?: never }
)

/** @group Thread runtime */
export interface PromptRequest {
  message: string
  images?: readonly PromptImageContent[]
  /** How the runtime should take it when a run is already streaming; the host maps it. */
  admission?: ZenPromptAdmission
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
  openDialogs: Type.Unsafe<() => ZenOpenDialog[]>(Type.Function([], Type.Unknown())),
  /** The slash commands this session can run — extension commands, prompt templates, skills. Synchronous: read off the live registry, no round trip. */
  listCommands: Type.Unsafe<() => RuntimeCommand[]>(Type.Function([], Type.Unknown())),
  /**
   * The permission-mode receipt a run starts with (#84): picc's CURRENT mode for this
   * session, computed the way picc itself restores it — the last persisted `modes` entry
   * in the session branch, else the initial `default` — and the modes this session may
   * switch to, picc's set intersected with the commands actually registered. picc keeps
   * the live value in a closure with no getter, so this is the only honest read.
   * Synchronous: it walks the in-memory branch and registry, no round trip — and it is
   * deliberately NOT `listCommands`, whose call count the refusal path's tests pin.
   */
  permissionModeState: Type.Unsafe<() => ZenPermissionModeState>(Type.Function([], Type.Unknown())),
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
   * Receive every observation of this thread (L2, #162 workstream 4): the runtime's events
   * mapped to `ZenObservation` BELOW this seam, plus what the host itself observes — a
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
  subscribe: Type.Unsafe<(onObservation: (observation: ZenObservation) => void) => () => void>(
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
