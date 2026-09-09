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
import { createEventTail, type EventTail } from "../host/event-tail.ts";

/**
 * How long a thread's session outlives its last run. Long enough for a human to read a
 * reply and type the next prompt without losing mode or read-tracker state; short enough
 * that an abandoned tab does not hold extension instances for the rest of the day.
 */
export const THREAD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ThreadSessionsOptions {
	/** Builds a hosted session for a thread — `AgentHost.createSession`. Injected so tests need no pi. */
	createSession: (threadId: string) => Promise<HostedSession>;
	onProblem: ((problem: unknown) => void) | undefined;
	/** Injectable for tests — the default is minutes. */
	idleTimeoutMs?: number;
}

export interface ThreadSessions {
	/**
	 * Take the thread for a run: the session, created on first use, held through a lease.
	 * Cancels a pending idle disposal and waits for an in-flight abort so the run always
	 * starts against an idle session.
	 *
	 * ⚠ A `createSession` failure is thrown to the caller and leaves NO entry behind, so the
	 * next request on that thread retries the build instead of finding a poisoned slot.
	 */
	acquire(threadId: string): Promise<ThreadLease>;
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

/**
 * One run's hold on a thread (#109, deepseek-harness's `openGeneration` on the server).
 *
 * ⚠ WHY A LEASE AND NOT `release(threadId)`. A thread is held by exactly one run at a
 * time, but handles to it outlive runs: a parked dialog carries its run's stop for the
 * eviction that may come ten minutes later, and by then a NEWER run may hold the same
 * thread. Addressed by id, that late stop aborted and released whatever was running — the
 * displaced-park case `release` used to document as "harmless only because of timing".
 * A lease is bound to the acquisition it came from; once a later `acquire` or a disposal
 * has moved the thread on, its `release` and `stop` are inert and say so.
 */
export interface ThreadLease {
	readonly threadId: string;
	readonly session: PiSession;
	/**
	 * Which acquisition this is, counted per thread id for the server's lifetime — the fence
	 * a stale lease is checked against, and the number the browser's `zen.run` receipt
	 * carries so the two can be compared (`ZenThreadInspection.generation`).
	 */
	readonly generation: number;
	/** The run is over and nothing is parked: start the idle clock. Stale: a reported no-op. */
	release(): void;
	/** Abort the run in flight (client gone, dialog evicted). Never disposes. Stale: a reported no-op. */
	stop(): void;
}

/** A live thread as inspection sees it: the session, and whether a run holds it. */
export interface ThreadView {
	readonly threadId: string;
	readonly hosted: HostedSession;
	/** Acquired and not yet released — a run in flight, or a dialog parked on it. */
	readonly busy: boolean;
	/** The latest acquisition's number — see {@link ThreadLease.generation}. */
	readonly generation: number;
	/** The last `acquire` or `release`, epoch milliseconds. */
	readonly lastActivityAt: number;
	/**
	 * The sent tail (#97): every AG-UI chunk the server wrote to this thread's browser, in
	 * the wire's order. The SAME instance as the entry's, so the chat handler records into
	 * it through a `peek` — the one server-owned record, beside the host's emitted tail.
	 */
	readonly sent: EventTail;
}

interface ThreadEntry {
	hosted: HostedSession;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The abort currently running, awaited by the next `acquire`. */
	abortInFlight: Promise<void> | undefined;
	/** Set by `acquire`, cleared by `release` — so a parked thread reads busy until its resume releases. */
	busy: boolean;
	/** The latest acquisition's number; a lease from an earlier one is stale. */
	generation: number;
	lastActivityAt: number;
	sent: EventTail;
}

function viewOf(threadId: string, thread: ThreadEntry): ThreadView {
	return {
		threadId,
		hosted: thread.hosted,
		busy: thread.busy,
		generation: thread.generation,
		lastActivityAt: thread.lastActivityAt,
		sent: thread.sent,
	};
}

export function createThreadSessions(options: ThreadSessionsOptions): ThreadSessions {
	const { createSession, onProblem } = options;
	const idleTimeoutMs = options.idleTimeoutMs ?? THREAD_IDLE_TIMEOUT_MS;

	const threads = new Map<string, ThreadEntry>();
	/** Builds in progress, so two concurrent first requests on one thread share one session. */
	const building = new Map<string, Promise<ThreadEntry>>();
	/**
	 * Per thread id, surviving disposal: a thread rebuilt after its idle window continues
	 * the count, so a lease from before the rebuild can never match the new entry by number.
	 */
	const generations = new Map<string, number>();

	function disposeThread(threadId: string, why: string): void {
		const thread = threads.get(threadId);
		if (thread === undefined) return;
		threads.delete(threadId);
		clearTimeout(thread.idleTimer);
		try {
			thread.hosted.session.dispose();
		} catch (error) {
			onProblem?.(`thread ${threadId}: dispose after ${why} failed: ${String(error)}`);
		}
	}

	/** Set by `shutdown`: no build may publish a session into a registry that is being torn down. */
	let shutDown = false;

	async function buildThread(threadId: string): Promise<ThreadEntry> {
		const hosted = await createSession(threadId);
		if (shutDown) {
			// ⚠ Teardown must reach quiescence, not just request it: a build that was in
			// flight when `shutdown` ran would otherwise publish a live pi AFTER every other
			// session was disposed — a leak nothing would ever dispose.
			hosted.session.dispose();
			throw new Error(`thread ${threadId}: the server shut down while its session was being built`);
		}
		const thread: ThreadEntry = {
			hosted,
			idleTimer: undefined,
			abortInFlight: undefined,
			busy: false,
			generation: generations.get(threadId) ?? 0,
			lastActivityAt: Date.now(),
			sent: createEventTail(),
		};
		threads.set(threadId, thread);
		return thread;
	}

	function release(threadId: string, thread: ThreadEntry): void {
		clearTimeout(thread.idleTimer);
		const idleTimer = setTimeout(() => disposeThread(threadId, `${idleTimeoutMs}ms idle`), idleTimeoutMs);
		// A pending disposal must never hold the process open on shutdown.
		idleTimer.unref?.();
		thread.idleTimer = idleTimer;
		thread.busy = false;
		thread.lastActivityAt = Date.now();
	}

	function stop(threadId: string, thread: ThreadEntry): void {
		const abort = thread.hosted.session
			.abort()
			.catch((error: unknown) => onProblem?.(`thread ${threadId}: abort failed: ${String(error)}`))
			.finally(() => {
				// Only clear our own promise — a later stop may have replaced it.
				if (thread.abortInFlight === abort) thread.abortInFlight = undefined;
			});
		thread.abortInFlight = abort;
	}

	function leaseOf(threadId: string, thread: ThreadEntry): ThreadLease {
		const generation = thread.generation;
		/** Current: the same entry, and no acquisition since. Stale is information, never a throw. */
		function current(operation: string): boolean {
			if (threads.get(threadId) === thread && thread.generation === generation) return true;
			onProblem?.(
				`thread ${threadId}: ${operation} from run ${generation} ignored — ` +
					(threads.get(threadId) === undefined ? "the thread was disposed" : `run ${thread.generation} holds it now`),
			);
			return false;
		}
		return {
			threadId,
			session: thread.hosted.session,
			generation,
			release: () => {
				if (current("release")) release(threadId, thread);
			},
			stop: () => {
				if (current("stop")) stop(threadId, thread);
			},
		};
	}

	return {
		async acquire(threadId: string): Promise<ThreadLease> {
			if (shutDown) throw new Error(`thread ${threadId}: the server has shut down`);
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
			thread.generation += 1;
			generations.set(threadId, thread.generation);
			thread.lastActivityAt = Date.now();
			return leaseOf(threadId, thread);
		},
		peek(threadId: string): ThreadView | undefined {
			const thread = threads.get(threadId);
			return thread === undefined ? undefined : viewOf(threadId, thread);
		},
		list(): ThreadView[] {
			return [...threads.entries()].map(([threadId, thread]) => viewOf(threadId, thread));
		},
		shutdown(): void {
			shutDown = true;
			for (const threadId of [...threads.keys()]) disposeThread(threadId, "server shutdown");
		},
		liveThreadCount(): number {
			return threads.size;
		},
	};
}
