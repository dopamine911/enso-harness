import { EventType, type Interrupt } from "@ag-ui/core";
import { INTERRUPT_BINDING_METADATA_KEY, type StreamChunk } from "@tanstack/ai";
import {
	isZenDialogResumeEntry,
	type PiDialogResponse,
	type PiSession,
	validateDialogAnswer,
	ZEN_DIALOG_KEY,
	type ZenDialogSpec,
} from "@zen/core";
import { ZEN_CUSTOM_EVENT_MODE } from "../rpc/custom-event-names.ts";
import { mapPiEvent } from "../rpc/map-events.ts";
import { type AguiIdentifiers, observationToAguiEvents } from "../rpc/to-agui.ts";
import type { DialogRegistry, PiSessionPump } from "./dialog-registry.ts";

/**
 * Chat runs against a pi session, as async iterables of AG-UI events (#24, #27, #69).
 *
 * This is where the three hops compose:
 *
 *     PiSession events → mapPiEvent → observationToAguiEvents → here
 *
 * Two entry points share one streaming loop:
 *
 *   `runChat`     a prompt against a pi session the host created
 *   `resumeChat`  a human's answer to a dialog that interrupted an earlier run,
 *                 continuing the SAME parked session (#27)
 *
 * ⚠ WHY A SEPARATE OBJECT RATHER THAN LOGIC IN THE HTTP HANDLER
 * AG-UI requires identifiers pi does not supply (`messageId`, `runId`, `threadId`), and
 * the observation→AG-UI mapper is a pure function that must not hold them. So the
 * identifiers live here — which is also what makes this testable against a fake
 * `PiSession`, with no HTTP and no pi.
 *
 * ⚠ The events arrive in pi's rpc WIRE shape even though nothing is on a wire (#69): the
 * in-process host translates `AgentSessionEvent`s into the records `map-events.ts` always
 * consumed, so this file and the two mappers are unchanged by where pi runs.
 */

/**
 * How long to wait with NO events before ending a run.
 *
 * ⚠⚠ Not a tuning knob — a correctness guard. The stream terminates on `agent_settled`,
 * and an extension command that runs no inference never emits one: pi's docs say an
 * extension command "executes immediately" and manages its own LLM interaction, so it may
 * finish without an agent run at all.
 *
 * An HTTP stream that never closes is the worst shape available: the client shows a
 * spinner, no error is raised anywhere, and nothing distinguishes it from a slow answer.
 *
 * ⚠⚠ IT MEASURES PROGRESS, NOT TRAFFIC, AND THE FIRST VERSION GOT THAT WRONG.
 * Resetting on any incoming event made the guard inert: pi-multi-account emits periodic
 * `setStatus` heartbeats, which are events we DROP without emitting anything, so they kept
 * the deadline alive indefinitely. `/mode` still hung past 120 seconds with the guard in
 * place. The deadline resets only when an event actually produces an AG-UI chunk — which
 * is what "no progress" has to mean for a stream whose whole purpose is chunks.
 */
const NO_PROGRESS_TIMEOUT_MS = 90_000;

/**
 * How long after an extension command's completion signal to keep the stream open.
 *
 * ⚠ An extension command never emits `agent_settled` — its completion signal is the PROMPT
 * ACCEPTANCE, which pi reports only when the command finishes (`preflightResult(true)`
 * fires after an "immediately handled" command completes, which is why `/mode`'s
 * unanswered dialog blocked it for the whole pre-#27 hang). Without this rule every
 * slash-command run held its HTTP response open for the full 90-second guard AFTER the
 * command had visibly finished — observed live on the first answered `/mode`.
 *
 * The grace exists because the acceptance callback and any trailing events are delivered
 * independently: closing the instant acceptance lands could race a final event still being
 * emitted. It is applied ONLY to slash-command runs — an ordinary prompt's acceptance means
 * ACCEPTED, not done, and closing on it would cut a real inference off at the knees.
 */
const SLASH_COMMAND_COMPLETION_GRACE_MS = 1000;

/** AG-UI requires RUN_STARTED first: "the first event in any streaming response". */
function runStarted(ids: AguiIdentifiers): StreamChunk {
	return { type: EventType.RUN_STARTED, threadId: ids.threadId, runId: ids.runId };
}

