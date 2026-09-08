import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import {
	type PiEventDelivery,
	type PiPromptOutcome,
	type PiRpcEvent,
	type PiSession,
	ZenResumableSession,
	ZenThreadEvents,
	ZenThreadHistory,
	ZenThreadInspection,
	ZenThreadSummary,
} from "@zen/core";
import { Check } from "typebox/value";
import type { AgentHost, HostedSession, HostedSessionInspection } from "../../host/agent-host.ts";
import { createEventTail, describePiRpcEvent } from "../../host/event-tail.ts";
import { startZenServer } from "../index.ts";

/**
 * The chat handler's stop / release sequencing, over real HTTP (#76 — promised on #74).
 *
 * `server/index.ts` had no test: whether a normal completion aborts the thread's session
 * (it must not — #74's review found it did), whether a client abort does (it must), whether
 * a parked dialog keeps the session, and whether a second prompt on the same thread reuses
 * the session (#43) were all receipt-by-reasoning. A fake host whose sessions record
 * `abort` / `dispose` calls, handed in through `ZenServerOptions.host`, makes each one an
 * assertion. The server binds port 0; `listening` yields the bound URL.
 */

interface FakeSessionRecord {
	aborts: number;
	disposed: number;
	prompts: string[];
}

interface FakeSessionScript {
	/** Called on every prompt; emit events through `emit`, signal acceptance via `outcome`. */
	onPrompt: (emit: (event: PiRpcEvent) => void, outcome: PiPromptOutcome, message: string) => void;
	onAnswer?: (emit: (event: PiRpcEvent) => void) => void;
}

function fakeHostedSession(script: FakeSessionScript): { hosted: HostedSession; record: FakeSessionRecord } {
	const listeners = new Set<(event: PiRpcEvent, delivery: PiEventDelivery) => void>();
	const record: FakeSessionRecord = { aborts: 0, disposed: 0, prompts: [] };
	// The fake records into the same tail the real host does, so the events route sees the
	// real shape (coalesced rows); it delivers only live, so every row is `live`. The real
	// host's held/replayed/dropped provenance is pinned in agent-host.test.ts.
	const emitted = createEventTail();
	const emit = (event: PiRpcEvent): void => {
		const described = describePiRpcEvent(event);
		emitted.record(described.type, described.name, "live");
		for (const listener of listeners) listener(event, "live");
	};
	const session: PiSession = {
		prompt: (request, outcome) => {
			record.prompts.push(request.message);
			script.onPrompt(emit, outcome, request.message);
		},
		answerDialog: () => {
			script.onAnswer?.(emit);
		},
		listCommands: () => [{ name: "mode", source: "extension" }],
		permissionModeState: () => ({ mode: "default", available: ["default", "acceptEdits"] }),
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
		dispose: () => {
			record.disposed += 1;
		},
	};
	// A branch shaped like pi's, with a picc `modes` entry, and NO file on disk — the
	// unflushed state #86's inspection must report honestly rather than invent (#86).
	const inspect = (): HostedSessionInspection => ({
		sessionId: "session-1",
		cwd: "/fake/cwd",
		sessionDir: "/fake/agent/sessions/--fake-cwd--",
		sessionFile: null,
		entries: [
			{ type: "session", id: "root", parentId: null, timestamp: "2026-09-08T00:00:00.000Z" },
			{
				type: "custom",
				customType: "modes",
				data: { mode: "plan" },
				id: "m1",
				parentId: "root",
				timestamp: "2026-09-08T00:00:01.000Z",
			},
		],
		commands: ["mode", "plan"],
	});
	return { hosted: { session, loadedExtensionPaths: [], inspect, emittedEvents: emitted.recent }, record };
}

/** What the fake host "has on disk" (#95): stored sessions by thread id, with their branch. */
interface FakeStoredSession {
	readonly branch: unknown[];
	readonly modified: Date;
	readonly firstMessage: string;
}

