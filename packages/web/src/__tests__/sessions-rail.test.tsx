import { afterEach, expect, test } from "bun:test";
import type { UIMessage } from "@tanstack/ai-client";
import { renderToStaticMarkup } from "react-dom/server";
import { relativeAge, SessionsRail, UNTITLED_SESSION } from "../sessions-rail.tsx";
import {
	adoptThread,
	clearThreadsForTest,
	mintThread,
	reviveHistoryMessages,
	TITLE_MAX_CHARS,
	threadListStore,
	titleFromMessages,
	updateThreadSummary,
} from "../thread-stores.ts";

/**
 * #90 PR 3: the sessions rail and the page's thread list behind it. The rail is rendered
 * statically with an injected `now`; the list is driven through `mintThread` and
 * `updateThreadSummary`, the two calls the page makes.
 */

afterEach(() => clearThreadsForTest());

const noop = (): void => {
	// Static markup runs no handlers; the callbacks exist only to satisfy the props.
};

// ── relative age ─────────────────────────────────────────────────────────────

test("relative age is one unit in deepseek's form, and never negative", () => {
	const now = new Date("2026-09-08T12:00:00Z");
	const ago = (seconds: number): Date => new Date(now.getTime() - seconds * 1000);
	expect(relativeAge(ago(0), now)).toBe("now");
	expect(relativeAge(ago(4), now)).toBe("now");
	expect(relativeAge(ago(12), now)).toBe("12s");
	expect(relativeAge(ago(3 * 60 + 5), now)).toBe("3m");
	expect(relativeAge(ago(2 * 3600), now)).toBe("2h");
	expect(relativeAge(ago(6 * 86_400 + 1), now)).toBe("6d");
	// A clock skewed into the future reads as now, not as a negative number.
	expect(relativeAge(new Date(now.getTime() + 60_000), now)).toBe("now");
});

// ── the title ────────────────────────────────────────────────────────────────

const user = (content: string): UIMessage => ({ id: "u", role: "user", parts: [{ type: "text", content }] });

test("the title is the FIRST user message, one line, clipped", () => {
	const messages: UIMessage[] = [
		user("  fix the   login\nbug "),
		{ id: "a", role: "assistant", parts: [{ type: "text", content: "sure" }] },
		user("second question"),
	];
	expect(titleFromMessages(messages)).toBe("fix the login bug");
	expect(titleFromMessages([user("x".repeat(TITLE_MAX_CHARS + 10))])).toBe(`${"x".repeat(TITLE_MAX_CHARS)}…`);
	expect(titleFromMessages([])).toBeUndefined();
	// A user message with no text (an image only) titles nothing rather than an empty string.
	expect(
		titleFromMessages([{ id: "u", role: "user", parts: [{ type: "image", source: { type: "url", value: "x.png" } }] }]),
	).toBeUndefined();
});

// ── the page's list ──────────────────────────────────────────────────────────

test("minting lists the thread at once, newest first, untitled and idle", () => {
	const first = mintThread();
	const second = mintThread();
	const listed = threadListStore.get();
	expect(listed.map((thread) => thread.threadId)).toEqual([second.threadId, first.threadId]);
	expect(listed[0]).toMatchObject({ title: undefined, busy: false });
});

test("a summary update reaches the list and moves the thread's activity clock; a no-change update does not", () => {
	const thread = mintThread();
	const before = threadListStore.get()[0];
	updateThreadSummary(thread.threadId, { title: "hello", busy: true });
	const after = threadListStore.get()[0];
	expect(after).toMatchObject({ title: "hello", busy: true });
	expect(after?.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before?.lastActivityAt.getTime() ?? 0);
	// Same values again: the snapshot is not replaced, so subscribers are not woken for nothing.
	updateThreadSummary(thread.threadId, { title: "hello", busy: true });
	expect(threadListStore.get()[0]).toBe(after);
	// An id this page never minted is ignored, not created.
	updateThreadSummary("not-minted", { title: "x", busy: false });
	expect(threadListStore.get()).toHaveLength(1);
});

