import { expect, test } from "bun:test";
import type { PiSession } from "@zen/core";
import type { HostedSession } from "../../host/agent-host.ts";
import { DIALOG_ANSWER_TIMEOUT_MS, EVICTION_GRACE_MS } from "../dialog-registry.ts";
import { createThreadSessions, THREAD_IDLE_TIMEOUT_MS } from "../thread-sessions.ts";

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
		listCommands: () => [],
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
	const hosted: HostedSession = { session, loadedExtensionPaths: [] };
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
	expect(again).toBe(first);
	expect(built).toHaveLength(1);
	await threads.acquire("t2");
	expect(built).toHaveLength(2);
	expect(threads.liveThreadCount()).toBe(2);
});

test("two concurrent first requests on one thread share one build", async () => {
	const { threads, built } = fakeHost();
	const [first, second] = await Promise.all([threads.acquire("t1"), threads.acquire("t1")]);
	expect(second).toBe(first);
	expect(built).toHaveLength(1);
});

test("release starts the idle clock; the session is disposed after the window, not before", async () => {
	const { threads, built } = fakeHost();
	await threads.acquire("t1");
	threads.release("t1");
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
	threads.release("t1");
	await sleep(10);
	const second = await threads.acquire("t1");
	await sleep(30);
	expect(second).toBe(first);
	expect(built[0]?.record.disposed).toBe(0);
	expect(built).toHaveLength(1);
});

test("stop aborts the run and never disposes; the next acquire waits for the abort to finish", async () => {
	const { threads, built } = fakeHost();
	await threads.acquire("t1");
	threads.stop("t1");
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

test("stop and release on an unknown thread are no-ops", () => {
	const { threads, problems } = fakeHost();
	threads.stop("nobody");
	threads.release("nobody");
	expect(problems).toHaveLength(0);
	expect(threads.liveThreadCount()).toBe(0);
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
	await threads.acquire("t1");
	await threads.acquire("t2");
	threads.release("t1");
	threads.shutdown();
	expect(built.map((hosted) => hosted.record.disposed)).toEqual([1, 1]);
	expect(threads.liveThreadCount()).toBe(0);
	await sleep(30);
	// The idle timer for t1 must not fire a second dispose.
	expect(built[0]?.record.disposed).toBe(1);
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

test("⚠ the idle window outlasts a parked dialog's TTL plus its eviction grace — `release` during a park cannot dispose it", () => {
	// See the comment on `release`: two paths release a thread while a dialog is still
	// parked. Eviction re-releases after TTL + grace, so the idle timer armed by the early
	// release must not be able to fire first. The two constants live in different modules.
	expect(THREAD_IDLE_TIMEOUT_MS).toBeGreaterThan(DIALOG_ANSWER_TIMEOUT_MS + EVICTION_GRACE_MS);
});
