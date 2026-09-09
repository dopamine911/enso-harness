import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import type { ZenFollowFrame } from "@zen/core";
import { createFollowConnection, type FollowConnection } from "../follow-connection.ts";
import { createScriptedFetch, type ScriptedFetch, SNAPSHOT_IDLE } from "./scripted-server.ts";

/**
 * The adapter is the ONLY place AG-UI is made (#112). These drive it with a scripted server
 * — an SSE body the test writes frames into, a prompt route the test answers — and read the
 * chunks TanStack would see. Event-driven: every assertion waits for the chunk it names.
 */

interface ScriptedServer extends ScriptedFetch {
	readonly connection: FollowConnection;
	readonly problems: string[];
	/** What TanStack would see, in order. */
	readonly chunks: StreamChunk[];
	/** Resolves once at least `count` chunks have arrived. */
	readonly untilChunks: (count: number) => Promise<void>;
	/** Abort the subscription — the client's own leaving. */
	readonly abort: () => void;
}

/** The adapter subscribed to a scripted server (`scripted-server.ts`), with its chunks collected. */
function scripted(
	promptStatus?: { status: number; body: unknown },
	dialogStatus?: number,
	abortStatus?: number,
): ScriptedServer {
	const server = createScriptedFetch({
		...(promptStatus === undefined ? {} : { promptStatus }),
		...(dialogStatus === undefined ? {} : { dialogStatus }),
		...(abortStatus === undefined ? {} : { abortStatus }),
	});
	const problems: string[] = [];
	const connection = createFollowConnection({
		threadId: "t1",
		fetch: server.fetch,
		onProblem: (problem) => problems.push(String(problem)),
	});
	const chunks: StreamChunk[] = [];
	const waiters: Array<() => void> = [];
	const controller = new AbortController();
	void (async () => {
		for await (const chunk of connection.subscribe(controller.signal)) {
			chunks.push(chunk);
			for (const waiter of waiters.splice(0)) waiter();
		}
		for (const waiter of waiters.splice(0)) waiter();
	})();
	return {
		...server,
		connection,
		problems,
		chunks,
		untilChunks: (count) => {
			if (chunks.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			const check = (): void => {
				if (chunks.length >= count) resolve();
				else waiters.push(check);
			};
			waiters.push(check);
			return promise;
		},
		abort: () => controller.abort(),
	};
}

test("⚠ a released status ends the run — the slash-command case, which never settles", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "/mode");
	await server.untilChunks(5);
	server.frame({ type: "status", live: true, busy: true, generation: 1 });
	server.frame({ type: "status", live: true, busy: false, generation: 1 });
	await server.untilChunks(8);
	expect(server.chunks[7]).toEqual({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" });
	server.abort();
});

test("⚠ an earlier run's ending frames cannot close a run whose receipt is still pending; the receipt closes it if the server already moved past it", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	const release = server.holdPrompt();
	const sending = send(server, "/mode");
	await server.untilChunks(5); // RUN_STARTED r1 at admission, receipt still out
	// The server took and released generation 1 before the receipt came back.
	server.frame({ type: "status", live: true, busy: true, generation: 1 });
	server.frame({ type: "status", live: true, busy: false, generation: 1 });
	await server.untilChunks(6);
	expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false);
	release();
	await sending;
	await server.untilChunks(8);
	expect(server.chunks[7]).toEqual({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" });
	server.abort();
});

const send = (server: ScriptedServer, message: string, runId = "r1") =>
	server.connection.send(
		[{ id: "u1", role: "user", parts: [{ type: "text", content: message }] }],
		undefined,
		undefined,
		{
			threadId: "t1",
			runId,
			clientTools: [],
			forwardedProps: {},
		},
	);

test("the snapshot becomes the mode, open-question and run receipts the stores already read", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	expect(server.chunks).toEqual([
		{ type: EventType.CUSTOM, name: "zen.mode", value: { mode: "default", available: ["default", "plan"] } },
		{ type: EventType.CUSTOM, name: "zen.open-dialogs", value: { open: [] } },
		{ type: EventType.CUSTOM, name: "zen.run", value: { generation: 0 } },
	]);
	server.abort();
});

