import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	applyZenMessageUsage,
	clearSessionStatsForTest,
	getSessionStatsSnapshot,
	SessionStatsBar,
	subscribeToSessionStats,
} from "../session-stats.tsx";

/**
 * #45's browser half: `zen.usage` chunks become the stats bar. The store is module-level
 * because TanStack's `onCustomEvent` is an option on an object built before any component
 * exists — same shape as notifications.tsx, tested the same way.
 */

afterEach(() => clearSessionStatsForTest());

const assistantUsage = (input: number, cacheRead: number, totalCost: number) => ({
	kind: "message-usage",
	role: "assistant",
	usage: { input, output: 10, cacheRead, cacheWrite: 0, totalCost },
});

// ⚠ THE SUMMING UNIT — cost must be the SUM across completed messages, not the last one.
// A run with a tool call produces two assistant messages; showing only the second would
// under-report every multi-step run.
test("cost accumulates across messages; last-request tokens follow the latest assistant message", () => {
	applyZenMessageUsage(assistantUsage(1000, 200, 0.01));
	applyZenMessageUsage(assistantUsage(1500, 400, 0.02));
	const snapshot = getSessionStatsSnapshot();
	expect(snapshot.totalCost).toBeCloseTo(0.03);
	expect(snapshot.lastRequestInputTokens).toBe(1500 + 400);
	expect(snapshot.countedMessages).toBe(2);
});

// pi's attribution rule counts a toolResult summary's spend — but its prompt is the tool
// output, not the conversation, so it must not overwrite the last-request number.
test("a toolResult summary adds cost but never moves the last-request tokens", () => {
	applyZenMessageUsage(assistantUsage(1000, 0, 0.01));
	applyZenMessageUsage({
		kind: "message-usage",
		role: "toolResult",
		usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalCost: 0.001 },
	});
	const snapshot = getSessionStatsSnapshot();
	expect(snapshot.totalCost).toBeCloseTo(0.011);
	expect(snapshot.lastRequestInputTokens).toBe(1000);
});

test("a usage with no totalCost still counts tokens without poisoning the sum", () => {
	applyZenMessageUsage({
		kind: "message-usage",
		role: "assistant",
		usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
	});
	const snapshot = getSessionStatsSnapshot();
	expect(snapshot.totalCost).toBe(0);
	expect(snapshot.lastRequestInputTokens).toBe(100);
});

// Defensive like every wire crossing: malformed values change nothing, never throw.
test("a malformed value is ignored without touching the stats", () => {
	applyZenMessageUsage(undefined);
	applyZenMessageUsage("not an object");
	applyZenMessageUsage({ role: "assistant" }); // no usage
	expect(getSessionStatsSnapshot().countedMessages).toBe(0);
});

test("subscribers are told about a counted message, and unsubscribe stops that", () => {
	let notified = 0;
	const unsubscribe = subscribeToSessionStats(() => {
		notified += 1;
	});
	applyZenMessageUsage(assistantUsage(10, 0, 0.001));
	expect(notified).toBe(1);
	unsubscribe();
	applyZenMessageUsage(assistantUsage(10, 0, 0.001));
	expect(notified).toBe(1);
});

test("the bar renders nothing before the first counted request", () => {
	expect(renderToStaticMarkup(<SessionStatsBar />)).toBe("");
});

test("the bar renders the cost and the last request's prompt size, labelled honestly", () => {
	applyZenMessageUsage(assistantUsage(12_000, 345, 0.0132));
	const rendered = renderToStaticMarkup(<SessionStatsBar />);
	expect(rendered).toContain("$0.0132");
	// ⚠ "last request … tokens in", NOT "context": the window size does not cross the wire
	// (#44), so a context label would claim a measurement this bar does not have.
	expect(rendered).toContain("last request");
	expect(rendered).toContain("12,345");
	// ⚠ Assert over VISIBLE text only — the hover title legitimately says "not a
	// context-window percentage", which is the disclaimer, not the claim.
	const visibleText = rendered.replace(/<[^>]*>/g, " ");
	expect(visibleText).not.toContain("context");
});
