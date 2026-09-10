import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import type { ZenOpenDialog } from './dialog.ts'
import type { PiPermissionModeState } from './permission-mode.ts'

/**
 * The shapes pi hands the web surface, and the in-process session contract around them.
 *
 * ⓘ WHY "rpc" IS STILL IN THE NAME. Until #69 the web server spawned `pi --mode rpc` and
 * spoke JSONL to it; that transport is deleted. What survives is the EVENT SHAPE pi's rpc
 * mode defined (`docs/rpc.md` of pi 0.84.4) — the in-process host translates
 * `AgentSession` events into exactly that shape (`host/session-events.ts`), because it is
 * the seam `map-events.ts` and its tests consume. The wire is gone; its vocabulary is the
 * contract. Renaming the module would churn every importer to say the same thing.
 *
 * ⚠ DELIBERATELY NOT EXHAUSTIVE, AND THE EVENT SCHEMA IS OPEN. Only `type` is constrained,
 * so an unmodelled event validates and is forwarded rather than rejected. pi's event list
 * will grow, and a schema that closed every event would turn a new event type into a
 * parse failure — converting "we do not render this yet" into "the host is broken".
 *
 * ⚠ ONE SCHEMA BELOW CARRIES FUNCTIONS: `PiSession`. TypeBox can express that, and its
 * validator does check `typeof === "function"` — but it serialises to `{"type":
 * "function"}`, a TypeBox extension rather than standard JSON Schema, so it is NOT usable
 * by an OpenAPI consumer. Declared as a schema anyway, by decision: one rule ("every shape
 * in this repo is a schema in this package") the next session can follow without judgement
 * beats a finer rule that is correct and needs explaining.
 */

/** Base64 image content, accepted by `prompt`, `steer` and `follow_up`. */
export const PiImageContent = Type.Object({
  type: Type.Literal('image'),
  data: Type.String(),
  mimeType: Type.String(),
})
export type PiImageContent = Static<typeof PiImageContent>

/** What to do when a prompt arrives while the agent is already streaming. */
export const PiStreamingBehavior = Type.Union([Type.Literal('steer'), Type.Literal('followUp')])
export type PiStreamingBehavior = Static<typeof PiStreamingBehavior>

/**
 * ⚠ Open-object types need an explicit intersection.
 *
 * `additionalProperties: Type.Unknown()` makes the SCHEMA accept extra fields, but
 * `Static<>` does not synthesise an index signature from it — verified against typebox
 * 1.3.25. So the runtime shape comes from the schema and the open-record ergonomics come
 * from the intersection. Both halves are needed; neither alone is enough.
 */
type OpenRecord = Record<string, unknown>

const openObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: Type.Unknown() })

/** One event from pi, in the rpc wire shape. Only `type` is constrained — see the header. */
export const PiRpcEventSchema = openObject({
  type: Type.String({ minLength: 1 }),
})
export type PiRpcEvent = Static<typeof PiRpcEventSchema> & OpenRecord

/**
 * One entry from pi's `get_commands`.
 *
 * ⚠ `source` matters for a reason the field name does not convey: these are the ONLY
 * commands invokable over rpc. pi's docs are explicit that built-in TUI commands
 * (`/settings`, `/hotkeys`, …) are excluded and "would not execute if sent via `prompt`" —
 * so a `/`-prefixed message absent from this list is not a command at all, it is prose the
 * model will try to answer. See `session.ts` for why that has to be refused rather than
 * forwarded.
 */
export const PiCommand = Type.Object({
  name: Type.String(),
  source: Type.Union([Type.Literal('extension'), Type.Literal('prompt'), Type.Literal('skill')]),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
})
export type PiCommand = Static<typeof PiCommand>

const commandValidator = Compile(PiCommand)

export function isPiCommand(value: unknown): value is PiCommand {
  return commandValidator.Check(value)
}

/**
 * ── The in-process session contract (#69) ────────────────────────────────────────────────
 *
 * What the web server's streaming loop needs from a pi session, whatever hosts it. Today
 * the host is an in-process `AgentSession` (`packages/web/src/host/agent-host.ts`); the
 * shape is what `session.ts` used to obtain from the rpc subprocess through `PiRpcClient`,
 * lifted one level: typed events in, typed commands out, no wire.
 *
 * ⚠ ACCEPTANCE AND COMPLETION ARE SEPARATE SIGNALS, deliberately. `prompt` reports
 * acceptance through `onAccepted` — pi's `preflightResult(true)`, which fires when the
 * prompt was accepted OR, for an extension command, when the command has COMPLETED (the
 * command runs inside prompt preflight; `/mode`'s unanswered dialog once blocked it for the
 * whole pre-#27 hang). Completion of an ordinary run is the `agent_settled` EVENT, never a
 * callback. The streaming loop's slash-command quick-close depends on that exact split.
 */

/** An answer to a blocking dialog, keyed to the request id the `extension_ui_request` carried. */
export type PiDialogResponse = { id: string } & ({ cancelled: true } | { value: string } | { confirmed: boolean })