test("send opens TanStack's own run at admission; the thread's settle closes it", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);

	await send(server, "hello");
	expect(server.prompts).toEqual([{ message: "hello" }]);
	await server.untilChunks(5);
	expect(server.chunks.slice(3)).toEqual([
		{ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
		{ type: EventType.TEXT_MESSAGE_START, messageId: expect.any(String), role: "assistant" },
	]);
	const opened = server.chunks[4];
	const messageId = opened !== undefined && "messageId" in opened ? String(opened.messageId) : "";

	// The server's status for OUR generation is not a second run.
	server.frame({ type: "status", live: true, busy: true, generation: 1 });
	server.frame({ type: "observation", seq: 1, observation: { kind: "text-delta", contentIndex: 0, delta: "hi" } });
	server.frame({ type: "observation", seq: 2, observation: { kind: "settled" } });
	server.frame({ type: "status", live: true, busy: false, generation: 1 });
	await server.untilChunks(9);
	expect(server.chunks.slice(5)).toEqual([
		{ type: EventType.CUSTOM, name: "zen.run", value: { generation: 1 } },
		{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "hi" },
		{ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
		{ type: EventType.CUSTOM, name: "zen.run", value: { generation: 1 } },
	]);
	server.abort();
});

test("⚠ a run another client started is synthesised so this tab renders what it is watching", async () => {
	const server = scripted();
	server.frame({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 4 });
	await server.untilChunks(5);
	expect(server.chunks.slice(3)).toEqual([
		{ type: EventType.RUN_STARTED, threadId: "t1", runId: "external-4" },
		{ type: EventType.TEXT_MESSAGE_START, messageId: expect.any(String), role: "assistant" },
	]);
	server.frame({ type: "observation", seq: 1, observation: { kind: "settled" } });
	await server.untilChunks(6);
	expect(server.chunks[5]).toEqual({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "external-4" });
	server.abort();
});

test("a refused prompt (400) is a run error with the server's reason, and no run stays open", async () => {
	const server = scripted({ status: 400, body: "/settings is not available on this surface" });
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "/settings");
	await server.untilChunks(6);
	expect(server.chunks[5]).toEqual({
		type: EventType.RUN_ERROR,
		runId: "r1",
		message: "/settings is not available on this surface",
	});
	server.abort();
});

test("⚠ a prompt pi rejects after admission reaches the run as an error, by the receipt's message id", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "hello");
	await server.untilChunks(5);
	server.frame({
		type: "observation",
		seq: 1,
		observation: { kind: "prompt-rejected", messageId: "pm1", reason: "Agent is already processing" },
	});
	await server.untilChunks(6);
	expect(server.chunks[5]).toEqual({ type: EventType.RUN_ERROR, runId: "r1", message: "Agent is already processing" });
	server.abort();
});

// PR #113 review: the queued-prompt path rejects the instant `session.prompt` runs, before
// the 202 body is written — the follow can deliver the rejection before the receipt names the run.
test("⚠ a rejection that beats its own receipt is held and still ends the run with its reason", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	const release = server.holdPrompt();
	const sending = send(server, "hello");
	await server.untilChunks(5);
	server.frame({
		type: "observation",
		seq: 1,
		observation: { kind: "prompt-rejected", messageId: "pm1", reason: "Agent is already processing" },
	});
	// Nothing yet: no run is named pm1 until the receipt lands.
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	expect(server.chunks).toHaveLength(5);
	release();
	await sending;
	await server.untilChunks(6);
	expect(server.chunks[5]).toEqual({ type: EventType.RUN_ERROR, runId: "r1", message: "Agent is already processing" });
	server.abort();
});

test("answerDialog names what the server did: answered (204), gone (404), refused (422)", async () => {
	expect(await scripted(undefined, 204).connection.answerDialog({ id: "d1", value: "a" })).toBe("answered");
	const gone = scripted(undefined, 404);
	expect(await gone.connection.answerDialog({ id: "d1", value: "a" })).toBe("gone");
	const refused = scripted(undefined, 422);
	expect(await refused.connection.answerDialog({ id: "d1", value: "zzz" })).toBe("refused");
	expect(refused.problems).toEqual([expect.stringContaining("refused: 422")]);
});

