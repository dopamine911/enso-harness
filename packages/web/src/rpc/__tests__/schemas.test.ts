import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import {
	isZenToolResultDescriptor,
	PiImageContent,
	PiRpcCommandInputSchema,
	PiRpcEventSchema,
	PiRpcResponseSchema,
	ZenObservation,
	ZenToolResultDescriptor,
	ZenUsage,
} from "@zen/core";
import { mapPiEvent } from "../map-events.ts";
import { claimsToBeResponse, isPiRpcResponse } from "../protocol.ts";

/**
 * These prove the TypeBox conversion bought RUNTIME VALIDATION and a JSON Schema, not just
 * types. Without them the schemas would be decorative — the "built claims need a caller"
 * failure, applied to a refactor of my own.
 */

// --- the schemas really are JSON Schema objects, which is the reason for choosing TypeBox
test("a schema is literally a JSON Schema object", () => {
	expect(ZenToolResultDescriptor).toMatchObject({ type: "object" });
	expect(ZenToolResultDescriptor.required).toContain("kind");
	expect(ZenToolResultDescriptor.required).toContain("props");
	// optional fields are absent from `required`, which is what an OpenAPI consumer reads
	expect(ZenToolResultDescriptor.required).not.toContain("truncated");
});

test("the observation union is expressed as a JSON Schema union", () =>
	expect(ZenObservation).toHaveProperty("anyOf"));

// --- and the validators actually reject
test("the descriptor validator rejects every malformed shape", () => {
	expect(isZenToolResultDescriptor({ kind: "diff", props: {} })).toBe(true);
	expect(isZenToolResultDescriptor({ kind: "", props: {} })).toBe(false);
	expect(isZenToolResultDescriptor({ kind: "diff" })).toBe(false);
	expect(isZenToolResultDescriptor({ props: {} })).toBe(false);
	expect(isZenToolResultDescriptor("diff")).toBe(false);
	expect(isZenToolResultDescriptor(null)).toBe(false);
});

test("a negative truncation count is rejected, not silently rendered", () =>
	expect(
		isZenToolResultDescriptor({ kind: "d", props: {}, truncated: { shown: -1, total: 5, unit: "lines" } }),
	).toBe(false));

test("an unknown truncation unit is rejected by the schema", () =>
	expect(
		isZenToolResultDescriptor({ kind: "d", props: {}, truncated: { shown: 1, total: 5, unit: "furlongs" } }),
	).toBe(false));

test("usage rejects non-integer token counts", () => {
	expect(Check(ZenUsage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(true);
	expect(Check(ZenUsage, { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(false);
	expect(Check(ZenUsage, { input: 1, output: 2 })).toBe(false);
});

// --- pi wire schemas
test("image content is validated, so a malformed attachment fails at the boundary", () => {
	expect(Check(PiImageContent, { type: "image", data: "aGk=", mimeType: "image/png" })).toBe(true);
	expect(Check(PiImageContent, { type: "file", data: "aGk=", mimeType: "image/png" })).toBe(false);
	expect(Check(PiImageContent, { type: "image", data: "aGk=" })).toBe(false);
});

test("a command input requires a non-empty type", () => {
	expect(Check(PiRpcCommandInputSchema, { type: "prompt", message: "x" })).toBe(true);
	expect(Check(PiRpcCommandInputSchema, { type: "" })).toBe(false);
	expect(Check(PiRpcCommandInputSchema, { message: "x" })).toBe(false);
});

// ⚠ The schemas are OPEN on purpose — an unmodelled field must not fail validation, or a
// new pi event becomes "the transport is broken" instead of "we don't render this yet".
test("extra fields are accepted, so a newer pi does not break the transport", () => {
	expect(Check(PiRpcEventSchema, { type: "some_future_event", brandNew: { nested: true } })).toBe(true);
	expect(Check(PiRpcResponseSchema, { type: "response", command: "prompt", success: true, extra: 1 })).toBe(true);
});

test("a response missing required fields fails validation while still claiming the route", () => {
	const malformed = { type: "response", id: "x" };
	expect(claimsToBeResponse(malformed)).toBe(true);
	expect(isPiRpcResponse(malformed)).toBe(false);
});

// --- the mapper's output validates against the union it claims to produce
test("EVERY observation the mapper can emit validates against ZenObservation", () => {
	const events = [
		{ type: "message_update", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "b" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		{ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "ls" } },
		{ type: "tool_execution_update", toolCallId: "c", toolName: "bash", partialResult: { content: [{ type: "text", text: "x" }] } },
		{ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: "y", details: { truncation: { shown: 1, total: 9, unit: "lines" } } }, isError: false },
		{ type: "tool_execution_end", toolCallId: "c", toolName: "write", result: { content: "denied" }, isError: true },
		{ type: "extension_error", extensionPath: "/g.ts", event: "tool_call", error: "boom" },
		{ type: "agent_end", willRetry: true },
		{ type: "agent_settled" },
		{ type: "totally_unknown", payload: [1, 2, 3] },
	];
	for (const event of events) {
		const observation = mapPiEvent(event);
		expect(Check(ZenObservation, observation)).toBe(true);
	}
	// and the set above actually covers every member of the union
	expect(new Set(events.map((event) => mapPiEvent(event).kind)).size).toBe(8);
});
