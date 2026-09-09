import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { isZenToolResultDescriptor, ZEN_TOOL_RESULT_KEY, type ZenObservation } from "@zen/core";
import { mapPiEvent } from "../map-events.ts";
import { type AguiIdentifiers, observationToAguiEvents } from "../to-agui.ts";
import { observationKindsDeclaredByTheUnion } from "./observation-kinds.ts";

const ids: AguiIdentifiers = { messageId: "m1", runId: "r1", threadId: "t1" };
const toAgui = (observation: ZenObservation) => observationToAguiEvents(observation, ids);
const types = (observation: ZenObservation) => toAgui(observation).map((event) => event.type);

test("a text delta becomes TEXT_MESSAGE_CONTENT carrying the message id", () => {
	const [event] = toAgui({ kind: "text-delta", contentIndex: 0, delta: "Hello " });
	expect(event).toMatchObject({
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: "m1",
		delta: "Hello ",
	});
});

// REASONING_*, because THINKING_* is deprecated in @ag-ui/core and goes at 1.0.0.
test("a thinking delta uses REASONING_MESSAGE_CONTENT, not the deprecated THINKING_*", () =>
	expect(types({ kind: "thinking-delta", contentIndex: 0, delta: "hmm" })).toEqual([
		EventType.REASONING_MESSAGE_CONTENT,
	]));

