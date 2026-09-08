import { beforeEach, expect, test } from "bun:test";
import { createSessionStatsStore, type SessionStatsStore } from "../session-stats.tsx";

/**
 * #45's browser half: `zen.usage` chunks become the stats the status bar renders (#90,
 * session-status.test.tsx). One store per thread (#90 PR 3); each case builds a fresh one.
 */

let store: SessionStatsStore;
beforeEach(() => {
	store = createSessionStatsStore();
});

const assistantUsage = (input: number, cacheRead: number, totalCost: number) => ({
	kind: "message-usage",
	role: "assistant",
	usage: { input, output: 10, cacheRead, cacheWrite: 0, totalCost },
});

// ⚠ THE SUMMING UNIT — cost must be the SUM across completed messages, not the last one.
// A run with a tool call produces two assistant messages; showing only the second would
// under-report every multi-step run.
test("cost accumulates across messages; last-request tokens follow the latest assistant message", () => {
	store.applyUsage(assistantUsage(1000, 200, 0.01));
	store.applyUsage(assistantUsage(1500, 400, 0.02));
	const snapshot = store.get();
	expect(snapshot.totalCost).toBeCloseTo(0.03);
	expect(snapshot.lastRequestInputTokens).toBe(1500 + 400);
	expect(snapshot.countedMessages).toBe(2);
});

// pi's attribution rule counts a toolResult summary's spend — but its prompt is the tool
// output, not the conversation, so it must not overwrite the last-request number.
test("a toolResult summary adds cost but never moves the last-request tokens", () => {
	store.applyUsage(assistantUsage(1000, 0, 0.01));
	store.applyUsage({
		kind: "message-usage",
		role: "toolResult",
		usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalCost: 0.001 },
	});
	const snapshot = store.get();
	expect(snapshot.totalCost).toBeCloseTo(0.011);
	expect(snapshot.lastRequestInputTokens).toBe(1000);
});

// ⚠ Observed on the wire: an errored/aborted request still emits an assistant message_end
// with ALL-ZERO usage. The context did not drop to zero — the request failed — so the
// number must hold while the cost (zero) and the count still register.
test("a zero-usage assistant message never overwrites the last-request tokens", () => {
	store.applyUsage(assistantUsage(1000, 200, 0.01));
	store.applyUsage({
		kind: "message-usage",
		role: "assistant",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
	});
	const snapshot = store.get();
	expect(snapshot.lastRequestInputTokens).toBe(1200);
	expect(snapshot.countedMessages).toBe(2);
});

test("a usage with no totalCost still counts tokens without poisoning the sum", () => {
	store.applyUsage({
		kind: "message-usage",
		role: "assistant",
		usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
	});
	const snapshot = store.get();
	expect(snapshot.totalCost).toBe(0);
	expect(snapshot.lastRequestInputTokens).toBe(100);
});

// Defensive like every wire crossing: malformed values change nothing, never throw.
test("a malformed value is ignored without touching the stats", () => {
	store.applyUsage(undefined);
	store.applyUsage("not an object");
	store.applyUsage({ role: "assistant" }); // no usage
	expect(store.get().countedMessages).toBe(0);
});

test("subscribers are told about a counted message, and unsubscribe stops that", () => {
	let notified = 0;
	const unsubscribe = store.subscribe(() => {
		notified += 1;
	});
	store.applyUsage(assistantUsage(10, 0, 0.001));
	expect(notified).toBe(1);
	unsubscribe();
	store.applyUsage(assistantUsage(10, 0, 0.001));
	expect(notified).toBe(1);
});

// ⚠ Every other fixture in this file sets cacheWrite: 0, so deleting the `+ usage.cacheWrite`
// term from the prompt-token sum left the suite green (#53 S2). This one pins the term.
test("last-request tokens include cacheWrite", () => {
	store.applyUsage({
		kind: "message-usage",
		role: "assistant",
		usage: { input: 100, output: 1, cacheRead: 20, cacheWrite: 7, totalCost: 0 },
	});
	expect(store.get().lastRequestInputTokens).toBe(127);
});
