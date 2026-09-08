/**
 * One pi session per chat THREAD, held across runs (#69 PR 2 — closes #43).
 *
 * Before this module the server created a session per HTTP run and disposed it in the
 * handler's `finally`. picc keys its permission mode to the session, so `/mode` answered
 * on prompt 1 was gone by prompt 2 (#43), the read-before-write tracker never saw a read
 * from an earlier prompt, and every prompt paid a fresh extension load. Here a thread's
 * session survives the run and is disposed only after `idleTimeoutMs` with no run, or at
 * server shutdown.
 *
 * ⚠ RUN vs SESSION LIFETIME. `stop` ABORTS the run in flight; it never disposes. `release`
 * arms the idle timer; `acquire` cancels it. Disposal is therefore only ever reached with
 * no run in flight, which is what makes the host's dispose ordering (unsubscribe, then
 * `session.dispose()`) safe: there is no `agent_settled` left to swallow.
 *
 * ⚠ THE DISCONNECT-THEN-PROMPT RACE. A tab closes mid-run → the response 'close' calls
 * `stop` → pi's `abort()` resolves only when the agent is idle again (agent-session.js
 * `abort` → `waitForIdle`). If the user reopens and prompts before that, pi's `prompt()`
 * would refuse ("Agent is already processing"). So `stop` stores the in-flight abort and
 * `acquire` awaits it first — the new run starts against an idle session.
 *
 * ⓘ Named non-coverage: the map is unbounded, and a client that omits `threadId` gets a
 * fresh session per request that lives for the idle window. Loopback-only, dev-only server.
 */
import type { PiSession } from "@zen/core";
import type { HostedSession } from "../host/agent-host.ts";

/**
 * How long a thread's session outlives its last run. Long enough for a human to read a
 * reply and type the next prompt without losing mode or read-tracker state; short enough
 * that an abandoned tab does not hold extension instances for the rest of the day.
 */
export const THREAD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ThreadSessionsOptions {
	/** Builds a hosted session — `AgentHost.createSession`. Injected so tests need no pi. */
	createSession: () => Promise<HostedSession>;
	onProblem: ((problem: unknown) => void) | undefined;
	/** Injectable for tests — the default is minutes. */
	idleTimeoutMs?: number;
}

export interface ThreadSessions {
	/**
	 * The thread's session, created on first use. Cancels a pending idle disposal and waits
	 * for an in-flight abort so the caller always receives an idle session.
	 *
	 * ⚠ A `createSession` failure is thrown to the caller and leaves NO entry behind, so the
	 * next request on that thread retries the build instead of finding a poisoned slot.
	 */
	acquire(threadId: string): Promise<PiSession>;
	/** The run is over and nothing is parked: start the idle clock. No-op for an unknown thread. */
	release(threadId: string): void;
	/** Abort the thread's run in flight (client gone, dialog evicted). Never disposes. */
	stop(threadId: string): void;
	/**
	 * The thread's hosted session IF it is live — never creates one (#86). Looking must
	 * not be the thing that spins pi up; `acquire` is for runs.
	 */
	peek(threadId: string): ThreadView | undefined;
	/** Every live thread, for the inspection listing. Never creates. */
	list(): ThreadView[];
	/** Dispose every session — server shutdown. */
	shutdown(): void;
	/** Observable state for tests. */
	liveThreadCount(): number;
}

/** A live thread as inspection sees it: the session, and whether a run holds it. */
export interface ThreadView {
	readonly threadId: string;
	readonly hosted: HostedSession;
	/** Acquired and not yet released — a run in flight, or a dialog parked on it. */
	readonly busy: boolean;
	/** The last `acquire` or `release`, epoch milliseconds. */
	readonly lastActivityAt: number;
}

interface ThreadEntry {
	hosted: HostedSession;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The abort currently running, awaited by the next `acquire`. */
	abortInFlight: Promise<void> | undefined;
	/** Set by `acquire`, cleared by `release` — so a parked thread reads busy until its resume releases. */
	busy: boolean;
	lastActivityAt: number;
}