function fakeHost(script: FakeSessionScript, stored: Record<string, FakeStoredSession> = {}) {
	const built: FakeSessionRecord[] = [];
	/** Thread ids the host was asked to build, in order — the resume path passes the id through. */
	const requested: string[] = [];
	const host: AgentHost = {
		createSession: (threadId) => {
			requested.push(threadId);
			const next = fakeHostedSession(script);
			built.push(next.record);
			return Promise.resolve(next.hosted);
		},
		listSessions: () =>
			Promise.resolve(
				Object.entries(stored).map(([id, session]) => ({
					id,
					path: `/stored/${id}.jsonl`,
					modified: session.modified,
					messageCount: session.branch.filter((entry) => (entry as { type?: unknown }).type === "message").length,
					firstMessage: session.firstMessage,
				})),
			),
		readBranch: (threadId) => Promise.resolve(stored[threadId]?.branch),
	};
	return { host, built, requested };
}

/** A harness dir with an empty pi manifest — enough for `assertVendorLinks` to pass. */
function emptyHarnessDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "zen-handler-harness-"));
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fake-harness", pi: {} }));
	return directory;
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

function neverPrompted(): void {
	// The 400 path must reject before any prompt reaches a session.
}

const openServers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	for (const started of openServers.splice(0)) await started.close();
});

async function startWith(script: FakeSessionScript, stored: Record<string, FakeStoredSession> = {}) {
	const { host, built, requested } = fakeHost(script, stored);
	const started = startZenServer({
		cwd: tmpdir(),
		harnessPackageDir: emptyHarnessDir(),
		agentDir: mkdtempSync(join(tmpdir(), "zen-handler-agent-")),
		port: 0,
		host,
	});
	openServers.push(started);
	const url = await started.listening;
	return { url, built, requested };
}

/** POST one AG-UI run and return every SSE chunk, parsed, in order. */
async function postRunChunks(url: string, body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
	const response = await fetch(`${url}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await response.text())
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

/** POST one AG-UI run and return the SSE chunk types in order. */
async function postRun(url: string, body: Record<string, unknown>): Promise<string[]> {
	return (await postRunChunks(url, body)).map((chunk) => String(chunk.type));
}

const userMessage = (content: string) => ({ role: "user", content });

// #96: a notify the session emits while the run is listening crosses the wire tagged
// `origin: "run"` — the browser renders it open. The session-start half of the tag rides the
// real host's replay, pinned in agent-host.test.ts and seen live in the fold.
test("a notify emitted during a run reaches the wire as zen.notify with origin run", async () => {
	const { url } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "refused", notifyType: "warning" });
			emit(SETTLED);
		},
	});
	const chunks = await postRunChunks(url, { threadId: "t1", runId: "r1", messages: [userMessage("hi")] });
	const notify = chunks.find((chunk) => chunk.type === EventType.CUSTOM && chunk.name === "zen.notify");
	expect(notify?.value).toMatchObject({ message: "refused", notifyType: "warning", origin: "run" });
});

test("⚠ a normal completion releases the thread and does NOT abort the session (#74 review)", async () => {
	const { url, built } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(TEXT_DELTA);
			emit(SETTLED);
		},
	});
	const types = await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("hello")] });
	expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
	expect(built).toHaveLength(1);
	expect(built[0]?.aborts).toBe(0);
	expect(built[0]?.disposed).toBe(0);
});

test("⚠ two prompts on one thread reuse ONE session; a second thread gets its own (#43 over HTTP)", async () => {
	const { url, built } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(SETTLED);
		},
	});
	await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("one")] });
	await postRun(url, { threadId: "t1", runId: "r2", messages: [userMessage("two")] });
	expect(built).toHaveLength(1);
	expect(built[0]?.prompts).toEqual(["one", "two"]);
	await postRun(url, { threadId: "t2", runId: "r3", messages: [userMessage("three")] });
	expect(built).toHaveLength(2);
	expect(built.map((record) => record.aborts)).toEqual([0, 0]);
});

test("⚠ a client that aborts mid-run makes the server abort the session's run, exactly once, and never dispose it", async () => {
	const { url, built } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(TEXT_DELTA);
			// never settles — the client will walk away
		},
	});
	const controller = new AbortController();
	const request = fetch(`${url}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ threadId: "t1", runId: "r1", messages: [userMessage("hello")] }),
		signal: controller.signal,
	});
	// Let the first chunk flow, then drop the connection.
	const response = await request;
	const reader = response.body?.getReader();
	await reader?.read();
	controller.abort();
	// The response 'close' fires on the server; give it a moment.
	for (let attempt = 0; attempt < 50 && (built[0]?.aborts ?? 0) === 0; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(built[0]?.aborts).toBe(1);
	expect(built[0]?.disposed).toBe(0);
});

