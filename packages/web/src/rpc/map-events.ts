import { Type, type Static } from "typebox";
import { ZEN_TOOL_RESULT_KEY, ZenToolResultDescriptor } from "../tool-result-descriptor.ts";
import type { PiRpcEvent } from "./protocol.ts";

/**
 * pi rpc events → the shapes the web surface renders (#24).
 *
 * This is the one seam that has to understand both protocols, and owning it is what buys
 * back the two things `@tanstack/ai-acp` drops: image input and streamed usage.
 *
 * ⚠ DESIGN RULE: an unrecognised event becomes an `unmapped` observation, never nothing.
 * Every silent-drop bug this project has hit had the same shape — a producer emitting
 * something a consumer quietly ignored. So the union below has no "skip" member.
 *
 * These are TypeBox schemas rather than plain unions because an observation is what crosses
 * to the browser: the same declaration then serves the TypeScript type, the HTTP contract
 * and its OpenAPI description, with no conversion step and nothing to keep in step by hand.
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
	ZenExtensionError,
	ZenRunEnded,
	ZenSettled,
	ZenUnmapped,
]);
export type ZenObservation = Static<typeof ZenObservation>;

interface PiContentPart {
	type?: string;
	text?: string;
}

/** pi's tool `details` bag, which is where truncation lives. */
interface PiToolDetails {
	truncation?: { shown?: number; total?: number; unit?: string } | null;
	fullOutputPath?: string | null;
	[field: string]: unknown;
}

function readUsage(raw: unknown): ZenUsage | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const usage = raw as Record<string, unknown>;
	const numberAt = (key: string): number =>
		typeof usage[key] === "number" ? (usage[key] as number) : 0;
	const cost = usage.cost as Record<string, unknown> | undefined;
	const totalCost = typeof cost?.total === "number" ? (cost.total as number) : undefined;
	return {
		input: numberAt("input"),
		output: numberAt("output"),
		cacheRead: numberAt("cacheRead"),
		cacheWrite: numberAt("cacheWrite"),
		...(totalCost === undefined ? {} : { totalCost }),
	};
}

/** Flatten pi's `content` array to text. Non-text parts are named, never dropped. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as PiContentPart[])
		.map((part) =>
			part.type === "text" && typeof part.text === "string"
				? part.text
				: `[${part.type ?? "unknown"} content]`,
		)
		.join("");
}

/**
 * Build our descriptor from pi's `details`.
 *
 * ⚠ Only truncation is mapped today, and deliberately: `details` is tool-specific and
 * inventing a `kind` per tool here would put rendering decisions in the transport. A tool
 * that wants a richer descriptor should emit one; this is the floor, not the ceiling.
 */
function descriptorFrom(toolName: string, details: unknown): ZenToolResultDescriptor | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const truncation = (details as PiToolDetails).truncation;
	if (truncation === null || truncation === undefined) return undefined;
	const { shown, total, unit } = truncation;
	if (typeof shown !== "number" || typeof total !== "number") return undefined;
	return {
		kind: `pi.tool.${toolName}`,
		props: {},
		truncated: {
			shown,
			total,
			unit: unit === "bytes" || unit === "items" ? unit : "lines",
		},
	};
}

/** The metadata bag to attach to a TanStack `ToolResultPart`, or undefined if there is none. */
export function toolResultMetadata(
	descriptor: ZenToolResultDescriptor | undefined,
): Record<string, unknown> | undefined {
	return descriptor === undefined ? undefined : { [ZEN_TOOL_RESULT_KEY]: descriptor };
}

/** Map one pi rpc event. Never returns undefined — see the design rule above. */
export function mapPiEvent(event: PiRpcEvent): ZenObservation {
	switch (event.type) {
		case "message_update": {
			const delta = event.assistantMessageEvent as
				| { type?: string; contentIndex?: number; delta?: string }
				| undefined;
			const usage = readUsage(event.usage);
			const contentIndex = typeof delta?.contentIndex === "number" ? delta.contentIndex : 0;
			const text = typeof delta?.delta === "string" ? delta.delta : "";
			if (delta?.type === "text_delta") {
				return { kind: "text-delta", contentIndex, delta: text, ...(usage ? { usage } : {}) };
			}
			if (delta?.type === "thinking_delta") {
				return { kind: "thinking-delta", contentIndex, delta: text, ...(usage ? { usage } : {}) };
			}
			// start/end markers and any future delta type: carried, not dropped.
			return { kind: "unmapped", event };
		}

		case "tool_execution_start":
			return {
				kind: "tool-call",
				toolCallId: String(event.toolCallId),
				toolName: String(event.toolName),
				args: event.args,
			};

		case "tool_execution_update": {
			const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
			const toolName = String(event.toolName);
			const descriptor = descriptorFrom(toolName, partial?.details);
			return {
				kind: "tool-result",
				toolCallId: String(event.toolCallId),
				toolName,
				text: contentToText(partial?.content),
				complete: false,
				isError: false,
				...(descriptor === undefined ? {} : { descriptor }),
			};
		}

		case "tool_execution_end": {
			const result = event.result as { content?: unknown; details?: unknown } | undefined;
			const toolName = String(event.toolName);
			const descriptor = descriptorFrom(toolName, result?.details);
			return {
				kind: "tool-result",
				toolCallId: String(event.toolCallId),
				toolName,
				text: contentToText(result?.content),
				complete: true,
				// ⚠ `isError` is the only signal a refused call has. pi documents no distinct
				// "blocked" event, so a guard's `{block: true, reason}` is UNVERIFIED as to
				// which shape it takes on the wire. Treating any error result as displayable
				// covers it either way — see also `extension_error` below.
				isError: event.isError === true,
				...(descriptor === undefined ? {} : { descriptor }),
			};
		}

		case "extension_error":
			return {
				kind: "extension-error",
				extensionPath: String(event.extensionPath ?? "unknown"),
				event: String(event.event ?? "unknown"),
				error: String(event.error ?? "unknown error"),
			};

		case "agent_end":
			return { kind: "run-ended", willRetry: event.willRetry === true };

		case "agent_settled":
			return { kind: "settled" };

		default:
			return { kind: "unmapped", event };
	}
}
