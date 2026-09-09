import type { ZenFollowFrame, ZenFollowSnapshot, ZenStoredThread, ZenThreadHistory } from "@zen/core";

/**
 * A scripted server behind `fetch` (#112, #118): one follow body the test writes SSE frames
 * into, and unary routes the test scripts the answers of. Everything the browser's transport
 * touches — `/follow`, `/prompt`, `/dialog`, `/abort` — plus the page's own reads: `/api/mode`
 * (the composer's mode control seeds from it), `/api/stored-threads` (the rail's Previous
 * Sessions) and `/api/threads/:id/history` (a resume click). Shared by the adapter tests (`follow-connection.test.ts`,
 * which subscribe the adapter directly) and the mounted-pane tests (`thread-pane.test.tsx`,
 * which hand this `fetch` to `mintThread` and read the DOM).
 */
export interface ScriptedFetch {
	readonly fetch: typeof fetch;
	/** Write one frame onto the open follow. */
	readonly frame: (frame: ZenFollowFrame) => void;
	/** End the follow body — the server went away. */
	readonly closeFollow: () => void;
	readonly prompts: Array<{ message: string }>;
	readonly dialogs: unknown[];
	/** How many `POST …/abort` the server saw (#116). */
	readonly abortCount: () => number;
	/** Hold the next prompt's answer; returns the release. */
	readonly holdPrompt: () => () => void;
}

export interface ScriptedFetchOptions {
	readonly promptStatus?: { status: number; body: unknown };
	readonly dialogStatus?: number;
	readonly abortStatus?: number;
	readonly mode?: { mode: string; available: string[] };
	/** What `GET /api/stored-threads` lists — the rail's Previous Sessions (#95). */
	readonly storedThreads?: ZenStoredThread[];
	/** What `GET /api/threads/:id/history` answers for a resume click; keyed by thread id. */
	readonly histories?: Record<string, ZenThreadHistory>;
}

export function createScriptedFetch(options: ScriptedFetchOptions = {}): ScriptedFetch {
	const promptStatus = options.promptStatus ?? {
		status: 202,
		body: { threadId: "t1", messageId: "pm1", generation: 1, queued: false },
	};
	const dialogStatus = options.dialogStatus ?? 204;
	const abortStatus = options.abortStatus ?? 204;
	const mode = options.mode ?? { mode: "default", available: ["default", "plan"] };
	let aborts = 0;
	let write: (text: string) => void = () => undefined;
	let close: () => void = () => undefined;
	/** The prompt route answers only once this resolves — open by default; a test may hold it. */
	let promptGate = { promise: Promise.resolve() } as { promise: Promise<void>; resolve?: () => void };
	const prompts: Array<{ message: string }> = [];
	const dialogs: unknown[] = [];
	/** The follow: one SSE body per subscription; the latest one is where `frame` writes. */
	const openFollow = (): Response => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				write = (text) => controller.enqueue(encoder.encode(text));
				close = () => controller.close();
			},
		});
		return new Response(body, { status: 200 });
	};
	/** The page's own reads — mode seed, the rail's stored list, a resume click's history. */
	const pageRead = (url: string): Response | undefined => {
		if (url.endsWith("/api/mode")) return Response.json(mode);
		if (url.endsWith("/api/stored-threads")) return Response.json(options.storedThreads ?? []);
		const history = /\/api\/threads\/([^/]+)\/history$/.exec(url);
		if (history?.[1] === undefined) return undefined;
		const found = options.histories?.[decodeURIComponent(history[1])];
		return found === undefined ? new Response("no such thread", { status: 404 }) : Response.json(found);
	};
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url.endsWith("/follow")) return Promise.resolve(openFollow());
		if (url.endsWith("/prompt")) {
			prompts.push(JSON.parse(String(init?.body)) as { message: string });
			const body = typeof promptStatus.body === "string" ? promptStatus.body : JSON.stringify(promptStatus.body);
			return promptGate.promise.then(() => new Response(body, { status: promptStatus.status }));
		}
		if (url.endsWith("/dialog")) {
			dialogs.push(JSON.parse(String(init?.body)));
			return Promise.resolve(new Response(dialogStatus === 204 ? null : "no", { status: dialogStatus }));
		}
		if (url.endsWith("/abort") && init?.method === "POST") {
			aborts += 1;
			return Promise.resolve(new Response(abortStatus === 204 ? null : "no", { status: abortStatus }));
		}
		return Promise.resolve(pageRead(url) ?? new Response("not found", { status: 404 }));
	}) as typeof fetch;
	return {
		fetch: fetchImpl,
		frame: (frame) => write(`data: ${JSON.stringify(frame)}\n\n`),
		closeFollow: () => close(),
		prompts,
		dialogs,
		abortCount: () => aborts,
		holdPrompt: () => {
			const gate = Promise.withResolvers<void>();
			promptGate = gate;
			return gate.resolve;
		},
	};
}

export const SNAPSHOT_IDLE: ZenFollowSnapshot = {
	type: "snapshot",
	threadId: "t1",
	asOfSeq: 0,
	live: false,
	busy: false,
	generation: 0,
	permissionMode: { mode: "default", available: ["default", "plan"] },
	messages: [],
	openDialogs: [],
};
