import { expect, test } from "bun:test";
import type { PiSession } from "@zen/core";
import type { HostedSession } from "../../host/agent-host.ts";
import { createThreadSessions } from "../thread-sessions.ts";

function ignore(): void {
	// The lifecycle tests never prompt, answer, or subscribe — only acquire/release/stop/dispose matter.
}

/**
 * A fake hosted session that records lifecycle calls. `abort` resolves only when the test
 * says so — the disconnect-then-prompt race is about the gap between abort and idle.
 */
function fakeHosted() {
	const record = { disposed: 0, aborts: 0 };
	let finishAbort: () => void = ignore;
	const session: PiSession = {
		prompt: ignore,
		answerDialog: ignore,
		openDialogs: () => [],
		listCommands: () => [],
		permissionModeState: () => ({ mode: "default", available: [] }),
		subscribe: () => ignore,
		abort: () => {
			record.aborts += 1;
			return new Promise<void>((resolve) => {
				finishAbort = resolve;
			});
		},
		dispose: () => {
			record.disposed += 1;
		},
	};
	const hosted: HostedSession = {
		session,
		loadedExtensionPaths: [],
		inspect: () => ({ sessionId: "s", cwd: "/", sessionDir: "/s", sessionFile: null, entries: [], commands: [] }),
		emittedEvents: () => [],
	};
	return { hosted, record, finishAbort: () => finishAbort() };
}

function fakeHost() {
	const built: ReturnType<typeof fakeHosted>[] = [];
	const problems: unknown[] = [];
	const threads = createThreadSessions({
		createSession: () => {
			const next = fakeHosted();
			built.push(next);
			return Promise.resolve(next.hosted);
		},
		onProblem: (problem) => problems.push(problem),
		idleTimeoutMs: 20,
	});
	return { threads, built, problems };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the same thread acquired twice gets ONE session; two threads get two", async () => {
	const { threads, built } = fakeHost();
	const first = await threads.acquire("t1");
	const again = await threads.acquire("t1");
	expect(again.session).toBe(first.session);
	expect(built).toHaveLength(1);
	await threads.acquire("t2");
	expect(built).toHaveLength(2);
	expect(threads.liveThreadCount()).toBe(2);
});

test("two concurrent first requests on one thread share one build", async () => {
	const { threads, built } = fakeHost();
	const [first, second] = await Promise.all([threads.acquire("t1"), threads.acquire("t1")]);
	expect(second.session).toBe(first.session);
	expect(built).toHaveLength(1);
});

test("release starts the idle clock; the session is disposed after the window, and a later acquire rebuilds", async () => {
	const { threads, built } = fakeHost();
	const lease = await threads.acquire("t1");
	lease.release();
	await sleep(5);
	expect(built[0]?.record.disposed).toBe(0);
	await sleep(30);
	expect(built[0]?.record.disposed).toBe(1);
	expect(threads.liveThreadCount()).toBe(0);
	// The next acquire on that thread builds a fresh session.
	await threads.acquire("t1");
	expect(built).toHaveLength(2);
});

test("acquire within the idle window cancels the disposal — #43's fix in one assertion", async () => {
	const { threads, built } = fakeHost();
	const first = await threads.acquire("t1");
	first.release();
	await sleep(10);
	const second = await threads.acquire("t1");
	await sleep(30);
	expect(second.session).toBe(first.session);
	expect(built[0]?.record.disposed).toBe(0);
	expect(built).toHaveLength(1);
});

test("stop aborts the run and never disposes; the next acquire waits for the abort to finish", async () => {
	const { threads, built } = fakeHost();
	const lease = await threads.acquire("t1");
	lease.stop();
	const hosted = built[0];
	if (hosted === undefined) throw new Error("no session built");
	expect(hosted.record.aborts).toBe(1);
	expect(hosted.record.disposed).toBe(0);

	let acquired = false;
	const pending = threads.acquire("t1").then(() => {
		acquired = true;
	});
	await sleep(5);
	expect(acquired).toBe(false);
	hosted.finishAbort();
	await pending;
	expect(acquired).toBe(true);
});

