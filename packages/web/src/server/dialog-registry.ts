import type { PiRpcEvent, PiTransport, ZenDialogSpec } from "@zen/core";

/**
 * Parked pi processes, waiting for a human to answer a dialog (#27).
 *
 * WHY PARKING EXISTS AT ALL
 * A blocking dialog crosses to the browser as an AG-UI interrupt, and TanStack treats a
 * `RUN_FINISHED` with an interrupt outcome as TERMINAL — the answer arrives as a NEW POST
 * carrying `resume` + `parentRunId`, never on the open stream (verified against the real
 * `ChatClient`, `.local/interrupt-probe/`). So the pi process — alive, blocked on stdin —
 * must outlive the HTTP request that surfaced its question. This registry is that
 * lifetime, and nothing more.
 *
 * ⚠ DELIBERATELY NOT SESSION REUSE. An entry exists ONLY while a dialog awaits its
 * answer; an ordinary run keeps the spawn-per-request lifecycle. Multi-turn reuse of one
 * pi process is real future work with its own lifecycle questions (eviction under memory
 * pressure, per-thread cwd, cross-tab races) and it must not ride in on this.
 *
 * ⚠ SECURITY: a resume request's `threadId` resolves to a live pi with unconfined bash
 * (#9). That is the same shape as accepting `cwd` from the request body, which this
 * server refuses. It is tolerable only because the server binds loopback — do not expose
 * the port without revisiting this.
 */

/**
 * The live pumping state runChat built around a pi process, handed over whole so the
 * resume request can continue draining exactly where the interrupted run stopped.
 *
 * ⚠ The event callback stays attached while parked — pi may still emit fire-and-forget
 * events (status heartbeats), and they accumulate in `pending` for the continuation to
 * drain. `notify` is whichever live stream loop is currently attached, or undefined while
 * parked; `wake()` on a parked pump is a deliberate no-op.
 */
export interface PiSessionPump {
	readonly pending: PiRpcEvent[];
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
	notify: (() => void) | undefined;
	wake(): void;
	readonly transport: PiTransport;
}

export interface ParkedDialog {
	pump: PiSessionPump;
	/** Stops the pi process. Handed over by the run that spawned it. */
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
	 * Park a process awaiting an answer. ⚠ Re-parking a thread that already holds an entry
	 * evicts the old one first (declined + stopped): one thread, one live question.
	 */
	park(entry: ParkedDialog): void;
	/** Read without removing — validation happens against a peek, so a bad resume request cannot destroy the parked question. */
	peek(threadId: string): ParkedDialog | undefined;
	/** Remove and return. The caller now owns the process. */
	take(threadId: string): ParkedDialog | undefined;
	/** Evict everything — server shutdown. */
	shutdown(): void;
}

/**
 * How long an unanswered question holds its process before being declined.
 *
 * A human answering is a pause measured in minutes, not a stream timeout — but an
 * abandoned tab must not hold a live pi forever. Eviction IS the pre-#27 behaviour
 * (decline on the wire), applied late instead of immediately.
 */
const DIALOG_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * After declining, the process gets this long to run the extension's cleanup path and
 * settle before it is stopped regardless. The write is what lets the extension finish
 * honestly (a declined `select` resolves `undefined`); the stop is what guarantees the
 * process does not outlive the registry's promise to have dealt with it.
 */
const EVICTION_GRACE_MS = 5_000;

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
				`declined and the process will be stopped`,
		);
		try {
			// pi's cancellation form: the extension receives `undefined` / `false` and the
			// command completes as a no-op — the pre-#27 behaviour, applied at eviction.
			entry.pump.transport.write(
				`${JSON.stringify({ type: "extension_ui_response", id: entry.dialogId, cancelled: true })}\n`,
			);
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
