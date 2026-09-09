import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import type { ModelMessage, UIMessage } from "@tanstack/ai/client";
import type { RunAgentInputContext, SubscribeConnectionAdapter } from "@tanstack/ai-client";
import {
	type PiDialogResponse,
	type ZenFollowFrame,
	ZenFollowFrame as ZenFollowFrameSchema,
	ZenPromptReceipt,
} from "@zen/core";
import { Check } from "typebox/value";
import {
	ZEN_CUSTOM_EVENT_MODE,
	ZEN_CUSTOM_EVENT_OPEN_DIALOGS,
	ZEN_CUSTOM_EVENT_RUN,
} from "./rpc/custom-event-names.ts";
import { type AguiIdentifiers, observationToAguiEvents } from "./rpc/to-agui.ts";

/**
 * The browser's connection to a thread (#112): TanStack's `SubscribeConnectionAdapter` over
 * the prompt/follow split.
 *
 *   subscribe()  opens `GET /api/threads/:id/follow` once and turns its frames into AG-UI
 *                chunks for as long as the view is attached.
 *   send()       POSTs `/api/threads/:id/prompt` and answers at admission; the run's events
 *                arrive on the subscription, not on the POST.
 *
 * ⚠ AG-UI IS MADE HERE AND ONLY HERE. The wire carries `ZenObservation` (`docs/architecture.md`,
 * decided constraints); this adapter derives the chunk vocabulary TanStack's client consumes,
 * in memory, per view. Nothing is stored in it and nothing else reads it.
 *
 * RUNS. TanStack minted the `runId` (`runContext.runId`) before calling `send`, and it
 * resolves its own loading state on `RUN_FINISHED`/`RUN_ERROR` for that id. So `send` emits
 * `RUN_STARTED` for the client's id at once — admission, in TanStack's own terms — and the
 * thread's `settled` observation closes every run this adapter has open. A run another client
 * started shows up as `status { busy }` with a generation this adapter did not send: it is
 * synthesised as `external-<generation>` so a second tab renders the transcript it is
 * watching (dsh: `followup()` is admission; a run is the interval to the next idle).
 *
 * MESSAGES. One assistant message per run, opened at `RUN_STARTED` — the same shape the run
 * path produced, so the renderers see nothing new. Per-message boundaries are on the wire
 * (`message-start`/`message-end`) for a later fold that wants them.
 *
 * DIALOGS. A blocking question is a `zen.dialog` CUSTOM chunk (`to-agui.ts`) into the thread's
 * dialog store; the answer is `answerDialog` below — a unary POST. No interrupt: the run keeps
 * going on the follow and nothing on the server parks. An unreadable blocking request is
 * declined here on pi's behalf, and the run error `to-agui.ts` emits tells the user.
 */

export interface FollowConnectionOptions {
	readonly threadId: string;
	/** Test seam: the page's `fetch`. */
	readonly fetch?: typeof fetch;
	/** Notified for anything the adapter could not deliver. Never silent. */
	readonly onProblem?: (problem: unknown) => void;
}

