import { type Static, Type } from 'typebox'
import { ZenDialogSpec } from './dialog.ts'
import { ZenPermissionModeState } from './permission-mode.ts'
import { ZenToolResultDescriptor } from './tool-result.ts'

/**
 * What a pi rpc event becomes for a surface to render.
 *
 * ⚠ THE UNION HAS NO "SKIP" MEMBER, BY DESIGN.
 * Every silent-drop bug this project has hit had one shape — a producer emitting something
 * a consumer quietly ignored. `ZenUnmapped` exists so that an unrecognised event is
 * carried rather than discarded, and the absence of a skip case is what makes dropping
 * inexpressible rather than merely discouraged.
 */

/** Token and cost accounting, present on `message_update`, assistant and tool messages. */
export const ZenUsage = Type.Object({
  input: Type.Integer({ minimum: 0 }),
  output: Type.Integer({ minimum: 0 }),
  cacheRead: Type.Integer({ minimum: 0 }),
  cacheWrite: Type.Integer({ minimum: 0 }),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
})
export type ZenUsage = Static<typeof ZenUsage>

/** A streaming text delta. ⚠ `usage` rides along on EVERY one — see `message_update`. */
export const ZenTextDelta = Type.Object({
  kind: Type.Literal('text-delta'),
  contentIndex: Type.Integer({ minimum: 0 }),
  delta: Type.String(),
  usage: Type.Optional(ZenUsage),
})

export const ZenThinkingDelta = Type.Object({
  kind: Type.Literal('thinking-delta'),
  contentIndex: Type.Integer({ minimum: 0 }),
  delta: Type.String(),
  usage: Type.Optional(ZenUsage),
})

