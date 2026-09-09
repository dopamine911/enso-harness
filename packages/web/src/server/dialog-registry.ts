import type { PiEventDelivery, PiRpcEvent, PiSession, ZenDialogSpec } from "@zen/core";

/**
 * Parked pi sessions, waiting for a human to answer a dialog (#27).
 *
 * WHY PARKING EXISTS AT ALL
 * A blocking dialog crosses to the browser as an AG-UI interrupt, and TanStack treats a
 * `RUN_FINISHED` with an interrupt outcome as TERMINAL — the answer arrives as a NEW POST
 * carrying `resume` + `parentRunId`, never on the open stream (verified against the real
 * `ChatClient`, `.local/interrupt-probe/`). So the pi session — alive, its extension blocked
 * on a promise our UI context holds — must outlive the HTTP request that surfaced its
 * question. This registry is that lifetime, and nothing more.
 *
 * ⚠ NOT THE SESSION'S LIFETIME. An entry exists ONLY while a dialog awaits its answer.
 * The session itself lives for the whole chat thread (`thread-sessions.ts`, #69 PR 2) and
 * is disposed there after an idle window — this registry only keeps a thread from going
 * idle while a question is open, and aborts the run (never the session) when the question
 * times out.
 *
 * ⚠ SECURITY: a resume request's `threadId` resolves to a live pi with unconfined bash
 * (#9). That is the same shape as accepting `cwd` from the request body, which this
 * server refuses. It is tolerable only because the server binds loopback — do not expose
 * the port without revisiting this.
 */

/**
 * The live pumping state runChat built around a pi session, handed over whole so the
 * resume request can continue draining exactly where the interrupted run stopped.
 *
 * ⚠ The event subscription stays attached while parked — pi may still emit fire-and-forget
 * events (status heartbeats), and they accumulate in `pending` for the continuation to
 * drain. `notify` is whichever live stream loop is currently attached, or undefined while
 * parked; `wake()` on a parked pump is a deliberate no-op.
 */
/** One queued event with how the host delivered it — the mapper turns the delivery into `origin` (#96). */
export interface PendingPiEvent {
	readonly event: PiRpcEvent;
	readonly delivery: PiEventDelivery;
}

export interface PiSessionPump {
	readonly pending: PendingPiEvent[];
	settled: boolean;
	/** A rejected prompt acknowledgement, surfaced by whichever loop drains next. */
	promptError: string | undefined;
	/**
	 * The prompt acknowledgement arrived with `success: true`.
	 *
	 * ⚠ For an ordinary prompt this means ACCEPTED (pi acks at preflight and the agent run
	 * follows). For an extension command it means COMPLETED — pi runs the command inside
	 * prompt handling and acks only when it finishes, which is why `/mode`'s unanswered
	 * dialog blocked the ack (pi `rpc-mode.js` case "prompt": the response is emitted from
	 * `preflightResult`). The streaming loop leans on that difference to end
	 * extension-command runs promptly instead of at the 90s guard.
	 */
	promptAcknowledged: boolean;
	/**
	 * Epoch ms of the last `tool_execution_start` / `tool_execution_update` this pump received
	 * — 0 until one has (#99). Recorded on ARRIVAL, by the pump, because the streaming loop
	 * cannot see it: an update maps to a partial tool-result that `to-agui.ts` drops (AG-UI
	 * has no progress event), so a long tool call streamed output and produced no chunk, and
	 * the no-progress guard, unable to tell a working tool from a hung run, ended the run at
	 * the cutoff mid-search (web_search, #98). The guard reads this as progress.
	 */
	lastToolActivityAt: number;
	notify: (() => void) | undefined;
	wake(): void;
	readonly session: PiSession;
	/**
	 * Detach this pump's event subscription from the session. Called by the streaming loop
	 * when a run ends NOT parked (#69 PR 2): the session now outlives the run, so a pump
	 * left subscribed would keep filling `pending` forever and double-deliver every event
	 * to the next run's pump. A PARKED pump keeps its subscription until its resume ends.
	 */
	readonly unsubscribe: () => void;
}

export interface ParkedDialog {
	pump: PiSessionPump;
	/**
	 * Aborts the thread's run in flight and lets the thread go idle. Handed over by the run
	 * that created it. ⓘ Since #69 PR 2 this never disposes the session — the thread keeps
	 * it for the next prompt.
	 */
	stopPi: () => void;
	/** pi's dialog request id — the interrupt id, and the id the response must carry. */
	dialogId: string;
	dialog: ZenDialogSpec;
	/**
	 * The run that was interrupted. A resume must name it as `parentRunId` — a stale or
	 * replayed resume naming an older run is refused rather than answering the wrong
	 * question.
	 */
	interruptedRunId: string;
	/**
	 * The interrupted prompt was a slash command. Carried so the CONTINUATION inherits the
	 * quick-close rule: an extension command's completion signal is its prompt
	 * acknowledgement, not `agent_settled` (which it never emits).
	 */
	isExtensionCommand: boolean;
	threadId: string;
	/** Epoch ms. Stamped on the interrupt as `expiresAt` so the UI can stop offering it. */
	expiresAt: number;
}

