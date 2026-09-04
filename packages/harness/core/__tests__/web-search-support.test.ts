import { expect, test } from "bun:test";
import { resolveModelAuth } from "../web-search/auth.ts";
import { applyByteIndexCitations, applyIndexCitations, applyTextCitations } from "../web-search/citations.ts";
import { runTavilyProviderSearch, TAVILY_SEARCH_URL } from "../web-search/providers/tavily.ts";
import { cleanSources, isLikelyJunkSearchUrl, normalizeSearchUrl, titleFromUrl } from "../web-search/sources.ts";
import type { FetchUrl } from "../web-search/vocabulary.ts";
import { WebSearchProviderError } from "../web-search/vocabulary.ts";

/** The web_search support layer (#63): source hygiene, citation appliers, auth, Tavily. */

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

// --- sources ---

test("normalizeSearchUrl strips fragments and tracking params, keeps YouTube params", () => {
	expect(normalizeSearchUrl("https://example.com/page?utm_source=x&ref=y&keep=1#frag")).toBe(
		"https://example.com/page?keep=1",
	);
	expect(normalizeSearchUrl("https://www.youtube.com/watch?v=abc&utm_source=x")).toBe(
		"https://www.youtube.com/watch?v=abc&utm_source=x",
	);
	expect(normalizeSearchUrl("not a url")).toBe("not a url");
});

test("junk URLs: binary suffixes and template residue are junk; pages are not; absent is junk", () => {
	expect(isLikelyJunkSearchUrl("https://example.com/archive.tar")).toBe(true);
	// The template-residue check sees the DECODED path, so the % arrives encoded (%25).
	expect(isLikelyJunkSearchUrl("https://example.com/list/%25")).toBe(true);
	expect(isLikelyJunkSearchUrl("https://example.com/docs/page")).toBe(false);
	expect(isLikelyJunkSearchUrl(undefined)).toBe(true);
});

test("titleFromUrl: last path segment, else hostname, else the raw string", () => {
	expect(titleFromUrl("https://example.com/docs/getting-started")).toBe("getting-started");
	expect(titleFromUrl("https://example.com/")).toBe("example.com");
	expect(titleFromUrl("not a url")).toBe("not a url");
});

test("cleanSources normalizes, junk-filters, titles, and dedupes in order", () => {
	const cleaned = cleanSources([
		{ title: "Zen", url: "https://example.com/zen?utm_source=x" },
		{ url: "https://example.com/zen" },
		{ url: "https://example.com/junk.zip" },
		{ url: "https://example.com/other" },
	]);
	expect(cleaned).toEqual([
		{ title: "Zen", url: "https://example.com/zen" },
		// The same page under a different title is a second entry (title is identity too),
		// with the fallback title derived from the path.
		{ title: "zen", url: "https://example.com/zen" },
		{ title: "other", url: "https://example.com/other" },
	]);
});

// --- citations ---

test("applyTextCitations inserts after the quoted text and numbers into one source list", () => {
	const result = applyTextCitations("alpha beta gamma", [
		{ citedText: "beta", title: "B", url: "https://example.com/b" },
		{ citedText: "alpha", title: "A", url: "https://example.com/a" },
		{ citedText: "missing quote", title: "C", url: "https://example.com/c" },
	]);
	expect(result.text).toBe("alpha[2] beta[1] gamma");
	expect(result.sources.map((source) => source.title)).toEqual(["B", "A", "C"]);
});

test("applyIndexCitations inserts at character offsets; index-less citations still list", () => {
	const result = applyIndexCitations("alpha beta", [
		{ endIndex: 5, title: "A", url: "https://example.com/a" },
		{ title: "NoIndex", url: "https://example.com/n" },
	]);
	expect(result.text).toBe("alpha[1] beta");
	expect(result.sources.map((source) => source.title)).toEqual(["A", "NoIndex"]);
});

