import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecorder } from "@logtape/testing/recorder";
import {
	isZenDialogSpec,
	type PiDialogResponse,
	type PiEventDelivery,
	type PiPromptOutcome,
	type PiPromptRequest,
	type PiRpcEvent,
	type PiSession,
	ZEN_IMAGE_MAX_BYTES,
	ZEN_PROMPT_BODY_MAX_BYTES,
	ZEN_PROMPT_MAX_IMAGES,
	type ZenDialogSpec,
	type ZenFollowFrame,
} from "@zen/core";
import { recordZenLogs, releaseZenLogs } from "../../__tests__/log-recorder.ts";
import type { AgentHost, HostedSession } from "../../host/agent-host.ts";
import { startZenServer } from "../index.ts";
import { type OpenFollow, openFollow as openSharedFollow } from "./follow-reader.ts";

/**
 * The wire, measured (#109's receipt, kept as the contract — #112). Each test is one
 * property of the prompt/follow split over a scripted host. Read the test names as the
 * findings.
 *
 * The fake's `emit` is exposed to the test, so every scenario advances by emitting the pi
 * event that would arrive and awaiting the frame it produces — never a guessed delay.
 */

interface FakeRecord {
	prompts: PiPromptRequest[];
	answers: PiDialogResponse[];
	aborts: number;
	disposed: number;
	/** What pi holds behind the run; a stop clears it and the route hands it back (#75). */
	queue: { steering: string[]; followUp: string[] };
}

interface FakeHost {
	readonly host: AgentHost;
	readonly built: FakeRecord[];
	/** Emit into the LAST built session — every scenario here uses one thread. */
	readonly emit: (event: PiRpcEvent) => void;
	/** Fire the last prompt's acceptance (a slash command's completion signal). */
	readonly accept: () => void;
}

function fakeHost(commands: string[] = ["mode"]): FakeHost {
	const built: FakeRecord[] = [];
	let emit: (event: PiRpcEvent) => void = () => undefined;
	let accept: () => void = () => undefined;
	const host: AgentHost = {
		createSession: () => {
			const listeners = new Set<(event: PiRpcEvent, delivery: PiEventDelivery) => void>();
			const record: FakeRecord = {
				prompts: [],
				answers: [],
				aborts: 0,
				disposed: 0,
				queue: { steering: [], followUp: [] },
			};
			built.push(record);
			/** Every blocking question this fake has emitted and not yet had answered — what the real host's `openDialog` reads. */
			const open = new Map<string, ZenDialogSpec>();
			emit = (event) => {
				if (event.type === "extension_ui_request" && typeof event.id === "string") {
					const { type: _type, id: _id, ...request } = event;
					if (isZenDialogSpec(request)) open.set(event.id, request);
				}
				for (const listener of listeners) listener(event, "live");
			};
			const session: PiSession = {
				prompt: (request: PiPromptRequest, outcome: PiPromptOutcome) => {
					record.prompts.push(request);
					accept = () => outcome.onAccepted();
				},
				answerDialog: (response) => {
					record.answers.push(response);
					// What the real host does at `finish` (#114): the settle is a record on the stream.
					if (open.delete(response.id)) {
						emit({
							type: "extension_ui_settled",
							id: response.id,
							outcome: "cancelled" in response ? "cancelled" : "answered",
						});
					}
				},
				openDialogs: () => [...open].map(([id, dialog]) => ({ id, dialog })),
				listCommands: () => commands.map((name) => ({ name, source: "extension" as const })),
				permissionModeState: () => ({ mode: "default", available: ["default", "plan"] }),
				subscribe: (onEvent) => {
					listeners.add(onEvent);
					return () => {
						listeners.delete(onEvent);
					};
				},
				abort: () => {
					record.aborts += 1;
					return Promise.resolve();
				},
				clearQueue: () => {
					const cleared = { steering: [...record.queue.steering], followUp: [...record.queue.followUp] };
					record.queue = { steering: [], followUp: [] };
					// pi emits the emptied queue to every follower.
					emit({ type: "queue_update", steering: [], followUp: [] });
					return cleared;
				},
				dispose: () => {
					record.disposed += 1;
				},
			};
			const hosted: HostedSession = {
				session,
				loadedExtensionPaths: [],
				inspect: () => ({ sessionId: "s1", cwd: "/", sessionDir: "/s", sessionFile: null, entries: [], commands }),
				emittedEvents: () => [],
			};
			return Promise.resolve(hosted);
		},
		listSessions: () => Promise.resolve([]),
		readBranch: () => Promise.resolve(undefined),
	};
	return { host, built, emit: (event) => emit(event), accept: () => accept() };
}

function emptyHarnessDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "zen-follow-harness-"));
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fake-harness", pi: {} }));
	return directory;
}

const openServers: Array<{ close: () => Promise<void> }> = [];
/** Every follow a test opened — aborted first, or a failed assertion leaves `server.close()` waiting on it. */
const openFollows: AbortController[] = [];
afterEach(async () => {
	for (const follow of openFollows.splice(0)) follow.abort();
	for (const started of openServers.splice(0)) await started.close();
});

let logs: LogRecorder;
beforeAll(async () => {
	logs = await recordZenLogs();
});
beforeEach(() => logs.clear());
afterAll(releaseZenLogs);

async function startWith(fake: FakeHost, sseKeepaliveMs = 1000) {
	const started = startZenServer({
		cwd: tmpdir(),
		harnessPackageDir: emptyHarnessDir(),
		agentDir: mkdtempSync(join(tmpdir(), "zen-follow-agent-")),
		logsDir: mkdtempSync(join(tmpdir(), "zen-logs-")),
		port: 0,
		host: fake.host,
		sseKeepaliveMs,
	});
	openServers.push(started);
	return await started.listening;
}

async function openFollow(url: string, threadId: string): Promise<OpenFollow> {
	const controller = new AbortController();
	openFollows.push(controller);
	return await openSharedFollow(url, threadId, controller);
}