function viewOf(threadId: string, thread: ThreadEntry): ThreadView {
	return { threadId, hosted: thread.hosted, busy: thread.busy, lastActivityAt: thread.lastActivityAt };
}

export function createThreadSessions(options: ThreadSessionsOptions): ThreadSessions {
	const { createSession, onProblem } = options;
	const idleTimeoutMs = options.idleTimeoutMs ?? THREAD_IDLE_TIMEOUT_MS;

	const threads = new Map<string, ThreadEntry>();
	/** Builds in progress, so two concurrent first requests on one thread share one session. */
	const building = new Map<string, Promise<ThreadEntry>>();

	function disposeThread(threadId: string, why: string): void {
		const thread = threads.get(threadId);
		if (thread === undefined) return;
		threads.delete(threadId);
		if (thread.idleTimer !== undefined) clearTimeout(thread.idleTimer);
		try {
			thread.hosted.session.dispose();
		} catch (error) {
			onProblem?.(`thread ${threadId}: dispose after ${why} failed: ${String(error)}`);
		}
	}

	async function buildThread(threadId: string): Promise<ThreadEntry> {
		const hosted = await createSession();
		const thread: ThreadEntry = {
			hosted,
			idleTimer: undefined,
			abortInFlight: undefined,
			busy: false,
			lastActivityAt: Date.now(),
		};
		threads.set(threadId, thread);
		return thread;
	}

	return {
		async acquire(threadId: string): Promise<PiSession> {
			let thread = threads.get(threadId);
			if (thread === undefined) {
				let build = building.get(threadId);
				if (build === undefined) {
					build = buildThread(threadId).finally(() => building.delete(threadId));
					building.set(threadId, build);
				}
				thread = await build;
			}
			if (thread.idleTimer !== undefined) {
				clearTimeout(thread.idleTimer);
				thread.idleTimer = undefined;
			}
			if (thread.abortInFlight !== undefined) {
				await thread.abortInFlight;
			}
			thread.busy = true;
			thread.lastActivityAt = Date.now();
			return thread.hosted.session;
		},
		release(threadId: string): void {
			// ⚠ This can be reached while a dialog is still PARKED on the thread: a resume that
			// fails validation releases in the handler's `finally` with the question still open,
			// and a displaced park's delayed `stopPi` releases while the newer park is live. It
			// is harmless only because the dialog TTL plus its grace is shorter than the idle
			// window, so eviction always releases again before the timer can dispose a parked
			// session. `thread-sessions.test.ts` pins that ordering of the two constants.
			const thread = threads.get(threadId);
			if (thread === undefined) return;
			if (thread.idleTimer !== undefined) clearTimeout(thread.idleTimer);
			const idleTimer = setTimeout(() => disposeThread(threadId, `${idleTimeoutMs}ms idle`), idleTimeoutMs);
			// A pending disposal must never hold the process open on shutdown.
			idleTimer.unref?.();
			thread.idleTimer = idleTimer;
			thread.busy = false;
			thread.lastActivityAt = Date.now();
		},
		stop(threadId: string): void {
			const thread = threads.get(threadId);
			if (thread === undefined) return;
			const abort = thread.hosted.session
				.abort()
				.catch((error: unknown) => onProblem?.(`thread ${threadId}: abort failed: ${String(error)}`))
				.finally(() => {
					// Only clear our own promise — a later stop may have replaced it.
					if (thread.abortInFlight === abort) thread.abortInFlight = undefined;
				});
			thread.abortInFlight = abort;
		},
		peek(threadId: string): ThreadView | undefined {
			const thread = threads.get(threadId);
			return thread === undefined ? undefined : viewOf(threadId, thread);
		},
		list(): ThreadView[] {
			return [...threads.entries()].map(([threadId, thread]) => viewOf(threadId, thread));
		},
		shutdown(): void {
			for (const threadId of [...threads.keys()]) disposeThread(threadId, "server shutdown");
		},
		liveThreadCount(): number {
			return threads.size;
		},
	};
}
