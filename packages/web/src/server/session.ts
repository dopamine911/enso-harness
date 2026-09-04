import { EventType, type Interrupt } from "@ag-ui/core";
import { INTERRUPT_BINDING_METADATA_KEY, type StreamChunk } from "@tanstack/ai";
import {
	isPiCommand,
	isZenDialogResumeEntry,
	type PiCommand,
	type PiTransport,
	validateDialogAnswer,
	ZEN_DIALOG_KEY,
	type ZenDialogSpec,
} from "@zen/core";
import { PiRpcClient } from "../rpc/client.ts";
import { mapPiEvent } from "../rpc/map-events.ts";
import { type AguiIdentifiers, observationToAguiEvents } from "../rpc/to-agui.ts";
import type { DialogRegistry, PiSessionPump } from "./dialog-registry.ts";

/**
 * Chat runs against a pi process, as async iterables of AG-UI events (#24, #27).
 *
 * This is where the three hops compose:
 *
 *     pi stdout → PiRpcClient → mapPiEvent → observationToAguiEvents → here
 *
 * Two entry points share one streaming loop:
 *
 *   `runChat`     a prompt against a freshly spawned pi
 *   `resumeChat`  a human's answer to a dialog that interrupted an earlier run,
 *                 continuing the SAME parked process (#27)
 *
 * ⚠ WHY A SEPARATE OBJECT RATHER THAN LOGIC IN THE HTTP HANDLER
 * AG-UI requires identifiers pi does not supply (`messageId`, `runId`, `threadId`), and
 * the observation→AG-UI mapper is a pure function that must not hold them. So the
 * identifiers live here — which is also what makes this testable against a fake
 * transport, with no HTTP and no pi.
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
 * ACKNOWLEDGEMENT, which pi sends only when the command finishes (`rpc-mode.js` case
 * "prompt": the response fires from `preflightResult`, which is why `/mode`'s unanswered
 * dialog blocked the ack for the whole pre-#27 hang). Without this rule every slash-command
 * run held its HTTP response open for the full 90-second guard AFTER the command had
 * visibly finished — observed live on the first answered `/mode`.
 *
 * The grace exists because the acknowledgement and any trailing events travel the same
 * pipe: closing the instant the ack resolves could race a final line still in flight. It is
 * applied ONLY to slash-command runs — an ordinary prompt's ack means ACCEPTED, not done,
 * and closing on it would cut a real inference off at the knees.
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
				// biome-ignore lint: `v` is TanStack's interruptBinding WIRE FORMAT (`tanstack:interruptBinding` {v, kind, interruptId, …}) — renaming it breaks resume resolution.
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

/**
 * pi's answer wire format, written straight to the transport: this is a RESPONSE keyed to
 * the request's id, not a command awaiting its own acknowledgement, so it must not go
 * through `client.send`.
 */
function writeDialogResponse(
	transport: PiTransport,
	response: { id: string } & ({ cancelled: true } | { value: string } | { confirmed: boolean }),
): void {
	transport.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
}

/**
 * Ask pi what commands exist.
 *
 * ⚠ These are the ONLY `/`-prefixed inputs that do anything over rpc. pi's docs:
 * "Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled
 * only in interactive mode and would NOT EXECUTE if sent via `prompt`."
 */