test("⚠ a parked dialog neither aborts nor disposes; the resume completes on the same session", async () => {
	const { url, built } = await startWith({
		onPrompt: (emit, _outcome, message) => {
			if (message === "/mode") emit(SELECT_DIALOG);
		},
		onAnswer: (emit) => {
			emit(SETTLED);
		},
	});
	const first = await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("/mode")] });
	expect(first.at(-1)).toBe(EventType.RUN_FINISHED);
	expect(built[0]?.aborts).toBe(0);

	const resumed = await postRun(url, {
		threadId: "t1",
		runId: "r2",
		parentRunId: "r1",
		resume: [{ interruptId: "d1", status: "resolved", payload: { value: "a" } }],
		messages: [],
	});
	expect(resumed.at(-1)).toBe(EventType.RUN_FINISHED);
	expect(built).toHaveLength(1);
	expect(built[0]?.aborts).toBe(0);
	expect(built[0]?.disposed).toBe(0);
});

test("a malformed body is a plain 400, no session built", async () => {
	const { url, built } = await startWith({ onPrompt: neverPrompted });
	const response = await fetch(`${url}/api/chat`, { method: "POST", body: "{not json" });
	expect(response.status).toBe(400);
	expect(built).toHaveLength(0);
});

// The header's first paint (#84): what a fresh thread starts in, answered WITHOUT building
// a session — asking must not be the thing that spins pi up.
test("GET /api/mode reports the fresh-thread mode and picc's modes, and builds no session", async () => {
	const { url, built } = await startWith({ onPrompt: neverPrompted });
	const response = await fetch(`${url}/api/mode`);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		mode: "default",
		available: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
	});
	expect(built).toHaveLength(0);
});

// ── session inspection (#86) ─────────────────────────────────────────────────

// ⚠ LOOKING MUST NOT BUILD. `peek`, never `acquire`: an inspection request for a thread
// that has never run must be a 404, not the thing that spins pi up for it.
test("⚠ inspecting an unknown thread is a 404 and builds no session", async () => {
	const { url, built } = await startWith({ onPrompt: neverPrompted });
	const listed = await fetch(`${url}/api/threads`);
	expect(await listed.json()).toEqual([]);
	const response = await fetch(`${url}/api/threads/never-ran`);
	expect(response.status).toBe(404);
	expect(built).toHaveLength(0);
});

// ⚠ A BAD URL MUST NOT KILL THE SERVER. `decodeURIComponent` throws on a malformed escape,
// and before the guard that throw escaped the request listener and took the whole process
// down — every live session with it — from one hand-typed URL (PR #87 review, reproduced).
// The decisive assertion is the SECOND request: the server is still there to answer it.
test("⚠ a malformed thread id is a 400, and the server survives to answer the next request", async () => {
	const { url, built } = await startWith({ onPrompt: neverPrompted });
	const malformed = await fetch(`${url}/api/threads/%`);
	expect(malformed.status).toBe(400);
	const afterwards = await fetch(`${url}/api/threads`);
	expect(afterwards.status).toBe(200);
	expect(built).toHaveLength(0);
});

test("a percent-encoded thread id round-trips to the same live thread", async () => {
	const { url } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(SETTLED);
		},
	});
	await postRun(url, { threadId: "thread with spaces", runId: "r1", messages: [userMessage("hi")] });
	const response = await fetch(`${url}/api/threads/${encodeURIComponent("thread with spaces")}`);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ threadId: "thread with spaces" });
});

