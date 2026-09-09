import type { ServerResponse } from "node:http";
import {
	PICC_PERMISSION_MODES,
	type PiDialogResponse,
	type PiPermissionModeState,
	type PiStreamingBehavior,
	persistedPermissionMode,
	type ZenInterruptedTail,
	type ZenObservation,
} from "@zen/core";
import type { AgentHost } from "../host/agent-host.ts";
import { branchToMessages, interruptedTail } from "../rpc/branch-to-messages.ts";
import { slashCommandName } from "./session.ts";
import { SSE_HEADERS, startSseKeepalive } from "./sse.ts";
import type { ThreadFeedFrame, ThreadSessions } from "./thread-sessions.ts";

/**
 * SPIKE #109 — deepseek-harness's prompt/follow split, beside the `/api/chat` run path.
 *
 * Three routes, none of which is a run:
 *
 *   POST /api/threads/:id/prompt   unary. Takes the thread, fires the prompt, answers at
 *                                  once with a message id. The thread's own `settled`
 *                                  releases it — not an HTTP response ending.
 *   GET  /api/threads/:id/follow   one snapshot frame, then observations and status
 *                                  frames for as long as the client stays. Observation
 *                                  only: never builds a session; a thread that is not live
 *                                  is served cold from its file and followed from build.
 *   POST /api/threads/:id/dialog   unary. A human's answer to a blocking dialog, delivered
 *                                  to the live session. Nothing parks: the extension's
 *                                  promise is still pending inside pi, the run keeps
 *                                  going on the follow.
 *
 * What this exists to MEASURE — see the receipt on #109: which of `dialog-registry.ts`,
 * `parentRunId`, `expiresAt`, `ChatRunOutcome.parkedAwaitingAnswer`, the no-progress
 * cutoff-as-run-ender and the slash-command grace are consequences of the run being the
 * HTTP response, and disappear once it is not.
 *
 * ⚠ Wire shapes are TS types here, not `@zen/core` TypeBox schemas — a spike's shortcut,
 * named so it is not mistaken for the rule.
 */

/** The first frame of every follow: the thread as of `asOfSeq`. Every later observation's `seq` is greater. */
export interface ZenFollowSnapshot {
	readonly type: "snapshot";
	readonly threadId: string;
	readonly asOfSeq: number;
	readonly live: boolean;
	readonly busy: boolean;
	readonly generation: number;
	readonly permissionMode: PiPermissionModeState;
	readonly messages: readonly unknown[];
	readonly interrupted?: ZenInterruptedTail;
}

export interface ZenFollowObservation {
	readonly type: "observation";
	readonly seq: number;
	readonly observation: ZenObservation;
}

export interface ZenFollowStatus {
	readonly type: "status";
	readonly live: boolean;
	readonly busy: boolean;
	readonly generation: number;
}

export type ZenFollowFrame = ZenFollowSnapshot | ZenFollowObservation | ZenFollowStatus;

/** What `POST …/prompt` answers with: admission, not a result (dsh: `followup()` returns void). */
export interface ZenPromptReceipt {
	readonly threadId: string;
	/** Minted here — the admission identity of this message, for a client to correlate. */
	readonly messageId: string;
	/** The acquisition this prompt took, or the one it queued behind. */
	readonly generation: number;
	/** The thread was busy: pi queued the message (`followUp`) behind the run in flight (#75). */
	readonly queued: boolean;
}

export interface FollowRouteDeps {
	readonly threads: ThreadSessions;
	readonly host: AgentHost;
	readonly sseKeepaliveMs: number;
	readonly onProblem: ((problem: unknown) => void) | undefined;
}

export interface PromptBody {
	readonly message: string;
	readonly streamingBehavior?: PiStreamingBehavior;
}

export type PromptOutcome =
	| { readonly status: 202; readonly receipt: ZenPromptReceipt }
	| { readonly status: 400; readonly reason: string };

function writeFrame(response: ServerResponse, frame: ZenFollowFrame): void {
	response.write(`data: ${JSON.stringify(frame)}\n\n`);
}

/**
 * Serve one follow. The snapshot is taken in the same tick as the subscription, so it is
 * exact as of `asOfSeq` and no observation can fall between the two (dsh: one complete
 * snapshot per generation, then only deltas; reconnect = a new follow = a new snapshot).
 */
export async function followThread(deps: FollowRouteDeps, threadId: string, response: ServerResponse): Promise<void> {
	const { threads, host } = deps;
	const live = threads.peek(threadId);
	// Cold read for a thread that is not live — the file, as `/history` reads it. Awaited
	// BEFORE subscribing: a thread built during the read is then seen live below. A thread
	// with neither a session nor a file is an EMPTY snapshot, not a 404: observation may
	// precede the first prompt, and must, or the prompt's opening events have no follower.
	const storedBranch = live === undefined ? await host.readBranch(threadId) : undefined;
	const nowLive = threads.peek(threadId);
	const branch = nowLive === undefined ? (storedBranch ?? []) : nowLive.hosted.inspect().entries;

	response.writeHead(200, SSE_HEADERS);
	const stopKeepalive = startSseKeepalive(response, deps.sseKeepaliveMs, deps.onProblem);
	const follow = threads.observe(threadId, (frame: ThreadFeedFrame) => {
		if (response.destroyed || response.writableEnded) return;
		writeFrame(
			response,
			frame.kind === "observation"
				? { type: "observation", seq: frame.seq, observation: frame.observation }
				: { type: "status", live: frame.live, busy: frame.busy, generation: frame.generation },
		);
	});
	response.once("close", () => {
		stopKeepalive();
		follow.unsubscribe();
	});

	const messages = branchToMessages(branch);
	const interrupted = interruptedTail(messages);
	writeFrame(response, {
		type: "snapshot",
		threadId,
		asOfSeq: follow.asOfSeq,
		live: nowLive !== undefined,
		busy: nowLive?.busy ?? false,
		generation: nowLive?.generation ?? 0,
		permissionMode:
			nowLive === undefined
				? { mode: persistedPermissionMode(branch), available: [...PICC_PERMISSION_MODES] }
				: nowLive.hosted.session.permissionModeState(),
		messages,
		...(interrupted === undefined ? {} : { interrupted }),
	});
}