async function prompt(url: string, threadId: string, message: string) {
	const response = await fetch(`${url}/api/threads/${threadId}/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message }),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function threadSummary(url: string, threadId: string) {
	const summaries = (await (await fetch(`${url}/api/threads`)).json()) as Array<Record<string, unknown>>;
	return summaries.find((summary) => summary.threadId === threadId);
}

const SETTLED: PiRpcEvent = { type: "agent_settled" };
const TEXT_DELTA: PiRpcEvent = {
	type: "message_update",
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
};
const SELECT_DIALOG: PiRpcEvent = {
	type: "extension_ui_request",
	id: "d1",
	method: "select",
	title: "Pick",
	options: ["a", "b"],
};

// ── 1. prompt is admission; the thread's own settle releases it ──────────────────────

test("prompt answers at admission with a message id; the run is released by pi's settle, no HTTP response in between", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const follow = await openFollow(url, "t1");
	await follow.untilFrames(1);
	// Observation preceded the first prompt: an empty snapshot, not a 404.
	expect(follow.frames[0]).toMatchObject({ type: "snapshot", live: false, busy: false, generation: 0, messages: [] });

	const admitted = await prompt(url, "t1", "hello");
	expect(admitted.status).toBe(202);
	expect(admitted.body).toMatchObject({ threadId: "t1", generation: 1, queued: false });
	expect(typeof admitted.body.messageId).toBe("string");
	// The admission is a record (#132): the same ids as the receipt, so a bundle joins them.
	logs.assertLogged({
		level: "info",
		rawMessage: "prompt {messageId} {admission} on run {generation}",
		properties: { threadId: "t1", messageId: admitted.body.messageId, generation: 1, admission: "opened" },
	});
	// Nothing has been emitted yet, and the prompt has already been answered.
	expect(fake.built[0]?.prompts.map((request) => request.message)).toEqual(["hello"]);
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: true, generation: 1 });

	// The follow saw the thread come alive and get taken — status frames, in order.
	await follow.untilFrames(3);
	expect(follow.frames.slice(1)).toEqual([
		{ type: "status", live: true, busy: false, generation: 0 },
		{ type: "status", live: true, busy: true, generation: 1 },
	]);

	fake.emit(TEXT_DELTA);
	fake.emit(SETTLED);
	await follow.untilFrames(6);
	expect(follow.frames.slice(3)).toEqual([
		{ type: "observation", seq: 1, observation: expect.objectContaining({ kind: "text-delta" }) },
		{ type: "observation", seq: 2, observation: { kind: "settled" } },
		{ type: "status", live: true, busy: false, generation: 1 },
	]);
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: false });

	// The trace (#132): the spine at `info` — built, acquired, the settle, released — and the
	// delta at `debug` as a COUNT, its text nowhere below `trace`.
	logs.assertLogged({ level: "info", rawMessage: /^thread built/, properties: { threadId: "t1", generation: 0 } });
	logs.assertLogged({
		level: "info",
		rawMessage: "run {generation} acquired",
		properties: { threadId: "t1", generation: 1 },
	});
	logs.assertLogged({
		level: "debug",
		category: ["zen", "server", "events"],
		properties: { threadId: "t1", generation: 1, seq: 1, kind: "text-delta", chars: 2 },
	});
	logs.assertLogged({ level: "info", category: ["zen", "server", "events"], properties: { seq: 2, kind: "settled" } });
	logs.assertLogged({
		level: "info",
		rawMessage: /^run \{generation\} released/,
		properties: { threadId: "t1", generation: 1 },
	});
	const payload = logs.find({ level: "trace", properties: { seq: 1 } });
	expect(payload?.properties.observation).toMatchObject({ kind: "text-delta", delta: "hi" });
	// Below trace, the text appears in no record's properties.
	expect(
		logs.records
			.filter((record) => record.level !== "trace")
			.some((record) => JSON.stringify(record.properties).includes('"hi"')),
	).toBe(false);
	follow.close();
});

test("⚠ POST …/abort tells pi once and answers with the restored queue; the run still ends on the follow by its settle, not by the route (#116, #75)", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const follow = await openFollow(url, "t1");
	await follow.untilFrames(1);
	const abortWith = (threadId: string) => fetch(`${url}/api/threads/${threadId}/abort`, { method: "POST" });

	// Nothing live: 404. Idle after a run: 409. Neither reaches the session.
	expect((await abortWith("never")).status).toBe(404);
	await prompt(url, "t1", "hello");
	await follow.untilFrames(3);
	// Two prompts wait behind the run (pi's queue); the stop hands them back, steering first.
	const built = fake.built[0];
	if (built === undefined) throw new Error("no session built");
	built.queue.followUp.push("then this");
	built.queue.steering.push("wait — stop at the tests");
	const told = await abortWith("t1");
	expect(told.status).toBe(200);
	expect(await told.json()).toEqual({ threadId: "t1", restored: ["wait — stop at the tests", "then this"] });
	expect(built.aborts).toBe(1);
	// Both outcomes are records: the 404 above named its thread; the stop names what it handed back.
	logs.assertLogged({ level: "warning", rawMessage: /^abort refused/, properties: { threadId: "never", status: 404 } });
	logs.assertLogged({ level: "info", rawMessage: /^abort: queue of/, properties: { threadId: "t1", restored: 2 } });
	expect(built.queue).toEqual({ steering: [], followUp: [] });
	// The route released nothing: the thread is still busy until pi's own settle arrives.
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: true, generation: 1 });
	// Every follower saw the queue empty (pi's queue_update from clearQueue), then the settle.
	await follow.untilFrames(4);
	expect(follow.frames[3]).toEqual({
		type: "observation",
		seq: 1,
		observation: { kind: "queue", steering: [], followUp: [] },
	});
	fake.emit(SETTLED);
	await follow.untilFrames(6);
	expect(follow.frames.slice(4)).toEqual([
		{ type: "observation", seq: 2, observation: { kind: "settled" } },
		{ type: "status", live: true, busy: false, generation: 1 },
	]);
	const idle = await abortWith("t1");
	expect(idle.status).toBe(409);
	expect(await idle.text()).toContain("nothing is running");
	expect(fake.built[0]?.aborts).toBe(1);
	follow.close();
});

// ── 2. a dialog parks nothing ─────────────────────────────────────────────────────────

test("⚠ a blocking dialog is an observation on the follow and a unary answer back — nothing parks, nothing expires", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const follow = await openFollow(url, "t1");
	await follow.untilFrames(1);

	const admitted = await prompt(url, "t1", "/mode");
	expect(admitted.status).toBe(202);
	fake.emit(SELECT_DIALOG);
	await follow.untilFrames(4);
	expect(follow.frames[3]).toMatchObject({
		type: "observation",
		observation: { kind: "extension-ui-request", id: "d1", blocking: true, dialog: expect.anything() },
	});
	// The thread is busy; nothing anywhere holds the question but pi itself.
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: true });

	// An unoffered value is refused at the door (#112) — the seam the old resume path
	// closed with the same check; the question stays open, nothing reaches pi.
	const answerWith = (body: Record<string, unknown>) =>
		fetch(`${url}/api/threads/t1/dialog`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const refused = await answerWith({ id: "d1", value: "zzz" });
	expect(refused.status).toBe(422);
	expect(await refused.text()).toContain("refused");
	const unknown = await answerWith({ id: "nope", value: "a" });
	expect(unknown.status).toBe(404);
	expect(fake.built[0]?.answers).toEqual([]);

	const answered = await answerWith({ id: "d1", value: "a" });
	expect(answered.status).toBe(204);
	expect(fake.built[0]?.answers).toEqual([{ id: "d1", value: "a" }]);
	// Answered: the question is spent, a replay is refused.
	expect((await answerWith({ id: "d1", value: "a" })).status).toBe(404);

	// A slash command's completion is its acceptance (it never settles) — the lease follows it.
	// Before it: the answer's own settle (#114), so this tab's card drops by the feed, not by faith.
	fake.accept();
	await follow.untilFrames(6);
	expect(follow.frames[4]).toEqual({
		type: "observation",
		seq: 2,
		observation: { kind: "dialog-settled", id: "d1", outcome: "answered" },
	});
	expect(follow.frames[5]).toEqual({ type: "status", live: true, busy: false, generation: 1 });
	expect(fake.built[0]?.aborts).toBe(0);
	follow.close();
});

test("⚠ a question answered in one tab is settled on every follower's feed, and a follow opened under it gets it in the snapshot (#114)", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const first = await openFollow(url, "t1");
	const second = await openFollow(url, "t1");
	await prompt(url, "t1", "/mode");
	fake.emit(SELECT_DIALOG);
	await first.untilFrames(4);
	await second.untilFrames(4);

	// A third follower arrives while pi waits: the question is in ITS snapshot — a reload
	// under an open question renders the card, not a busy thread with nothing to answer.
	const late = await openFollow(url, "t1");
	await late.untilFrames(1);
	expect(late.frames[0]).toMatchObject({
		type: "snapshot",
		busy: true,
		openDialogs: [{ id: "d1", dialog: { method: "select", title: "Pick", options: ["a", "b"] } }],
	});

	// The first tab answers; the second and the late one learn it without touching the route.
	const answered = await fetch(`${url}/api/threads/t1/dialog`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: "d1", value: "a" }),
	});
	expect(answered.status).toBe(204);
	const settled: ZenFollowFrame = {
		type: "observation",
		seq: 2,
		observation: { kind: "dialog-settled", id: "d1", outcome: "answered" },
	};
	await second.untilFrames(5);
	await late.untilFrames(2);
	expect(second.frames[4]).toEqual(settled);
	expect(late.frames[1]).toEqual(settled);

	// And a follow opened after the settle lists nothing.
	const after = await openFollow(url, "t1");
	await after.untilFrames(1);
	expect(after.frames[0]).toMatchObject({ type: "snapshot", openDialogs: [] });
	for (const follow of [first, second, late, after]) follow.close();
});

// ── 3. silence ends nothing ───────────────────────────────────────────────────────────

test("⚠ a long silent tool call ends nothing: the follow stays open on keepalives and the thread stays busy", async () => {
	const fake = fakeHost();
	// A keepalive interval far shorter than the run path's 90 s cutoff, so three of them
	// are a silence the cutoff would have called a hung run.
	const url = await startWith(fake, 5);
	const follow = await openFollow(url, "t1");
	await prompt(url, "t1", "hello");
	await follow.untilFrames(3);

	await follow.untilComments(3);
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: true });
	expect(follow.frames).toHaveLength(3);

	fake.emit(SETTLED);
	await follow.untilFrames(5);
	expect(follow.frames.at(-1)).toEqual({ type: "status", live: true, busy: false, generation: 1 });
	follow.close();
});

// ── 4. a follower leaving is not a client leaving a run ───────────────────────────────

test("⚠ closing the follow mid-run aborts nothing — the run is pi's, not the connection's", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const follow = await openFollow(url, "t1");
	await prompt(url, "t1", "hello");
	await follow.untilFrames(3);
	follow.close();

	// A second follower opens a NEW generation: a fresh snapshot, taken live, mid-run.
	const again = await openFollow(url, "t1");
	await again.untilFrames(1);
	expect(again.frames[0]).toMatchObject({ type: "snapshot", live: true, busy: true, generation: 1 });
	expect(fake.built[0]?.aborts).toBe(0);
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: true });

	fake.emit(SETTLED);
	await again.untilFrames(3);
	expect(again.frames.at(-1)).toEqual({ type: "status", live: true, busy: false, generation: 1 });
	again.close();
});

test("⚠ two followers share one feed: both see every frame with the same seq, and one leaving detaches nothing", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const first = await openFollow(url, "t1");
	const second = await openFollow(url, "t1");
	await first.untilFrames(1);
	await second.untilFrames(1);

	await prompt(url, "t1", "hello");
	fake.emit(TEXT_DELTA);
	await first.untilFrames(4);
	await second.untilFrames(4);
	expect(second.frames.slice(1)).toEqual(first.frames.slice(1));
	expect(first.frames[3]).toMatchObject({ type: "observation", seq: 1 });

	// The first follower leaves; the feed stays attached for the second (the last-listener
	// detach must count listeners, not followers that ever existed).
	first.close();
	fake.emit(SETTLED);
	await second.untilFrames(6);
	expect(second.frames.slice(4)).toEqual([
		{ type: "observation", seq: 2, observation: { kind: "settled" } },
		{ type: "status", live: true, busy: false, generation: 1 },
	]);
	second.close();
});

test("a confirm dialog round-trips through /dialog; a value answer to it is refused", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const follow = await openFollow(url, "t1");
	await prompt(url, "t1", "/mode");
	fake.emit({
		type: "extension_ui_request",
		id: "c1",
		method: "confirm",
		title: "Apply?",
		message: "It is reversible",
	});
	await follow.untilFrames(4);
	const answerWith = (body: Record<string, unknown>) =>
		fetch(`${url}/api/threads/t1/dialog`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	expect((await answerWith({ id: "c1", value: "yes" })).status).toBe(422);
	expect((await answerWith({ id: "c1", confirmed: true })).status).toBe(204);
	expect(fake.built[0]?.answers).toEqual([{ id: "c1", confirmed: true }]);
	follow.close();
});

// ── 5. a busy thread queues through pi (#75) ──────────────────────────────────────────

test("a prompt on a busy thread is queued through pi as a followUp, not refused and not re-acquired", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const first = await prompt(url, "t1", "one");
	expect(first.body).toMatchObject({ generation: 1, queued: false });
	const second = await prompt(url, "t1", "two");
	expect(second.status).toBe(202);
	expect(second.body).toMatchObject({ generation: 1, queued: true });
	expect(fake.built[0]?.prompts).toEqual([{ message: "one" }, { message: "two", streamingBehavior: "followUp" }]);
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: true, generation: 1 });
});

// ── 7. two threads are two feeds (#103 invariant 1) ────────────────────────────────

test("⚠ what happens on thread A is on A's feed only: B's follow, snapshot, summary and dialog route see none of it", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	// B first, then A, so the fake's emitter targets A's session (it follows the latest build).
	await prompt(url, "b", "hello from b");
	const followB = await openFollow(url, "b");
	await followB.untilFrames(1);
	await prompt(url, "a", "/mode");
	const followA = await openFollow(url, "a");
	await followA.untilFrames(1);
	fake.emit(SELECT_DIALOG);
	fake.emit(TEXT_DELTA);
	await followA.untilFrames(3);
	expect(
		followA.frames.slice(1).map((frame) => (frame.type === "observation" ? frame.observation.kind : frame.type)),
	).toEqual(["extension-ui-request", "text-delta"]);
	// B's feed: its own snapshot, nothing after — no seq advanced, no question, no text.
	await followB.untilComments(2);
	expect(followB.frames).toHaveLength(1);
	expect(followB.frames[0]).toMatchObject({ type: "snapshot", threadId: "b", busy: true, openDialogs: [] });
	// A follow opened on B NOW still lists no question; the summaries are per thread.
	const lateB = await openFollow(url, "b");
	await lateB.untilFrames(1);
	expect(lateB.frames[0]).toMatchObject({ type: "snapshot", threadId: "b", openDialogs: [] });
	expect(await threadSummary(url, "a")).toMatchObject({ busy: true, generation: 1 });
	expect(await threadSummary(url, "b")).toMatchObject({ busy: true, generation: 1 });
	// A's question cannot be answered through B: the id is not one of B's open questions.
	const crossed = await fetch(`${url}/api/threads/b/dialog`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: "d1", value: "a" }),
	});
	expect(crossed.status).toBe(404);
	expect(fake.built.map((record) => record.answers)).toEqual([[], []]);
	for (const follow of [followA, followB, lateB]) follow.close();
});

// ── 6. refusals are plain HTTP, not stream events ─────────────────────────────────────

test("an unknown slash command is a 400 at admission and releases the thread", async () => {
	const fake = fakeHost(["mode"]);
	const url = await startWith(fake);
	const refused = await fetch(`${url}/api/threads/t1/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: "/settings" }),
	});
	expect(refused.status).toBe(400);
	expect(await refused.text()).toContain("/settings is not available");
	expect(fake.built[0]?.prompts).toEqual([]);
	expect(await threadSummary(url, "t1")).toMatchObject({ busy: false });
});

