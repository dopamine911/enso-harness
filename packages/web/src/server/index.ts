import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import {
	PICC_DEFAULT_PERMISSION_MODE,
	PICC_PERMISSION_MODES,
	persistedPermissionMode,
	type ZenResumableSession,
	type ZenThreadEvents,
	type ZenThreadHistory,
	type ZenThreadInspection,
	type ZenThreadSummary,
} from "@zen/core";
import { type AgentHost, createAgentHost } from "../host/agent-host.ts";
import { describeStreamChunk, type EventTail } from "../host/event-tail.ts";
import { branchToMessages } from "../rpc/branch-to-messages.ts";
import { createDialogRegistry } from "./dialog-registry.ts";
import { type ChatRunOutcome, resumeChat, runChat } from "./session.ts";
import { createThreadSessions, type ThreadView } from "./thread-sessions.ts";

/** `GET /api/threads/<threadId>` — the id is one path segment, percent-encoded by the caller. */
const THREAD_ROUTE = /^\/api\/threads\/([^/?#]+)$/;
/** `GET /api/threads/<threadId>/events` — the thread's two event tails (#97). */
const THREAD_EVENTS_ROUTE = /^\/api\/threads\/([^/?#]+)\/events$/;
/** `GET /api/threads/<threadId>/history` — the branch as messages, live or stored (#95). */
const THREAD_HISTORY_ROUTE = /^\/api\/threads\/([^/?#]+)\/history$/;

/**
 * The dev backend: one SSE endpoint TanStack AI's `fetchServerSentEvents` can talk to (#24).
 *
 * ⚠ DEV ONLY, AND THE REASON IS NOT POLISH.
 * There is no sandbox (#24), `bash` is unconfined (#9), and `cwd` is the tree pi reads and
 * writes — so whatever this process accepts as `cwd` IS the blast radius. It therefore
 * binds loopback only and takes `cwd` from ITS OWN launch arguments, never from the request
 * body. Accepting a browser-supplied working directory is a deliberate, later decision that
 * should not happen by default, and doing it before #9 closes would mean a page could point
 * an unconfined agent at any path on the machine.
 */

const DEFAULT_PORT = 5179;
const LOOPBACK_ONLY = "127.0.0.1";
const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
	// Vite proxies in dev, so this is the same origin — but a stray buffering proxy would
	// hold the stream open and silent, which looks exactly like a hung agent.
	"X-Accel-Buffering": "no",
} as const;

/**
 * AG-UI's `RunAgentInput`, reduced to the fields this endpoint uses.
 *
 * `resume` + `parentRunId` mark a RESUME request — the browser answering a dialog that
 * interrupted an earlier run (#27). TanStack puts both in the POST body
 * (`connection-adapters.js:573-574`); their presence is what routes the request to the
 * parked session instead of a fresh one.
 */
interface RunAgentInputBody {
	threadId?: string;
	runId?: string;
	parentRunId?: string;
	resume?: unknown;
	messages?: Array<{ role?: string; content?: unknown }>;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

/** Last user message, flattened to text. Images are a later step — see the README. */
function latestUserPrompt(body: RunAgentInputBody): string {
	const messages = body.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.map((part) =>
					typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "",
				)
				.join("");
		}
	}
	return "";
}

/**
 * ⚠ `decodeURIComponent` THROWS on a malformed escape (`/api/threads/%`), and a throw in the
 * request listener has nothing above it — it took the whole dev server down, every live
 * session with it, from one hand-typed URL (PR #87 review, reproduced). A bad id is the
 * caller's problem: 400 written here, `undefined` returned, and the server stays up.
 */
function decodeThreadId(rawSegment: string, response: ServerResponse): string | undefined {
	try {
		return decodeURIComponent(rawSegment);
	} catch {
		response.writeHead(400, { "Content-Type": "text/plain" });
		response.end("malformed thread id");
		return undefined;
	}
}

function writeSseEvent(response: ServerResponse, chunk: StreamChunk, sent: EventTail | undefined): void {
	// The sent tail (#97) records here, at the one place every chunk crosses to the browser,
	// so the record and the wire cannot disagree. `undefined` only when the thread is not
	// live any more by the time a chunk is written — nothing to record it against.
	if (sent !== undefined) {
		const described = describeStreamChunk(chunk);
		sent.record(described.type, described.name, "sent");
	}
	// One `data:` line per event, blank line terminated — the SSE framing the adapter reads.
	response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export interface ZenServerOptions {
	/**
	 * Where pi runs — the tree it will read and write. With no sandbox (#24) this value IS
	 * the blast radius; it comes from the launcher's own arguments, never from a request.
	 */
	cwd: string;
	/**
	 * The zen-harness pi package directory, loaded as the ONLY extension source.
	 *
	 * ⚠ Required, not optional. An optional value here would make "no guards" the default
	 * for anyone who forgot it, which is exactly the state the first live run was in.
	 */
	harnessPackageDir: string;
	/** Scratch config dir for pi, so the operator's own packages stay invisible. */
	agentDir: string;
	port?: number;
	/** Notified for anything worth an operator's attention. Never swallowed. */
	onProblem?: (problem: unknown) => void;
	/**
	 * The pi host to use instead of building one from `cwd` / `agentDir` /
	 * `harnessPackageDir`. ⓘ Exists for `__tests__/server-handler.test.ts` (#76): a fake host
	 * whose sessions record abort/dispose is the only way to observe the handler's
	 * stop/release sequencing without a model. Production launchers never pass it.
	 */
	host?: AgentHost;
}

/*
 * ⚠⚠ THE FIRST LIVE RUN EXPOSED THIS, AND IT WAS A SECURITY DEFECT — kept as history because
 * the in-process host inherits the same obligation.
 *
 * The spawned `pi --mode rpc` inherited the environment, so pi loaded the OPERATOR'S GLOBAL
 * CONFIG — `~/.pi/agent`, all sixteen of their packages, and **not the zen harness**.
 * Observed directly in the first SSE stream: pi-lens status lines, powerline widgets and a
 * pi-multi-account advisor warning, none of which this package installs. The web surface
 * was running with **no Tier 0 guard at all**.
 *
 * The in-process host (`host/agent-host.ts`, #69) applies the same isolation as loader
 * options — `noExtensions`, `noSkills`, the harness dir as the only extension path — and
 * sets `PI_CODING_AGENT_DIR` on this process before the first session, because
 * pi-multi-account reads it at module import (spike receipt: unset, it read the operator's
 * real credentials again).
 */

/**
 * Refuse to start if the harness package's vendor links are missing.
 *
 * ⚠⚠ THIS EXISTS BECAUSE THE ABSENCE WAS SILENT AND THE SYMPTOM WAS UNRELATED.
 * `npm install` rebuilds `node_modules` and destroys the links `npm run link:vendor`
 * creates. When that happened, `pi -e <package>` loaded — pi SKIPS a missing manifest
 * resource path without a word — so `pi-multi-account` was simply absent, and the visible
 * failure was an HTTP 400 from the provider several layers away. Diagnosing that from the
 * 400 took a detour through expiry checks and rpc-mode hypotheses, none of which were the
 * cause.
 *
 * `scripts/zen.mjs` already refuses to launch on the same condition. The server had no
 * equivalent, which is the asymmetry this closes: two launch points, one precondition, and
 * it must be enforced at both or the unenforced one becomes the confusing path.
 */
function assertVendorLinks(harnessPackageDir: string): void {
	const manifestPath = join(harnessPackageDir, "package.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`zen-server: no package.json at ${harnessPackageDir}`);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		pi?: Record<string, string | string[]>;
	};
	const declared = Object.values(manifest.pi ?? {}).flatMap((paths) => (Array.isArray(paths) ? paths : [paths]));
	const missing = declared
		.filter((entry) => entry.startsWith("node_modules/"))
		.filter((entry) => !existsSync(resolve(harnessPackageDir, entry)));
	if (missing.length > 0) {
		throw new Error(
			`zen-server: vendor package paths are missing from the harness package:\n` +
				`${missing.map((entry) => `  - ${entry}`).join("\n")}\n` +
				`Run \`bun install\` (its postinstall relinks the vendor packages).`,
		);
	}
}

export function startZenServer(options: ZenServerOptions) {
	if (options.cwd.length === 0) {
		// ⚠ Fail at startup rather than on the first request. A bad `cwd` discovered mid-run
		// is a confusing failure; discovered at boot it is a one-line message.
		throw new Error("zen-server: cwd must not be empty");
	}
	assertVendorLinks(options.harnessPackageDir);

	// pi, in this process (#69). Creating the host sets the isolation env and pins the
	// multi-account config; sessions are created per chat THREAD below and live across runs
	// (#43 — a mode chosen on prompt 1 is in force on prompt 2).
	const host: AgentHost =
		options.host ??
		createAgentHost({
			cwd: options.cwd,
			agentDir: options.agentDir,
			harnessPackageDir: options.harnessPackageDir,
			onProblem: options.onProblem,
		});
	const threads = createThreadSessions({
		createSession: (threadId) => host.createSession(threadId),
		onProblem: options.onProblem,
	});

	// Parked pi sessions awaiting a human's answer to a dialog (#27). Owned by the server,
	// shared by every request; evicted whole on close.
	const registry = createDialogRegistry({ onProblem: options.onProblem });

	// The permission mode a FRESH thread starts in (#84). The browser asks once on mount,
	// before any run exists, so the header can read `default` instead of `unknown` from the
	// first paint. Honest by construction: every page load is a new thread, the host creates
	// a fresh session file for it, and picc's initial mode is `default`; the option list is
	// the set picc registers unconditionally (one command per mode). A thread's LIVE state —
	// after a change — rides on the run-start receipt, never here.
	function respondWithFreshThreadMode(response: ServerResponse): void {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ mode: PICC_DEFAULT_PERMISSION_MODE, available: [...PICC_PERMISSION_MODES] }));
	}

	// ── Session inspection (#86): what a live thread's session ACTUALLY contains, for a
	// human (the debug drawer) or an agent (`scripts/zen-session.mjs`) to cross-check the
	// derived views against. Read-only. Never creates a session — `threads.peek`, never
	// `acquire`: looking must not be the thing that spins pi up. Loopback-only by the
	// server's bind; the branch is conversation and tool output, which is the point.
	function summarize(thread: ThreadView): ZenThreadSummary {
		const inspection = thread.hosted.inspect();
		return {
			threadId: thread.threadId,
			sessionId: inspection.sessionId,
			sessionDir: inspection.sessionDir,
			sessionFile: inspection.sessionFile,
			mode: thread.hosted.session.permissionModeState().mode,
			busy: thread.busy,
			parked: registry.peek(thread.threadId) !== undefined,
			lastActivityAt: new Date(thread.lastActivityAt).toISOString(),
		};
	}

	function respondWithThreads(response: ServerResponse): void {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(threads.list().map(summarize)));
	}

	function respondWithThreadEvents(threadId: string, response: ServerResponse): void {
		const thread = threads.peek(threadId);
		if (thread === undefined) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end(`no live session for thread ${threadId}`);
			return;
		}
		const payload: ZenThreadEvents = {
			threadId,
			emitted: thread.hosted.emittedEvents(),
			sent: thread.sent.recent(),
		};
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(payload));
	}

	/**
	 * pi's session files for this workspace (#95) — what the rail can come back to. `busy`
	 * marks the ones a thread on THIS server is running right now; the rail shows those but
	 * does not offer them, and `/history` refuses them below.
	 */
	async function respondWithSessions(response: ServerResponse): Promise<void> {
		const stored = await host.listSessions();
		const payload: ZenResumableSession[] = stored.map((session) => ({
			threadId: session.id,
			...(session.firstMessage.trim().length === 0 ? {} : { title: session.firstMessage.trim() }),
			lastActivityAt: session.modified.toISOString(),
			messageCount: session.messageCount,
			busy: threads.peek(session.id)?.busy === true,
		}));
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(payload));
	}

	/**
	 * The thread's branch as the messages a chat mounts with (#95), plus its permission mode.
	 * Read-only — looking must not build (#86).
	 *
	 * Three states, decided by what the server holds, not by whether it holds anything:
	 *   • BUSY here (a run in flight, a dialog parked): 409. Two pages must never drive one pi
	 *     session at once — pi refuses the second prompt with "already processing", and this
	 *     is that refusal made readable before a prompt is typed. The server owns the check,
	 *     not only the rail's disabled row: a rail fetched a moment before another tab
	 *     prompted would otherwise get past it.
	 *   • IDLE here (released, cached for the idle window): pi's memory and the session's own
	 *     mode — fresher than the file, and RESUMABLE. A page that reloaded after a run must be
	 *     able to come back to its session before the 30-minute eviction (PR #104 review).
	 *   • NOT here: the file, with the mode its branch persists. Neither: 404.
	 */
	async function respondWithThreadHistory(threadId: string, response: ServerResponse): Promise<void> {
		const live = threads.peek(threadId);
		if (live?.busy === true) {
			response.writeHead(409, { "Content-Type": "text/plain" });
			response.end(`thread ${threadId} is running on this server`);
			return;
		}
		const branch = live === undefined ? await host.readBranch(threadId) : live.hosted.inspect().entries;
		if (branch === undefined) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end(`no session for thread ${threadId}`);
			return;
		}
		const payload: ZenThreadHistory = {
			threadId,
			messages: branchToMessages(branch),
			permissionMode:
				live === undefined
					? { mode: persistedPermissionMode(branch), available: [...PICC_PERMISSION_MODES] }
					: live.hosted.session.permissionModeState(),
		};
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(payload));
	}

	/**
	 * ⚠ The dispatcher is synchronous and a throw in the request listener has nothing above
	 * it (PR #87). The two handlers that await the host run through here: a rejection is
	 * reported and answered as a 500, and the server stays up.
	 */
	function answerOrFail(work: Promise<void>, response: ServerResponse): void {
		work.catch((error: unknown) => {
			options.onProblem?.(error);
			if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
			response.end("the session listing failed — see the server log");
		});
	}

	function respondWithThread(threadId: string, response: ServerResponse): void {
		const thread = threads.peek(threadId);
		if (thread === undefined) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end(`no live session for thread ${threadId}`);
			return;
		}
		const inspection = thread.hosted.inspect();
		const payload: ZenThreadInspection = {
			threadId,
			sessionId: inspection.sessionId,
			cwd: inspection.cwd,
			sessionDir: inspection.sessionDir,
			sessionFile: inspection.sessionFile,
			permissionMode: thread.hosted.session.permissionModeState(),
			commands: [...inspection.commands],
			busy: thread.busy,
			parked: registry.peek(threadId) !== undefined,
			lastActivityAt: new Date(thread.lastActivityAt).toISOString(),
			entries: [...inspection.entries],
		};
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify(payload));
	}

	// ⚠ Routes dispatch HERE, outside the chat handler, on purpose: that handler sits at the
	// complexity ceiling biome.jsonc pins for this file (#82), and its top-to-bottom shape is
	// the #27/#34 teardown ordering. New routes are added to this dispatcher, not to it.
	const server = createServer((request, response) => {
		const url = request.url ?? "";
		if (request.method === "GET" && url === "/api/mode") {
			respondWithFreshThreadMode(response);
			return;
		}
		if (request.method === "GET" && url === "/api/threads") {
			respondWithThreads(response);
			return;
		}
		if (request.method === "GET" && url === "/api/sessions") {
			answerOrFail(respondWithSessions(response), response);
			return;
		}
		if (request.method === "GET") {
			const eventsMatch = THREAD_EVENTS_ROUTE.exec(url);
			if (eventsMatch?.[1] !== undefined) {
				const threadId = decodeThreadId(eventsMatch[1], response);
				if (threadId !== undefined) respondWithThreadEvents(threadId, response);
				return;
			}
			const historyMatch = THREAD_HISTORY_ROUTE.exec(url);
			if (historyMatch?.[1] !== undefined) {
				const threadId = decodeThreadId(historyMatch[1], response);
				if (threadId !== undefined) answerOrFail(respondWithThreadHistory(threadId, response), response);
				return;
			}
			const threadMatch = THREAD_ROUTE.exec(url);
			if (threadMatch?.[1] !== undefined) {
				const threadId = decodeThreadId(threadMatch[1], response);
				if (threadId !== undefined) respondWithThread(threadId, response);
				return;
			}
		}
		void handleChat(request, response);
	});

	async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method === "POST" && request.url?.startsWith("/api/chat")) {
			let body: RunAgentInputBody = {};
			try {
				body = JSON.parse(await readBody(request)) as RunAgentInputBody;
			} catch (error) {
				options.onProblem?.(error);
				response.writeHead(400, { "Content-Type": "text/plain" });
				response.end("malformed RunAgentInput body");
				return;
			}

			const ids = {
				threadId: body.threadId ?? crypto.randomUUID(),
				runId: body.runId ?? crypto.randomUUID(),
				messageId: crypto.randomUUID(),
			};

			// ⚠ Read by BOTH paths after their stream completes: `parkedAwaitingAnswer` means
			// the run handed its process to the registry mid-stream, so the teardown that
			// normally follows a response must not run — a human's answer is coming back for
			// that process on a later request.
			const outcome: ChatRunOutcome = { parkedAwaitingAnswer: false };
			// ⚠ Set in each path's `finally` BEFORE `response.end()`. The response 'close' event
			// fires on normal completion too, and since #69 PR 2 "stop" is a real `abort()` on
			// the thread's long-lived session (the subprocess era's stop was an idempotent
			// dispose). Aborting an idle session after every settled run would set
			// `abortInFlight` and make the very next prompt wait on it — so 'close' stops pi
			// only when the stream did NOT end on its own, i.e. the client went away.
			let streamEnded = false;

			// ── The resume path: an answer to a parked dialog. No new session — the one this
			// request addresses has been alive since the run it interrupted (#27).
			if (Array.isArray(body.resume) && body.resume.length > 0) {
				// Captured BEFORE resumeChat can take the entry — the registry's stop handle
				// aborts the run and releases the thread; the session itself stays alive.
				const stopParked = registry.peek(ids.threadId)?.stopPi;
				response.writeHead(200, SSE_HEADERS);
				// ⚠ `response`, NOT `request` (#34). Under bun's node:http compat the REQUEST
				// 'close' event fires when the request BODY has been consumed — the start of
				// every run, before this listener is registered — so a request-close hook is
				// INERT and a mid-run disconnect never tore pi down. The RESPONSE 'close' is
				// what fires on a client abort; on normal end `streamEnded` keeps it inert.
				response.on("close", () => {
					if (streamEnded) return;
					if (outcome.parkedAwaitingAnswer) return;
					stopParked?.();
				});
				try {
					for await (const chunk of resumeChat({
						registry,
						ids,
						parentRunId: body.parentRunId,
						resume: body.resume,
						outcome,
						onProblem: options.onProblem,
					})) {
						writeSseEvent(response, chunk, threads.peek(ids.threadId)?.sent);
					}
				} catch (error) {
					options.onProblem?.(error);
					writeSseEvent(
						response,
						{
							type: EventType.RUN_ERROR,
							runId: ids.runId,
							message: error instanceof Error ? error.message : String(error),
						},
						threads.peek(ids.threadId)?.sent,
					);
				} finally {
					// A resume that ended unparked is a finished run: the thread goes idle. A
					// client that dropped mid-resume is handled by the 'close' hook above.
					streamEnded = true;
					if (!outcome.parkedAwaitingAnswer) threads.release(ids.threadId);
					response.end();
				}
				return;
			}

			// ⚠ One pi session per chat THREAD (#69 PR 2, closes #43): acquired here, RELEASED
			// (not disposed) in `finally` so the idle clock starts — UNLESS a dialog parked
			// the run (#27), in which case the registry holds it until the answer or the TTL
			// and the resume path releases. Disposal happens only after the idle window or at
			// shutdown (`thread-sessions.ts`). Acquired BEFORE the SSE head goes out, so a
			// session that cannot be built is a plain HTTP failure and not a half-open stream.
			let session: Awaited<ReturnType<typeof threads.acquire>>;
			try {
				session = await threads.acquire(ids.threadId);
			} catch (error) {
				options.onProblem?.(error);
				response.writeHead(500, { "Content-Type": "text/plain" });
				response.end(`pi session could not be created: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			response.writeHead(200, SSE_HEADERS);

			// A client that navigates away must not leave pi running — but a PARKED session
			// belongs to the registry, and this close event also fires on normal completion,
			// AFTER a park. Stopping here would abort the run whose answer is pending.
			// ⚠ `response`, NOT `request` (#34). Under bun's node:http compat the REQUEST
			// 'close' event fires when the request BODY has been consumed — the start of
			// every run, before this listener is registered — so the request-close hook this
			// used to be was INERT and a mid-run disconnect never tore pi down (found by the
			// disconnect receipt lingering exactly until the no-progress guard's `finally`).
			// The RESPONSE 'close' fires on a client abort; on normal end `streamEnded` is
			// already set by `finally` and this stays inert — see its declaration for why a
			// stop here is no longer free.
			response.on("close", () => {
				if (streamEnded) return;
				if (outcome.parkedAwaitingAnswer) return;
				threads.stop(ids.threadId);
			});

			try {
				for await (const chunk of runChat({
					session,
					ids,
					prompt: latestUserPrompt(body),
					registry,
					// Handed to the registry with a parked run: eviction aborts what is running
					// and lets the thread go idle. The session survives for the next prompt.
					stopPi: () => {
						threads.stop(ids.threadId);
						threads.release(ids.threadId);
					},
					outcome,
					onProblem: options.onProblem,
				})) {
					writeSseEvent(response, chunk, threads.peek(ids.threadId)?.sent);
				}
			} catch (error) {
				options.onProblem?.(error);
				// The stream is already open, so an error has to travel as an event — a
				// mid-stream HTTP status is not available and a silent close reads as success.
				writeSseEvent(
					response,
					{
						type: EventType.RUN_ERROR,
						runId: ids.runId,
						message: error instanceof Error ? error.message : String(error),
					},
					threads.peek(ids.threadId)?.sent,
				);
			} finally {
				streamEnded = true;
				if (!outcome.parkedAwaitingAnswer) threads.release(ids.threadId);
				response.end();
			}
			return;
		}

		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found");
	}

	// Parked sessions must not outlive the server that parked them — evicted first, so their
	// declines reach a live session; then every thread's session is disposed.
	server.on("close", () => {
		registry.shutdown();
		threads.shutdown();
	});

	const port = options.port ?? DEFAULT_PORT;

	// ⚠ Without this, a port clash surfaces as an unhandled 'error' event and a Node stack
	// trace — which is what happened, and which reads as "the server is broken" rather than
	// "something else is already listening". Observed while restarting during development,
	// and it cost a minute of reading a trace to learn a one-line fact.
	server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE") {
			options.onProblem?.(
				`port ${port} is already in use — another zen server is probably running. ` +
					`Stop it, or pass a different port.`,
			);
			return;
		}
		options.onProblem?.(error);
	});

	// Resolves with the URL of the port the OS actually bound — the same as `url` unless the
	// caller asked for port 0 (tests do), where `url` would name a port that does not exist.
	const listening = new Promise<string>((resolve, reject) => {
		server.once("listening", () => {
			const address = server.address();
			const boundPort = typeof address === "object" && address !== null ? address.port : port;
			resolve(`http://${LOOPBACK_ONLY}:${boundPort}`);
		});
		// A bind failure emits 'error' (handled above), never 'listening'. Under Bun the
		// 'listening' event does not re-fire afterwards, so without this the promise would
		// hang forever and any `await listening` caller (dev.ts) would dangle silently. The
		// onProblem handler already reported the cause; this only settles the wait.
		server.once("error", reject);
	});
	server.listen(port, LOOPBACK_ONLY);
	return {
		server,
		url: `http://${LOOPBACK_ONLY}:${port}`,
		listening,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