test("GET /api/threads/:id returns the branch as pi holds it, with sessionFile null while unflushed", async () => {
	const { url } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(SETTLED);
		},
	});
	await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("hello")] });
	const response = await fetch(`${url}/api/threads/t1`);
	expect(response.status).toBe(200);
	const inspection: unknown = await response.json();
	// Closed schema: a host internal cannot leak by an accidental spread.
	expect(Check(ZenThreadInspection, inspection)).toBe(true);
	expect(inspection).toMatchObject({
		threadId: "t1",
		sessionId: "session-1",
		sessionFile: null,
		permissionMode: { mode: "default", available: ["default", "acceptEdits"] },
		commands: ["mode", "plan"],
		busy: false,
		parked: false,
	});
	// The branch is verbatim — the picc `modes` entry a reader would cross-check against.
	const entries = (inspection as ZenThreadInspection).entries;
	expect(entries).toHaveLength(2);
	expect(entries[1]).toMatchObject({ type: "custom", customType: "modes", data: { mode: "plan" } });
});

// #97: the two tails of one run, read after it — what the host emitted and what the server wrote,
// each in its own order. The sent tail is recorded at the SSE writer, so it is the wire's order by
// construction; the test pins that the record matches what the client actually received.
test("GET /api/threads/:id/events returns the emitted and sent tails of a run, in wire order, deltas coalesced", async () => {
	const { url } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(TEXT_DELTA);
			emit(TEXT_DELTA);
			emit(TEXT_DELTA);
			emit(SETTLED);
		},
	});
	const received = await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("hello")] });
	const response = await fetch(`${url}/api/threads/t1/events`);
	expect(response.status).toBe(200);
	const events: unknown = await response.json();
	expect(Check(ZenThreadEvents, events)).toBe(true);
	const { emitted, sent } = events as ZenThreadEvents;
	// The host's funnel: three deltas fold into one row with an exact count, then the settle.
	expect(emitted.map((event) => [event.type, event.count])).toEqual([
		["message_update", 3],
		["agent_settled", 1],
	]);
	// The wire: the sent tail, expanded by its counts, IS the chunk sequence the client got.
	const sentExpanded = sent.flatMap((event) => Array.from({ length: event.count }, () => event.type));
	expect(sentExpanded).toEqual(received);
	expect(sent.every((event) => event.provenance === "sent")).toBe(true);
	expect(sent[0]).toMatchObject({ type: EventType.RUN_STARTED, count: 1 });
	expect(sent.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, count: 1 });
});

test("⚠ the events route of an unknown thread is a 404 and builds no session; a malformed id is a 400", async () => {
	const { url, built } = await startWith({ onPrompt: neverPrompted });
	expect((await fetch(`${url}/api/threads/never-ran/events`)).status).toBe(404);
	expect((await fetch(`${url}/api/threads/%/events`)).status).toBe(400);
	expect((await fetch(`${url}/api/threads`)).status).toBe(200);
	expect(built).toHaveLength(0);
});

// ── resume (#95) ─────────────────────────────────────────────────────────────

const STORED_BRANCH: unknown[] = [
	{ type: "custom", customType: "modes", data: { mode: "plan" }, id: "p", parentId: null, timestamp: "" },
	{
		type: "message",
		id: "u1",
		parentId: "p",
		timestamp: "2026-09-08T10:00:00.000Z",
		message: { role: "user", content: "earlier question", timestamp: 1 },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: "2026-09-08T10:00:05.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
	},
];

test("⚠ a prompt on a thread passes THAT id to the host — the thread id is pi's session id, so a stored one reopens", async () => {
	const { url, requested } = await startWith({
		onPrompt: (emit, outcome) => {
			outcome.onAccepted();
			emit(SETTLED);
		},
	});
	await postRun(url, { threadId: "stored-1", runId: "r1", messages: [userMessage("continue")] });
	expect(requested).toEqual(["stored-1"]);
});

