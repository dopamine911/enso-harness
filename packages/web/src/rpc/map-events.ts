import { ZEN_TOOL_RESULT_KEY, type PiRpcEvent, type ZenObservation, type ZenToolResultDescriptor, type ZenUsage } from "@zen/core";

/**
 * pi rpc events → the observations a surface renders (#24).
 *
 * This is the one seam that has to understand both protocols, and owning it is what buys
 * back the two things `@tanstack/ai-acp` drops: image input and streamed usage.
 *
 * ⚠ The observation SCHEMAS live in `@zen/core`. This module is the mapping only — the
 * shapes are declared once, in one package, so a second `usage` or a second `truncation`
 * cannot appear beside a different consumer.
 *
 * ⚠ DESIGN RULE: an unrecognised event becomes an `unmapped` observation, never nothing.
 * Every silent-drop bug this project has hit had the same shape — a producer emitting
 * something a consumer quietly ignored. So the union has no "skip" member and this
 * function cannot return undefined.
 */

/** Methods that block pi until a response arrives — see the `extension_ui_request` case. */
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

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

		case "extension_ui_request": {
			// ⚠ pi's Extension UI sub-protocol, and it splits in two (`docs/rpc.md` § Extension
			// UI Protocol):
			//
			//   DIALOG methods    select | confirm | input | editor
			//                     emit a request and BLOCK until the client writes an
			//                     `extension_ui_response` on stdin with the matching id.
			//   FIRE-AND-FORGET   notify | setStatus | setWidget | setTitle | set_editor_text
			//                     emit and continue; a client may ignore them.
			//
			// ⚠⚠ We do not answer dialogs yet, so one arriving means pi is BLOCKED and will
			// stay blocked — a hung agent with no error anywhere. It is surfaced as its own
			// observation so a caller can fail loudly instead of waiting forever. Answering
			// them is the escalation channel from #12, and it is the missing half.
			const method = String(event.method ?? "unknown");
			return {
				kind: "extension-ui-request",
				id: String(event.id ?? ""),
				method,
				blocking: DIALOG_UI_METHODS.has(method),
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
