import { expect, test } from "bun:test";
import { ANTHROPIC_WEB_SEARCH_TOOL_TYPE, runAnthropicWireSearch } from "../web-search/anthropic-wire.ts";
import {
	DEEPSEEK_SEARCH_BASE_URL,
	DEEPSEEK_SEARCH_MODEL_ID,
	runDeepseekProviderSearch,
} from "../web-search/providers/deepseek.ts";
import { readSseEvents } from "../web-search/sse.ts";
import type { FetchUrl } from "../web-search/vocabulary.ts";
import { WebSearchProviderError } from "../web-search/vocabulary.ts";

/**
 * The Anthropic WIRE (#63) against synthetic SSE fixtures — the wire serves both the
 * `anthropic` and `deepseek` providers, so these fixtures are the shared spine.
 * ⚠ The live receipt for this wire is the Anthropic native search (#63 build step 5);
 * a captured transcript from that run should extend these fixtures, not replace them.
 */

/** Await a provider run that MUST reject; returns the typed provider error. */
async function expectProviderRejection(promise: Promise<unknown>): Promise<WebSearchProviderError> {
	let caught: unknown = "the run resolved instead of rejecting";
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	if (caught instanceof WebSearchProviderError) return caught;
	throw new Error(`expected a WebSearchProviderError rejection, got: ${String(caught)}`);
}

