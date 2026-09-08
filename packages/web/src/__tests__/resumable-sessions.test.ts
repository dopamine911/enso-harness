import { expect, test } from "bun:test";
import { createResumableSessionsStore, sessionsNotOnThisPage } from "../resumable-sessions.ts";

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