// ── the lease fence (#109) ─────────────────────────────────────────────────────
// The displaced-park case: run A parks a dialog, run B takes the same thread, A's dialog
// is evicted, and A's stop lands ten minutes later. Addressed by thread id, it aborted B.

test("⚠ a lease superseded by a later acquire is stale: its stop and release touch nothing, and say so", async () => {
	const { threads, built, problems } = fakeHost();
	const first = await threads.acquire("t1");
	const second = await threads.acquire("t1");
	expect(second.generation).toBe(first.generation + 1);

	first.stop();
	first.release();
	expect(built[0]?.record.aborts).toBe(0);
	expect(threads.peek("t1")?.busy).toBe(true);
	expect(problems.map(String)).toEqual([
		expect.stringContaining(`stop from run ${first.generation} ignored — run ${second.generation} holds it now`),
		expect.stringContaining(`release from run ${first.generation} ignored`),
	]);

	// The current lease still works.
	second.stop();
	expect(built[0]?.record.aborts).toBe(1);
});

test("⚠ a lease from before a rebuild is stale, and the rebuilt thread continues the count", async () => {
	const { threads, built, problems } = fakeHost();
	const before = await threads.acquire("t1");
	before.release();
	await sleep(30); // idle window: disposed
	expect(threads.liveThreadCount()).toBe(0);
	before.stop();
	expect(problems.map(String)).toEqual([expect.stringContaining("the thread was disposed")]);

	const after = await threads.acquire("t1");
	expect(after.generation).toBe(before.generation + 1);
	expect(built).toHaveLength(2);
	expect(threads.peek("t1")?.generation).toBe(after.generation);
});

test("a failed build leaves no entry, so the next request retries", async () => {
	let attempts = 0;
	const threads = createThreadSessions({
		createSession: () => {
			attempts += 1;
			if (attempts === 1) return Promise.reject(new Error("loader exploded"));
			return Promise.resolve(fakeHosted().hosted);
		},
		onProblem: undefined,
		idleTimeoutMs: 20,
	});
	await expect(threads.acquire("t1")).rejects.toThrow("loader exploded");
	expect(threads.liveThreadCount()).toBe(0);
	await threads.acquire("t1");
	expect(attempts).toBe(2);
	expect(threads.liveThreadCount()).toBe(1);
});

test("shutdown disposes every live session and clears pending idle timers", async () => {
	const { threads, built } = fakeHost();
	const t1 = await threads.acquire("t1");
	await threads.acquire("t2");
	t1.release();
	threads.shutdown();
	expect(built.map((hosted) => hosted.record.disposed)).toEqual([1, 1]);
	expect(threads.liveThreadCount()).toBe(0);
	await sleep(30);
	// The idle timer for t1 must not fire a second dispose.
	expect(built[0]?.record.disposed).toBe(1);
});

test("⚠ a build in flight at shutdown is disposed on arrival, never published; a later acquire is refused", async () => {
	let finishBuild: () => void = ignore;
	const hosted = fakeHosted();
	const threads = createThreadSessions({
		createSession: () =>
			new Promise<HostedSession>((resolve) => {
				finishBuild = () => resolve(hosted.hosted);
			}),
		onProblem: undefined,
		idleTimeoutMs: 20,
	});
	const pending = threads.acquire("t1");
	await sleep(1);
	threads.shutdown();
	finishBuild();
	await expect(pending).rejects.toThrow("shut down while its session was being built");
	expect(hosted.record.disposed).toBe(1);
	expect(threads.liveThreadCount()).toBe(0);
	await expect(threads.acquire("t2")).rejects.toThrow("has shut down");
});

test("a dispose that throws is reported, not thrown", async () => {
	const problems: unknown[] = [];
	const broken = fakeHosted();
	broken.hosted.session.dispose = () => {
		throw new Error("already gone");
	};
	const threads = createThreadSessions({
		createSession: () => Promise.resolve(broken.hosted),
		onProblem: (problem) => problems.push(problem),
		idleTimeoutMs: 20,
	});
	await threads.acquire("t1");
	threads.shutdown();
	expect(problems).toHaveLength(1);
	expect(String(problems[0])).toContain("already gone");
});
