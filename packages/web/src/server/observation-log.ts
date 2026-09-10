import { type ZenLogProperties, type ZenObservation, zenLogger } from "@zen/core";
import { forgetRun, takeFirstDeltaMs } from "./run-timing.ts";

/**
 * Every observation the server publishes becomes a record (#132, "trace everything") —
 * at the tier it belongs to, with the ids that join it to the transcript, the event tail
 * (#97) and the other layers' lines about the same moment.
 *
 *   `info`  — the spine: what happened. Tool calls and their results, the run's end, a
 *             question asked (a BLOCKING ui request — not a notify or a status line) and
 *             settled, the queue moving, a prompt pi refused, an extension that threw.
 *   `debug` — every observation, one compact line: kind, seq, generation, ids. Deltas
 *             become a count of characters, not the text.
 *   `trace` — the same, plus a second record carrying the whole observation.
 *
 * `ZEN_LOG_LEVEL` picks the tier (`log-process.ts`); `zen.server.events` is the category to
 * turn up alone (`ZEN_LOG_LEVEL=info,zen.server.events=trace`).
 *
 * ⚠ Never the text itself below `trace`. At `debug` a delta is `{ chars }`, a tool result
 * `{ chars, isError }` — the transcript is pi's session file, not this one; this file says
 * WHEN and WHAT KIND, and at `trace`, for one investigation, everything.
 */

const events = zenLogger("server", "events");

/** The kinds that are the spine at `info`; everything else is `debug`. */
const SPINE: Readonly<Record<string, true>> = {
	"tool-call": true,
	"tool-result": true,
	"extension-ui-request": true,
	"dialog-settled": true,
	queue: true,
	"prompt-rejected": true,
	"extension-error": true,
	"run-ended": true,
	settled: true,
};

/**
 * The name of a pi event an `unmapped` observation wraps — `message_update/toolcall_delta`,
 * `agent_start` — so the compact line says which, not that one happened. The whole event
 * is on the `trace` line.
 */
function piEventName(event: unknown): string {
	if (typeof event !== "object" || event === null) return "(not an object)";
	const record = event as { type?: unknown; assistantMessageEvent?: { type?: unknown } };
	const outer = typeof record.type === "string" ? record.type : "(untyped)";
	const inner = record.assistantMessageEvent?.type;
	return typeof inner === "string" ? `${outer}/${inner}` : outer;
}

/** The ids and sizes a compact line carries, per kind — no text below `trace`. */
function compactOf(observation: ZenObservation): ZenLogProperties {
	switch (observation.kind) {
		case "tool-call":
			return { toolCallId: observation.toolCallId, toolName: observation.toolName };
		case "tool-result":
			return {
				toolCallId: observation.toolCallId,
				toolName: observation.toolName,
				chars: observation.text.length,
				complete: observation.complete,
				isError: observation.isError,
			};
		case "text-delta":
		case "thinking-delta":
			return { contentIndex: observation.contentIndex, chars: observation.delta.length };
		case "message-start":
		case "message-end":
			return { role: observation.role };
		case "extension-ui-request":
			return { requestId: observation.id, method: observation.method, blocking: observation.blocking };
		case "dialog-settled":
			return { dialogId: observation.id, outcome: observation.outcome };
		case "queue":
			return { steering: observation.steering.length, followUp: observation.followUp.length };
		case "prompt-rejected":
			return { messageId: observation.messageId, reason: observation.reason };
		case "custom-entry":
			return { customType: observation.customType };
		case "extension-error":
			return { extensionPath: observation.extensionPath, event: observation.event };
		case "run-ended":
			return { willRetry: observation.willRetry };
		case "turn-start":
			return {};
		case "turn-end":
			return { toolResults: observation.toolResults };
		case "unmapped":
			return { event: piEventName(observation.event) };
		case "settled":
			return {};
	}
}

/**
 * Whether this observation is the spine: its kind is, and — for a ui request — it BLOCKS.
 * A notify or a status line is a fire-and-forget request pi's extensions send by the dozen
 * at session start (four before the first prompt, live); a question is the one that matters.
 */
function isSpine(observation: ZenObservation): boolean {
	if (observation.kind === "extension-ui-request") return observation.blocking;
	return SPINE[observation.kind] === true;
}

/** One observation, on its way to every follower: the compact line at its tier, the payload at `trace`. */
export function recordObservation(
	threadId: string,
	generation: number,
	seq: number,
	observation: ZenObservation,
): void {
	const properties: ZenLogProperties = { threadId, generation, seq, kind: observation.kind, ...compactOf(observation) };
	if (isSpine(observation)) events.info("{kind}", properties);
	else events.debug("{kind}", properties);
	events.trace("{kind} payload", { threadId, generation, seq, kind: observation.kind, observation });
	// Time to first token, at `info` (#144): the deltas themselves are `debug`, so without this
	// one line the latency a person actually asks about is only visible to whoever was already
	// turned up. One record per run — the second delta finds nothing to take.
	if (observation.kind === "text-delta" || observation.kind === "thinking-delta") {
		const firstDeltaMs = takeFirstDeltaMs(threadId, generation);
		if (firstDeltaMs !== undefined) {
			events.info("run {generation} first delta after {firstDeltaMs}ms", {
				threadId,
				generation,
				seq,
				kind: observation.kind,
				firstDeltaMs,
			});
		}
	} else if (observation.kind === "settled") forgetRun(threadId, generation);
}