/** Opens the assistant message the text deltas will attach to. */
function messageStarted(ids: AguiIdentifiers): StreamChunk {
	return { type: EventType.TEXT_MESSAGE_START, messageId: ids.messageId, role: "assistant" };
}

/**
 * The permission mode this run STARTS in, and the modes the browser may offer (#84).
 *
 * ⚠ Synthesised here, not mapped from a pi event, because there is no event to map: picc
 * persists a `modes` entry only on a CHANGE, so a fresh thread sitting in `default` never
 * says so on its own — which is exactly the state #73's refusals happen in. Reading it off
 * the session at run start is the one honest source; the browser renders `unknown` until
 * this arrives rather than assuming. The host computes both halves (`permissionModeState`),
 * so this stays a one-line handoff — and never touches `listCommands`, whose call count
 * the refusal tests below pin for prose prompts.
 */
function modeReceipt(session: PiSession): StreamChunk {
	return { type: EventType.CUSTOM, name: ZEN_CUSTOM_EVENT_MODE, value: session.permissionModeState() };
}

function runError(ids: AguiIdentifiers, message: string): StreamChunk {
	return { type: EventType.RUN_ERROR, runId: ids.runId, message };
}

/**
 * `RUN_FINISHED` whose outcome hands a pi dialog to the browser as a resolvable
 * interrupt (#27).
 *
 * ⚠⚠ THE BINDING STAMP IS MANDATORY, NOT DECORATION. TanStack classifies an interrupt
 * with no `tanstack:interruptBinding` metadata as `kind:"unbound"`, `canResolve:false` —
 * rendered, permanently unanswerable. With this exact stamp it classifies
 * `kind:"generic"`, `canResolve:true`, and `resolveInterrupt(payload)` accepts an
 * arbitrary payload. Verified against the real `ChatClient`, not the type declarations
 * (`.local/interrupt-probe/`): `interruptedRunId` must equal the interrupted run's id and
 * `generation` must be the same integer on every interrupt of the batch (we send one).
 *
 * ⚠ Do NOT add a `responseSchema` to the descriptor: the client then requires a matching
 * `responseSchemaHash` in the binding (their hash, computed their way). With no schema,
 * the hash check is vacuous and the payload is validated by US, server-side, against the
 * dialog spec — `validateDialogAnswer`, where the select-option allowlist lives.
 */
function runFinishedWithDialogInterrupt(
	ids: AguiIdentifiers,
	dialogId: string,
	dialog: ZenDialogSpec,
	expiresAt: number,
): StreamChunk {
	const interrupt: Interrupt = {
		id: dialogId,
		reason: `pi-dialog:${dialog.method}`,
		message: dialog.title,
		expiresAt: new Date(expiresAt).toISOString(),
		metadata: {
			[INTERRUPT_BINDING_METADATA_KEY]: {
				v: 1,
				kind: "generic",
				interruptId: dialogId,
				interruptedRunId: ids.runId,
				generation: 0,
			},
			[ZEN_DIALOG_KEY]: dialog,
		},
	};
	return {
		type: EventType.RUN_FINISHED,
		threadId: ids.threadId,
		runId: ids.runId,
		outcome: { type: "interrupt", interrupts: [interrupt] },
	};
}

/** Deliver a dialog answer, keyed to the request id — the session resolves the blocked extension call. */
function writeDialogResponse(session: PiSession, response: PiDialogResponse): void {
	session.answerDialog(response);
}

