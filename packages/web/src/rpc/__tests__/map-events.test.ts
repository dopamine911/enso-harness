import { expect, test } from "bun:test";
import { ZEN_TOOL_RESULT_KEY, type ZenObservation } from "@zen/core";
import { mapPiEvent, toolResultMetadata } from "../map-events.ts";

const kindOf = (event: Parameters<typeof mapPiEvent>[0]): ZenObservation["kind"] => mapPiEvent(event).kind;

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
	expect(kindOf({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } })).toBe(
		"unmapped",
	));

// --- tool lifecycle
// ⓘ Full-envelope `toEqual` wherever the whole shape is known (#53 S2): a `toMatchObject`
// on a subset let a renamed or extra field ride through unnoticed.
test("tool_execution_start becomes a tool call", () =>
	expect(
		mapPiEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }),
	).toEqual({ kind: "tool-call", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }));

test("a partial result is incomplete and not an error", () => {
	const observed = mapPiEvent({
		type: "tool_execution_update",
		toolCallId: "c1",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "partial…" }], details: { truncation: null } },
	});
	expect(observed).toEqual({
		kind: "tool-result",
		toolCallId: "c1",
		toolName: "bash",
		text: "partial…",
		complete: false,
		isError: false,
	});
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
	).toEqual({
		kind: "tool-result",
		toolCallId: "c1",
		toolName: "bash",
		text: "total 48",
		complete: true,
		isError: false,
	}));

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
			result: {
				content: [
					{ type: "image", data: "…" },
					{ type: "text", text: " ok" },
				],
			},
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
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "bash",
		result: { content: "x", details: { truncation: null } },
		isError: false,
	});
	expect(withNull).not.toHaveProperty("descriptor");
	const withoutDetails = mapPiEvent({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "bash",
		result: { content: "x" },
		isError: false,
	});
	expect(withoutDetails).not.toHaveProperty("descriptor");
});

test("an unknown truncation unit falls back to lines rather than propagating garbage", () =>
	expect(
		mapPiEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: "x", details: { truncation: { shown: 1, total: 2, unit: "furlongs" } } },
			isError: false,
		}),
	).toMatchObject({ descriptor: { truncated: { unit: "lines" } } }));

test("the descriptor is wrapped under the namespaced metadata key", () => {
	const descriptor = { kind: "pi.tool.bash", props: {} };
	expect(toolResultMetadata(descriptor)).toEqual({ [ZEN_TOOL_RESULT_KEY]: descriptor });
	expect(toolResultMetadata(undefined)).toBeUndefined();
});

// --- extension UI requests: the notify payload (#29)
// The envelope always crossed; these pin that the MESSAGE now crosses with it — the gap
// that made a mode change complete silently.
test("a notify carries its message and a declared notifyType", () =>
	expect(
		mapPiEvent({
			type: "extension_ui_request",
			id: "n1",
			method: "notify",
			message: "Mode set to Plan Mode",
			notifyType: "info",
		}),
	).toEqual({
		kind: "extension-ui-request",
		id: "n1",
		method: "notify",
		blocking: false,
		message: "Mode set to Plan Mode",
		notifyType: "info",
	}));

test("an unrecognised notifyType degrades to an untyped notification, not a failure", () => {
	const observed = mapPiEvent({
		type: "extension_ui_request",
		id: "n2",
		method: "notify",
		message: "odd",
		notifyType: "sparkle",
	});
	expect(observed).toMatchObject({ kind: "extension-ui-request", message: "odd" });
	expect((observed as { notifyType?: unknown }).notifyType).toBeUndefined();
});

test("a notify with no message maps to an empty string, never undefined", () =>
	expect(mapPiEvent({ type: "extension_ui_request", id: "n3", method: "notify" })).toMatchObject({
		kind: "extension-ui-request",
		method: "notify",
		message: "",
	}));

// ⚠ A dialog's `message` is part of the QUESTION and travels inside `dialog` — it must not
// gain a second home on the observation root, or the two copies drift.
test("a confirm dialog's message stays inside dialog and off the observation root", () => {
	const observed = mapPiEvent({
		type: "extension_ui_request",
		id: "d1",
		method: "confirm",
		title: "Proceed?",
		message: "Really?",
	});
	expect(observed).toMatchObject({
		kind: "extension-ui-request",
		blocking: true,
		dialog: { method: "confirm", title: "Proceed?", message: "Really?" },
	});
	expect((observed as { message?: unknown }).message).toBeUndefined();
});

// --- errors and lifecycle
test("extension_error surfaces with its origin", () =>
	expect(
		mapPiEvent({ type: "extension_error", extensionPath: "/x/guards.ts", event: "tool_call", error: "boom" }),
	).toEqual({ kind: "extension-error", extensionPath: "/x/guards.ts", event: "tool_call", error: "boom" }));

// ⚠ #24 acceptance: agent_end with willRetry must not present as completion.
test("agent_end is a run ending, not a settle — and carries willRetry", () => {
	expect(mapPiEvent({ type: "agent_end", willRetry: true })).toEqual({ kind: "run-ended", willRetry: true });
	expect(mapPiEvent({ type: "agent_end", willRetry: false })).toEqual({ kind: "run-ended", willRetry: false });
	expect(mapPiEvent({ type: "agent_end" })).toEqual({ kind: "run-ended", willRetry: false });
});

