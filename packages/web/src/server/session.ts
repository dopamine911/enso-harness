import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import { isPiCommand, type PiCommand, type PiRpcEvent, type PiTransport } from "@zen/core";
import { PiRpcClient } from "../rpc/client.ts";
import { mapPiEvent } from "../rpc/map-events.ts";
import { observationToAguiEvents, type AguiIdentifiers } from "../rpc/to-agui.ts";

/**
 * One chat run against one pi process, as an async iterable of AG-UI events (#24).
 *
 * This is where the three hops finally compose:
 *
 *     pi stdout → PiRpcClient → mapPiEvent → observationToAguiEvents → here
 *
 * ⚠ WHY A SEPARATE OBJECT RATHER THAN LOGIC IN THE HTTP HANDLER
 * Two things need to be true at once and neither belongs in a request handler: AG-UI
 * requires identifiers pi does not supply (`messageId`, `runId`, `threadId`), and the
 * observation→AG-UI mapper is a pure function that must not hold them. So the identifiers
 * live here, in the one object that knows what "the current message" is — which is also
 * what makes this testable against a fake transport, with no HTTP and no pi.
 */

/**
 * How long to wait with NO events before ending a run.
 *
 * ⚠⚠ Not a tuning knob — a correctness guard. `runChat` terminates on `agent_settled`,
 * and an extension command that runs no inference never emits one: pi's docs say an
 * extension command "executes immediately" and manages its own LLM interaction, so it may
 * finish without an agent run at all. Observed with `/mode`, which emitted RUN_ERROR and
 * then left the SSE response open forever.
 *
 * An HTTP stream that never closes is the worst shape available: the client shows a
 * spinner, no error is raised anywhere, and nothing distinguishes it from a slow answer.
 * Generous enough not to cut a real inference short — pi's own drain tick is a minute — and
 * finite, which is the whole point.
 *
 * ⚠⚠ IT MEASURES PROGRESS, NOT TRAFFIC, AND THE FIRST VERSION GOT THAT WRONG.
 * Resetting on any incoming event made the guard inert: pi-multi-account emits periodic
 * `setStatus` heartbeats, which are events we DROP without emitting anything, so they kept
 * the deadline alive indefinitely. `/mode` still hung past 120 seconds with the guard in
 * place. The deadline now resets only when an event actually produces an AG-UI chunk —
 * which is what "no progress" has to mean for a stream whose whole purpose is chunks.
 */
const NO_PROGRESS_TIMEOUT_MS = 90_000;

/** AG-UI requires RUN_STARTED first: "the first event in any streaming response". */
function runStarted(ids: AguiIdentifiers): StreamChunk {
	return { type: EventType.RUN_STARTED, threadId: ids.threadId, runId: ids.runId };
}

