import { expect, test } from "bun:test";
import type { MessagePart, ToolCallPart, ToolResultPart } from "@tanstack/ai";
import type { ChatUISelectedPart } from "@tanstack/ai-client/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectedMessagePart } from "../selected-message-part.tsx";

/**
 * The dispatch this file guards was DEAD for its whole prior life: TanStack routes tool
 * parts to `toolsComponents[name]` (exact name, no fallback), so the old
 * `partsComponents.toolCall` entry never rendered and an unregistered tool showed as
 * NOTHING plus a console warning. `SelectedMessagePart` exists so an unanticipated tool
 * name still renders through the textual contract — these tests are the CI guard for
 * that; the `?fixture` page is the visual one and nothing runs it in CI.
 */

const toolCallWith = (overrides: Partial<ToolCallPart>): ToolCallPart => ({
	type: "tool-call",
	id: "call-1",
	name: "bash",
	arguments: "{}",
	state: "complete" as ToolCallPart["state"],
	...overrides,
});

const toolResultWith = (overrides: Partial<ToolResultPart>): ToolResultPart => ({
	type: "tool-result",
	toolCallId: "call-1",
	content: "PLAIN TEXT FORM",
	state: "complete" as ToolResultPart["state"],
	...overrides,
});

const html = (selected: ChatUISelectedPart, isStreaming = false) =>
	renderToStaticMarkup(<SelectedMessagePart selected={selected} isStreaming={isStreaming} renderers={{}} />);

test("a tool call from an UNREGISTERED name renders its name and result text", () => {
	const rendered = html({
		key: "toolCall",
		part: toolCallWith({ name: "mcp_tool_nobody_registered" }),
		result: toolResultWith({ content: "the visible result text" }),
	});
	expect(rendered).toContain("mcp_tool_nobody_registered");
	expect(rendered).toContain("the visible result text");
});

test("a tool call with no result yet renders the visible pending state", () => {
	const rendered = html({
		key: "toolCall",
		part: toolCallWith({ id: "call-2", state: "pending" as ToolCallPart["state"] }),
	});
	expect(rendered).toContain("bash");
	expect(rendered).toContain("running…");
});

test("an unmatched tool result renders through the same textual contract", () => {
	const rendered = html({
		key: "toolResult",
		part: toolResultWith({ toolCallId: "call-orphan", content: "orphan result body" }),
		matched: false,
	});
	expect(rendered).toContain("orphan result body");
});

test("an unknown part kind renders visibly instead of vanishing", () => {
	// An image part, which no branch of the dispatcher claims — the generic member's
	// `part` is the broad `MessagePart` union, so this needs no cast.
	const imagePart: MessagePart = {
		type: "image",
		source: { type: "url", value: "https://example.com/x.png" },
	};
	const rendered = html({ key: "image", part: imagePart });
	expect(rendered).toContain("image");
});

test("a thinking part renders inside the Reasoning shell", () => {
	const thinkingPart: MessagePart = {
		type: "thinking",
		content: "the model reasoning text",
	};
	const rendered = html({ key: "thinking", part: thinkingPart }, true);
	expect(rendered).toContain("the model reasoning text");
	expect(rendered).toContain("Thinking...");
});