// ⚠ Byte-safe, deliberately multi-byte: a character-space insertion corrupts this text.
test("applyByteIndexCitations inserts at BYTE offsets without corrupting multi-byte text", () => {
	const text = "禅は良い";
	const byteLengthOfFirstTwoCharacters = new TextEncoder().encode("禅は").length;
	const result = applyByteIndexCitations(text, [{ byteIndex: byteLengthOfFirstTwoCharacters, marker: "[1]" }]);
	expect(result).toBe("禅は[1]良い");
});

// --- auth ---

test("resolveModelAuth strips null headers and passes failures through", async () => {
	const model = { provider: "zen-test-nonexistent-provider" } as never;
	const resolved = await resolveModelAuth(
		{
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "key-1",
				headers: { keep: "yes", drop: null },
			}),
		},
		model,
	);
	expect(resolved).toEqual({ ok: true, apiKey: "key-1", headers: { keep: "yes" } });

	const failed = await resolveModelAuth({ getApiKeyAndHeaders: async () => ({ ok: false, error: "nope" }) }, model);
	expect(failed).toEqual({ ok: false, error: "nope" });
});

test("resolveModelAuth without key or auth header falls to provider env — absent here, so unchanged", async () => {
	// The provider name cannot exist in pi-ai's env map, so the fallback resolves nothing —
	// which is the assertable half of the fallback without reading process.env in a test.
	const resolved = await resolveModelAuth(
		{ getApiKeyAndHeaders: async () => ({ ok: true, headers: { "x-unrelated": "1" } }) },
		{ provider: "zen-test-nonexistent-provider" } as never,
	);
	expect(resolved).toEqual({ ok: true, headers: { "x-unrelated": "1" } });
});

// --- tavily ---

test("tavily sends the query, bounded results, bearer key, and only non-empty domain filters", async () => {
	let capturedUrl: string | undefined;
	let capturedHeaders: Record<string, string> | undefined;
	let capturedBody: Record<string, unknown> | undefined;
	const fetchUrl: FetchUrl = async (url, init) => {
		capturedUrl = url;
		capturedHeaders = init.headers;
		capturedBody = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
		return Response.json({
			results: [
				{ title: "Zen docs", url: "https://example.com/zen", content: "a guarded pi setup" },
				{ url: "https://example.com/untitled" },
				{ notAUrl: true },
			],
		});
	};
	const outcome = await runTavilyProviderSearch({
		query: "zen-harness",
		apiKey: "tv-key",
		includeDomains: ["example.com"],
		excludeDomains: [],
		fetchUrl,
		signal: undefined,
	});
	expect(capturedUrl).toBe(TAVILY_SEARCH_URL);
	expect(capturedHeaders?.Authorization).toBe("Bearer tv-key");
	expect(capturedBody?.include_domains).toEqual(["example.com"]);
	// An EMPTY exclude list is omitted, not sent as [] (Tavily treats [] and absent alike,
	// but omitting keeps the request minimal and the intent unambiguous).
	expect(capturedBody?.exclude_domains).toBeUndefined();
	expect(outcome.kind).toBe("searched");
	if (outcome.kind !== "searched") throw new Error("unreachable");
	expect(outcome.snippets).toEqual([
		{ title: "Zen docs", url: "https://example.com/zen", snippet: "a guarded pi setup" },
		{ title: "https://example.com/untitled", url: "https://example.com/untitled", snippet: undefined },
	]);
	expect(outcome.sources).toHaveLength(2);
});

test("tavily HTTP and body failures throw with the dispatched bit set", async () => {
	const httpError = await expectProviderRejection(
		runTavilyProviderSearch({
			query: "q",
			apiKey: "tv-key",
			fetchUrl: async () => new Response("unauthorized", { status: 401 }),
			signal: undefined,
		}),
	);
	expect(httpError).toBeInstanceOf(WebSearchProviderError);
	expect(httpError.requestDispatched).toBe(true);
	expect(httpError.message).toContain("401");

	const bodyError = await expectProviderRejection(
		runTavilyProviderSearch({
			query: "q",
			apiKey: "tv-key",
			fetchUrl: async () => new Response("not json", { status: 200 }),
			signal: undefined,
		}),
	);
	expect(bodyError).toBeInstanceOf(WebSearchProviderError);
	expect(bodyError.message).toContain("unparseable");
});
