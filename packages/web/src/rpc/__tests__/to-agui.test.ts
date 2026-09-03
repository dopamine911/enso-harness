import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { isZenToolResultDescriptor, ZEN_TOOL_RESULT_KEY, type ZenObservation } from "@zen/core";
import { mapPiEvent } from "../map-events.ts";
import { observationToAguiEvents, type AguiIdentifiers } from "../to-agui.ts";

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
	expect(events.map((event) => event.type)).toEqual([
		EventType.TOOL_CALL_START,
		EventType.TOOL_CALL_ARGS,
	]);
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
		toAgui({ kind: "tool-result", toolCallId: "c1", toolName: "bash", text: "partial…", complete: false, isError: false }),
	).toEqual([]));

test("a completed tool result becomes TOOL_CALL_RESULT with its text", () => {
	const [event] = toAgui({
		kind: "tool-result", toolCallId: "c1", toolName: "bash", text: "total 48", complete: true, isError: false,
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
		kind: "tool-result", toolCallId: "c1", toolName: "write", text: "blocked", complete: true, isError: true,
	});
	expect(errored).toMatchObject({ zenIsError: true });
	const [fine] = toAgui({
		kind: "tool-result", toolCallId: "c1", toolName: "read", text: "ok", complete: true, isError: false,
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
		kind: "extension-error", extensionPath: "/x/guards.ts", event: "tool_call", error: "boom",
	});
	expect(event).toMatchObject({ type: EventType.RUN_ERROR, runId: "r1" });
	expect((event as { message: string }).message).toContain("/x/guards.ts");
	expect((event as { message: string }).message).toContain("tool_call");
});

// ⚠ CUSTOM, not RAW. @ag-ui/core defines RAW and it looks made for this, but TanStack
// NARROWS AGUIEvent and RAW is not in the narrowed union — found only by removing a cast.
test("an unmapped observation rides CUSTOM, because RAW is not a valid StreamChunk", () => {
	const [event] = toAgui({ kind: "unmapped", event: { type: "some_future_event", detail: 1 } });
	expect(event).toMatchObject({ type: EventType.CUSTOM, name: "zen.unmapped" });
	expect((event as { value: unknown }).value).toEqual({ type: "some_future_event", detail: 1 });
});

test("nothing is silently dropped: every kind except an in-flight result yields an event", () => {
	const observations: ZenObservation[] = [
		{ kind: "text-delta", contentIndex: 0, delta: "a" },
		{ kind: "thinking-delta", contentIndex: 0, delta: "b" },
		{ kind: "tool-call", toolCallId: "c", toolName: "bash", args: {} },
		{ kind: "tool-result", toolCallId: "c", toolName: "bash", text: "x", complete: true, isError: false },
		{ kind: "extension-error", extensionPath: "/x", event: "e", error: "err" },
		{ kind: "run-ended", willRetry: false },
		{ kind: "settled" },
		{ kind: "unmapped", event: { type: "z" } },
	];
	for (const observation of observations) {
		expect(toAgui(observation).length).toBeGreaterThan(0);
	}
	// all eight members covered
	expect(new Set(observations.map((o) => o.kind)).size).toBe(8);
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
		type: "tool_execution_end", toolCallId: "c1", toolName: "bash",
		result: { content: "plain" }, isError: false,
	});
	expect(observationToAguiEvents(observation, ids)[0]).not.toHaveProperty(ZEN_TOOL_RESULT_KEY);
});
