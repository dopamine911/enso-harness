import { expect, test } from "bun:test";
import { ZEN_TOOL_RESULT_KEY, type ZenObservation } from "@zen/core";
import { mapPiEvent, toolResultMetadata } from "../map-events.ts";

const kindOf = (event: Parameters<typeof mapPiEvent>[0]): ZenObservation["kind"] =>
	mapPiEvent(event).kind;

// --- streaming deltas, and the usage that rides on every one
test("a text delta maps, carrying usage", () => {
	const observed = mapPiEvent({
		type: "message_update",
		usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0004 } },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
	});
	expect(observed).toMatchObject({ kind: "text-delta", delta: "Hello ", contentIndex: 0 });
	// ⚠ #24's second deal-breaker: usage per message, not by polling.
	expect(observed).toMatchObject({ usage: { input: 100, output: 1, totalCost: 0.0004 } });
});

test("a thinking delta is distinguished from text", () =>
	expect(
		kindOf({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
		}),
	).toBe("thinking-delta"));

test("a start/end marker is carried as unmapped, never dropped", () =>
	expect(
		kindOf({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
	).toBe("unmapped"));

// --- tool lifecycle
test("tool_execution_start becomes a tool call", () =>
	expect(
		mapPiEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }),
	).toMatchObject({ kind: "tool-call", toolCallId: "c1", toolName: "bash" }));

test("a partial result is incomplete and not an error", () => {
	const observed = mapPiEvent({
		type: "tool_execution_update",
		toolCallId: "c1",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "partial…" }], details: { truncation: null } },
	});
	expect(observed).toMatchObject({ kind: "tool-result", text: "partial…", complete: false, isError: false });
});

test("a completed result is complete", () =>
	expect(
		mapPiEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "total 48" }] },
			isError: false,
		}),
	).toMatchObject({ kind: "tool-result", text: "total 48", complete: true, isError: false }));

// ⚠ The only signal a refused call has. pi documents no distinct "blocked" event, so a
// guard's `{block:true}` shape on the wire is unverified — any error result must display.
test("an errored result is flagged so it cannot render as success", () =>
	expect(
		mapPiEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "write",
			result: { content: [{ type: "text", text: "blocked: outside the workspace" }] },
			isError: true,
		}),
	).toMatchObject({ kind: "tool-result", isError: true, text: "blocked: outside the workspace" }));

test("non-text content parts are named, not silently dropped", () =>
	expect(
		mapPiEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "read",
			result: { content: [{ type: "image", data: "…" }, { type: "text", text: " ok" }] },
			isError: false,
		}),
	).toMatchObject({ text: "[image content] ok" }));

// --- truncation becomes a descriptor, so it renders per surface (#18)
test("truncation in details becomes a descriptor with structured fields", () => {
	const observed = mapPiEvent({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "bash",
		result: { content: "…", details: { truncation: { shown: 500, total: 4000, unit: "lines" } } },
		isError: false,
	});
	expect(observed).toMatchObject({
		descriptor: { kind: "pi.tool.bash", truncated: { shown: 500, total: 4000, unit: "lines" } },
	});
});

test("absent or null truncation yields no descriptor", () => {
	const withNull = mapPiEvent({
		type: "tool_execution_end", toolCallId: "c1", toolName: "bash",
		result: { content: "x", details: { truncation: null } }, isError: false,
	});
	expect(withNull).not.toHaveProperty("descriptor");
	const withoutDetails = mapPiEvent({
		type: "tool_execution_end", toolCallId: "c1", toolName: "bash",
		result: { content: "x" }, isError: false,
	});
	expect(withoutDetails).not.toHaveProperty("descriptor");
});

test("an unknown truncation unit falls back to lines rather than propagating garbage", () =>
	expect(
		mapPiEvent({
			type: "tool_execution_end", toolCallId: "c1", toolName: "bash",
			result: { content: "x", details: { truncation: { shown: 1, total: 2, unit: "furlongs" } } },
			isError: false,
		}),
	).toMatchObject({ descriptor: { truncated: { unit: "lines" } } }));

test("the descriptor is wrapped under the namespaced metadata key", () => {
	const descriptor = { kind: "pi.tool.bash", props: {} };
	expect(toolResultMetadata(descriptor)).toEqual({ [ZEN_TOOL_RESULT_KEY]: descriptor });
	expect(toolResultMetadata(undefined)).toBeUndefined();
});

// --- errors and lifecycle
test("extension_error surfaces with its origin", () =>
	expect(
		mapPiEvent({ type: "extension_error", extensionPath: "/x/guards.ts", event: "tool_call", error: "boom" }),
	).toMatchObject({ kind: "extension-error", extensionPath: "/x/guards.ts", event: "tool_call", error: "boom" }));

// ⚠ #24 acceptance: agent_end with willRetry must not present as completion.
test("agent_end is a run ending, not a settle — and carries willRetry", () => {
	expect(mapPiEvent({ type: "agent_end", willRetry: true })).toEqual({ kind: "run-ended", willRetry: true });
	expect(mapPiEvent({ type: "agent_end", willRetry: false })).toEqual({ kind: "run-ended", willRetry: false });
	expect(mapPiEvent({ type: "agent_end" })).toEqual({ kind: "run-ended", willRetry: false });
});

test("agent_settled is the only completion", () =>
	expect(mapPiEvent({ type: "agent_settled" })).toEqual({ kind: "settled" }));

// ⚠ The design rule: there is no skip case.
test("an unmodelled event is carried through with its payload intact", () => {
	const observed = mapPiEvent({ type: "some_future_event", detail: 42 });
	expect(observed.kind).toBe("unmapped");
	expect(observed).toMatchObject({ event: { type: "some_future_event", detail: 42 } });
});