test("abort is one POST to …/abort and names what the server did; it closes no run itself — the feed does (#116)", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "hello");
	await server.untilChunks(5);
	expect(await server.connection.abort()).toBe("aborted");
	expect(server.abortCount()).toBe(1);
	// Nothing closed here: the run ends when the server's settle arrives, like any run.
	expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false);
	server.frame({ type: "observation", seq: 1, observation: { kind: "settled" } });
	server.frame({ type: "status", live: true, busy: false, generation: 1 });
	await server.untilChunks(7);
	expect(server.chunks).toContainEqual({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" });
	server.abort();

	expect(await scripted(undefined, 204, 409).connection.abort()).toBe("idle");
	const gone = scripted(undefined, 204, 404);
	expect(await gone.connection.abort()).toBe("gone");
	expect(gone.problems).toEqual([expect.stringContaining("abort gone: 404")]);
});

// PR #120 review: the callers fire-and-forget (`void connection.abort()`), so a network
// failure must be an OUTCOME the adapter reports, never a rejection that escapes them.
test("a unary POST that never gets an answer is `unreachable` — reported once, not thrown (#116)", async () => {
	const problems: string[] = [];
	const connection = createFollowConnection({
		threadId: "t1",
		fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
		onProblem: (problem) => problems.push(String(problem)),
	});
	expect(await connection.abort()).toBe("unreachable");
	expect(await connection.answerDialog({ id: "d1", value: "a" })).toBe("unreachable");
	expect(problems).toEqual([
		expect.stringContaining("abort unreachable: TypeError: fetch failed"),
		expect.stringContaining("dialog d1 unreachable: TypeError: fetch failed"),
	]);
});

test("⚠ a blocking question crosses as zen.dialog — no interrupt, no run boundary — and the answer is one POST", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "/mode");
	await server.untilChunks(5);
	server.frame({
		type: "observation",
		seq: 1,
		observation: {
			kind: "extension-ui-request",
			id: "d1",
			method: "select",
			blocking: true,
			origin: "run",
			dialog: { method: "select", title: "Pick", options: ["a", "b"] },
		},
	});
	await server.untilChunks(6);
	expect(server.chunks[5]).toEqual({
		type: EventType.CUSTOM,
		name: "zen.dialog",
		value: { id: "d1", dialog: { method: "select", title: "Pick", options: ["a", "b"] } },
	});
	expect(await server.connection.answerDialog({ id: "d1", value: "a" })).toBe("answered");
	expect(server.dialogs).toEqual([{ id: "d1", value: "a" }]);
	// The run is still open — nothing finished for the question.
	expect(server.chunks.some((chunk) => chunk.type === EventType.RUN_FINISHED)).toBe(false);
	server.abort();
});

test("an unreadable blocking request is declined on pi's behalf and told to the user", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "/mode");
	await server.untilChunks(5);
	server.frame({
		type: "observation",
		seq: 1,
		observation: { kind: "extension-ui-request", id: "d9", method: "custom", blocking: true, origin: "run" },
	});
	await server.untilChunks(6);
	expect(server.chunks[5]).toMatchObject({ type: EventType.RUN_ERROR, runId: "r1" });
	// The decline is a real POST, awaited through the same seam.
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	expect(server.dialogs).toEqual([{ id: "d9", cancelled: true }]);
	server.abort();
});

test("⚠ the follow closing under an open run is a run error, then the ending is said as a chunk — not when this page leaves", async () => {
	const server = scripted();
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	await send(server, "hello");
	await server.untilChunks(5);
	server.closeFollow();
	await server.untilChunks(7);
	expect(server.chunks[5]).toMatchObject({
		type: EventType.RUN_ERROR,
		runId: "r1",
		message: expect.stringContaining("closed"),
	});
	// #103 receipt, step 8: the server went away; the page is told even with no run open.
	expect(server.chunks[6]).toEqual({ type: EventType.CUSTOM, name: "zen.follow-ended", value: { threadId: "t1" } });

	// This page leaving (abort) is not the server ending: no chunk.
	const leaving = scripted();
	leaving.frame(SNAPSHOT_IDLE);
	await leaving.untilChunks(3);
	leaving.abort();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(leaving.chunks.some((chunk) => chunk.type === EventType.CUSTOM && chunk.name === "zen.follow-ended")).toBe(
		false,
	);
});

test("a frame that fails the wire schema is reported and skipped, never rendered", async () => {
	const server = scripted();
	server.frame({ type: "status", live: true, busy: "yes", generation: 1 } as unknown as ZenFollowFrame);
	server.frame(SNAPSHOT_IDLE);
	await server.untilChunks(3);
	expect(server.problems).toEqual([expect.stringContaining("fails ZenFollowFrame")]);
	expect(server.chunks[0]).toMatchObject({ name: "zen.mode" });
	server.abort();
});