export interface PiPromptRequest {
  message: string
  images?: readonly PiImageContent[]
  /** Required by pi when the session is already streaming — otherwise `prompt` rejects. */
  streamingBehavior?: PiStreamingBehavior
}

export interface PiPromptOutcome {
  /** Preflight accepted the prompt (or an extension command finished). NOT run completion. */
  onAccepted: () => void
  /** Preflight rejected the prompt before acceptance; the run never started. */
  onRejected: (reason: string) => void
}

/** ⚠ Function-bearing — the one schema the module header's rule is written for. */
/**
 * How an event reached a subscriber (#96): `replayed` from the host's until-first-subscriber
 * buffer (the session's own start), or `live`. The two deliveries a subscriber can see — the
 * event tail's `held`/`dropped` provenances (#97) never reach one.
 */
export type PiEventDelivery = 'live' | 'replayed'

export const PiSession = Type.Object({
  /** Fire a prompt. Never awaits the run — see the section header. */
  prompt: Type.Unsafe<(request: PiPromptRequest, outcome: PiPromptOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * Deliver a human's answer (or cancellation) to a pending blocking dialog. Never throws:
   * an unknown or already-settled id is reported through the host's problem channel, so
   * callers do not wrap this in a try/catch.
   */
  answerDialog: Type.Unsafe<(response: PiDialogResponse) => void>(Type.Function([Type.Unknown()], Type.Void())),
  /**
   * Every question a blocking dialog is waiting on, oldest first — what the follow's
   * snapshot lists (#114), and what an answer is validated against (#112: a select's value
   * handed to the extension VERBATIM is an injection seam unless the server checks it).
   * Empty once answered, cancelled, or never asked.
   */
  openDialogs: Type.Unsafe<() => ZenOpenDialog[]>(Type.Function([], Type.Unknown())),
  /** The slash commands this session can run — extension commands, prompt templates, skills. Synchronous: read off the live registry, no round trip. */
  listCommands: Type.Unsafe<() => PiCommand[]>(Type.Function([], Type.Unknown())),
  /**
   * The permission-mode receipt a run starts with (#84): picc's CURRENT mode for this
   * session, computed the way picc itself restores it — the last persisted `modes` entry
   * in the session branch, else the initial `default` — and the modes this session may
   * switch to, picc's set intersected with the commands actually registered. picc keeps
   * the live value in a closure with no getter, so this is the only honest read.
   * Synchronous: it walks the in-memory branch and registry, no round trip — and it is
   * deliberately NOT `listCommands`, whose call count the refusal path's tests pin.
   */
  permissionModeState: Type.Unsafe<() => PiPermissionModeState>(Type.Function([], Type.Unknown())),
  /**
   * Receive every event in pi's rpc wire shape (the shape `map-events.ts` consumes), plus
   * `extension_ui_request` and `extension_error` records the host synthesises. Events
   * emitted before the FIRST subscriber are buffered and replayed to it, so nothing an
   * extension says at `session_start` is lost; with no subscriber after that, events are
   * dropped (#69 PR 2 — a held `agent_settled` would end the next run). Returns the
   * unsubscribe.
   *
   * The subscriber is told HOW each event reached it (`delivery`, #96): `replayed` from
   * that held buffer — emitted during the session's own start — or `live`. The mapper turns
   * it into the observation's `origin`, so the browser can group startup chatter without
   * guessing from position in the stream.
   *
   * ⚠ `Type.Unsafe` rather than `Type.Function([PiRpcEventSchema], …)`, and the reason is
   * a cost of declaring behaviour as a schema worth recording: the latter infers its
   * parameter as `Static<typeof PiRpcEventSchema>`, which DROPS the `& Record<string,
   * unknown>` intersection that makes an event's unmodelled fields reachable — consumers
   * would get `{ type: string }` and could not read `event.willRetry`. `Type.Unsafe<T>`
   * keeps the schema for uniformity and the precise type for consumers; it is "unsafe"
   * because the two are no longer derived from one another, so a schema change must be
   * mirrored in the annotation by hand.
   */
  subscribe: Type.Unsafe<(onEvent: (event: PiRpcEvent, delivery: PiEventDelivery) => void) => () => void>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /** Abort the in-flight run and wait until the agent is idle. The session survives. */
  abort: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
  /**
   * Drop every prompt waiting behind the run and return the texts, steering first (#75,
   * clear-and-restore): pi's `AgentSession.clearQueue()`, which also emits the
   * `queue_update` every follower reads. The stop route hands the texts back to the tab
   * that stopped, so nothing typed is lost and nothing runs unasked on the next turn.
   */
  clearQueue: Type.Unsafe<() => { steering: string[]; followUp: string[] }>(Type.Function([], Type.Unknown())),
  /** Cancel pending dialogs, tell extensions the session is shutting down, release the session. Idempotent. */
  dispose: Type.Unsafe<() => void>(Type.Function([], Type.Void())),
})
export type PiSession = Static<typeof PiSession>
