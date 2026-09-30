import { type Static, Type } from 'typebox'
import { EnsoDialogSpec } from './dialog.ts'
import { EnsoPermissionModeState } from './permission-mode.ts'
import { EnsoProviderRefusal, EnsoProviderRetry, EnsoProviderRetryEnd } from './provider-refusal.ts'
import { EnsoModelState, EnsoSessionUsage } from './thread-runtime.ts'
import { EnsoToolResultDescriptor } from './tool-result.ts'

/**
 * What a pi rpc event becomes for a surface to render.
 *
 * ⚠ THE UNION HAS NO "SKIP" MEMBER, BY DESIGN.
 * Every silent-drop bug this project has hit had one shape — a producer emitting something
 * a consumer quietly ignored. `EnsoUnmapped` exists so that an unrecognised event is
 * carried rather than discarded, and the absence of a skip case is what makes dropping
 * inexpressible rather than merely discouraged.
 */

/**
 * Token and cost accounting, present on `message_update`, assistant and tool messages.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoUsage = Type.Object({
  input: Type.Integer({ minimum: 0 }),
  output: Type.Integer({ minimum: 0 }),
  cacheRead: Type.Integer({ minimum: 0 }),
  cacheWrite: Type.Integer({ minimum: 0 }),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
})
/**
 * @group Observations
 * @category Turns and cost
 */
export type EnsoUsage = Static<typeof EnsoUsage>

/**
 * A streaming text delta. ⚠ `usage` rides along on EVERY one — see `message_update`.
 *
 * @group Observations
 * @category Message stream
 */
export const EnsoTextDelta = Type.Object({
  kind: Type.Literal('text-delta'),
  contentIndex: Type.Integer({ minimum: 0 }),
  delta: Type.String(),
  usage: Type.Optional(EnsoUsage),
})

/**
 * @group Observations
 * @category Message stream
 */
export const EnsoThinkingDelta = Type.Object({
  kind: Type.Literal('thinking-delta'),
  contentIndex: Type.Integer({ minimum: 0 }),
  delta: Type.String(),
  usage: Type.Optional(EnsoUsage),
})

/**
 * A tool call has started. Mirrors TanStack's `ToolCallPart` fields.
 *
 * @group Observations
 * @category Tool calls
 */
