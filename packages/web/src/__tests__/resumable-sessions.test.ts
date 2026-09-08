import { expect, test } from "bun:test";
import type { ZenThreadHistory } from "@zen/core";
import { createResumableSessionsStore, createResumeRequests, sessionsNotOnThisPage } from "../resumable-sessions.ts";

/** #95: a failed refresh remains visible without erasing the last known resumable sessions. */
test("the resumable-session store validates listings and preserves the last good rows on failure", async () => {
	let answer: unknown = [
		{
			threadId: "stored-1",
			title: "earlier work",
			lastActivityAt: "2026-09-08T12:00:00.000Z",
			messageCount: 2,
			busy: false,
		},
	];
	const store = createResumableSessionsStore(async () => {
		if (answer instanceof Error) throw answer;
		return answer;
	});

	await store.refresh();
	expect(store.get()).toMatchObject({ sessions: [{ threadId: "stored-1", title: "earlier work" }], error: undefined });

	answer = new Error("connection refused");
	await store.refresh();
	expect(store.get().sessions).toHaveLength(1);
	expect(store.get().error).toBe("connection refused");

	answer = [{ threadId: "missing-fields" }];
	await store.refresh();
	expect(store.get().sessions).toHaveLength(1);
	expect(store.get().error).toContain("did not match its schema");
});

test("the earlier list excludes every session already owned by this page", () => {
	const stored = [
		{
			threadId: "here",
			lastActivityAt: "2026-09-08T12:00:00.000Z",
			messageCount: 2,
			busy: true,
		},
		{
			threadId: "earlier",
			lastActivityAt: "2026-09-08T11:00:00.000Z",
			messageCount: 4,
			busy: false,
		},
	];
	expect(sessionsNotOnThisPage(stored, new Set(["here"])).map((session) => session.threadId)).toEqual(["earlier"]);
});

// ── last click wins (PR #104 review) ─────────────────────────────────────────

interface Deferred {
	promise: Promise<ZenThreadHistory>;
	resolve: (history: ZenThreadHistory) => void;
	reject: (error: Error) => void;
}

/**
 * A history fetch the test settles by hand, per thread id, in whatever order it wants.
 * `settled(id)` resolves after the coordinator's own handlers have run — they were attached
 * to the same promise first — so no timer stands in for "the response was processed".
 */
function controlledHistory(): {
	fetch: (threadId: string) => Promise<ZenThreadHistory>;
	resolve: (threadId: string) => Promise<void>;
	reject: (threadId: string, message: string) => Promise<void>;
} {
	const pending = new Map<string, Deferred>();
	const settled = (threadId: string): Promise<void> =>
		(pending.get(threadId)?.promise ?? Promise.resolve()).then(
			() => undefined,
			() => undefined,
		);
	return {
		fetch: (threadId) => {
			const deferred = Promise.withResolvers<ZenThreadHistory>();
			pending.set(threadId, deferred);
			return deferred.promise;
		},
		resolve: (threadId) => {
			pending.get(threadId)?.resolve({ threadId, messages: [], permissionMode: { mode: "default", available: [] } });
			return settled(threadId);
		},
		reject: (threadId, message) => {
			pending.get(threadId)?.reject(new Error(message));
			return settled(threadId);
		},
	};
}

test("⚠ two clicks before the first history lands: the FIRST response is dropped even though it arrives last", async () => {
	const history = controlledHistory();
	const applied: string[] = [];
	const failures: string[] = [];
	const resume = createResumeRequests(
		history.fetch,
		(next) => applied.push(next.threadId),
		(m) => failures.push(m),
	);
	resume("first");
	resume("second");
	// The slow first response arrives AFTER the second click: superseded, not applied.
	await history.resolve("first");
	expect(applied).toEqual([]);
	await history.resolve("second");
	expect(applied).toEqual(["second"]);
	expect(failures).toEqual([]);
});

test("a superseded request's failure is not shown; the latest request's failure is", async () => {
	const history = controlledHistory();
	const applied: string[] = [];
	const failures: string[] = [];
	const resume = createResumeRequests(
		history.fetch,
		(next) => applied.push(next.threadId),
		(m) => failures.push(m),
	);
	resume("first");
	resume("second");
	await history.reject("first", "first went away");
	await history.reject("second", "409 second is running on this server");
	expect(applied).toEqual([]);
	expect(failures).toEqual(["409 second is running on this server"]);
	// After the latest settles, a new click is a fresh request, not a stale one.
	resume("third");
	await history.resolve("third");
	expect(applied).toEqual(["third"]);
});