// ⚠ One observation, two events — which is why the mapper returns an array.
test("a tool call becomes TOOL_CALL_START followed by TOOL_CALL_ARGS", () => {
	const events = toAgui({ kind: "tool-call", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
	expect(events.map((event) => event.type)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS]);
	expect(events[0]).toMatchObject({ toolCallId: "c1", toolCallName: "bash" });
	// args are serialised, because AG-UI streams them as a string delta
	expect(events[1]).toMatchObject({ delta: '{"command":"ls"}' });
});

test("absent args serialise to an empty object rather than undefined", () =>
	expect(toAgui({ kind: "tool-call", toolCallId: "c1", toolName: "ls", args: undefined })[1]).toMatchObject({
		delta: "{}",
	}));

// ⚠⚠ The documented loss: AG-UI has no partial-result event, so accumulated output before
// completion has nowhere to go. Emitting a result per update would say "finished" repeatedly.
test("an INCOMPLETE tool result maps to nothing, deliberately", () =>
	expect(
		toAgui({
			kind: "tool-result",
			toolCallId: "c1",
			toolName: "bash",
			text: "partial…",
			complete: false,
			isError: false,
		}),
	).toEqual([]));

test("a completed tool result becomes TOOL_CALL_RESULT with its text", () => {
	const [event] = toAgui({
		kind: "tool-result",
		toolCallId: "c1",
		toolName: "bash",
		text: "total 48",
		complete: true,
		isError: false,
	});
	expect(event).toMatchObject({
		type: EventType.TOOL_CALL_RESULT,
		toolCallId: "c1",
		content: "total 48",
		role: "tool",
	});
});

// ⚠ `isError` has no AG-UI field on a tool result and is the only signal a REFUSED call has.
test("an errored result carries the error flag, so a denial cannot render as success", () => {
	const [errored] = toAgui({
		kind: "tool-result",
		toolCallId: "c1",
		toolName: "write",
		text: "blocked",
		complete: true,
		isError: true,
	});
	expect(errored).toMatchObject({ zenIsError: true });
	const [fine] = toAgui({
		kind: "tool-result",
		toolCallId: "c1",
		toolName: "read",
		text: "ok",
		complete: true,
		isError: false,
	});
	expect(fine).not.toHaveProperty("zenIsError");
});

// ⚠ NOT RUN_FINISHED — `agent_end` may be followed by an automatic retry.
test("a run ending is STEP_FINISHED, never RUN_FINISHED", () => {
	expect(types({ kind: "run-ended", willRetry: false })).toEqual([EventType.STEP_FINISHED]);
	expect(types({ kind: "run-ended", willRetry: true })).toEqual([EventType.STEP_FINISHED]);
	// and the retry is visible in the step name rather than lost
	expect(toAgui({ kind: "run-ended", willRetry: true })[0]).toMatchObject({
		stepName: "agent-run-will-retry",
	});
});

test("only a settle becomes RUN_FINISHED", () =>
	expect(toAgui({ kind: "settled" })[0]).toMatchObject({
		type: EventType.RUN_FINISHED,
		threadId: "t1",
		runId: "r1",
	}));

test("an extension error becomes RUN_ERROR naming the extension and the hook", () => {
	const [event] = toAgui({
		kind: "extension-error",
		extensionPath: "/x/guards.ts",
		event: "tool_call",
		error: "boom",
	});
	// The whole envelope, exactly: two `toContain`s used to pass with `${event}` and
	// `${error}` swapped in the template (#53 S2, the 1f436dc class).
	expect(event).toEqual({
		type: EventType.RUN_ERROR,
		runId: "r1",
		message: "/x/guards.ts failed on tool_call: boom",
	});
});

// #29: the notify payload must survive the LAST hop too — the browser's onCustomEvent
// receives exactly this event's `value`, so a message dropped here is a message dropped
// on screen. The full pipeline pin: pi wire event → mapPiEvent → toAgui, message intact.
test("a notify observation rides CUSTOM as zen.notify with its message intact", () => {
	const observation = mapPiEvent({
		type: "extension_ui_request",
		id: "n1",
		method: "notify",
		message: "Mode set to Plan Mode",
		notifyType: "warning",
	});
	const [event] = toAgui(observation);
	expect(event).toMatchObject({ type: EventType.CUSTOM, name: "zen.notify" });
	expect((event as { value: unknown }).value).toMatchObject({
		message: "Mode set to Plan Mode",
		notifyType: "warning",
	});
});

// #29's remaining half: the mode lines read picc's "modes" entries from this chunk, so the
// pipeline pin is wire event → mapPiEvent → toAgui with customType and data intact.
test("a custom session entry rides CUSTOM as zen.entry with its data intact", () => {
	const observation = mapPiEvent({
		type: "entry_appended",
		entry: { type: "custom", customType: "modes", data: { mode: "acceptEdits" } },
	});
	const [event] = toAgui(observation);
	expect(event).toMatchObject({ type: EventType.CUSTOM, name: "zen.entry" });
	expect((event as { value: unknown }).value).toMatchObject({
		customType: "modes",
		data: { mode: "acceptEdits" },
	});
});

// --- #45: a completed request's accounting crosses as zen.usage, the whole observation
test("a message-end observation rides CUSTOM as zen.usage with role and usage intact", () => {
	const observation = mapPiEvent({
		type: "message_end",
		message: {
			role: "assistant",
			usage: { input: 1200, output: 40, cacheRead: 300, cacheWrite: 50, cost: { total: 0.0132 } },
		},
	});
	const [event] = toAgui(observation);
	expect(event).toMatchObject({ type: EventType.CUSTOM, name: "zen.usage" });
	expect((event as { value: unknown }).value).toEqual({
		kind: "message-end",
		role: "assistant",
		usage: { input: 1200, output: 40, cacheRead: 300, cacheWrite: 50, totalCost: 0.0132 },
	});
});

// ⚠ CUSTOM, not RAW. @ag-ui/core defines RAW and it looks made for this, but TanStack
// NARROWS AGUIEvent and RAW is not in the narrowed union — found only by removing a cast.
test("an unmapped observation rides CUSTOM, because RAW is not a valid StreamChunk", () => {
	const [event] = toAgui({ kind: "unmapped", event: { type: "some_future_event", detail: 1 } });
	expect(event).toMatchObject({ type: EventType.CUSTOM, name: "zen.unmapped" });
	expect((event as { value: unknown }).value).toEqual({ type: "some_future_event", detail: 1 });
});

test("nothing is silently dropped: every kind except an in-flight result and a bare message boundary yields an event", () => {
	const observations: ZenObservation[] = [
		{ kind: "text-delta", contentIndex: 0, delta: "a" },
		{ kind: "thinking-delta", contentIndex: 0, delta: "b" },
		{ kind: "tool-call", toolCallId: "c", toolName: "bash", args: {} },
		{ kind: "tool-result", toolCallId: "c", toolName: "bash", text: "x", complete: true, isError: false },
		{ kind: "extension-error", extensionPath: "/x", event: "e", error: "err" },
		// The notify variant: the one ui-request shape that crosses (fire-and-forget ones are
		// addressed to a terminal and are dropped by design — see the mapper).
		{
			kind: "extension-ui-request",
			id: "u1",
			method: "notify",
			blocking: false,
			origin: "run",
			message: "Mode: acceptEdits",
		},
		{ kind: "custom-entry", customType: "modes", data: { mode: "acceptEdits" } },
		{
			kind: "message-end",
			role: "assistant",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		},
		{ kind: "turn-start" },
		{ kind: "turn-end", toolResults: 1 },
		{ kind: "queue", steering: [], followUp: ["later"] },
		{ kind: "prompt-rejected", messageId: "m", reason: "Agent is already processing" },
		{ kind: "dialog-settled", id: "d1", outcome: "answered" },
		{ kind: "run-ended", willRetry: false },
		{ kind: "settled" },
		{ kind: "unmapped", event: { type: "z" } },
	];
	for (const observation of observations) {
		expect(toAgui(observation).length).toBeGreaterThan(0);
	}
	// The AG-UI view opens one message per run, so a per-message boundary has no event in
	// it (#112) — the follow carries boundaries; this view's loss is stated, not silent.
	const bareBoundaries: ZenObservation[] = [
		{ kind: "message-start", role: "user", text: "hi" },
		{ kind: "message-end", role: "user" },
	];
	for (const boundary of bareBoundaries) {
		expect(toAgui(boundary)).toEqual([]);
	}
	observations.push(...bareBoundaries);
	// every member covered — the oracle is the union itself, never a hard-coded count (the
	// count here and in schemas.test.ts drifted apart once; a set diff names the missing kind)
	const coveredKinds: string[] = [...new Set(observations.map((observation) => observation.kind))];
	expect(coveredKinds.sort()).toEqual(observationKindsDeclaredByTheUnion());
});

// ⚠⚠ THE END-TO-END ASSERTION: #18's descriptor must survive BOTH hops.
// pi rpc event → ZenObservation → AG-UI StreamChunk, and still be readable.
test("the tool-result descriptor survives pi → observation → AG-UI intact", () => {
	const observation = mapPiEvent({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "bash",
		result: { content: "trimmed output", details: { truncation: { shown: 500, total: 4000, unit: "lines" } } },
		isError: false,
	});
	const [event] = observationToAguiEvents(observation, ids);
	const carried = (event as Record<string, unknown>)[ZEN_TOOL_RESULT_KEY];
	expect(isZenToolResultDescriptor(carried)).toBe(true);
	expect(carried).toMatchObject({
		kind: "pi.tool.bash",
		truncated: { shown: 500, total: 4000, unit: "lines" },
	});
	// and the mandatory textual form rode alongside it, which is what makes an
	// unrecognised descriptor render visibly rather than blank
	expect(event).toMatchObject({ content: "trimmed output" });
});

test("a result with no descriptor carries no descriptor key at all", () => {
	const observation = mapPiEvent({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "bash",
		result: { content: "plain" },
		isError: false,
	});
	expect(observationToAguiEvents(observation, ids)[0]).not.toHaveProperty(ZEN_TOOL_RESULT_KEY);
});

// ⚠ The deliberate drop (#53 S3): terminal-addressed fire-and-forget requests produce NO
// event — measured at 40 of 43 events for a one-word prompt when they were forwarded.
test("setStatus, setWidget, setTitle and set_editor_text produce no AG-UI event", () => {
	for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text"]) {
		expect(
			toAgui({ kind: "extension-ui-request", id: "", method, blocking: false, origin: "run", message: "" }),
		).toEqual([]);
	}
});