/** The prompt body, shape-checked. Throws `Error`s whose message is the 400 text. */
export function readPromptBody(raw: string): PromptBody {
	let body: { message?: unknown; streamingBehavior?: unknown };
	try {
		body = JSON.parse(raw) as { message?: unknown; streamingBehavior?: unknown };
	} catch (error) {
		throw new Error(`malformed prompt body: ${String(error)}`);
	}
	if (typeof body.message !== "string" || body.message.length === 0) throw new Error("prompt body needs a message");
	if (body.streamingBehavior === undefined) return { message: body.message };
	if (body.streamingBehavior !== "steer" && body.streamingBehavior !== "followUp") {
		throw new Error("streamingBehavior must be steer or followUp");
	}
	return { message: body.message, streamingBehavior: body.streamingBehavior };
}

/**
 * Fire a prompt and answer at admission.
 *
 * A BUSY thread (a run in flight, or a dialog the follow is showing) is not refused and
 * not acquired again: the message goes to pi with a streaming behaviour (`followUp` unless
 * the caller asked to `steer`), which is #75's decision. The run in flight keeps its lease;
 * its `settled` releases the thread once everything queued has run.
 *
 * An IDLE thread is taken; the prompt's own `settled` (or, for a slash command, its
 * acceptance — an extension command never settles) releases it through the feed. No HTTP
 * response is open for any of this.
 */
export async function promptThread(deps: FollowRouteDeps, threadId: string, body: PromptBody): Promise<PromptOutcome> {
	const { threads, onProblem } = deps;
	const messageId = crypto.randomUUID();

	const live = threads.peek(threadId);
	if (live?.busy === true) {
		live.hosted.session.prompt(
			{ message: body.message, streamingBehavior: body.streamingBehavior ?? "followUp" },
			{
				onAccepted: () => undefined,
				onRejected: (reason: string) =>
					onProblem?.(`thread ${threadId}: queued prompt ${messageId} rejected: ${reason}`),
			},
		);
		return { status: 202, receipt: { threadId, messageId, generation: live.generation, queued: true } };
	}

	const lease = await threads.acquire(threadId);
	const command = slashCommandName(body.message);
	if (command !== undefined) {
		const available = lease.session.listCommands();
		if (!available.some((known) => known.name === command)) {
			lease.release();
			return {
				status: 400,
				reason: `/${command} is not available on this surface. Available here: ${
					available.length === 0 ? "none" : available.map((known) => `/${known.name}`).join(", ")
				}`,
			};
		}
	}

	// The run's end, observed the way a follower would: the thread's own `settled`.
	const settle = threads.observe(threadId, (frame: ThreadFeedFrame) => {
		if (frame.kind !== "observation" || frame.observation.kind !== "settled") return;
		settle.unsubscribe();
		lease.release();
	});
	lease.session.prompt(
		{
			message: body.message,
			...(body.streamingBehavior === undefined ? {} : { streamingBehavior: body.streamingBehavior }),
		},
		{
			onAccepted: () => {
				// An extension command's acceptance IS its completion (pi reports it after the
				// command ran); an ordinary prompt's acceptance is only admission.
				if (command === undefined) return;
				settle.unsubscribe();
				lease.release();
			},
			onRejected: (reason: string) => {
				onProblem?.(`thread ${threadId}: prompt ${messageId} rejected: ${reason}`);
				settle.unsubscribe();
				lease.release();
			},
		},
	);
	return { status: 202, receipt: { threadId, messageId, generation: lease.generation, queued: false } };
}

/** The dialog body: pi's response shape, keyed by the request id the follow showed. */
export function readDialogBody(raw: string): PiDialogResponse {
	let body: { id?: unknown; cancelled?: unknown; value?: unknown; confirmed?: unknown };
	try {
		body = JSON.parse(raw) as typeof body;
	} catch (error) {
		throw new Error(`malformed dialog body: ${String(error)}`);
	}
	if (typeof body.id !== "string" || body.id.length === 0) throw new Error("dialog body needs the request id");
	if (body.cancelled === true) return { id: body.id, cancelled: true };
	if (typeof body.value === "string") return { id: body.id, value: body.value };
	if (typeof body.confirmed === "boolean") return { id: body.id, confirmed: body.confirmed };
	throw new Error("dialog body needs cancelled, value, or confirmed");
}

/** Deliver the answer to the LIVE session — a thread that is not live has no question to answer. */
export function answerThreadDialog(deps: FollowRouteDeps, threadId: string, answer: PiDialogResponse): 204 | 404 {
	const live = deps.threads.peek(threadId);
	if (live === undefined) return 404;
	live.hosted.session.answerDialog(answer);
	return 204;
}
