import { expect, test } from "bun:test";
import { isPiRpcResponse, isRunComplete, PiRpcParseError, parsePiRpcRecord, willRetryAfter } from "../protocol.ts";

/** Run `operation` and hand back what it threw — `undefined` when it did not throw. */
function captureThrown(operation: () => unknown): unknown {
	try {
		operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

test("a response is distinguished from an event", () => {
	expect(isPiRpcResponse({ type: "response", command: "prompt", success: true })).toBe(true);
	expect(isPiRpcResponse({ type: "message_update" })).toBe(false);
});

test("valid JSON with a string type parses", () => {
	expect(parsePiRpcRecord('{"type":"agent_start"}').type).toBe("agent_start");
});

test("malformed JSON throws with the raw line attached", () => {
	// Capture-then-assert, so the assertions sit outside any conditional path: a run that
	// does NOT throw leaves `thrown` undefined and the instanceof assertion fails loudly.
	const thrown = captureThrown(() => parsePiRpcRecord("{nope}"));
	expect(thrown).toBeInstanceOf(PiRpcParseError);
	expect((thrown as PiRpcParseError).raw).toBe("{nope}");
});

test("valid JSON without a string type is rejected", () => {
	expect(() => parsePiRpcRecord('{"delta":"x"}')).toThrow(PiRpcParseError);
	expect(() => parsePiRpcRecord('{"type":7}')).toThrow(PiRpcParseError);
	expect(() => parsePiRpcRecord('"a string"')).toThrow(PiRpcParseError);
	expect(() => parsePiRpcRecord("null")).toThrow(PiRpcParseError);
});

// ⚠ #24 acceptance: `agent_end` with willRetry must NOT present as completion.
// `agent_end` is ONE low-level run; `agent_settled` is the session-level settle.
test("agent_settled is completion; agent_end is not", () => {
	expect(isRunComplete({ type: "agent_settled" })).toBe(true);
	expect(isRunComplete({ type: "agent_end", willRetry: false })).toBe(false);
	expect(isRunComplete({ type: "agent_end", willRetry: true })).toBe(false);
	expect(isRunComplete({ type: "turn_end" })).toBe(false);
});

test("a retry-bound agent_end is identifiable", () => {
	expect(willRetryAfter({ type: "agent_end", willRetry: true })).toBe(true);
	expect(willRetryAfter({ type: "agent_end", willRetry: false })).toBe(false);
	// absent is not true — a missing field must not read as "will retry"
	expect(willRetryAfter({ type: "agent_end" })).toBe(false);
	// and the check is scoped to agent_end, not any event carrying the field
	expect(willRetryAfter({ type: "turn_end", willRetry: true })).toBe(false);
});
