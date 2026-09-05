import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toRpcWireEvent } from "../session-events.ts";

/**
 * The replica of pi's unexported `toJsonEvent` (#69): what `map-events.ts` consumes must be
 * byte-for-byte the rpc wire shape. These pin the three behaviours pi's own has — strip the
 * cumulative `partial`, hoist tool id/name on `toolcall_start`, pass everything else through.
 *
 * The fixtures are built as REAL `AgentSessionEvent`s, no casts: the types are what the
 * translation is written against, so a fixture the types reject is a fixture pi could not emit.
 */

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;
type AssistantMessage = Extract<MessageUpdate["message"], { role: "assistant" }>;
type AssistantMessageEvent = MessageUpdate["assistantMessageEvent"];

const usage: AssistantMessage["usage"] = {
	input: 3,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 7,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageUpdate(message: MessageUpdate["message"], assistantMessageEvent: AssistantMessageEvent): MessageUpdate {
	return { type: "message_update", message, assistantMessageEvent };
}

test("message_update drops the cumulative partial and lifts usage to the top level", () => {
	const partial = assistantMessage([{ type: "text", text: "hi" }]);
	const event = messageUpdate(partial, { type: "text_delta", contentIndex: 0, delta: "hi", partial });
	expect(toRpcWireEvent(event)).toEqual({
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
	});
});

test("toolcall_start hoists the tool call's id and name off the partial", () => {
	const partial = assistantMessage([
		{ type: "text", text: "x" },
		{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
	]);
	const event = messageUpdate(partial, { type: "toolcall_start", contentIndex: 1, partial });
	expect(toRpcWireEvent(event)).toEqual({
		type: "message_update",
		usage,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" },
	});
});

test("an assistant event without a partial passes through unchanged", () => {
	const message = assistantMessage([]);
	const event = messageUpdate(message, { type: "done", reason: "stop", message });
	expect(toRpcWireEvent(event).assistantMessageEvent).toEqual({ type: "done", reason: "stop", message });
});

test("every other event type is a plain copy", () => {
	expect(toRpcWireEvent({ type: "agent_settled" })).toEqual({ type: "agent_settled" });
	expect(toRpcWireEvent({ type: "agent_end", messages: [], willRetry: true })).toEqual({
		type: "agent_end",
		messages: [],
		willRetry: true,
	});
});

test("a non-assistant message_update and a toolcall_start over non-tool content are refused loudly", () => {
	const partial = assistantMessage([{ type: "text", text: "x" }]);
	const userMessage: MessageUpdate["message"] = { role: "user", content: "hello", timestamp: 1 };
	expect(() =>
		toRpcWireEvent(messageUpdate(userMessage, { type: "text_delta", contentIndex: 0, delta: "", partial })),
	).toThrow(/not an assistant message/);
	expect(() => toRpcWireEvent(messageUpdate(partial, { type: "toolcall_start", contentIndex: 0, partial }))).toThrow(
		/not a tool call/,
	);
});