/** A tool call has started. Mirrors TanStack's `ToolCallPart` fields. */
export const ZenToolCall = Type.Object({
  kind: Type.Literal('tool-call'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  args: Type.Unknown(),
})

/**
 * Tool output.
 *
 * ⚠ `text` is ACCUMULATED, not a delta — pi's docs say `partialResult` "contains the
 * accumulated output so far (not just the delta), allowing clients to simply replace their
 * display on each update." A client that appends will duplicate every chunk, and the bug
 * grows with output length. The field is named `text` rather than `delta` for that reason.
 */
export const ZenToolResultObservation = Type.Object({
  kind: Type.Literal('tool-result'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  text: Type.String(),
  complete: Type.Boolean(),
  isError: Type.Boolean(),
  descriptor: Type.Optional(ZenToolResultDescriptor),
})

/**
 * pi asked the client for UI.
 *
 * ⚠ `blocking: true` means pi is WAITING and will not proceed until an
 * `extension_ui_response` is written to its stdin with the matching `id`. The session
 * layer answers these by handing them to the browser as AG-UI interrupts (#27); a caller
 * that cannot do that has to fail loudly instead of waiting forever — which is why this is
 * a distinct observation rather than folded into `unmapped`.
 *
 * `dialog` carries the question itself for the four blocking methods. It is optional
 * because the mapper reads it defensively off the wire: a blocking request whose fields do
 * not form a well-shaped question still surfaces as blocking, and the session layer's
 * answer to an unreadable question is to decline it — the pre-#27 behaviour, kept as the
 * degenerate case.
 *
 * `message`/`notifyType` carry a `notify` request's payload (#29). A notify's message IS
 * the request — pi's wire shape is `{method: "notify", message, notifyType?}` — and until
 * #29 the envelope crossed while the message was dropped, which is how a mode change
 * completed with nothing visible. Optional because only `notify` carries them; the mapper
 * copies `notifyType` only when it is one of pi's three declared values, so an unknown
 * value degrades to an untyped notification rather than failing validation.
 */
export const ZenNotifyType = Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')])
export type ZenNotifyType = Static<typeof ZenNotifyType>

/**
 * Where a ui request came from (#96) — tagged at the SOURCE, never inferred.
 *
 *   session-start  emitted during the session's own start, before anyone subscribed, and
 *                  replayed to the first run's pump (the host's held buffer, #69/#88). An
 *                  infra fact about the process, true of every thread — the browser groups
 *                  the informational ones.
 *   run            emitted while a run was listening. Rendered as it always was: a guard
 *                  refusal before the first token is a run notice, not startup chatter, and
 *                  a browser-side "notifies before the first assistant message" rule would
 *                  have swallowed it.
 *
 * A closed union: a third origin fails at the mapper, loudly, not silently in a consumer.
 */
export const ZenUiRequestOrigin = Type.Union([Type.Literal('session-start'), Type.Literal('run')])
export type ZenUiRequestOrigin = Static<typeof ZenUiRequestOrigin>

export const ZenExtensionUiRequest = Type.Object({
  kind: Type.Literal('extension-ui-request'),
  id: Type.String(),
  method: Type.String(),
  blocking: Type.Boolean(),
  origin: ZenUiRequestOrigin,
  dialog: Type.Optional(ZenDialogSpec),
  message: Type.Optional(Type.String()),
  notifyType: Type.Optional(ZenNotifyType),
})

/**
 * How a blocking question stopped waiting (#114). A closed union: `answered` is a human's
 * value, the other three are pi's cancel value delivered for a reason — the browser's
 * cancel or the session's teardown (`cancelled`), the extension's own `timeout`, or the
 * caller's abort signal (`aborted`).
 */
export const ZenDialogOutcome = Type.Union([
  Type.Literal('answered'),
  Type.Literal('cancelled'),
  Type.Literal('timeout'),
  Type.Literal('aborted'),
])
export type ZenDialogOutcome = Static<typeof ZenDialogOutcome>

/**
 * A blocking question is no longer waiting (#114). The HOST synthesises this at the one
 * point every settle path crosses — pi has no event for it, because in rpc mode the client
 * that answered already knows. Here a second follower does not: without this, a question
 * answered in one tab lingered in every other until that tab tried and got `gone`.
 */
export const ZenDialogSettled = Type.Object({
  kind: Type.Literal('dialog-settled'),
  /** `minLength: 1`, as `ZenOpenDialog.id` — a settle must name a question (PR #115 review). */
  id: Type.String({ minLength: 1 }),
  outcome: ZenDialogOutcome,
})
export type ZenDialogSettled = Static<typeof ZenDialogSettled>

/**
 * A CUSTOM session entry was appended (#29) — an extension persisted state via
 * `pi.appendEntry(customType, data)`.
 *
 * This is a STATE receipt, not an event narration: the entry says "this extension's
 * persisted state is now `data`", and it may be re-appended without anything having
 * changed (picc persists on session start and on rule updates, not only on a mode
 * change). A renderer that wants to show a change must diff against the previous value
 * itself. `data` is `Type.Unknown()` for the same reason `ZenUnmapped.event` is: the
 * shape belongs to the extension that wrote it, and constraining it here would turn
 * "we do not render this yet" into "the transport is broken".
 *
 * ⚠ Only `type: "custom"` entries map here. Other session entries (messages, compaction,
 * labels) duplicate information that already flows as first-class observations, so they
 * stay `unmapped`.
 */
export const ZenCustomEntry = Type.Object({
  kind: Type.Literal('custom-entry'),
  customType: Type.String(),
  data: Type.Unknown(),
})
export type ZenCustomEntry = Static<typeof ZenCustomEntry>

/**
 * The permission mode changed, and what a run may switch to now (#162 workstream 4, L3).
 * The HOST emits this when its mode extension persists a change — the one observation the
 * browser reads the mode from mid-run, so no surface knows which extension's entry it was
 * or what that entry looks like. The same `{ mode, available }` a run starts with
 * (`ZenPermissionModeState`): one shape for the receipt and for the change.
 */
export const ZenPermissionMode = Type.Object({
  kind: Type.Literal('permission-mode'),
  ...ZenPermissionModeState.properties,
})
export type ZenPermissionMode = Static<typeof ZenPermissionMode>

/**
 * A mode change the route told the runtime about was REJECTED after the 204 went out (L3
 * step C): the vendor's command refused, or failed before acceptance. The SERVER announces
 * it, as it announces `prompt-rejected` — the feed is the browser's only way to hear that a
 * click did nothing, and every follower hears it alike. The mode is unchanged.
 */
export const ZenPermissionModeRejected = Type.Object({
  kind: Type.Literal('permission-mode-rejected'),
  mode: Type.String({ minLength: 1 }),
  reason: Type.String(),
})
export type ZenPermissionModeRejected = Static<typeof ZenPermissionModeRejected>

/**
 * A message began — pi's `message_start` (#112). The boundary AG-UI's `TEXT_MESSAGE_START`
 * supplied and the observation vocabulary lacked. `text` rides only on a USER message: a
 * second follower of the same thread sees the prompt another tab sent (dsh's
 * `user/message`); assistant text arrives as deltas.
 */
export const ZenMessageStart = Type.Object({
  kind: Type.Literal('message-start'),
  /** pi's message role, carried as pi names it. */
  role: Type.String(),
  text: Type.Optional(Type.String()),
})
export type ZenMessageStart = Static<typeof ZenMessageStart>

/**
 * A message completed — pi's `message_end` — with its accounting when it has any (#45).
 *
 * ⚠ WHY `message_end` AND NOT THE PER-DELTA `usage`. Every `message_update` carries the
 * SAME cumulative usage for the in-flight message, so summing deltas would multiply cost
 * by the delta count; the honest unit is the completed message, emitted exactly once.
 *
 * ⚠ WHICH MESSAGES CARRY `usage` — pi's own attribution rule, copied so our total matches
 * pi's `/stats` (`core/usage-totals.js` getUsageCostBreakdown): `assistant` messages always;
 * a `toolResult` only when a model summarized the output. Every other completed message
 * is a boundary with no spend, and `usage` is absent. (pi also attributes compaction and
 * branch-summary entries; those cross as session entries, not `message_end`, and are not
 * counted here — a stated undercount, not a bug.) One event per durable fact: the
 * accounting travels with the message it belongs to, never as a side record.
 */
export const ZenMessageEnd = Type.Object({
  kind: Type.Literal('message-end'),
  role: Type.String(),
  usage: Type.Optional(ZenUsage),
})
export type ZenMessageEnd = Static<typeof ZenMessageEnd>

/**
 * pi's `turn_start` / `turn_end` (#112). ⚠ pi's "turn" is ONE model request plus the tool
 * results it produced — what deepseek-harness calls a *step*; dsh's *turn* (input claimed
 * through nothing owed) is pi's whole run, `settled`. Carried under pi's name so a reader
 * of pi's docs and a reader of this stream agree; the dsh mapping is this comment.
 */
export const ZenTurnStart = Type.Object({ kind: Type.Literal('turn-start') })
export type ZenTurnStart = Static<typeof ZenTurnStart>
export const ZenTurnEnd = Type.Object({
  kind: Type.Literal('turn-end'),
  /** How many tool results the request produced — the step row's count, without the results themselves (they crossed as `tool-result`). */
  toolResults: Type.Integer({ minimum: 0 }),
})
export type ZenTurnEnd = Static<typeof ZenTurnEnd>

/**
 * What is waiting behind the run in flight (#75, #112, #216): prompts that will INTERRUPT at
 * the next step boundary, and prompts ENQUEUED until the run settles. The TEXTS, in order, as
 * the runtime holds them: the page shows what is waiting (the queue list above the composer),
 * every follower sees the same list, and a stop hands them back to the composer (#75,
 * clear-and-restore). Empty lists when nothing waits — the frame emitted after a claim or a
 * clear.
 *
 * ⚠ ZEN's words, not the runtime's. The fields were `steering`/`followUp` — pi's own, on the
 * SSE wire, with `host/map-events.ts` passing them through rather than mapping them. Every
 * consumer concatenates the two lists (`custom-event-router.ts`, the abort receipt), so the
 * split survives on the wire for one reason: a follower renders what is waiting, and "this one
 * cuts in" is a different sentence from "this one waits its turn".
 */
export const ZenQueue = Type.Object({
  kind: Type.Literal('queue'),
  interrupting: Type.Array(Type.String()),
  enqueued: Type.Array(Type.String()),
})
export type ZenQueue = Static<typeof ZenQueue>

/**
 * pi refused a prompt at preflight (#112) — the one observation the SERVER synthesises,
 * because the refusal arrives on the prompt's callback, after `POST …/prompt` has already
 * answered 202: the follow is the only place a client can learn of it. `messageId` is the
 * receipt's, so the client can name which prompt.
 */
export const ZenPromptRejected = Type.Object({
  kind: Type.Literal('prompt-rejected'),
  messageId: Type.String(),
  reason: Type.String(),
})
export type ZenPromptRejected = Static<typeof ZenPromptRejected>

/** An extension threw. Surfaced, never swallowed. */
export const ZenExtensionError = Type.Object({
  kind: Type.Literal('extension-error'),
  extensionPath: Type.String(),
  event: Type.String(),
  error: Type.String(),
})

/** One low-level run ended. ⚠ NOT completion — `willRetry` may be true. */
export const ZenRunEnded = Type.Object({
  kind: Type.Literal('run-ended'),
  willRetry: Type.Boolean(),
})

/** The session-level settle. This is completion. */
export const ZenSettled = Type.Object({ kind: Type.Literal('settled') })

/**
 * Anything not modelled above, carried through so it can be logged or displayed.
 *
 * ⚠ `event` is `Type.Unknown()`, not a closed event schema. Constraining it would make a
 * new pi event type fail validation here — turning "we do not render this yet" into "the
 * transport is broken", which is the opposite of what this member exists for.
 */
export const ZenUnmapped = Type.Object({
  kind: Type.Literal('unmapped'),
  event: Type.Unknown(),
})

export const ZenObservation = Type.Union([
  ZenTextDelta,
  ZenThinkingDelta,
  ZenToolCall,
  ZenToolResultObservation,
  ZenCustomEntry,
  ZenPermissionMode,
  ZenPermissionModeRejected,
  ZenMessageStart,
  ZenMessageEnd,
  ZenTurnStart,
  ZenTurnEnd,
  ZenQueue,
  ZenPromptRejected,
  ZenExtensionError,
  ZenExtensionUiRequest,
  ZenDialogSettled,
  ZenRunEnded,
  ZenSettled,
  ZenUnmapped,
])
export type ZenObservation = Static<typeof ZenObservation>