test("a whitespace-only message is a 400 before any lease or session exists", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const refused = await fetch(`${url}/api/threads/t1/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: "   " }),
	});
	expect(refused.status).toBe(400);
	expect(fake.built).toHaveLength(0);
	expect(await threadSummary(url, "t1")).toBeUndefined();
});

// ── 9. images on a prompt (#68) ─────────────────────────────────────────────────────

/** A real 1×1 PNG — signature `89 50 4E 47`, IHDR, IDAT, IEND — the smallest file a decoder accepts. */
const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

async function promptWith(url: string, threadId: string, body: unknown) {
	const response = await fetch(`${url}/api/threads/${threadId}/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, text: await response.text() };
}

test("a real PNG's bytes reach pi's prompt.images unchanged, byte for byte; the audit record carries the count and kinds, never the data", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const data = ONE_PIXEL_PNG.toString("base64");
	const admitted = await promptWith(url, "t1", {
		message: "what does this say?",
		images: [{ mimeType: "image/png", data }],
	});
	expect(admitted.status).toBe(202);

	const received = fake.built[0]?.prompts[0];
	expect(received?.message).toBe("what does this say?");
	expect(received?.images).toEqual([{ type: "image", mimeType: "image/png", data }]);
	expect(Buffer.from(received?.images?.[0]?.data ?? "", "base64").equals(ONE_PIXEL_PNG)).toBe(true);

	logs.assertLogged({
		level: "info",
		rawMessage: "prompt carries {count} image(s): {mimeTypes}, {bytes} bytes",
		// A predicate: the recorder compares values with `Object.is`, which no two arrays pass.
		properties: (properties) =>
			properties.threadId === "t1" &&
			properties.count === 1 &&
			JSON.stringify(properties.mimeTypes) === JSON.stringify(["image/png"]) &&
			properties.bytes === ONE_PIXEL_PNG.length,
	});
	expect(logs.records.map((record) => JSON.stringify(record.properties)).join("\n")).not.toContain(data.slice(0, 24));
});