test("GET /api/sessions lists stored sessions with title, count and age, marking the ones a thread here is RUNNING", async () => {
	const stored = {
		"stored-1": {
			branch: STORED_BRANCH,
			modified: new Date("2026-09-08T10:00:05.000Z"),
			firstMessage: "earlier question",
		},
		"stored-2": { branch: [] as unknown[], modified: new Date("2026-09-08T11:00:00.000Z"), firstMessage: "   " },
	};
	const { url } = await startWith(
		{
			onPrompt: (emit, _outcome, message) => {
				if (message === "/mode") emit(SELECT_DIALOG);
			},
		},
		stored,
	);
	// A parked dialog holds stored-1 busy on this server: acquired, never released.
	await postRun(url, { threadId: "stored-1", runId: "r1", messages: [userMessage("/mode")] });
	const response = await fetch(`${url}/api/sessions`);
	expect(response.status).toBe(200);
	const listed: unknown = await response.json();
	expect(Array.isArray(listed) && listed.every((session) => Check(ZenResumableSession, session))).toBe(true);
	expect(listed).toEqual([
		{
			threadId: "stored-1",
			title: "earlier question",
			lastActivityAt: "2026-09-08T10:00:05.000Z",
			messageCount: 2,
			busy: true,
		},
		// A blank first message is no title — the rail says "new session", not "   ".
		{ threadId: "stored-2", lastActivityAt: "2026-09-08T11:00:00.000Z", messageCount: 0, busy: false },
	]);
});

test("GET /api/threads/:id/history serves a STORED thread's branch as messages with its persisted mode, and builds no session", async () => {
	const stored = { "stored-1": { branch: STORED_BRANCH, modified: new Date(0), firstMessage: "earlier question" } };
	const { url, built } = await startWith({ onPrompt: neverPrompted }, stored);
	const response = await fetch(`${url}/api/threads/stored-1/history`);
	expect(response.status).toBe(200);
	const history: unknown = await response.json();
	expect(Check(ZenThreadHistory, history)).toBe(true);
	expect(history).toMatchObject({
		threadId: "stored-1",
		permissionMode: { mode: "plan" },
		messages: [
			{ id: "u1", role: "user", parts: [{ type: "text", content: "earlier question" }] },
			{ id: "a1", role: "assistant", parts: [{ type: "text", content: "earlier answer" }] },
		],
	});
	expect(built).toHaveLength(0);
	// Neither live nor stored: 404, still nothing built.
	expect((await fetch(`${url}/api/threads/never-existed/history`)).status).toBe(404);
	expect(built).toHaveLength(0);
});

// ⚠ HELD IS NOT BUSY (PR #104 review). A released thread stays cached for the idle window;
// gating on presence locked a reloaded page out of its own session for thirty minutes.
test("⚠ a thread this server holds IDLE is resumable — /history reads pi's memory, /sessions does not mark it busy", async () => {
	const stored = { t1: { branch: STORED_BRANCH, modified: new Date(0), firstMessage: "earlier question" } };
	const { url, built } = await startWith(
		{
			onPrompt: (emit, outcome) => {
				outcome.onAccepted();
				emit(SETTLED);
			},
		},
		stored,
	);
	await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("hello")] });
	const listed = (await (await fetch(`${url}/api/sessions`)).json()) as ZenResumableSession[];
	expect(listed.find((session) => session.threadId === "t1")?.busy).toBe(false);
	const response = await fetch(`${url}/api/threads/t1/history`);
	expect(response.status).toBe(200);
	const history = (await response.json()) as ZenThreadHistory;
	// The fake's LIVE mode is `default` while its stored file says `plan`: an idle live
	// thread's history is what pi holds now, the session's own answer, not the file's.
	expect(history.permissionMode).toEqual({ mode: "default", available: ["default", "acceptEdits"] });
	// Its in-memory branch carries no messages (a session-start entry and picc's modes entry).
	expect(history.messages).toEqual([]);
	expect(built).toHaveLength(1);
});

test("⚠ GET /api/threads/:id/history refuses a thread that is BUSY here, even if a stale rail made it clickable", async () => {
	const { url, built } = await startWith({
		onPrompt: (emit, _outcome, message) => {
			if (message === "/mode") emit(SELECT_DIALOG);
		},
	});
	await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("/mode")] });
	const response = await fetch(`${url}/api/threads/t1/history`);
	expect(response.status).toBe(409);
	expect(await response.text()).toContain("running on this server");
	expect(built).toHaveLength(1);
});

