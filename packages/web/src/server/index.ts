import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import { isPiLaunchConfig, type PiLaunchConfig } from "@zen/core";
import { spawnPiRpcProcess } from "../rpc/process-transport.ts";
import { runChat } from "./session.ts";

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

/** AG-UI's `RunAgentInput`, reduced to the fields this endpoint uses. */
interface RunAgentInputBody {
	threadId?: string;
	runId?: string;
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
					typeof part === "object" && part !== null && "text" in part
						? String((part as { text: unknown }).text)
						: "",
				)
				.join("");
		}
	}
	return "";
}

function writeSseEvent(response: ServerResponse, chunk: StreamChunk): void {
	// One `data:` line per event, blank line terminated — the SSE framing the adapter reads.
	response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export interface ZenServerOptions {
	launch: PiLaunchConfig;
	/**
	 * The zen-harness pi package directory, loaded with `-e`.
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
}

/**
 * ⚠⚠ THE FIRST LIVE RUN EXPOSED THIS, AND IT WAS A SECURITY DEFECT.
 *
 * `spawnPiRpcProcess` inherits the environment, so pi loaded the OPERATOR'S GLOBAL CONFIG —
 * `~/.pi/agent`, all sixteen of their packages, and **not the zen harness**. Observed
 * directly in the first SSE stream: pi-lens status lines, powerline widgets and a
 * pi-multi-account advisor warning, none of which this package installs.
 *
 * The consequence is not cosmetic. The web surface was running with **no Tier 0 guard at
 * all** — no write confinement, no secret-path denial, no bash timeout — because the guards
 * extension lives in the zen package that was never loaded.
 *
 * So the server applies the same two isolation mechanisms `scripts/zen.mjs` does, for the
 * same reasons: `PI_CODING_AGENT_DIR` hides the operator's packages and credentials, and
 * `--no-extensions` stops discovery so only the explicitly named package loads.
 */
function isolatedLaunchArgs(harnessPackageDir: string): readonly string[] {
	return ["--no-extensions", "--no-skills", "-e", harnessPackageDir];
}

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
	const declared = Object.values(manifest.pi ?? {}).flatMap((paths) =>
		Array.isArray(paths) ? paths : [paths],
	);
	const missing = declared
		.filter((entry) => entry.startsWith("node_modules/"))
		.filter((entry) => !existsSync(resolve(harnessPackageDir, entry)));
	if (missing.length > 0) {
		throw new Error(
			`zen-server: vendor package paths are missing from the harness package:\n` +
				`${missing.map((entry) => `  - ${entry}`).join("\n")}\n` +
				`Run \`npm install && npm run link:vendor\`.`,
		);
	}
}

export function startZenServer(options: ZenServerOptions) {
	if (!isPiLaunchConfig(options.launch)) {
		// ⚠ Fail at startup rather than on the first request. A bad `cwd` discovered mid-run
		// is a confusing failure; discovered at boot it is a one-line message.
		throw new Error("zen-server: invalid pi launch config");
	}
	assertVendorLinks(options.harnessPackageDir);

	const server = createServer(async (request, response) => {
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

			response.writeHead(200, SSE_HEADERS);

			// ⚠ One pi process per run, torn down in `finally`. Session reuse is what
			// `modelOptions.sessionId` and pi's own session tree are for, and doing it here
			// before the lifecycle is designed would leak a process per abandoned tab.
			const pi = spawnPiRpcProcess({
				...options.launch,
				args: [...isolatedLaunchArgs(options.harnessPackageDir), ...(options.launch.args ?? [])],
				env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir } as Record<string, string>,
				onStderr: (chunk) => options.onProblem?.(`pi stderr: ${chunk}`),
			});

			// A client that navigates away must not leave pi running.
			request.on("close", () => pi.stop());

			try {
				for await (const chunk of runChat({
					transport: pi.transport,
					ids,
					prompt: latestUserPrompt(body),
					onProblem: options.onProblem,
				})) {
					writeSseEvent(response, chunk);
				}
			} catch (error) {
				options.onProblem?.(error);
				// The stream is already open, so an error has to travel as an event — a
				// mid-stream HTTP status is not available and a silent close reads as success.
				writeSseEvent(response, {
					type: EventType.RUN_ERROR,
					runId: ids.runId,
					message: error instanceof Error ? error.message : String(error),
				});
			} finally {
				pi.stop();
				response.end();
			}
			return;
		}

		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found");
	});

	const port = options.port ?? DEFAULT_PORT;
	server.listen(port, LOOPBACK_ONLY);
	return {
		server,
		url: `http://${LOOPBACK_ONLY}:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
