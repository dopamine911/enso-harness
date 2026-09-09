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
import type { PiSession, ZenObservation } from "@zen/core";
import type { HostedSession } from "../host/agent-host.ts";
import { createEventTail, type EventTail } from "../host/event-tail.ts";
import { mapPiEvent } from "../rpc/map-events.ts";

/**
 * One frame of a thread's feed (SPIKE #109 — the `follow` half of deepseek-harness's
 * prompt/follow split). An `observation` is a pi event through the mapper with the feed's
 * own monotonic `seq`; a `status` is the thread's lifecycle as this registry sees it —
 * built, taken by a run, released, disposed. The feed exists whether or not a run does:
 * that independence is the whole experiment.
 */
export type ThreadFeedFrame =
	| { readonly kind: "observation"; readonly seq: number; readonly observation: ZenObservation }
	| { readonly kind: "status"; readonly live: boolean; readonly busy: boolean; readonly generation: number };

export type ThreadFeedListener = (frame: ThreadFeedFrame) => void;

/** A thread's observers and their attachment to whichever session the thread currently has. */
interface ThreadFeed {
	readonly listeners: Set<ThreadFeedListener>;
	seq: number;
	/** The session subscription while the thread is live; undefined while it is not. */
	detach: (() => void) | undefined;
	/**
	 * Frames raised by a listener DURING a publish (a `settled` observation releasing the
	 * thread, which publishes a status). Delivered after the current frame reaches every
	 * listener, so no follower sees the consequence before its cause.
	 */
	readonly queued: ThreadFeedFrame[];
	publishing: boolean;
}

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
	 * Follow the thread's feed (SPIKE #109): every observation and status change from now
	 * on, whether or not a run is in flight, whether or not the thread is even built yet.
	 * Observation only — never creates a session. `asOfSeq` is the feed's position at
	 * subscription: a snapshot taken in the same tick is exact as of it, and every
	 * observation delivered afterwards carries a greater `seq`.
	 */
	observe(threadId: string, listener: ThreadFeedListener): ThreadFollow;
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

/** A live follow: where the feed stood when it began, and how to leave. */
export interface ThreadFollow {
	readonly asOfSeq: number;
	readonly unsubscribe: () => void;
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
	 * ⓘ Never pruned — one integer per thread id this server has ever run, the same named
	 * non-coverage as the thread map itself (header): loopback, dev-only, ids minted by the
	 * page. Pruning would reopen the rebuild case for a thread that comes back after it.
	 */
	const generations = new Map<string, number>();

	/**
	 * Feeds by thread id, independent of the entry: a follower may arrive before the thread
	 * is built and stays through a rebuild. Deleted when its last listener leaves.
	 */
	const feeds = new Map<string, ThreadFeed>();

	function publish(feed: ThreadFeed, frame: ThreadFeedFrame): void {
		feed.queued.push(frame);
		if (feed.publishing) return;
		feed.publishing = true;
		try {
			for (let next = feed.queued.shift(); next !== undefined; next = feed.queued.shift()) {
				for (const listener of feed.listeners) {
					try {
						listener(next);
					} catch (error) {
						// One bad follower never breaks the feed for the others, nor the session.
						onProblem?.(`thread feed: a listener threw: ${String(error)}`);
					}
				}
			}
		} finally {
			feed.publishing = false;
		}
	}

	function publishStatus(threadId: string, thread: ThreadEntry | undefined): void {
		const feed = feeds.get(threadId);
		if (feed === undefined) return;
		publish(feed, {
			kind: "status",
			live: thread !== undefined,
			busy: thread?.busy ?? false,
			generation: thread?.generation ?? generations.get(threadId) ?? 0,
		});
	}

	/**
	 * Subscribe the feed to the thread's session. ⚠ This makes the feed the session's FIRST
	 * subscriber when a follower is present at build, so the host's start-up replay
	 * (#96) lands here, not in a later `/api/chat` pump — the spike's receipt records it.
	 */
	function attachFeed(threadId: string, thread: ThreadEntry): void {
		const feed = feeds.get(threadId);
		if (feed === undefined || feed.detach !== undefined) return;
		feed.detach = thread.hosted.session.subscribe((event, delivery) => {
			feed.seq += 1;
			publish(feed, { kind: "observation", seq: feed.seq, observation: mapPiEvent(event, delivery) });
		});
	}

	function detachFeed(threadId: string): void {
		const feed = feeds.get(threadId);
		if (feed?.detach === undefined) return;
		feed.detach();
		feed.detach = undefined;
	}

	function disposeThread(threadId: string, why: string): void {
		const thread = threads.get(threadId);
		if (thread === undefined) return;
		threads.delete(threadId);
		clearTimeout(thread.idleTimer);
		// Listeners first, then the kill — a late event from the disposing session must not
		// reach a follower as if the thread were alive.
		detachFeed(threadId);
		try {
			thread.hosted.session.dispose();
		} catch (error) {
			onProblem?.(`thread ${threadId}: dispose after ${why} failed: ${String(error)}`);
		}
		publishStatus(threadId, undefined);
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
		attachFeed(threadId, thread);
		publishStatus(threadId, thread);
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
		publishStatus(threadId, thread);
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
			publishStatus(threadId, thread);
			return leaseOf(threadId, thread);
		},
		observe(threadId: string, listener: ThreadFeedListener): ThreadFollow {
			let feed = feeds.get(threadId);
			if (feed === undefined) {
				feed = { listeners: new Set(), seq: 0, detach: undefined, queued: [], publishing: false };
				feeds.set(threadId, feed);
			}
			feed.listeners.add(listener);
			const thread = threads.get(threadId);
			if (thread !== undefined) attachFeed(threadId, thread);
			const attached = feed;
			return {
				asOfSeq: attached.seq,
				unsubscribe: () => {
					attached.listeners.delete(listener);
					if (attached.listeners.size > 0) return;
					// The last follower leaves: detach from the session so the next run's pump
					// is the first subscriber again, and forget the feed (its `seq` restarts
					// with the next follower — a new generation, snapshot-first).
					detachFeed(threadId);
					feeds.delete(threadId);
				},
			};
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