test("agent_settled is the only completion", () =>
	expect(mapPiEvent({ type: "agent_settled" })).toEqual({ kind: "settled" }));

// --- #29's remaining half: custom session entries are promoted, other entries are not
test("a custom session entry maps with its type and data", () =>
	expect(
		mapPiEvent({
			type: "entry_appended",
			entry: { type: "custom", customType: "modes", data: { mode: "acceptEdits" } },
		}),
	).toEqual({ kind: "custom-entry", customType: "modes", data: { mode: "acceptEdits" } }));

test("a custom entry with no data still maps — the shape belongs to its extension", () =>
	expect(mapPiEvent({ type: "entry_appended", entry: { type: "custom", customType: "modes" } })).toEqual({
		kind: "custom-entry",
		customType: "modes",
		data: undefined,
	}));

// ⚠ Non-custom entries duplicate first-class observations (messages stream as
// message_update), so they stay unmapped exactly as before this case existed.
test("a non-custom session entry stays unmapped", () =>
	expect(kindOf({ type: "entry_appended", entry: { type: "message", message: { role: "user" } } })).toBe("unmapped"));

test("an entry_appended with no readable entry stays unmapped", () =>
	expect(kindOf({ type: "entry_appended" })).toBe("unmapped"));

// --- #45: one completed request's accounting, off message_end
test("an assistant message_end becomes a message-usage with its role and usage", () =>
	expect(
		mapPiEvent({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 1200, output: 40, cacheRead: 300, cacheWrite: 50, cost: { total: 0.0132 } },
			},
		}),
	).toEqual({
		kind: "message-usage",
		role: "assistant",
		usage: { input: 1200, output: 40, cacheRead: 300, cacheWrite: 50, totalCost: 0.0132 },
	}));

// pi's attribution rule: a toolResult carries usage only when a model summarized the output.
test("a toolResult message_end WITH usage is counted spend", () =>
	expect(
		mapPiEvent({
			type: "message_end",
			message: { role: "toolResult", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
		}),
	).toEqual({
		kind: "message-usage",
		role: "toolResult",
		usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
	}));

test("a toolResult message_end WITHOUT usage stays unmapped — no spend to count", () =>
	expect(kindOf({ type: "message_end", message: { role: "toolResult" } })).toBe("unmapped"));

// ⚠ The role gate is load-bearing: without it, any future message shape carrying a
// usage-like object would inflate the cost sum outside pi's own attribution rule.
test("a message_end with usage but an unattributable role stays unmapped", () =>
	expect(
		kindOf({
			type: "message_end",
			message: { role: "user", usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 } },
		}),
	).toBe("unmapped"));

test("a message_end with no readable message stays unmapped", () =>
	expect(kindOf({ type: "message_end" })).toBe("unmapped"));

// ⚠ The design rule: there is no skip case.
test("an unmodelled event is carried through with its payload intact", () => {
	const observed = mapPiEvent({ type: "some_future_event", detail: 42 });
	expect(observed).toEqual({ kind: "unmapped", event: { type: "some_future_event", detail: 42 } });
});

// --- usage: zero versus absent (#53 S2, adjacent to #45)
// `usage: {}` is a real shape pi can emit (an errored request); absent means "this delta
// carries no accounting". They must not collapse into one another: the browser's stats
// treat an all-zero usage as a failed request and an absent one as nothing to fold.
test("a delta with usage {} carries an all-zero usage; a delta without usage carries none", () => {
	const withEmptyUsage = mapPiEvent({
		type: "message_update",
		usage: {},
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
	});
	expect(withEmptyUsage).toEqual({
		kind: "text-delta",
		contentIndex: 0,
		delta: "x",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const withoutUsage = mapPiEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
	});
	expect(withoutUsage).toEqual({ kind: "text-delta", contentIndex: 0, delta: "x" });
});

test("cacheWrite and cost.total are read from usage, not defaulted", () =>
	expect(
		mapPiEvent({
			type: "message_update",
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
			assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "x" },
		}),
	).toEqual({
		kind: "text-delta",
		contentIndex: 2,
		delta: "x",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalCost: 0.5 },
	}));

// ⚠ All four dialog methods block pi (#53 S3): `input` and `editor` were never tested as
// blocking, so dropping either from the dialog set would have let pi hang silently.
test("input and editor dialogs are blocking, with their question read into dialog", () => {
	expect(
		mapPiEvent({ type: "extension_ui_request", id: "i1", method: "input", title: "Name?", placeholder: "x" }),
	).toEqual({
		kind: "extension-ui-request",
		id: "i1",
		method: "input",
		blocking: true,
		dialog: { method: "input", title: "Name?", placeholder: "x" },
	});
	expect(
		mapPiEvent({ type: "extension_ui_request", id: "e1", method: "editor", title: "Edit", prefill: "draft" }),
	).toEqual({
		kind: "extension-ui-request",
		id: "e1",
		method: "editor",
		blocking: true,
		dialog: { method: "editor", title: "Edit", prefill: "draft" },
	});
});