/** Leading token of a slash input, without the slash. `/mode auto` -> `mode`. */
function slashCommandName(prompt: string): string | undefined {
	if (!prompt.startsWith("/")) return undefined;
	const name = prompt.slice(1).trimEnd().split(/\s/)[0];
	return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * Written by the generators, read by the HTTP handler AFTER the stream completes.
 *
 * ⚠ WHY AN OUT-PARAMETER: the handler owns the pi session and must know whether the run
 * handed it to the registry (do not stop it — a human's answer is coming) or not (stop it,
 * as always). A generator's return value is invisible to `for await`, and asking the
 * registry "do you hold this thread?" is WRONG under concurrency: a second run on the same
 * thread would read the FIRST run's parked entry as its own and leak its session.
 */
export interface ChatRunOutcome {
	parkedAwaitingAnswer: boolean;
}

function noop(): void {
	// Intentionally empty: the resting state of a released subscription handle.
}

/**
 * The queue between the session's event subscription and the streaming loop.
 *
 * One pump per RUN, deliberately, even though the session now lives for the whole thread
 * (#69 PR 2). The host holds events that arrive while nobody is subscribed and replays them
 * to the next subscriber, so a per-thread pump would gain nothing and lose something: it
 * would swallow the startup notifies extensions emit before the first prompt, and the
 * previous run's `agent_settled` would leak into the next run's state. The run-scoped pump
 * subscribes here and unsubscribes when its stream ends unparked (see `streamRun`).
 */
function createSessionPump(session: PiSession): PiSessionPump {
	// Replaced by the real handle below; the placeholder makes a double `unsubscribe` harmless.
	let unsubscribeFromSession: () => void = noop;
	const pump: PiSessionPump = {
		pending: [],
		settled: false,
		promptError: undefined,
		promptAcknowledged: false,
		notify: undefined,
		wake(): void {
			pump.notify?.();
			pump.notify = undefined;
		},
		session,
		unsubscribe(): void {
			unsubscribeFromSession();
			unsubscribeFromSession = noop;
		},
	};
	// Subscribed BEFORE the prompt is fired, so no event can slip between the two; events an
	// extension emitted during the session's own start are replayed here by the host.
	unsubscribeFromSession = session.subscribe((event, delivery) => {
		pump.pending.push({ event, delivery });
		if (event.type === "agent_settled") pump.settled = true;
		pump.wake();
	});
	return pump;
}

interface StreamRunOptions {
	pump: PiSessionPump;
	ids: AguiIdentifiers;
	registry: DialogRegistry;
	stopPi: () => void;
	outcome: ChatRunOutcome;
	onProblem: ((problem: unknown) => void) | undefined;
	noProgressTimeoutMs: number;
	/** This run is a slash command — see {@link SLASH_COMMAND_COMPLETION_GRACE_MS}. */
	isExtensionCommand: boolean;
	slashCommandGraceMs: number;
}

/**
 * The shared streaming loop: drain pi's events into AG-UI chunks until the run settles,
 * a blocking dialog hands the session to the registry, or progress stops.
 *
 * ⚠⚠ NOTHING MAY SIT BETWEEN THE SESSION AND THIS LOOP. The original `/mode` hang was
 * exactly that shape: an `await` on the prompt's acceptance stood in front of the drain
 * loop, and pi reports acceptance of an extension command only after the command completes
 * — which the unanswered dialog prevented. The guard that would have reported the dialog
 * was unreachable BECAUSE of the dialog. So acceptance is observed from a callback
 * (`pump.promptAcknowledged` / `pump.promptError`), never awaited in front of this loop.
 */
async function* streamRun(options: StreamRunOptions): AsyncGenerator<StreamChunk> {
	const { pump, outcome } = options;
	try {
		yield* drainUntilRunEnds(options);
	} finally {
		// ⚠ Runs on every exit — settle, guard, error, AND the consumer abandoning the
		// generator (a client disconnect ends the `for await` in `server/index.ts`, which
		// calls `return()` here). A parked run is the one exception: its pump travels to the
		// registry with the subscription attached, and the resume's own loop releases it.
		if (!outcome.parkedAwaitingAnswer) pump.unsubscribe();
	}
}

async function* drainUntilRunEnds(options: StreamRunOptions): AsyncGenerator<StreamChunk> {
	const { pump, ids, registry, stopPi, outcome, noProgressTimeoutMs } = options;
	const { isExtensionCommand, slashCommandGraceMs } = options;
	let lastProgressAt = Date.now();
	/** When the extension-command completion state was first observed, or undefined. */
	let commandQuietSince: number | undefined;

	while (true) {
		let emitted = false;
		while (pump.pending.length > 0) {
			const pending = pump.pending.shift();
			if (pending === undefined) break;
			const observation = mapPiEvent(pending.event, pending.delivery);

			// ⚠⚠ A BLOCKING DIALOG IS INTERCEPTED HERE, BEFORE THE AG-UI MAPPER — it ends
			// this response but not the RUN: the session stays alive, its extension blocked
			// on our UI context's promise, parked in the registry until the human's answer
			// arrives as a resume request (#27).
			if (observation.kind === "extension-ui-request" && observation.blocking) {
				if (observation.dialog !== undefined && observation.id.length > 0) {
					const expiresAt = Date.now() + registry.answerTimeoutMs;
					registry.park({
						pump,
						stopPi,
						dialogId: observation.id,
						dialog: observation.dialog,
						interruptedRunId: ids.runId,
						threadId: ids.threadId,
						isExtensionCommand,
						expiresAt,
					});
					outcome.parkedAwaitingAnswer = true;
					yield runFinishedWithDialogInterrupt(ids, observation.id, observation.dialog, expiresAt);
					return;
				}
				// The degenerate case: a blocking request whose question could not be read
				// (or that carries no id to answer). Decline it so the extension is not left
				// hanging — the pre-#27 behaviour — and let the mapper's RUN_ERROR tell the
				// user. The run continues: the command completes as a no-op and settles.
				if (observation.id.length > 0) {
					writeDialogResponse(pump.session, { id: observation.id, cancelled: true });
				}
			}

			for (const chunk of observationToAguiEvents(observation, ids)) {
				emitted = true;
				yield chunk;
			}
		}
		if (emitted) lastProgressAt = Date.now();

		if (pump.promptError !== undefined) {
			// A rejected prompt is a protocol outcome, not an exception — surface it as a run
			// error rather than throwing, so the client sees why instead of a dropped
			// connection.
			yield runError(ids, pump.promptError);
			return;
		}
		if (pump.settled) return;

		if (Date.now() - lastProgressAt >= noProgressTimeoutMs) {
			// Nothing has been EMITTED for the whole window, whatever traffic arrived.
			yield { type: EventType.RUN_FINISHED, threadId: ids.threadId, runId: ids.runId };
			return;
		}

		// ⚠ The slash-command quick close — see SLASH_COMMAND_COMPLETION_GRACE_MS. The ack
		// is the command's completion signal, so once it has arrived and the queue has
		// stayed drained for the grace, the run is over; `agent_settled` is never coming.
		const isCommandComplete = isExtensionCommand && pump.promptAcknowledged && pump.pending.length === 0;
		if (!isCommandComplete) {
			commandQuietSince = undefined;
		} else {
			commandQuietSince = commandQuietSince ?? Date.now();
			if (Date.now() - commandQuietSince >= slashCommandGraceMs) {
				yield { type: EventType.RUN_FINISHED, threadId: ids.threadId, runId: ids.runId };
				return;
			}
		}

		// Wake on the next event OR when the nearest deadline elapses — whichever first.
		// The loop then re-checks everything, so a heartbeat wakes us and changes nothing.
		const guardRemaining = noProgressTimeoutMs - (Date.now() - lastProgressAt);
		const graceRemaining =
			commandQuietSince === undefined
				? Number.POSITIVE_INFINITY
				: slashCommandGraceMs - (Date.now() - commandQuietSince);
		const remaining = Math.min(guardRemaining, graceRemaining);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, Math.max(remaining, 1));
			pump.notify = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}
}

