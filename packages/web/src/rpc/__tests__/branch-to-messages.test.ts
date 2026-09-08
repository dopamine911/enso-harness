import { expect, test } from "bun:test";
import { ZEN_TOOL_RESULT_KEY } from "@zen/core";
import { branchToMessages } from "../branch-to-messages.ts";

/**
 * #95: a stored branch mounts as the messages a live run would have left behind. Shapes are
 * pi's session entries, carried verbatim from a real file; what is pinned is what a resumed
 * transcript SHOWS — text, thinking, tool rows with their results paired — and what it does
 * not invent.
 */

const entry = (id: string, message: Record<string, unknown>, timestamp = "2026-09-08T12:00:00.000Z") => ({
	type: "message",
	id,
	parentId: null,
	timestamp,
	message,
});

test("user and assistant messages map in branch order, with text, thinking and tool calls as parts", () => {
	const messages = branchToMessages([
		{ type: "model_change", id: "m0", parentId: null, timestamp: "", provider: "x", modelId: "y" },
		entry("u1", { role: "user", content: "fix the login bug", timestamp: 1 }),
		entry("a1", {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "look at auth first" },
				{ type: "text", text: "Reading auth.ts." },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "auth.ts" } },
			],
		}),
	]);
	expect(messages.map((message) => [message.id, message.role])).toEqual([
		["u1", "user"],
		["a1", "assistant"],
	]);
	expect(messages[0]?.parts).toEqual([{ type: "text", content: "fix the login bug" }]);
	expect(messages[0]?.createdAt?.toISOString()).toBe("2026-09-08T12:00:00.000Z");
	expect(messages[1]?.parts).toEqual([
		{ type: "thinking", content: "look at auth first" },
		{ type: "text", content: "Reading auth.ts." },
		{
			type: "tool-call",
			id: "c1",
			name: "read",
			arguments: '{"path":"auth.ts"}',
			input: { path: "auth.ts" },
			state: "input-complete",
		},
	]);
});

// TanStack's own normalised shape: the result sits in the assistant message that holds the
// call, and the call reads complete with the result as its output — so a resumed step row
// (#93) renders exactly like a live one.
test("⚠ a tool result is paired into the assistant message holding its call; the call completes with that output", () => {
	const messages = branchToMessages([
		entry("u1", { role: "user", content: "ls", timestamp: 1 }),
		entry("a1", {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
		}),
		entry("r1", {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "a.ts\nb.ts" }],
			isError: false,
			details: { truncation: { shown: 2, total: 40, unit: "lines" } },
		}),
		entry("a2", { role: "assistant", content: [{ type: "text", text: "Two files." }] }),
	]);
	expect(messages).toHaveLength(3);
	const withCall = messages[1];
	expect(withCall?.parts.map((part) => part.type)).toEqual(["tool-call", "tool-result"]);
	expect(withCall?.parts[0]).toMatchObject({ type: "tool-call", state: "complete", output: "a.ts\nb.ts" });
	expect(withCall?.parts[1]).toMatchObject({
		type: "tool-result",
		toolCallId: "c1",
		name: "bash",
		content: "a.ts\nb.ts",
		state: "complete",
		metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "pi.tool.bash", truncated: { shown: 2, total: 40, unit: "lines" } } },
	});
	expect(withCall?.parts[1]).not.toHaveProperty("error");
});

test("a refused tool call (isError) reads as an error on both the call and the result — a denial must not render as success", () => {
	const messages = branchToMessages([
		entry("a1", {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "env" } }],
		}),
		entry("r1", {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "refused" }],
			isError: true,
		}),
	]);
	expect(messages[0]?.parts[0]).toMatchObject({ type: "tool-call", state: "error" });
	expect(messages[0]?.parts[1]).toMatchObject({ type: "tool-result", state: "error", error: "refused" });
});

test("a result whose call is not on the branch is dropped, not rendered as a stray row", () => {
	const messages = branchToMessages([
		entry("u1", { role: "user", content: "hi", timestamp: 1 }),
		entry("r1", { role: "toolResult", toolCallId: "gone", toolName: "bash", content: [{ type: "text", text: "x" }] }),
	]);
	expect(messages).toHaveLength(1);
	expect(messages[0]?.role).toBe("user");
});

test("entries that are not messages, and malformed messages, never throw: skipped or emptied", () => {
	const messages = branchToMessages([
		{ type: "custom", customType: "modes", data: { mode: "plan" }, id: "p", parentId: null, timestamp: "" },
		"garbage",
		null,
		entry("a1", { role: "assistant", content: "not an array" }),
		entry("u1", { role: "user", content: [{ type: "image", data: "…" }], timestamp: 1 }, "not a date"),
		entry("x1", { role: "somethingElse", content: "?" }),
	]);
	expect(messages.map((message) => [message.role, message.parts])).toEqual([
		["assistant", []],
		["user", [{ type: "text", content: "[image content]" }]],
	]);
	expect(messages[1]).not.toHaveProperty("createdAt");
});