test("[WARN] a text-only prompt has NO images key (the committed shape), and images ride a queued prompt on a busy thread too", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	await promptWith(url, "t1", { message: "one" });
	expect(fake.built[0]?.prompts[0]).toEqual({ message: "one" });
	expect(fake.built[0]?.prompts[0]).not.toHaveProperty("images");

	const data = ONE_PIXEL_PNG.toString("base64");
	const queued = await promptWith(url, "t1", { message: "and this", images: [{ mimeType: "image/webp", data }] });
	expect(queued.status).toBe(202);
	expect(fake.built[0]?.prompts[1]).toEqual({
		message: "and this",
		streamingBehavior: "followUp",
		images: [{ type: "image", mimeType: "image/webp", data }],
	});
});

test("[WARN] an image outside the allowlist, over the byte cap, or too many is a 400 that names the image and the reason — never silently dropped", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const data = ONE_PIXEL_PNG.toString("base64");

	const svg = await promptWith(url, "t1", { message: "x", images: [{ mimeType: "image/svg+xml", data }] });
	expect(svg.status).toBe(400);
	expect(svg.text).toContain("/images/0/mimeType");

	const notBase64 = await promptWith(url, "t1", {
		message: "x",
		images: [{ mimeType: "image/png", data: "data:image/png;base64,AAAA" }],
	});
	expect(notBase64.status).toBe(400);
	expect(notBase64.text).toContain("/images/0/data");

	// Over the cap by one byte, decoded — the base64 string is 4/3 longer and would pass a length check.
	const oversized = Buffer.alloc(ZEN_IMAGE_MAX_BYTES + 1).toString("base64");
	const big = await promptWith(url, "t1", {
		message: "x",
		images: [
			{ mimeType: "image/png", data },
			{ mimeType: "image/jpeg", data: oversized },
		],
	});
	expect(big.status).toBe(400);
	expect(big.text).toBe("image 2 of 2 is 5.0 MB; an image is at most 5.0 MB");

	const tooMany = await promptWith(url, "t1", {
		message: "x",
		images: Array.from({ length: ZEN_PROMPT_MAX_IMAGES + 1 }, () => ({ mimeType: "image/png", data })),
	});
	expect(tooMany.status).toBe(400);
	expect(tooMany.text).toContain("/images");

	const empty = await promptWith(url, "t1", { message: "x", images: [] });
	expect(empty.status).toBe(400);

	// Base64 that is not whole groups is "not base64", refused by path — not decoded leniently into a truncated image.
	const ragged = await promptWith(url, "t1", { message: "x", images: [{ mimeType: "image/png", data: "AAAAA" }] });
	expect(ragged.status).toBe(400);
	expect(ragged.text).toContain("/images/0/data");

	// None of them reached pi, and no session was built for a prompt that was refused at the door.
	expect(fake.built).toHaveLength(0);
});