export const EnsoToolCall = Type.Object({
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
 *
 * @group Observations
 * @category Tool calls
 */
export const EnsoToolResultObservation = Type.Object({
  kind: Type.Literal('tool-result'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  text: Type.String(),
  complete: Type.Boolean(),
  isError: Type.Boolean(),
  descriptor: Type.Optional(EnsoToolResultDescriptor),
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
 * `dialog` carries the question itself for the five blocking methods (pi's four and the
 * questionnaire, #12). It is optional
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
 *
 * @group Observations
 * @category Extension surface
 */
export const EnsoNotifyType = Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')])
/**
 * @group Observations
 * @category Extension surface
 */
export type EnsoNotifyType = Static<typeof EnsoNotifyType>

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
 *
 * @group Observations
 * @category Extension surface
 */
export const EnsoUiRequestOrigin = Type.Union([Type.Literal('session-start'), Type.Literal('run')])
/**
 * @group Observations
 * @category Extension surface
 */
export type EnsoUiRequestOrigin = Static<typeof EnsoUiRequestOrigin>

/**
 * The source a line of Enso's own says it came from (#387) — the host's login and compaction
 * notices, the page's connection and busy lines — beside an extension's name or a provider's.
 *
 * @group Observations
 * @category Extension surface
 */
export const ENSO_NOTICE_SOURCE = 'Enso' as const

/**
 * @group Observations
 * @category Extension surface
 */
export const EnsoExtensionUiRequest = Type.Object({
  kind: Type.Literal('extension-ui-request'),
  id: Type.String(),
  method: Type.String(),
  blocking: Type.Boolean(),
  origin: EnsoUiRequestOrigin,
  dialog: Type.Optional(EnsoDialogSpec),
  message: Type.Optional(Type.String()),
  notifyType: Type.Optional(EnsoNotifyType),
  /**
   * Who said a notify (#387): the extension that called `ui.notify` — its package, or `Enso <name>`
   * for the harness's own — or `Enso` for the host's own lines. pi hands every extension the same
   * `ctx.ui`, so this is never read from the call; the host tags each extension's context with
   * the extension pi loaded it as (`host/notice-sender.ts`). Absent when nothing is known.
   */
  sender: Type.Optional(Type.String({ minLength: 1 })),
})

/**
 * How a blocking question stopped waiting (#114).
 *
 * A closed union: `answered` is a human's value, the other three are pi's cancel value
 * delivered for a reason — the browser's cancel or the session's teardown (`cancelled`), the
 * extension's own `timeout`, or the caller's abort signal (`aborted`).
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoDialogOutcome = Type.Union([
  Type.Literal('answered'),
  Type.Literal('cancelled'),
  Type.Literal('timeout'),
  Type.Literal('aborted'),
])
/**
 * @group Observations
 * @category Permission and dialogs
 */
export type EnsoDialogOutcome = Static<typeof EnsoDialogOutcome>

/**
 * A blocking question is no longer waiting (#114).
 *
 * The HOST synthesises this at the one point every settle path crosses — pi has no event for
 * it, because in rpc mode the client that answered already knows. Here a second follower does
 * not: without this, a question answered in one tab lingered in every other until that tab
 * tried and got `gone`.
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoDialogSettled = Type.Object({
  kind: Type.Literal('dialog-settled'),
  /** `minLength: 1`, as `EnsoOpenDialog.id` — a settle must name a question (PR #115 review). */
  id: Type.String({ minLength: 1 }),
  outcome: EnsoDialogOutcome,
})
/**
 * @group Observations
 * @category Permission and dialogs
 */
export type EnsoDialogSettled = Static<typeof EnsoDialogSettled>

/**
 * A CUSTOM session entry was appended (#29) — an extension persisted state via
 * `pi.appendEntry(customType, data)`.
 *
 * This is a STATE receipt, not an event narration: the entry says "this extension's
 * persisted state is now `data`", and it may be re-appended without anything having
 * changed (an extension may persist on session start as well as on a change). A renderer
 * that wants to show a change must diff against the previous value
 * itself. `data` is `Type.Unknown()` for the same reason `EnsoUnmapped.event` is: the
 * shape belongs to the extension that wrote it, and constraining it here would turn
 * "we do not render this yet" into "the transport is broken".
 *
 * ⚠ Only `type: "custom"` entries map here. Other session entries (messages, compaction,
 * labels) duplicate information that already flows as first-class observations, so they
 * stay `unmapped`.
 *
 * @group Observations
 * @category The union
 */
export const EnsoCustomEntry = Type.Object({
  kind: Type.Literal('custom-entry'),
  customType: Type.String(),
  data: Type.Unknown(),
})
/**
 * @group Observations
 * @category The union
 */
export type EnsoCustomEntry = Static<typeof EnsoCustomEntry>

/**
 * The permission mode changed, and what a run may switch to now (#162 workstream 4, L3).
 *
 * The HOST emits this when its mode extension persists a change — the one observation the
 * browser reads the mode from mid-run, so no surface knows which extension's entry it was or
 * what that entry looks like. The same `{ mode, available }` a run starts with
 * (`EnsoPermissionModeState`): one shape for the receipt and for the change.
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoPermissionMode = Type.Object({
  kind: Type.Literal('permission-mode'),
  ...EnsoPermissionModeState.properties,
})
/**
 * @group Observations
 * @category Permission and dialogs
 */
export type EnsoPermissionMode = Static<typeof EnsoPermissionMode>

/**
 * A mode change the route told the runtime about was REJECTED after the 204 went out (L3
 * step C): the vendor's command refused, or failed before acceptance.
 *
 * The SERVER announces it, as it announces `prompt-rejected` — the feed is the browser's only
 * way to hear that a click did nothing, and every follower hears it alike. The mode is
 * unchanged.
 *
 * @group Observations
 * @category Permission and dialogs
 */
/**
 * The model or thinking level changed (#338 slice 2) — by `POST …/command`, by an extension
 * (pi-multi-account's failover swaps the model mid-run), or by pi restoring a session. The
 * snapshot frame's `model` is the same shape at run start; the composer chip folds both.
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoModelObservation = Type.Object({
  kind: Type.Literal('model'),
  ...EnsoModelState.properties,
})
/**
 * @group Observations
 * @category Permission and dialogs
 */
export type EnsoModelObservation = Static<typeof EnsoModelObservation>

/**
 * What the session has spent and how full its context is, after it changed (#45): said by the
 * host after each turn, each run, each compaction, and each model change (a new model is a new
 * window). The WHOLE state, never a delta — a follower applies the latest one and cannot
 * double-count; the snapshot frame's `usage` is the same shape at follow start.
 *
 * @group Observations
 * @category Message stream
 */
export const EnsoSessionUsageObservation = Type.Object({
  kind: Type.Literal('session-usage'),
  ...EnsoSessionUsage.properties,
})
/**
 * @group Observations
 * @category Message stream
 */
export type EnsoSessionUsageObservation = Static<typeof EnsoSessionUsageObservation>

/**
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoPermissionModeRejected = Type.Object({
  kind: Type.Literal('permission-mode-rejected'),
  mode: Type.String({ minLength: 1 }),
  reason: Type.String(),
})
/**
 * @group Observations
 * @category Permission and dialogs
 */
export type EnsoPermissionModeRejected = Static<typeof EnsoPermissionModeRejected>

/**
 * A message began — pi's `message_start` (#112).
 *
 * The boundary AG-UI's `TEXT_MESSAGE_START` supplied and the observation vocabulary lacked.
 * `text` rides only on a USER message: a second follower of the same thread sees the prompt
 * another tab sent (dsh's `user/message`); assistant text arrives as deltas.
 *
 * @group Observations
 * @category Message stream
 */
export const EnsoMessageStart = Type.Object({
  kind: Type.Literal('message-start'),
  /** pi's message role, carried as pi names it. */
  role: Type.String(),
  text: Type.Optional(Type.String()),
})
/**
 * @group Observations
 * @category Message stream
 */
export type EnsoMessageStart = Static<typeof EnsoMessageStart>

/**
 * A message completed — pi's `message_end` — with its accounting when it has any (#45).
 *
 * ⚠ WHY `message_end` AND NOT THE PER-DELTA `usage`. Every `message_update` carries the
 * SAME cumulative usage for the in-flight message, so summing deltas would multiply cost
 * by the delta count; the honest unit is the completed message, emitted exactly once.
 *
 * ⚠ WHICH MESSAGES CARRY `usage` — pi's own attribution rule (`core/usage-totals.js`
 * getUsageCostBreakdown): `assistant` messages always; a `toolResult` only when a model
 * summarized the output. Every other completed message is a boundary with no spend, and
 * `usage` is absent. This is the per-message unit the day's log folds (#144 slice 4); a
 * thread's TOTAL is `session-usage`, pi's own sum, which also counts the compaction and
 * branch-summary calls that never cross as a `message_end`. One event per durable fact: the
 * accounting travels with the message it belongs to, never as a side record.
 *
 * @group Observations
 * @category Message stream
 */
export const EnsoMessageEnd = Type.Object({
  kind: Type.Literal('message-end'),
  role: Type.String(),
  usage: Type.Optional(EnsoUsage),
  /**
   * The model that produced an assistant message, as pi names it (#144 slice 4) — the axis
   * "cost per model" is derived on. Absent on every message pi does not attribute to one.
   */
  model: Type.Optional(Type.String()),
})
/**
 * @group Observations
 * @category Message stream
 */
export type EnsoMessageEnd = Static<typeof EnsoMessageEnd>

/**
 * pi's `turn_start` / `turn_end` (#112).
 *
 * ⚠ pi's "turn" is ONE model request plus the tool results it produced — what deepseek-harness
 * calls a *step*; dsh's *turn* (input claimed through nothing owed) is pi's whole run,
 * `settled`. Carried under pi's name so a reader of pi's docs and a reader of this stream
 * agree; the dsh mapping is this comment.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoTurnStart = Type.Object({ kind: Type.Literal('turn-start') })
/**
 * @group Observations
 * @category Turns and cost
 */
export type EnsoTurnStart = Static<typeof EnsoTurnStart>
/**
 * @group Observations
 * @category Turns and cost
 */
export const EnsoTurnEnd = Type.Object({
  kind: Type.Literal('turn-end'),
  /** How many tool results the request produced — the step row's count, without the results themselves (they crossed as `tool-result`). */
  toolResults: Type.Integer({ minimum: 0 }),
})
/**
 * @group Observations
 * @category Turns and cost
 */
export type EnsoTurnEnd = Static<typeof EnsoTurnEnd>

/**
 * What is waiting behind the run in flight (#75, #112, #216): prompts that will INTERRUPT at
 * the next step boundary, and prompts ENQUEUED until the run settles.
 *
 * The TEXTS, in order, as the runtime holds them: the page shows what is waiting (the queue
 * list above the composer), every follower sees the same list, and a stop hands them back to
 * the composer (#75, clear-and-restore). Empty lists when nothing waits — the frame emitted
 * after a claim or a clear.
 *
 * ⚠ ZEN's words, not the runtime's. The fields were `steering`/`followUp` — pi's own, on the
 * SSE wire, with `host/map-events.ts` passing them through rather than mapping them. Every
 * consumer concatenates the two lists (`custom-event-router.ts`, the abort receipt), so the
 * split survives on the wire for one reason: a follower renders what is waiting, and "this one
 * cuts in" is a different sentence from "this one waits its turn".
 *
 * @group Observations
 * @category Prompt admission
 */
export const EnsoQueue = Type.Object({
  kind: Type.Literal('queue'),
  interrupting: Type.Array(Type.String()),
  enqueued: Type.Array(Type.String()),
})
/**
 * @group Observations
 * @category Prompt admission
 */
export type EnsoQueue = Static<typeof EnsoQueue>

/**
 * The model provider refused a request (#340) — a 429, a missing login, a model the account may
 * not use — said by the host beside the failed assistant message's own `message-end`. The page
 * shows it where the reply would have been; the log keeps it at `info`, so a day counts them.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoProviderRefused = Type.Object({
  kind: Type.Literal('provider-refused'),
  ...EnsoProviderRefusal.properties,
})
/**
 * @group Observations
 * @category Turns and cost
 */
export type EnsoProviderRefused = Static<typeof EnsoProviderRefused>

/**
 * pi is retrying the refused request (#340) — pi's `auto_retry_start`: the attempt it will make,
 * of how many, after how long.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoProviderRetrying = Type.Object({
  kind: Type.Literal('provider-retry'),
  ...EnsoProviderRetry.properties,
})
/**
 * @group Observations
 * @category Turns and cost
 */
export type EnsoProviderRetrying = Static<typeof EnsoProviderRetrying>

/**
 * pi stopped retrying (#380 review) — pi's `auto_retry_end`: `success` when a retry got through;
 * otherwise the retries ran out, or a Stop cancelled the wait, and `finalError` says which.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoProviderRetryEnded = Type.Object({
  kind: Type.Literal('provider-retry-ended'),
  ...EnsoProviderRetryEnd.properties,
})
/**
 * @group Observations
 * @category Turns and cost
 */
export type EnsoProviderRetryEnded = Static<typeof EnsoProviderRetryEnded>

/**
 * pi refused a prompt at preflight (#112) — the one observation the SERVER synthesises,
 * because the refusal arrives on the prompt's callback, after `POST …/prompt` has already
 * answered 202: the follow is the only place a client can learn of it.
 *
 * `messageId` is the receipt's, so the client can name which prompt.
 *
 * @group Observations
 * @category Prompt admission
 */
export const EnsoPromptRejected = Type.Object({
  kind: Type.Literal('prompt-rejected'),
  messageId: Type.String(),
  reason: Type.String(),
})
/**
 * @group Observations
 * @category Prompt admission
 */
export type EnsoPromptRejected = Static<typeof EnsoPromptRejected>

/**
 * An extension threw. Surfaced, never swallowed.
 *
 * @group Observations
 * @category Extension surface
 */
export const EnsoExtensionError = Type.Object({
  kind: Type.Literal('extension-error'),
  extensionPath: Type.String(),
  event: Type.String(),
  error: Type.String(),
})

/**
 * One low-level run ended. ⚠ NOT completion — `willRetry` may be true.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoRunEnded = Type.Object({
  kind: Type.Literal('run-ended'),
  willRetry: Type.Boolean(),
})

/**
 * The session-level settle. This is completion.
 *
 * @group Observations
 * @category Turns and cost
 */
export const EnsoSettled = Type.Object({ kind: Type.Literal('settled') })

/**
 * pi compacted the branch (#348): its older turns are now one summary, so a transcript a page
 * mounted earlier no longer matches the session — the page re-reads the thread once it is idle.
 * `manual` is `/compact`; `threshold` and `overflow` are pi's own, when the context crossed its
 * threshold or overflowed mid-run. Said only for a compaction that finished: an aborted one
 * rewrote nothing.
 *
 * @group Observations
 * @category Message stream
 */
export const EnsoBranchCompacted = Type.Object({
  kind: Type.Literal('branch-compacted'),
  reason: Type.Union([Type.Literal('manual'), Type.Literal('threshold'), Type.Literal('overflow')]),
})

/**
 * A login waiting on its provider (#348): the provider as the flow names it. A login holds no run
 * lease — the composer stays open through a device-code wait — so this is what tells a page there
 * is something Stop can end. The follow's snapshot carries it for a page that arrives mid-login.
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoLoginInProgress = Type.Object({ provider: Type.String({ minLength: 1 }) })
/**
 * @group Observations
 * @category Permission and dialogs
 */
export type EnsoLoginInProgress = Static<typeof EnsoLoginInProgress>

/**
 * A login's state as the host says it (#348): which provider, and whether it is still waiting.
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoLoginState = Type.Object({ ...EnsoLoginInProgress.properties, waiting: Type.Boolean() })

/**
 * A login started waiting, or stopped (#348): `waiting: false` once it settles — stored,
 * failed, or cancelled, by Stop or by its own card.
 *
 * @group Observations
 * @category Permission and dialogs
 */
export const EnsoLoginObservation = Type.Object({
  kind: Type.Literal('login'),
  ...EnsoLoginState.properties,
})

/**
 * Anything not modelled above, carried through so it can be logged or displayed.
 *
 * ⚠ `event` is `Type.Unknown()`, not a closed event schema. Constraining it would make a
 * new pi event type fail validation here — turning "we do not render this yet" into "the
 * transport is broken", which is the opposite of what this member exists for.
 *
 * @group Observations
 * @category The union
 */
export const EnsoUnmapped = Type.Object({
  kind: Type.Literal('unmapped'),
  event: Type.Unknown(),
})

/**
 * @group Observations
 * @category The union
 */
export const EnsoObservation = Type.Union([
  EnsoTextDelta,
  EnsoThinkingDelta,
  EnsoToolCall,
  EnsoToolResultObservation,
  EnsoCustomEntry,
  EnsoPermissionMode,
  EnsoPermissionModeRejected,
  EnsoModelObservation,
  EnsoMessageStart,
  EnsoMessageEnd,
  EnsoSessionUsageObservation,
  EnsoBranchCompacted,
  EnsoLoginObservation,
  EnsoTurnStart,
  EnsoTurnEnd,
  EnsoProviderRefused,
  EnsoProviderRetrying,
  EnsoProviderRetryEnded,
  EnsoQueue,
  EnsoPromptRejected,
  EnsoExtensionError,
  EnsoExtensionUiRequest,
  EnsoDialogSettled,
  EnsoRunEnded,
  EnsoSettled,
  EnsoUnmapped,
])
/**
 * @group Observations
 * @category The union
 */
export type EnsoObservation = Static<typeof EnsoObservation>
