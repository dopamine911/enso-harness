import { expect, test } from "bun:test";
import type { UIMessage } from "@tanstack/ai-client";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStats } from "../session-stats.tsx";
import { countSession, describeActivity, SessionStatusView } from "../session-status.tsx";

/**
 * #90 PR 1: the always-on status bar. Activity and counts are derived from the message
 * list the page already holds; cost from the #45 store. Tested as the two pure functions
 * plus a static render of the view, the session-debug.test.tsx pattern.
 */

const user = (id: string, content: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", content }] });
const assistant = (id: string, parts: UIMessage["parts"]): UIMessage => ({ id, role: "assistant", parts });
const call = (id: string, name: string): UIMessage["parts"][number] => ({
	type: "tool-call",
	id,
	name,
	arguments: "{}",
	state: "input-complete",
});
const result = (toolCallId: string): UIMessage["parts"][number] => ({
	type: "tool-result",
	toolCallId,
	content: "ok",
	state: "complete",
});

const NO_STATS: SessionStats = { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 };

// ── activity ─────────────────────────────────────────────────────────────────

test("not loading is idle, whatever the transcript holds", () => {
	const messages = [user("u1", "hi"), assistant("a1", [call("c1", "read")])];
	expect(describeActivity(messages, false)).toEqual({ kind: "idle" });
});

test("a run with no assistant output yet is working, not idle", () => {
	expect(describeActivity([user("u1", "hi")], true)).toEqual({ kind: "working" });
	expect(describeActivity([], true)).toEqual({ kind: "working" });
});

// ⚠ THE DONE/PENDING RULE: a call is running until its result is paired — and pairing is
// TanStack's own selection across the whole list, not a `state` field we would have to
// keep in step with the library.
test("a tool call with no result is running <tool>; once its result lands the model is working again", () => {
	const pending = [user("u1", "hi"), assistant("a1", [{ type: "text", content: "let me look" }, call("c1", "read")])];
	expect(describeActivity(pending, true)).toEqual({ kind: "running", tool: "read" });
	const paired = [user("u1", "hi"), assistant("a1", [call("c1", "read"), result("c1")])];
	expect(describeActivity(paired, true)).toEqual({ kind: "working" });
});

test("a thinking tail is thinking; a text tail is responding", () => {
	expect(describeActivity([user("u1", "hi"), assistant("a1", [{ type: "thinking", content: "hm" }])], true)).toEqual({
		kind: "thinking",
	});
	expect(describeActivity([user("u1", "hi"), assistant("a1", [{ type: "text", content: "so" }])], true)).toEqual({
		kind: "responding",
	});
});

// ── counts ───────────────────────────────────────────────────────────────────

test("turns count user messages; tool calls count every call, paired or not", () => {
	const messages = [
		user("u1", "one"),
		assistant("a1", [call("c1", "read"), result("c1"), call("c2", "bash")]),
		user("u2", "two"),
		assistant("a2", [{ type: "text", content: "done" }]),
	];
	expect(countSession(messages)).toEqual({ turns: 2, toolCalls: 2 });
	expect(countSession([])).toEqual({ turns: 0, toolCalls: 0 });
});

// ── the view ─────────────────────────────────────────────────────────────────

const render = (props: Partial<Parameters<typeof SessionStatusView>[0]>): string =>
	renderToStaticMarkup(
		<SessionStatusView
			activity={props.activity ?? { kind: "idle" }}
			counts={props.counts ?? { turns: 0, toolCalls: 0 }}
			stats={props.stats ?? NO_STATS}
		/>,
	);

// ⚠ ALWAYS VISIBLE. The #45 bar hid until the first request; this one is the place you look,
// so a fresh session must read as an empty session, not as nothing.
test("a fresh session renders idle with zeros — never an empty string", () => {
	const rendered = render({});
	expect(rendered).toContain("idle");
	expect(rendered).toContain("0 turns");
	expect(rendered).toContain("0 tool calls");
	expect(rendered).toContain("$0.0000");
	// No last-request figure before the first request: absent, not a fabricated zero.
	expect(rendered).not.toContain("tok in");
});

test("the running tool is named, and counts read as English", () => {
	const rendered = render({ activity: { kind: "running", tool: "bash" }, counts: { turns: 1, toolCalls: 1 } });
	expect(rendered).toContain("running bash");
	expect(rendered).toContain("1 turn<");
	expect(rendered).toContain("1 tool call<");
});

test("cost and the last request's prompt size are labelled honestly", () => {
	const rendered = render({ stats: { totalCost: 0.0132, lastRequestInputTokens: 12_345, countedMessages: 1 } });
	expect(rendered).toContain("$0.0132");
	expect(rendered).toContain("12,345");
	// ⚠ "last … tok in", NOT "context": the window size does not cross the wire (#44), so a
	// context label would claim a measurement this bar does not have. Visible text only —
	// the hover title legitimately says "not a context-window percentage".
	const visibleText = rendered.replace(/<[^>]*>/g, " ");
	expect(visibleText).not.toContain("context");
});