/** Render events as an SSE body the way the Messages API streams them. */
function sseBody(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sseResponse(events: unknown[]): Response {
	return new Response(sseBody(events), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const fetchReturning =
	(response: Response): FetchUrl =>
	async () =>
		response;

const QUERY_TEXT = "what is zen-harness";

function wireOptions(fetchUrl: FetchUrl) {
	return {
		providerId: "anthropic" as const,
		endpointUrl: "https://api.anthropic.example/v1/messages",
		headers: { "x-api-key": "test-key" },
		modelId: "claude-test",
		prompt: QUERY_TEXT,
		maxTokens: 1024,
		maxServerToolUses: 5,
		fetchUrl,
		signal: undefined,
	};
}

/** A full searched stream: tool use, results, text with a citation. */
const SEARCHED_EVENTS = [
	{ type: "content_block_start", content_block: { type: "server_tool_use", name: "web_search", id: "srv1" } },
	{
		type: "content_block_start",
		content_block: {
			type: "web_search_tool_result",
			tool_use_id: "srv1",
			content: [
				{ type: "web_search_result", url: "https://example.com/zen", title: "Zen docs" },
				{ type: "web_search_result", url: "https://example.com/other.zip", title: "Junk archive" },
			],
		},
	},
	{ type: "content_block_start", content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", delta: { type: "text_delta", text: "zen-harness is a guarded pi setup." } },
	{
		type: "content_block_delta",
		delta: {
			type: "citations_delta",
			citation: {
				type: "web_search_result_location",
				url: "https://example.com/zen",
				title: "Zen docs",
				cited_text: "a guarded pi setup",
			},
		},
	},
];

test("a stream with search blocks and citations comes back as `searched`, marker-numbered", async () => {
	const outcome = await runAnthropicWireSearch(wireOptions(fetchReturning(sseResponse(SEARCHED_EVENTS))));
	expect(outcome.kind).toBe("searched");
	if (outcome.kind !== "searched") throw new Error("unreachable");
	// The citation marker lands right after the cited text, numbered into the source list.
	expect(outcome.answerText).toBe("zen-harness is a guarded pi setup[1].");
	expect(outcome.sources[0]).toEqual({ title: "Zen docs", url: "https://example.com/zen" });
	// The uncited junk archive is hygiene-filtered; the cited source is NOT re-filtered.
	expect(outcome.sources).toHaveLength(1);
});

// ⚠ THE ACCURACY KEY (#63): the verdict must come from search-activity BLOCKS, never from
// citations or sources. This fixture carries a citations_delta with a URL but NO
// server_tool_use / web_search_tool_result block — upstream's `grounded = sources > 0`
// called this grounded; the rework must call it ungrounded.
test("an answer with a citation but NO search block is `ungrounded` — sources are not the key", async () => {
	const events = [
		{ type: "content_block_delta", delta: { type: "text_delta", text: "From my training data." } },
		{
			type: "content_block_delta",
			delta: {
				type: "citations_delta",
				citation: {
					type: "web_search_result_location",
					url: "https://made-up.example/page",
					title: "Confabulated",
					cited_text: "training data",
				},
			},
		},
	];
	const outcome = await runAnthropicWireSearch(wireOptions(fetchReturning(sseResponse(events))));
	expect(outcome.kind).toBe("ungrounded");
});

test("a search that ran but errored server-side is still `searched` — the search HAPPENED", async () => {
	const events = [
		{ type: "content_block_start", content_block: { type: "server_tool_use", name: "web_search", id: "srv1" } },
		{
			type: "content_block_start",
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: "srv1",
				content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
			},
		},
		{ type: "content_block_delta", delta: { type: "text_delta", text: "Search was rate limited." } },
	];
	const outcome = await runAnthropicWireSearch(wireOptions(fetchReturning(sseResponse(events))));
	expect(outcome.kind).toBe("searched");
	if (outcome.kind !== "searched") throw new Error("unreachable");
	expect(outcome.sources).toHaveLength(0);
});

test("an HTTP error is a WebSearchProviderError that admits the request was dispatched", async () => {
	const errorResponse = new Response("over quota", { status: 429 });
	const thrown = await expectProviderRejection(runAnthropicWireSearch(wireOptions(fetchReturning(errorResponse))));
	expect(thrown.requestDispatched).toBe(true);
	expect(thrown.message).toContain("429");
});

test("a network failure BEFORE dispatch says so — requestDispatched false", async () => {
	const failingFetch: FetchUrl = async () => {
		throw new Error("connection refused");
	};
	const thrown = await expectProviderRejection(runAnthropicWireSearch(wireOptions(failingFetch)));
	expect(thrown).toBeInstanceOf(WebSearchProviderError);
	expect(thrown.requestDispatched).toBe(false);
});

test("an in-stream error event throws with the API's message", async () => {
	const events = [{ type: "error", error: { message: "overloaded_error" } }];
	const thrown = await expectProviderRejection(
		runAnthropicWireSearch(wireOptions(fetchReturning(sseResponse(events)))),
	);
	expect(thrown).toBeInstanceOf(WebSearchProviderError);
	expect(thrown.message).toContain("overloaded_error");
	expect(thrown.requestDispatched).toBe(true);
});

test("the request body carries the pinned tool type, budgets, and prompt", async () => {
	let capturedBody: string | undefined;
	const capturingFetch: FetchUrl = async (_url, init) => {
		capturedBody = init.body;
		return sseResponse(SEARCHED_EVENTS);
	};
	await runAnthropicWireSearch(wireOptions(capturingFetch));
	const body = JSON.parse(capturedBody ?? "{}") as {
		tools: { type: string; max_uses: number }[];
		messages: { content: string }[];
		max_tokens: number;
	};
	expect(body.tools[0]?.type).toBe(ANTHROPIC_WEB_SEARCH_TOOL_TYPE);
	expect(body.tools[0]?.max_uses).toBe(5);
	expect(body.max_tokens).toBe(1024);
	expect(body.messages[0]?.content).toBe(QUERY_TEXT);
});

// --- the deepseek provider: the same wire, its own endpoint, credential and prompt. ---

test("deepseek without its key refuses BEFORE any request, naming the env var", async () => {
	let fetchCalls = 0;
	const countingFetch: FetchUrl = async () => {
		fetchCalls += 1;
		return sseResponse([]);
	};
	const thrown = await expectProviderRejection(
		runDeepseekProviderSearch({
			query: QUERY_TEXT,
			apiKey: undefined,
			fetchUrl: countingFetch,
			signal: undefined,
		}),
	);
	expect(thrown).toBeInstanceOf(WebSearchProviderError);
	expect(thrown.message).toContain("DEEPSEEK_API_KEY");
	expect(thrown.requestDispatched).toBe(false);
	expect(fetchCalls).toBe(0);
});

test("deepseek hits ITS Anthropic-compatible base with dsh's instruction and budgets", async () => {
	let capturedUrl: string | undefined;
	let capturedHeaders: Record<string, string> | undefined;
	let capturedBody: string | undefined;
	const capturingFetch: FetchUrl = async (url, init) => {
		capturedUrl = url;
		capturedHeaders = init.headers;
		capturedBody = init.body;
		return sseResponse(SEARCHED_EVENTS);
	};
	const outcome = await runDeepseekProviderSearch({
		query: QUERY_TEXT,
		apiKey: "ds-test-key",
		fetchUrl: capturingFetch,
		signal: undefined,
	});
	expect(outcome.kind).toBe("searched");
	expect(outcome.providerId).toBe("deepseek");
	expect(capturedUrl).toBe(`${DEEPSEEK_SEARCH_BASE_URL}/messages`);
	expect(capturedHeaders?.["x-api-key"]).toBe("ds-test-key");
	const body = JSON.parse(capturedBody ?? "{}") as {
		model: string;
		messages: { content: string }[];
		tools: { max_uses: number }[];
	};
	expect(body.model).toBe(DEEPSEEK_SEARCH_MODEL_ID);
	expect(body.messages[0]?.content).toBe(`Perform a web search for the query: ${QUERY_TEXT}`);
	// dsh's server-tool budget, not the Anthropic path's 10.
	expect(body.tools[0]?.max_uses).toBe(5);
});

// ⚠ dsh's STRICT MODE, carried: native search not triggering is `ungrounded`, never
// prose-scraping (the deepseek README's whole point).
test("deepseek with no result blocks is `ungrounded`", async () => {
	const events = [{ type: "content_block_delta", delta: { type: "text_delta", text: "I already know this." } }];
	const outcome = await runDeepseekProviderSearch({
		query: QUERY_TEXT,
		apiKey: "ds-test-key",
		fetchUrl: fetchReturning(sseResponse(events)),
		signal: undefined,
	});
	expect(outcome.kind).toBe("ungrounded");
});

// --- the SSE reader itself. ---

test("readSseEvents parses event names, multi-line data, and skips [DONE] and non-JSON", async () => {
	const body =
		`event: message_start\ndata: {"alpha":1}\n\n` +
		`data: {"beta":\ndata: 2}\n\n` +
		`data: [DONE]\n\n` +
		`data: not json\n\n` +
		`data: {"gamma":3}`;
	const seen: { eventName: string; data: unknown }[] = [];
	await readSseEvents(new Response(body), undefined, (event) => {
		seen.push(event);
		return undefined;
	});
	expect(seen).toEqual([
		{ eventName: "message_start", data: { alpha: 1 } },
		// Multi-line data joins with a newline; JSON.parse tolerates it inside the object.
		{ eventName: "", data: { beta: 2 } },
		// The final, unterminated event still flushes at EOF.
		{ eventName: "", data: { gamma: 3 } },
	]);
});

test("readSseEvents stops early when the callback asks — the Codex never-closing stream", async () => {
	const body = `data: {"first":true}\n\ndata: {"second":true}\n\n`;
	const seen: unknown[] = [];
	await readSseEvents(new Response(body), undefined, ({ data }) => {
		seen.push(data);
		return true;
	});
	expect(seen).toEqual([{ first: true }]);
});

// --- the anthropic provider's OAuth branch (live-diagnosed 2026-09-04). ---

test("⚠ an OAuth credential sends the Claude Code identity system block — its absence is a live 429", async () => {
	// Observed live: without this block, Anthropic rejects the OAuth request as HTTP 429
	// rate_limit_error/"Error" (request_id req_011CejDyvm41VXVA7BY1jHgw); with it, the same
	// credential searched (audit line: `searched provider=anthropic — primary`).
	const { runAnthropicProviderSearch } = await import("../web-search/providers/anthropic.ts");
	let capturedBody: string | undefined;
	const capturingFetch: FetchUrl = async (_url, init) => {
		capturedBody = init.body;
		return sseResponse(SEARCHED_EVENTS);
	};
	const oauthModel = {
		id: "claude-test",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.example",
		maxTokens: 8192,
	} as never;
	await runAnthropicProviderSearch({
		query: QUERY_TEXT,
		model: oauthModel,
		resolveAuth: async () => ({ ok: true, apiKey: "sk-ant-oat01-fake-oauth-token" }),
		fetchUrl: capturingFetch,
		signal: undefined,
	});
	const oauthBody = JSON.parse(capturedBody ?? "{}") as { system?: { type: string; text: string }[] };
	expect(oauthBody.system?.[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");

	// The API-key branch sends NO system block — the identity is OAuth-only.
	await runAnthropicProviderSearch({
		query: QUERY_TEXT,
		model: oauthModel,
		resolveAuth: async () => ({ ok: true, apiKey: "sk-ant-api-key" }),
		fetchUrl: capturingFetch,
		signal: undefined,
	});
	const apiKeyBody = JSON.parse(capturedBody ?? "{}") as { system?: unknown };
	expect(apiKeyBody.system).toBeUndefined();
});