/** One run this adapter has open: its AG-UI ids and, once the receipt is in, the acquisition it took or queued behind. */
interface OpenRun {
	readonly runId: string;
	readonly messageId: string;
	/** The receipt's `messageId` — how a `prompt-rejected` names this run. Undefined for a run another client started. */
	promptMessageId: string | undefined;
	generation: number | undefined;
}
/** The last user message's text — what `send` prompts with. Images are #68. */
function latestUserText(messages: Array<UIMessage> | Array<ModelMessage>): string {
	for (let position = messages.length - 1; position >= 0; position -= 1) {
		const message: UIMessage | ModelMessage | undefined = messages[position];
		if (message === undefined || message.role !== "user") continue;
		if ("parts" in message) {
			return message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
		}
		if (typeof message.content === "string") return message.content;
		return (message.content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");
	}
	return "";
}

/** `data:` lines of an SSE body, one parsed frame at a time; comments (keepalives) are skipped. */
async function* readSseFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done) return;
			buffered += decoder.decode(value, { stream: true });
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("data: ")) yield JSON.parse(line.slice("data: ".length)) as unknown;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * What the server did with a dialog answer (#112, PR #113 review):
 *   `answered`  taken (204) — the question is spent.
 *   `gone`      no such open question (404) — answered from another tab, or expired. Spent too.
 *   `refused`   the answer did not fit the question (422: an unoffered value). The question is
 *               STILL OPEN on the server and must stay on screen.
 */
export type DialogAnswerOutcome = "answered" | "gone" | "refused";

export interface FollowConnection extends SubscribeConnectionAdapter {
	/** Answer the thread's open question. A non-`answered` outcome is also reported with the server's reason. */
	readonly answerDialog: (answer: PiDialogResponse) => Promise<DialogAnswerOutcome>;
}

export function createFollowConnection(options: FollowConnectionOptions): FollowConnection {
	const { threadId } = options;
	const fetchImpl = options.fetch ?? fetch;
	const onProblem = options.onProblem;
	const base = `/api/threads/${encodeURIComponent(threadId)}`;

	/** Chunks waiting for the subscription loop to take them — pushed by frames and by `send`. */
	const queue: StreamChunk[] = [];
	let wake: (() => void) | undefined;
	const runs = new Map<string, OpenRun>();
	/** The run observation chunks attach to: the most recently opened. */
	let current: OpenRun | undefined;
	/** `prompt-rejected` reasons that arrived before the receipt naming their run, by the receipt's `messageId`. */
	const rejectedBeforeReceipt = new Map<string, string>();

	function push(...chunks: StreamChunk[]): void {
		queue.push(...chunks);
		wake?.();
		wake = undefined;
	}

	function openRun(runId: string, promptMessageId: string | undefined, generation: number | undefined): OpenRun {
		const run: OpenRun = { runId, messageId: crypto.randomUUID(), promptMessageId, generation };
		runs.set(runId, run);
		current = run;
		push(
			{ type: EventType.RUN_STARTED, threadId, runId },
			{ type: EventType.TEXT_MESSAGE_START, messageId: run.messageId, role: "assistant" },
		);
		return run;
	}

	function closeRun(run: OpenRun, chunk: StreamChunk): void {
		runs.delete(run.runId);
		if (current === run) current = undefined;
		push(chunk);
	}

	function idsOf(run: OpenRun | undefined): AguiIdentifiers {
		return { threadId, runId: run?.runId ?? `external-${threadId}`, messageId: run?.messageId ?? threadId };
	}

	/** The server's latest word on the thread, from the last snapshot or status frame. */
	let serverGeneration = 0;
	let serverBusy = false;

	/**
	 * Close every run the server has moved past: `RUN_FINISHED` for each, so TanStack's
	 * loading state resolves. ⚠ A run whose generation is still unknown (its receipt has
	 * not come back) or newer than the server's is NOT closed — the frames ending an
	 * EARLIER run can arrive after this tab has already opened the next one, and closing
	 * that one here would end it before it started.
	 */
	function finishRunsThrough(generation: number): void {
		for (const run of [...runs.values()]) {
			if (run.generation === undefined || run.generation > generation) continue;
			closeRun(run, { type: EventType.RUN_FINISHED, threadId, runId: run.runId });
		}
	}

	/**
	 * The thread's status. Released (`busy: false`) is the server's statement that the run
	 * is over — the way a slash command ends, which never `settled`s (its completion is its
	 * acceptance). Busy under a generation this adapter did not send is a run another
	 * client started.
	 */
	function observeStatus(busy: boolean, generation: number): void {
		serverGeneration = generation;
		serverBusy = busy;
		push({ type: EventType.CUSTOM, name: ZEN_CUSTOM_EVENT_RUN, value: { generation } });
		if (!busy) {
			finishRunsThrough(generation);
			return;
		}
		for (const run of runs.values()) {
			if (run.generation === generation || run.generation === undefined) return;
		}
		openRun(`external-${generation}`, undefined, generation);
	}

	async function declineUnreadable(id: string): Promise<void> {
		// `gone` is fine — someone else settled it; only a refusal of a cancel is a problem.
		if ((await answerDialog({ id, cancelled: true })) === "refused") {
			onProblem?.(`thread ${threadId}: could not decline unreadable dialog ${id}`);
		}
	}

	function observe(frame: ZenFollowFrame): void {
		if (frame.type === "snapshot") {
			push({ type: EventType.CUSTOM, name: ZEN_CUSTOM_EVENT_MODE, value: frame.permissionMode });
			// The complete list, every snapshot (#114): a reconnect's snapshot is the resync,
			// so an empty list is a fact ("nothing is waiting") the browser must apply too.
			push({ type: EventType.CUSTOM, name: ZEN_CUSTOM_EVENT_OPEN_DIALOGS, value: { open: frame.openDialogs } });
			observeStatus(frame.busy, frame.generation);
			return;
		}
		if (frame.type === "status") {
			observeStatus(frame.busy, frame.generation);
			return;
		}
		const { observation } = frame;
		if (observation.kind === "settled") {
			finishRunsThrough(serverGeneration);
			return;
		}
		if (observation.kind === "prompt-rejected") {
			const run = [...runs.values()].find((open) => open.promptMessageId === observation.messageId);
			if (run === undefined) {
				// ⚠ The rejection can beat the receipt that names the run (the queued-prompt
				// path rejects the instant `session.prompt` runs, before the 202 body is even
				// written). Keep it; `send` looks here when its receipt lands.
				rejectedBeforeReceipt.set(observation.messageId, observation.reason);
				return;
			}
			closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: observation.reason });
			return;
		}
		if (observation.kind === "extension-ui-request" && observation.blocking && observation.dialog === undefined) {
			if (observation.id.length > 0) void declineUnreadable(observation.id);
		}
		push(...observationToAguiEvents(observation, idsOf(current)));
	}

	async function* subscribe(signal?: AbortSignal): AsyncIterable<StreamChunk> {
		const abort = signal ?? new AbortController().signal;
		const response = await fetchImpl(`${base}/follow`, { signal: abort });
		if (!response.ok || response.body === null) {
			throw new Error(`follow ${threadId}: ${response.status} ${await response.text()}`);
		}
		const frames = readSseFrames(response.body, abort);
		// Frames are consumed on their own loop so `send` can interleave chunks; this loop
		// yields whatever is queued, waiting when nothing is.
		let ended = false;
		const pump = (async () => {
			try {
				for await (const raw of frames) {
					if (!Check(ZenFollowFrameSchema, raw)) {
						onProblem?.(`thread ${threadId}: a frame off the wire fails ZenFollowFrame: ${JSON.stringify(raw)}`);
						continue;
					}
					observe(raw);
				}
			} catch (error) {
				if (!abort.aborted) onProblem?.(`thread ${threadId}: the follow failed: ${String(error)}`);
			} finally {
				ended = true;
				// The follow closed under open runs: the client would otherwise wait forever.
				for (const run of [...runs.values()]) {
					closeRun(run, {
						type: EventType.RUN_ERROR,
						runId: run.runId,
						message: "the follow closed before the run settled",
					});
				}
				wake?.();
				wake = undefined;
			}
		})();
		try {
			while (!abort.aborted) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		} finally {
			await pump;
		}
	}

	async function send(
		messages: Array<UIMessage> | Array<ModelMessage>,
		_data?: Record<string, unknown>,
		signal?: AbortSignal,
		runContext?: RunAgentInputContext,
	): Promise<void> {
		const run = openRun(runContext?.runId ?? crypto.randomUUID(), undefined, undefined);
		const message = latestUserText(messages);
		let response: Response;
		try {
			response = await fetchImpl(`${base}/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message }),
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			closeRun(run, {
				type: EventType.RUN_ERROR,
				runId: run.runId,
				message: `prompt could not be sent: ${String(error)}`,
			});
			return;
		}
		if (response.status !== 202) {
			closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: await response.text() });
			return;
		}
		const receipt: unknown = await response.json();
		if (!Check(ZenPromptReceipt, receipt)) {
			closeRun(run, {
				type: EventType.RUN_ERROR,
				runId: run.runId,
				message: "the prompt receipt did not match its schema",
			});
			return;
		}
		run.promptMessageId = receipt.messageId;
		run.generation = receipt.generation;
		// The rejection may already have crossed on the follow, before this receipt named the run.
		const rejection = rejectedBeforeReceipt.get(receipt.messageId);
		if (rejection !== undefined) {
			rejectedBeforeReceipt.delete(receipt.messageId);
			closeRun(run, { type: EventType.RUN_ERROR, runId: run.runId, message: rejection });
			return;
		}
		// A run so quick the server released it before its receipt came back (a slash
		// command that answered in the same tick): the status that ended it has already
		// passed through, so nothing later will close this run. Close it now.
		if (!serverBusy && serverGeneration >= receipt.generation) {
			closeRun(run, { type: EventType.RUN_FINISHED, threadId, runId: run.runId });
		}
	}

	async function answerDialog(answer: PiDialogResponse): Promise<DialogAnswerOutcome> {
		const response = await fetchImpl(`${base}/dialog`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(answer),
		});
		if (response.status === 204) return "answered";
		const outcome: DialogAnswerOutcome = response.status === 404 ? "gone" : "refused";
		onProblem?.(`thread ${threadId}: dialog ${answer.id} ${outcome}: ${response.status} ${await response.text()}`);
		return outcome;
	}

	return { subscribe, send, answerDialog };
}