export interface ChatRunOptions {
	session: PiSession;
	ids: AguiIdentifiers;
	prompt: string;
	/** Base64 images, forwarded verbatim — pi accepts them on `prompt`. */
	images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
	registry: DialogRegistry;
	/**
	 * Aborts the run and lets the thread go idle — never disposes the session (#69 PR 2).
	 * Handed to the registry when a dialog parks the run, for eviction.
	 */
	stopPi: () => void;
	/** See {@link ChatRunOutcome} — the handler reads it after the stream completes. */
	outcome: ChatRunOutcome;
	/**
	 * Notified for anything the run could not deliver (a dialog answer to a gone session).
	 * Never silent.
	 *
	 * ⚠ Explicitly `| undefined` rather than optional. `exactOptionalPropertyTypes` is on,
	 * so `onProblem?: T` rejects a caller forwarding a handler it may not have — and "no
	 * handler" is a real state a server legitimately holds, not an omitted argument.
	 */
	onProblem: ((problem: unknown) => void) | undefined;
	/**
	 * Milliseconds of silence before the run ends itself.
	 *
	 * ⚠ Injectable so a test can assert the guard in milliseconds rather than waiting the
	 * real 90 seconds — a correctness guard nobody can afford to test is a guard nobody
	 * tests.
	 */
	noProgressTimeoutMs?: number;
	/** Injectable for the same reason. See {@link SLASH_COMMAND_COMPLETION_GRACE_MS}. */
	slashCommandGraceMs?: number;
}