test("GET /api/threads lists live threads with busy and parked state", async () => {
	const { url } = await startWith({
		onPrompt: (emit, _outcome, message) => {
			if (message === "/mode") emit(SELECT_DIALOG);
		},
	});
	// A parked dialog holds the thread: acquired, never released, a question pending.
	await postRun(url, { threadId: "parked-thread", runId: "r1", messages: [userMessage("/mode")] });
	const summaries: unknown = await (await fetch(`${url}/api/threads`)).json();
	expect(Array.isArray(summaries) && summaries.every((summary) => Check(ZenThreadSummary, summary))).toBe(true);
	expect(summaries).toMatchObject([{ threadId: "parked-thread", busy: true, parked: true, sessionFile: null }]);
});

test("⚠ a bind conflict rejects `listening` instead of hanging, and reports the clash (#81 review)", async () => {
	const { host } = fakeHost({ onPrompt: neverPrompted });
	// Occupy a real port by letting the OS pick one (port 0).
	const first = startZenServer({
		cwd: tmpdir(),
		harnessPackageDir: emptyHarnessDir(),
		agentDir: mkdtempSync(join(tmpdir(), "zen-handler-agent-")),
		port: 0,
		host,
	});
	openServers.push(first);
	const occupied = Number(new URL(await first.listening).port);

	// Asking for the same port must not dangle: before the fix `listening` never settled
	// (Bun does not re-fire 'listening' after an 'error'), so `await listening` hung forever.
	// Now it rejects, and the human-readable clash still reaches `onProblem`.
	const problems: unknown[] = [];
	const second = startZenServer({
		cwd: tmpdir(),
		harnessPackageDir: emptyHarnessDir(),
		agentDir: mkdtempSync(join(tmpdir(), "zen-handler-agent-")),
		port: occupied,
		host,
		onProblem: (problem) => problems.push(problem),
	});
	openServers.push(second);
	await expect(second.listening).rejects.toThrow();
	expect(problems.some((problem) => typeof problem === "string" && problem.includes("already in use"))).toBe(true);
});

test("⚠ a client that drops mid-resume aborts the parked run's session exactly once and keeps it (#81 review)", async () => {
	const { url, built } = await startWith({
		onPrompt: (emit, _outcome, message) => {
			if (message === "/mode") emit(SELECT_DIALOG);
		},
		onAnswer: (emit) => {
			// One chunk so the client can observe the resume is live, then it never settles —
			// the client walks away mid-resume.
			emit(TEXT_DELTA);
		},
	});
	// First run parks on a dialog; its own response has ended, so only the resume path's
	// close hook (index.ts:234-238) can fire below.
	const first = await postRun(url, { threadId: "t1", runId: "r1", messages: [userMessage("/mode")] });
	expect(first.at(-1)).toBe(EventType.RUN_FINISHED);
	expect(built[0]?.aborts).toBe(0);

	// Resume, read one real chunk (proving the loop is running and the close hook is
	// registered), then drop the connection before the run settles.
	const controller = new AbortController();
	const response = await fetch(`${url}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			threadId: "t1",
			runId: "r2",
			parentRunId: "r1",
			resume: [{ interruptId: "d1", status: "resolved", payload: { value: "a" } }],
			messages: [],
		}),
		signal: controller.signal,
	});
	const reader = response.body?.getReader();
	await reader?.read();
	controller.abort();
	// Poll the real server-side side effect (the fake session's abort count) rather than a
	// fixed sleep: the response 'close' → stopParked → session.abort hop crosses the event
	// loop over real HTTP, with no promise the handler exposes to await directly.
	for (let attempt = 0; attempt < 50 && (built[0]?.aborts ?? 0) === 0; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(built).toHaveLength(1);
	expect(built[0]?.aborts).toBe(1);
	expect(built[0]?.disposed).toBe(0);
});
