import { Type, type Static } from "typebox";
import { ZenDialogSpec } from "./dialog.ts";
import { ZenToolResultDescriptor } from "./tool-result.ts";

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
});
export type ZenUsage = Static<typeof ZenUsage>;

/** A streaming text delta. ⚠ `usage` rides along on EVERY one — see `message_update`. */
export const ZenTextDelta = Type.Object({
	kind: Type.Literal("text-delta"),
	contentIndex: Type.Integer({ minimum: 0 }),
	delta: Type.String(),
	usage: Type.Optional(ZenUsage),
});

export const ZenThinkingDelta = Type.Object({
	kind: Type.Literal("thinking-delta"),
	contentIndex: Type.Integer({ minimum: 0 }),
	delta: Type.String(),
	usage: Type.Optional(ZenUsage),
});

/** A tool call has started. Mirrors TanStack's `ToolCallPart` fields. */
export const ZenToolCall = Type.Object({
	kind: Type.Literal("tool-call"),
	toolCallId: Type.String(),
	toolName: Type.String(),
	args: Type.Unknown(),
});

/**
 * Tool output.
 *
 * ⚠ `text` is ACCUMULATED, not a delta — pi's docs say `partialResult` "contains the
 * accumulated output so far (not just the delta), allowing clients to simply replace their
 * display on each update." A client that appends will duplicate every chunk, and the bug
 * grows with output length. The field is named `text` rather than `delta` for that reason.
 */
export const ZenToolResultObservation = Type.Object({
	kind: Type.Literal("tool-result"),
	toolCallId: Type.String(),
	toolName: Type.String(),
	text: Type.String(),
	complete: Type.Boolean(),
	isError: Type.Boolean(),
	descriptor: Type.Optional(ZenToolResultDescriptor),
});

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
export const ZenNotifyType = Type.Union([
	Type.Literal("info"),
	Type.Literal("warning"),
	Type.Literal("error"),
]);
export type ZenNotifyType = Static<typeof ZenNotifyType>;

export const ZenExtensionUiRequest = Type.Object({
	kind: Type.Literal("extension-ui-request"),
	id: Type.String(),
	method: Type.String(),
	blocking: Type.Boolean(),
	dialog: Type.Optional(ZenDialogSpec),
	message: Type.Optional(Type.String()),
	notifyType: Type.Optional(ZenNotifyType),
});

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
export const ZenCustomSessionEntry = Type.Object({
	kind: Type.Literal("custom-entry"),
	customType: Type.String(),
	data: Type.Unknown(),
});
export type ZenCustomSessionEntry = Static<typeof ZenCustomSessionEntry>;

/** An extension threw. Surfaced, never swallowed. */
export const ZenExtensionError = Type.Object({
	kind: Type.Literal("extension-error"),
	extensionPath: Type.String(),
	event: Type.String(),
	error: Type.String(),
});

/** One low-level run ended. ⚠ NOT completion — `willRetry` may be true. */
export const ZenRunEnded = Type.Object({
	kind: Type.Literal("run-ended"),
	willRetry: Type.Boolean(),
});

/** The session-level settle. This is completion. */
export const ZenSettled = Type.Object({ kind: Type.Literal("settled") });

/**
 * Anything not modelled above, carried through so it can be logged or displayed.
 *
 * ⚠ `event` is `Type.Unknown()`, not a closed event schema. Constraining it would make a
 * new pi event type fail validation here — turning "we do not render this yet" into "the
 * transport is broken", which is the opposite of what this member exists for.
 */
export const ZenUnmapped = Type.Object({
	kind: Type.Literal("unmapped"),
	event: Type.Unknown(),
});

export const ZenObservation = Type.Union([
	ZenTextDelta,
	ZenThinkingDelta,
	ZenToolCall,
	ZenToolResultObservation,
	ZenCustomSessionEntry,
	ZenExtensionError,
	ZenExtensionUiRequest,
	ZenRunEnded,
	ZenSettled,
	ZenUnmapped,
]);
export type ZenObservation = Static<typeof ZenObservation>;