/**
 * Run one prompt and yield AG-UI events until pi settles, a dialog interrupts, or
 * progress stops.
 *
 * ⚠ Terminates on `agent_settled`, NOT on `agent_end` — `agent_end` is one low-level run
 * and may be followed by an automatic retry, so ending the stream there would cut the
 * response off mid-retry. That distinction is asserted in `map-events.test.ts` and preserved
 * through both mappers; here is where it decides when the HTTP response closes.
 */
export async function* runChat(options: ChatRunOptions): AsyncGenerator<StreamChunk> {
	const { session, ids, prompt, images, registry, stopPi, outcome, onProblem } = options;
	const noProgressTimeoutMs = options.noProgressTimeoutMs ?? NO_PROGRESS_TIMEOUT_MS;
	const slashCommandGraceMs = options.slashCommandGraceMs ?? SLASH_COMMAND_COMPLETION_GRACE_MS;
	const pump = createSessionPump(session);

	yield runStarted(ids);
	// The state receipt rides FIRST after RUN_STARTED, before the slash-command refusal
	// below: even a refused run tells the browser what mode it is in.
	yield modeReceipt(session);
	yield messageStarted(ids);

	/**
	 * ⚠⚠ REFUSE AN UNKNOWN SLASH COMMAND RATHER THAN FORWARDING IT.
	 *
	 * Observed in a real session: a user typed `/settings`, it was sent as an ordinary
	 * prompt, and the MODEL answered it — by reading config files and producing a
	 * plausible, unauthoritative summary. That is the worst available outcome: it looks
	 * like the command worked, costs a turn of inference, and the answer is a guess.
	 *
	 * `/settings` is TUI-only by pi's design and cannot execute over rpc. So a
	 * `/`-prefixed input that pi does not list is refused HERE, naming the commands that
	 * do exist, instead of becoming prose for the model to interpret.
	 *
	 * ⓘ `listCommands` is a synchronous read off the live registry (#69 closed the one
	 * unbounded await that used to stand here, #53 S2): no round trip, nothing to block.
	 */
	const requestedCommand = slashCommandName(prompt);
	if (requestedCommand !== undefined) {
		const available = session.listCommands();
		const known = available.some((command) => command.name === requestedCommand);
		if (!known) {
			yield runError(
				ids,
				`/${requestedCommand} is not available on this surface. ` +
					`pi's built-in commands (/settings, /hotkeys, …) are terminal-only and cannot ` +
					`run over rpc. Available here: ${
						available.length === 0 ? "none" : available.map((command) => `/${command.name}`).join(", ")
					}`,
			);
			return;
		}
	}

	// ⚠⚠ FIRED, NOT AWAITED. pi reports acceptance of an extension command only after the
	// command completes — so when that command opens a dialog, acceptance arrives after
	// the ANSWER. Awaiting it here is the original `/mode` hang: the loop that would have
	// surfaced the dialog sat behind an await the dialog was blocking. Acceptance and
	// rejection land on the pump from callbacks, and the loop reports them.
	session.prompt(
		{ message: prompt, ...(images === undefined ? {} : { images }) },
		{
			onAccepted: () => {
				pump.promptAcknowledged = true;
				pump.wake();
			},
			onRejected: (reason) => {
				pump.promptError = reason;
				pump.wake();
			},
		},
	);

	yield* streamRun({
		pump,
		ids,
		registry,
		stopPi,
		outcome,
		onProblem,
		noProgressTimeoutMs,
		isExtensionCommand: requestedCommand !== undefined,
		slashCommandGraceMs,
	});
}

export interface ResumeRunOptions {
	registry: DialogRegistry;
	/** Fresh identifiers for THIS response — the client generates a new runId per POST. */
	ids: AguiIdentifiers;
	/** The interrupted run the client says it is answering. */
	parentRunId: string | undefined;
	/** The raw `resume` array off the request body — validated here, not by the caller. */
	resume: unknown;
	outcome: ChatRunOutcome;
	onProblem: ((problem: unknown) => void) | undefined;
	noProgressTimeoutMs?: number;
	/** Injectable — see {@link SLASH_COMMAND_COMPLETION_GRACE_MS}. */
	slashCommandGraceMs?: number;
}