/** Opens the assistant message the text deltas will attach to. */
function messageStarted(ids: AguiIdentifiers): StreamChunk {
	return { type: EventType.TEXT_MESSAGE_START, messageId: ids.messageId, role: "assistant" };
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

export interface ChatRunOptions {
	transport: PiTransport;
	ids: AguiIdentifiers;
	prompt: string;
	/** Base64 images, forwarded verbatim — pi's rpc accepts them on `prompt`. */
	images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
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
}

/**
 * Run one prompt and yield AG-UI events until pi settles.
 *
 * ⚠ Terminates on `agent_settled`, NOT on `agent_end` — `agent_end` is one low-level run
 * and may be followed by an automatic retry, so ending the stream there would cut the
 * response off mid-retry. That distinction is asserted in `protocol.test.ts` and preserved
 * through both mappers; here is where it decides when the HTTP response closes.
 */
export async function* runChat(options: ChatRunOptions): AsyncGenerator<StreamChunk> {
	const { transport, ids, prompt, images, onProblem } = options;
	const noProgressTimeoutMs = options.noProgressTimeoutMs ?? NO_PROGRESS_TIMEOUT_MS;

	// A bounded queue between the callback-driven client and this generator. pi pushes; the
	// generator pulls. Without it, events emitted between yields would be lost.
	const pending: PiRpcEvent[] = [];
	let settled = false;
	let notify: (() => void) | undefined;
	const wake = () => {
		notify?.();
		notify = undefined;
	};

	/**
	 * ⚠⚠ CANCEL A BLOCKING DIALOG IMMEDIATELY, OR THE WHOLE RUN HANGS FOREVER.
	 *
	 * Observed with `/mode`: picc-permission-modes calls `ctx.ui.select()`, which in rpc
	 * mode emits `{"type":"extension_ui_request","method":"select",…}` and BLOCKS pi until
	 * a matching `extension_ui_response` arrives on stdin. Nothing wrote one, so:
	 *
	 *   - pi never acknowledged the `prompt` command
	 *   - `await client.send(...)` below never resolved
	 *   - the drain loop was never entered
	 *   - the SSE stream emitted NOTHING, forever
	 *
	 * ⚠ Note what that broke: the blocking-dialog → RUN_ERROR path in `to-agui.ts` was
	 * unreachable in exactly the case it was written for, because the code that would have
	 * mapped it sat behind the await that the dialog was blocking. A guard downstream of the
	 * thing it guards against is not a guard.
	 *
	 * ⓘ `ctx.hasUI` is TRUE in rpc mode (pi's docs: the dialog methods "are functional via
	 * the extension UI sub-protocol"), so an extension's own `if (!ctx.hasUI) return` guard
	 * does not save us — pi genuinely expects an answer.
	 *
	 * Cancelling is honest rather than a workaround: this surface cannot ask the user
	 * anything yet (#12), so declining is the truthful answer. The extension receives
	 * `undefined`, the command completes as a no-op, and the observation still becomes a
	 * RUN_ERROR so the user learns why. Answering for real is #12's escalation channel.
	 */
	const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
	function cancelDialogIfBlocking(event: PiRpcEvent): void {
		if (event.type !== "extension_ui_request") return;
		if (!DIALOG_METHODS.has(String(event.method))) return;
		const id = String(event.id ?? "");
		if (id.length === 0) return;
		// Written straight to the transport: this is a RESPONSE keyed to the request's id,
		// not a command awaiting its own acknowledgement, so it must not go through `send`.
		transport.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
	}

	const client = new PiRpcClient({
		transport,
		onEvent: (event) => {
			// ⚠ Before queueing. This callback runs from the transport's data handler,
			// independent of any pending await — which is precisely why it can unblock pi
			// while the prompt acknowledgement is still outstanding.
			cancelDialogIfBlocking(event);
			pending.push(event);
			if (event.type === "agent_settled") settled = true;
			wake();
		},
		onParseError: (problem) => {
			onProblem?.(problem);
			// ⚠ A parse failure must not strand the stream. If pi is emitting garbage we will
			// never see `agent_settled`, so waking the generator lets it drain and finish
			// rather than hang on a promise nothing resolves.
			wake();
		},
	});

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
	 */
	const requestedCommand = slashCommandName(prompt);
	if (requestedCommand !== undefined) {
		const available = await fetchPiCommands(client);
		const known = available.some((command) => command.name === requestedCommand);
		if (!known) {
			yield {
				type: EventType.RUN_ERROR,
				runId: ids.runId,
				message:
					`/${requestedCommand} is not available on this surface. ` +
					`pi's built-in commands (/settings, /hotkeys, …) are terminal-only and cannot ` +
					`run over rpc. Available here: ${
						available.length === 0
							? "none"
							: available.map((command) => `/${command.name}`).join(", ")
					}`,
			};
			return;
		}
	}

	const response = await client.send({
		type: "prompt",
		message: prompt,
		...(images === undefined ? {} : { images }),
	});
	if (!response.success) {
		// A rejected prompt is a protocol outcome, not an exception — surface it as a run
		// error rather than throwing, so the client sees why instead of a dropped connection.
		yield {
			type: EventType.RUN_ERROR,
			runId: ids.runId,
			message: response.error ?? "pi rejected the prompt",
		};
		return;
	}

	/**
	 * Drain the queue, reporting whether anything was actually EMITTED.
	 *
	 * ⚠ The boolean is the whole point: an event that maps to no chunks — a dropped TUI
	 * status heartbeat, a start/end marker — is traffic, not progress, and must not renew
	 * the deadline.
	 */
	function* drain(): Generator<StreamChunk, boolean> {
		let emitted = false;
		while (pending.length > 0) {
			const event = pending.shift();
			if (event === undefined) break;
			for (const chunk of observationToAguiEvents(mapPiEvent(event), ids)) {
				emitted = true;
				yield chunk;
			}
		}
		return emitted;
	}

	let lastProgressAt = Date.now();

	while (true) {
		const madeProgress = yield* drain();
		if (madeProgress) lastProgressAt = Date.now();
		if (settled) return;

		if (Date.now() - lastProgressAt >= noProgressTimeoutMs) {
			// Nothing has been EMITTED for the whole window, whatever traffic arrived.
			yield {
				type: EventType.RUN_FINISHED,
				threadId: ids.threadId,
				runId: ids.runId,
			};
			return;
		}

		// Wake on the next event OR when the remaining window elapses — whichever first.
		// The loop then re-checks progress, so a heartbeat wakes us and changes nothing.
		const remaining = noProgressTimeoutMs - (Date.now() - lastProgressAt);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, Math.max(remaining, 1));
			notify = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}
}