export interface DialogRegistry {
	readonly answerTimeoutMs: number;
	/**
	 * Park a session awaiting an answer. ⚠ Re-parking a thread that already holds an entry
	 * evicts the old one first (declined + stopped): one thread, one live question.
	 */
	park(entry: ParkedDialog): void;
	/** Read without removing — validation happens against a peek, so a bad resume request cannot destroy the parked question. */
	peek(threadId: string): ParkedDialog | undefined;
	/** Remove and return. The caller now owns the session. */
	take(threadId: string): ParkedDialog | undefined;
	/** Evict everything — server shutdown. */
	shutdown(): void;
}

/**
 * How long an unanswered question holds its session before being declined.
 *
 * A human answering is a pause measured in minutes, not a stream timeout — but an
 * abandoned tab must not hold a live pi forever. Eviction IS the pre-#27 behaviour
 * (decline on the wire), applied late instead of immediately.
 */
export const DIALOG_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * After declining, the session gets this long to run the extension's cleanup path and
 * settle before it is stopped regardless. The answer is what lets the extension finish
 * honestly (a declined `select` resolves `undefined`); the stop is what guarantees the
 * session does not outlive the registry's promise to have dealt with it.
 */
export const EVICTION_GRACE_MS = 5000;

export interface DialogRegistryOptions {
	onProblem: ((problem: unknown) => void) | undefined;
	/** Injectable for tests — the defaults are minutes, and a guard nobody can afford to test is a guard nobody tests. */
	answerTimeoutMs?: number;
	evictionGraceMs?: number;
}

export function createDialogRegistry(options: DialogRegistryOptions): DialogRegistry {
	const { onProblem } = options;
	const answerTimeoutMs = options.answerTimeoutMs ?? DIALOG_ANSWER_TIMEOUT_MS;
	const evictionGraceMs = options.evictionGraceMs ?? EVICTION_GRACE_MS;

	const parked = new Map<string, { entry: ParkedDialog; expiry: ReturnType<typeof setTimeout> }>();

	function decline(entry: ParkedDialog, why: string): void {
		onProblem?.(
			`dialog '${entry.dialog.title}' (${entry.dialog.method}, thread ${entry.threadId}) ${why} — ` +
				`declined and the run will be aborted`,
		);
		try {
			// pi's cancellation form: the extension receives `undefined` / `false` and the
			// command completes as a no-op — the pre-#27 behaviour, applied at eviction.
			entry.pump.session.answerDialog({ id: entry.dialogId, cancelled: true });
		} catch (error) {
			onProblem?.(error);
		}
		// Grace, then stop unconditionally. `unref` (where available) so a pending stop
		// never holds the process open on shutdown.
		const graceTimer = setTimeout(() => {
			try {
				entry.stopPi();
			} catch (error) {
				onProblem?.(error);
			}
		}, evictionGraceMs);
		graceTimer.unref?.();
	}

	function evict(threadId: string, why: string): void {
		const held = parked.get(threadId);
		if (held === undefined) return;
		parked.delete(threadId);
		clearTimeout(held.expiry);
		decline(held.entry, why);
		// No resume is coming for this pump, and the session outlives it (#69 PR 2): release
		// the subscription here or it sits in the host's listener set for the rest of the
		// thread's life, collecting every later run's events into a `pending` nobody drains.
		held.entry.pump.unsubscribe();
	}

	return {
		answerTimeoutMs,
		park(entry: ParkedDialog): void {
			evict(entry.threadId, "was displaced by a newer question on the same thread");
			const expiry = setTimeout(
				() => evict(entry.threadId, `went unanswered for ${answerTimeoutMs}ms`),
				answerTimeoutMs,
			);
			expiry.unref?.();
			parked.set(entry.threadId, { entry, expiry });
		},
		peek(threadId: string): ParkedDialog | undefined {
			return parked.get(threadId)?.entry;
		},
		take(threadId: string): ParkedDialog | undefined {
			const held = parked.get(threadId);
			if (held === undefined) return undefined;
			parked.delete(threadId);
			clearTimeout(held.expiry);
			return held.entry;
		},
		shutdown(): void {
			for (const threadId of [...parked.keys()]) {
				evict(threadId, "was still open at server shutdown");
			}
		},
	};
}