test("the edges are inside: an image of exactly the cap, exactly the maximum count (a gif among them), and an image with no words at all", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	const data = ONE_PIXEL_PNG.toString("base64");

	const atCap = Buffer.alloc(ZEN_IMAGE_MAX_BYTES).toString("base64");
	expect(
		(await promptWith(url, "t1", { message: "x", images: [{ mimeType: "image/jpeg", data: atCap }] })).status,
	).toBe(202);
	expect(fake.built[0]?.prompts[0]?.images?.[0]?.data.length).toBe(atCap.length);

	const twenty = Array.from({ length: ZEN_PROMPT_MAX_IMAGES }, (_, index) => ({
		mimeType: index === 0 ? ("image/gif" as const) : ("image/png" as const),
		data,
	}));
	expect((await promptWith(url, "t1", { message: "x", images: twenty })).status).toBe(202);
	expect(fake.built[0]?.prompts[1]?.images?.map((image) => image.mimeType)).toEqual(
		twenty.map((image) => image.mimeType),
	);

	// An image with an empty message is a prompt: pi-ai drops the empty text block and keeps
	// the image (`anthropic-messages.js`, `filteredBlocks`). Only nothing-at-all is refused.
	expect((await promptWith(url, "t1", { message: "", images: [{ mimeType: "image/png", data }] })).status).toBe(202);
	expect(fake.built[0]?.prompts[2]).toMatchObject({ message: "", images: [{ type: "image", mimeType: "image/png" }] });
	expect((await promptWith(url, "t1", { message: "  " })).status).toBe(400);
});

test("[WARN] a body past the wire cap is a 413 and the read stops — the server does not buffer it first", async () => {
	const fake = fakeHost();
	const url = await startWith(fake);
	// Streamed in chunks so the cap has to trip mid-body, not on a Content-Length it never reads.
	const chunk = "x".repeat(1024 * 1024);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let sent = 0; sent <= ZEN_PROMPT_BODY_MAX_BYTES + chunk.length; sent += chunk.length) {
				controller.enqueue(new TextEncoder().encode(chunk));
			}
			controller.close();
		},
	});
	const response = await fetch(`${url}/api/threads/t1/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
		// @ts-expect-error — Bun accepts a streaming body with duplex; the lib types lag.
		duplex: "half",
	});
	expect(response.status).toBe(413);
	expect(await response.text()).toContain("a prompt body is at most");
	expect(fake.built).toHaveLength(0);
});
