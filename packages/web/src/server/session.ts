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

	// A bounded queue between the callback-driven client and this generator. pi pushes; the
	// generator pulls. Without it, events emitted between yields would be lost.
	const pending: PiRpcEvent[] = [];
	let settled = false;
	let notify: (() => void) | undefined;
	const wake = () => {
		notify?.();
		notify = undefined;
	};

	const client = new PiRpcClient({
		transport,
		onEvent: (event) => {
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

	while (true) {
		while (pending.length > 0) {
			const event = pending.shift();
			if (event === undefined) break;
			for (const chunk of observationToAguiEvents(mapPiEvent(event), ids)) yield chunk;
		}
		if (settled) return;
		await new Promise<void>((resolve) => {
			notify = resolve;
		});
	}
}