test("adopting stored history restores dates, title and mode under the stored session id exactly once", () => {
	const history = {
		threadId: "stored-1",
		messages: [
			{
				id: "u1",
				role: "user",
				parts: [{ type: "text", content: "resume this work" }],
				createdAt: "2026-09-08T10:00:00.000Z",
			},
			{ id: "a1", role: "assistant", parts: [{ type: "text", content: "continuing" }] },
		],
		permissionMode: { mode: "plan", available: ["default", "plan"] },
	};
	const adopted = adoptThread(history);
	expect(adopted.threadId).toBe("stored-1");
	expect(adopted.history[0]?.createdAt).toBeInstanceOf(Date);
	expect(adopted.history[0]?.createdAt?.toISOString()).toBe("2026-09-08T10:00:00.000Z");
	expect(adopted.permissionMode.get()).toEqual({ mode: "plan", available: ["default", "plan"] });
	expect(threadListStore.get()).toMatchObject([{ threadId: "stored-1", title: "resume this work", busy: false }]);
	expect(adoptThread({ ...history, messages: [] })).toBe(adopted);
	expect(threadListStore.get()).toHaveLength(1);
});

test("history revival drops malformed rows and invalid dates instead of handing them to TanStack", () => {
	const revived = reviveHistoryMessages([
		null,
		{ id: 3, role: "user", parts: [] },
		{ id: "x", role: "tool", parts: [] },
		{ id: "u", role: "user", parts: [{ type: "text", content: "visible" }], createdAt: "not-a-date" },
	]);
	expect(revived).toEqual([{ id: "u", role: "user", parts: [{ type: "text", content: "visible" }] }]);
});

// ── the rail ─────────────────────────────────────────────────────────────────

test("the rail names the active thread, titles the untitled honestly, and marks a busy one", () => {
	const now = new Date("2026-09-08T12:00:00Z");
	const rendered = renderToStaticMarkup(
		<SessionsRail
			threads={[
				{ threadId: "t2", title: undefined, lastActivityAt: now, busy: true },
				{
					threadId: "t1",
					title: "fix the login bug",
					lastActivityAt: new Date(now.getTime() - 6 * 86_400_000),
					busy: false,
				},
			]}
			activeThreadId="t1"
			earlier={[]}
			earlierError={undefined}
			now={now}
			onSelect={noop}
			onResume={noop}
			onNew={noop}
		/>,
	);
	expect(rendered).toContain("live sessions");
	expect(rendered).toContain("New session");
	expect(rendered).toContain(UNTITLED_SESSION);
	expect(rendered).toContain("fix the login bug");
	expect(rendered).toContain("6d");
	// Exactly one row is current, and it is the active one.
	expect(rendered.match(/aria-current="true"/g)).toHaveLength(1);
	const currentRow = rendered.slice(rendered.indexOf('aria-current="true"'));
	expect(currentRow.indexOf("fix the login bug")).toBeLessThan(currentRow.indexOf("</button>"));
	// The busy row says so for assistive tech, not only with a dot.
	expect(rendered).toContain("running");
});

test("the earlier list distinguishes resumable, live-elsewhere, empty and failed states", () => {
	const now = new Date("2026-09-08T12:00:00Z");
	const baseProps = {
		threads: [{ threadId: "here", title: "current", lastActivityAt: now, busy: false }],
		activeThreadId: "here",
		now,
		onSelect: noop,
		onResume: noop,
		onNew: noop,
	};
	const rendered = renderToStaticMarkup(
		<SessionsRail
			{...baseProps}
			earlier={[
				{
					threadId: "stored",
					title: "resume me",
					lastActivityAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
					messageCount: 4,
					live: false,
				},
				{
					threadId: "elsewhere",
					lastActivityAt: now.toISOString(),
					messageCount: 2,
					live: true,
				},
			]}
			earlierError={undefined}
		/>,
	);
	expect(rendered).toContain('aria-label="earlier sessions"');
	expect(rendered).toContain("resume me");
	expect(rendered).toContain("2h");
	expect(rendered).toContain("open in another tab");
	expect(rendered).toContain("disabled");
	expect(rendered).toContain(UNTITLED_SESSION);

	const empty = renderToStaticMarkup(<SessionsRail {...baseProps} earlier={[]} earlierError={undefined} />);
	expect(empty).toContain("none yet");
	const failed = renderToStaticMarkup(<SessionsRail {...baseProps} earlier={[]} earlierError="connection refused" />);
	expect(failed).toContain('role="alert"');
	expect(failed).toContain("could not list sessions: connection refused");
	expect(failed).not.toContain("none yet");
});