export async function fetchPiCommands(client: PiRpcClient): Promise<PiCommand[]> {
	const response = await client.send({ type: "get_commands" });
	if (!response.success) return [];
	const data = (response as { data?: { commands?: unknown } }).data;
	const commands = data?.commands;
	return Array.isArray(commands) ? commands.filter(isPiCommand) : [];
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
 * ⚠ WHY AN OUT-PARAMETER: the handler owns the pi process and must know whether the run
 * handed it to the registry (do not stop it — a human's answer is coming) or not (stop it,
 * as always). A generator's return value is invisible to `for await`, and asking the
 * registry "do you hold this thread?" is WRONG under concurrency: a second run on the same
 * thread would read the FIRST run's parked entry as its own and leak its process.
 */
export interface ChatRunOutcome {
	parkedAwaitingAnswer: boolean;
}

interface SessionPumpInternals {
	pump: PiSessionPump;
	client: PiRpcClient;
}

/** The queue between the callback-driven client and the streaming loop. */
function createSessionPump(
	transport: PiTransport,
	onProblem: ((problem: unknown) => void) | undefined,
): SessionPumpInternals {
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
		transport,
	};
	const client = new PiRpcClient({
		transport,
		onEvent: (event) => {
			pump.pending.push(event);
			if (event.type === "agent_settled") pump.settled = true;
			pump.wake();
		},
		onParseError: (problem) => {
			onProblem?.(problem);
			// ⚠ A parse failure must not strand the stream. If pi is emitting garbage we will
			// never see `agent_settled`, so waking the loop lets it drain and finish rather
			// than hang on a promise nothing resolves.
			pump.wake();
		},
	});
	return { pump, client };
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
 * a blocking dialog hands the process to the registry, or progress stops.
 *
 * ⚠⚠ NOTHING MAY SIT BETWEEN THE TRANSPORT AND THIS LOOP. The original `/mode` hang was
 * exactly that shape: `await client.send(prompt)` stood in front of the drain loop, and
 * pi acknowledges a prompt only after the command completes — which the unanswered dialog
 * prevented. The guard that would have reported the dialog was unreachable BECAUSE of the
 * dialog. So the prompt acknowledgement is observed from a callback (`pump.promptError`),
 * never awaited in front of this loop.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the session pump — one loop owning progress timeouts, dialog parking, and settle detection in ORDER; the ordering is the #27 contract, and helper-splitting it is how a parked process would leak past a teardown.
async function* streamRun(options: StreamRunOptions): AsyncGenerator<StreamChunk> {
	const { pump, ids, registry, stopPi, outcome, noProgressTimeoutMs } = options;
	const { isExtensionCommand, slashCommandGraceMs } = options;
	let lastProgressAt = Date.now();
	/** When the extension-command completion state was first observed, or undefined. */
	let commandQuietSince: number | undefined;

	while (true) {
		let emitted = false;
		while (pump.pending.length > 0) {
			const event = pump.pending.shift();
			if (event === undefined) break;
			const observation = mapPiEvent(event);

			// ⚠⚠ A BLOCKING DIALOG IS INTERCEPTED HERE, BEFORE THE AG-UI MAPPER — it ends
			// this response but not the RUN: pi stays alive, blocked on stdin, parked in the
			// registry until the human's answer arrives as a resume request (#27).
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
				// (or that carries no id to answer). Decline on the wire so pi is not left
				// hanging — the pre-#27 behaviour — and let the mapper's RUN_ERROR tell the
				// user. The run continues: the command completes as a no-op and settles.
				if (observation.id.length > 0) {
					writeDialogResponse(pump.transport, { id: observation.id, cancelled: true });
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
	transport: PiTransport;
	ids: AguiIdentifiers;
	prompt: string;
	/** Base64 images, forwarded verbatim — pi's rpc accepts them on `prompt`. */
	images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
	registry: DialogRegistry;
	/** Stops the pi process. Handed to the registry when a dialog parks the run. */
	stopPi: () => void;
	/** See {@link ChatRunOutcome} — the handler reads it after the stream completes. */
	outcome: ChatRunOutcome;
	/**
	 * Notified for a record that could not be parsed or correlated. Never silent.
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
 * response off mid-retry. That distinction is asserted in `protocol.test.ts` and preserved
 * through both mappers; here is where it decides when the HTTP response closes.
 */
export async function* runChat(options: ChatRunOptions): AsyncGenerator<StreamChunk> {
	const { transport, ids, prompt, images, registry, stopPi, outcome, onProblem } = options;
	const noProgressTimeoutMs = options.noProgressTimeoutMs ?? NO_PROGRESS_TIMEOUT_MS;
	const slashCommandGraceMs = options.slashCommandGraceMs ?? SLASH_COMMAND_COMPLETION_GRACE_MS;
	const { pump, client } = createSessionPump(transport, onProblem);

	yield runStarted(ids);
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
	 * ⓘ Awaiting `get_commands` in front of the loop is safe where awaiting the prompt was
	 * not: pi answers it directly, no extension command runs, so nothing can block it.
	 */
	const requestedCommand = slashCommandName(prompt);
	if (requestedCommand !== undefined) {
		const available = await fetchPiCommands(client);
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

	// ⚠⚠ SENT, NOT AWAITED. pi acknowledges a prompt only after the command it starts
	// completes — so when that command opens a dialog, the acknowledgement arrives after
	// the ANSWER. Awaiting it here is the original `/mode` hang: the loop that would have
	// surfaced the dialog sat behind an await the dialog was blocking. The outcome lands in
	// `pump.promptError` and the loop reports it.
	client
		.send({ type: "prompt", message: prompt, ...(images === undefined ? {} : { images }) })
		.then((response) => {
			if (response.success) {
				pump.promptAcknowledged = true;
			} else {
				pump.promptError = response.error ?? "pi rejected the prompt";
			}
			pump.wake();
		})
		.catch((error: unknown) => {
			pump.promptError = error instanceof Error ? error.message : String(error);
			pump.wake();
		});

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
	try {
		if (first.status === "cancelled") {
			writeDialogResponse(entry.pump.transport, { id: entry.dialogId, cancelled: true });
		} else {
			// `validateDialogAnswer` proved the payload matches the dialog's method, so the
			// narrowing here cannot disagree with what was checked.
			const answer = first.payload as { value: string } | { confirmed: boolean };
			writeDialogResponse(entry.pump.transport, { id: entry.dialogId, ...answer });
		}
	} catch (error) {
		onProblem?.(error);
		entry.stopPi();
		yield runError(ids, "the agent process is gone — the answer could not be delivered.");
		return;
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