/**
 * Deliver a human's answer to a parked dialog and stream the continuation (#27).
 *
 * ⚠ VALIDATION HAPPENS AGAINST A PEEK. `take` runs only after the request has proven it
 * names this thread's open question and carries a well-formed answer — so a malformed or
 * stale resume cannot destroy the parked dialog. A refused ANSWER re-presents the same
 * question as a fresh interrupt (the refusal text first), because TanStack clears its
 * pending-interrupt state on any terminal event for the resuming run: a bare RUN_ERROR
 * would leave the server holding a question the browser no longer shows.
 */
export async function* resumeChat(options: ResumeRunOptions): AsyncGenerator<StreamChunk> {
	const { registry, ids, parentRunId, resume, outcome, onProblem } = options;
	const noProgressTimeoutMs = options.noProgressTimeoutMs ?? NO_PROGRESS_TIMEOUT_MS;
	const slashCommandGraceMs = options.slashCommandGraceMs ?? SLASH_COMMAND_COMPLETION_GRACE_MS;

	yield runStarted(ids);
	yield messageStarted(ids);

	const parked = registry.peek(ids.threadId);
	if (parked === undefined) {
		yield runError(
			ids,
			"there is no open question on this conversation — it may have expired " +
				"(an unanswered dialog is declined after " +
				`${Math.round(registry.answerTimeoutMs / 60_000)} minutes) or already been answered.`,
		);
		return;
	}

	const entries = Array.isArray(resume) ? resume : [];
	const first: unknown = entries[0];
	if (entries.length !== 1 || !isZenDialogResumeEntry(first)) {
		// Structural misuse (pi asks one question at a time, so one entry is the only valid
		// shape). The question stays parked; its TTL is still running.
		yield runError(ids, "a resume request must carry exactly one well-formed resume entry.");
		return;
	}
	if (parentRunId !== parked.interruptedRunId || first.interruptId !== parked.dialogId) {
		yield runError(
			ids,
			"this answer names a different question than the one that is open — " +
				"it may be a replay of an already-answered dialog.",
		);
		return;
	}

	if (first.status === "resolved") {
		const refusal = validateDialogAnswer(parked.dialog, first.payload);
		if (refusal !== undefined) {
			// Re-present rather than error out: move the open question onto THIS run so the
			// next resume's parentRunId matches, and hand the browser the same interrupt
			// again with the refusal as visible text.
			registry.take(ids.threadId);
			const expiresAt = Date.now() + registry.answerTimeoutMs;
			registry.park({ ...parked, interruptedRunId: ids.runId, expiresAt });
			outcome.parkedAwaitingAnswer = true;
			yield {
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: ids.messageId,
				delta: `That answer was refused: ${refusal}. The question is still open.`,
			};
			yield runFinishedWithDialogInterrupt(ids, parked.dialogId, parked.dialog, expiresAt);
			return;
		}
	}

	const entry = registry.take(ids.threadId);
	if (entry === undefined) {
		// The peek above saw it, so something took it between then and now — a concurrent
		// resume on the same thread. Refuse rather than crash; the winner is delivering it.
		yield runError(ids, "this question is being answered by a concurrent request.");
		return;
	}
	// `answerDialog` never throws (contract on `PiSession`): the subprocess era needed a
	// broken-pipe catch here, but an in-process answer to a stale id is reported through the
	// host's problem channel and returns normally. PR #70 review flagged the old catch as dead.
	if (first.status === "cancelled") {
		writeDialogResponse(entry.pump.session, { id: entry.dialogId, cancelled: true });
	} else {
		// `validateDialogAnswer` proved the payload matches the dialog's method, so the
		// narrowing here cannot disagree with what was checked.
		const answer = first.payload as { value: string } | { confirmed: boolean };
		writeDialogResponse(entry.pump.session, { id: entry.dialogId, ...answer });
	}

	yield* streamRun({
		pump: entry.pump,
		ids,
		registry,
		stopPi: entry.stopPi,
		outcome,
		onProblem,
		noProgressTimeoutMs,
		isExtensionCommand: entry.isExtensionCommand,
		slashCommandGraceMs,
	});
}
