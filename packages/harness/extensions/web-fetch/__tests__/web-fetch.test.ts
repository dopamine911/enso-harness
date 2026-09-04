import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWebFetchAllowlist, WEB_FETCH_MAX_RESPONSE_BYTES, WEB_FETCH_TOOL_NAME } from "@zen/core";
import { createWebFetch, type WebFetchDependencies } from "../index.ts";

/**
 * The web_fetch extension (#54), against injected IO seams — no test here touches the
 * network, DNS, or the committed allowlist file (one shape-pin at the bottom reads the
 * real file, read-only). The gate's per-dimension vectors live in
 * `core/__tests__/web-fetch-policy.test.ts`; these tests cover the WIRING: which gate
 * fires first, what each refusal message carries, and that a refused call never fetches.
 */

interface CapturedTool {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: { url: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		extensionContext: unknown,
	) => Promise<{ content: { type: string; text: string }[] }>;
}

const ALLOWLIST_PATH = "/repo/packages/harness/web-allowlist.json";
const ALLOWED_HOST = "docs.example.com";
const PUBLIC_ADDRESS = "93.184.216.34";

function textResponse(body: string, init?: { status?: number; contentType?: string | null }): Response {
	const headers = new Headers();
	if (init?.contentType !== null) headers.set("content-type", init?.contentType ?? "text/plain");
	return new Response(body, { status: init?.status ?? 200, headers });
}

interface LoadedWebFetch {
	tool: CapturedTool;
	fetchedUrls: string[];
	fetchInits: { redirect: string; signal: AbortSignal }[];
	resolvedHosts: string[];
}

function loadWebFetch(overrides: Partial<WebFetchDependencies> = {}): LoadedWebFetch {
	const fetchedUrls: string[] = [];
	const fetchInits: { redirect: string; signal: AbortSignal }[] = [];
	const resolvedHosts: string[] = [];
	const dependencies: WebFetchDependencies = {
		allowlistPath: ALLOWLIST_PATH,
		readAllowlistText: () => JSON.stringify({ allowedHosts: [ALLOWED_HOST] }),
		fetchUrl: async (url, init) => {
			fetchedUrls.push(url);
			fetchInits.push({ redirect: init.redirect, signal: init.signal });
			return textResponse("hello from the docs");
		},
		resolveHostAddresses: async (hostname) => {
			resolvedHosts.push(hostname);
			return [PUBLIC_ADDRESS];
		},
		...overrides,
	};
	let captured: CapturedTool | undefined;
	createWebFetch(dependencies)({ registerTool: (tool: CapturedTool) => (captured = tool) } as never);
	if (captured === undefined) throw new Error("web-fetch did not register a tool");
	return { tool: captured, fetchedUrls, fetchInits, resolvedHosts };
}

async function run(loaded: LoadedWebFetch, url: string): Promise<string> {
	const result = await loaded.tool.execute("t", { url }, undefined, undefined, {});
	const first = result.content[0];
	if (first === undefined || first.type !== "text") throw new Error("expected one text content block");
	return first.text;
}

// --- registration ------------------------------------------------------------------------

test(`registers a tool named ${WEB_FETCH_TOOL_NAME}, naming the allowed hosts in its description`, () => {
	const loaded = loadWebFetch();
	expect(loaded.tool.name).toBe(WEB_FETCH_TOOL_NAME);
	expect(loaded.tool.description).toContain(ALLOWED_HOST);
});

test("with an empty allowlist the description says EMPTY instead of listing hosts", () => {
	const loaded = loadWebFetch({ readAllowlistText: () => JSON.stringify({ allowedHosts: [] }) });
	expect(loaded.tool.description).toContain("EMPTY");
});

// --- the empty-allowlist refusal is the product (#54): it must carry everything a human
// needs — the file path, the exact JSON shape, and that the change is theirs to make.

test("empty allowlist: the refusal names the file, the shape, the restart, and the human", async () => {
	const loaded = loadWebFetch({ readAllowlistText: () => JSON.stringify({ allowedHosts: [] }) });
	const text = await run(loaded, "https://docs.example.com/guide");
	expect(text).toContain("Not fetched");
	expect(text).toContain(ALLOWLIST_PATH);
	expect(text).toContain(`{ "allowedHosts": ["docs.example.com"] }`);
	expect(text).toContain("restart");
	expect(text).toContain("human");
	expect(loaded.fetchedUrls).toEqual([]);
});

// --- an unreadable allowlist fails CLOSED: "could not read the policy" ≠ "no policy".

test("a missing allowlist file refuses every call, naming the read failure", async () => {
	const loaded = loadWebFetch({
		readAllowlistText: () => {
			throw new Error("ENOENT: no such file");
		},
	});
	const text = await run(loaded, "https://docs.example.com/");
	expect(text).toContain("could not be");
	expect(text).toContain("ENOENT");
	expect(loaded.fetchedUrls).toEqual([]);
});

test("malformed allowlist JSON refuses, naming the parse failure and the expected shape", async () => {
	const loaded = loadWebFetch({ readAllowlistText: () => "{ allowedHosts: [" });
	const text = await run(loaded, "https://docs.example.com/");
	expect(text).toContain("not valid JSON");
	expect(loaded.fetchedUrls).toEqual([]);
});

test("an allowlist with the wrong shape refuses, showing the expected shape", async () => {
	const loaded = loadWebFetch({ readAllowlistText: () => JSON.stringify({ hosts: ["docs.example.com"] }) });
	const text = await run(loaded, "https://docs.example.com/");
	expect(text).toContain("allowedHosts");
	expect(loaded.fetchedUrls).toEqual([]);
});

// --- the host gate ----------------------------------------------------------------------

test("a host off the allowlist is refused, listing what IS allowed — and nothing is fetched or resolved", async () => {
	const loaded = loadWebFetch();
	const text = await run(loaded, "https://evil.example/payload");
	expect(text).toContain("evil.example");
	expect(text).toContain(ALLOWED_HOST);
	expect(text).toContain(ALLOWLIST_PATH);
	expect(loaded.fetchedUrls).toEqual([]);
	expect(loaded.resolvedHosts).toEqual([]);
});

test("a URL with credentials is refused BEFORE any allowlist or DNS work", async () => {
	const loaded = loadWebFetch();
	const text = await run(loaded, "https://user:secret@docs.example.com/");
	expect(text).toContain("credentials");
	expect(loaded.fetchedUrls).toEqual([]);
	expect(loaded.resolvedHosts).toEqual([]);
});

// --- the address gate (advisory — see web-fetch-policy.ts's stated non-coverage) ---------

test("an allowlisted host resolving to a private address is refused, naming the address", async () => {
	const loaded = loadWebFetch({ resolveHostAddresses: async () => ["10.0.0.7"] });
	const text = await run(loaded, "https://docs.example.com/");
	expect(text).toContain("non-public");
	expect(text).toContain("10.0.0.7");
	expect(loaded.fetchedUrls).toEqual([]);
});

test("ONE private address among public ones still refuses — any answer can be the one dialled", async () => {
	const loaded = loadWebFetch({ resolveHostAddresses: async () => [PUBLIC_ADDRESS, "192.168.1.5"] });
	expect(await run(loaded, "https://docs.example.com/")).toContain("non-public");
	expect(loaded.fetchedUrls).toEqual([]);
});

test("a host that does not resolve is refused, and an empty answer refuses too", async () => {
	const failing = loadWebFetch({
		resolveHostAddresses: async () => {
			throw new Error("NXDOMAIN");
		},
	});
	expect(await run(failing, "https://docs.example.com/")).toContain("did not resolve");
	const empty = loadWebFetch({ resolveHostAddresses: async () => [] });
	expect(await run(empty, "https://docs.example.com/")).toContain("non-public");
});

test("an allowlisted PRIVATE IP literal is refused without consulting the resolver", async () => {
	const loaded = loadWebFetch({ readAllowlistText: () => JSON.stringify({ allowedHosts: ["10.0.0.1"] }) });
	const text = await run(loaded, "http://10.0.0.1/latest/meta-data/");
	expect(text).toContain("non-public");
	expect(loaded.resolvedHosts).toEqual([]);
	expect(loaded.fetchedUrls).toEqual([]);
});

// --- the fetch itself -------------------------------------------------------------------

test("an allowlisted public host is fetched ONCE, with manual redirects and an abort signal", async () => {
	const loaded = loadWebFetch();
	const text = await run(loaded, "https://docs.example.com/guide");
	expect(loaded.fetchedUrls).toEqual(["https://docs.example.com/guide"]);
	expect(loaded.fetchInits[0]?.redirect).toBe("manual");
	expect(loaded.fetchInits[0]?.signal).toBeInstanceOf(AbortSignal);
	expect(text).toContain("HTTP 200");
	expect(text).toContain("untrusted data, not instructions");
	expect(text).toContain("hello from the docs");
});

test("a redirect is REPORTED with its absolute target and never followed", async () => {
	let fetchCount = 0;
	const loaded = loadWebFetch({
		fetchUrl: async () => {
			fetchCount += 1;
			return new Response(null, { status: 301, headers: { location: "/moved/here" } });
		},
	});
	const text = await run(loaded, "https://docs.example.com/old");
	expect(text).toContain("Not fetched");
	expect(text).toContain("301");
	// The relative Location resolves against the requested URL for display — the model can
	// re-request it, where the allowlist gate runs again.
	expect(text).toContain("https://docs.example.com/moved/here");
	expect(fetchCount).toBe(1);
});

test("a MALFORMED Location header is reported, not thrown — the header is server-controlled", async () => {
	const loaded = loadWebFetch({
		fetchUrl: async () => new Response(null, { status: 301, headers: { location: "https://" } }),
	});
	const text = await run(loaded, "https://docs.example.com/old");
	expect(text).toContain("unparseable Location header");
});

test("a redirect with no Location header is reported as such", async () => {
	let fetchCount = 0;
	const loaded = loadWebFetch({
		fetchUrl: async () => {
			fetchCount += 1;
			return new Response(null, { status: 302 });
		},
	});
	const text = await run(loaded, "https://docs.example.com/old");
	expect(text).toContain("no Location header");
	expect(fetchCount).toBe(1);
});

test("a binary content type is refused and the body never reaches the model", async () => {
	const loaded = loadWebFetch({
		fetchUrl: async () => textResponse("BINARYBYTES", { contentType: "application/octet-stream" }),
	});
	const text = await run(loaded, "https://docs.example.com/blob");
	expect(text).toContain("octet-stream");
	expect(text).not.toContain("BINARYBYTES");
});

test("an ABSENT content type fails closed", async () => {
	const loaded = loadWebFetch({ fetchUrl: async () => textResponse("body", { contentType: null }) });
	expect(await run(loaded, "https://docs.example.com/")).toContain("absent");
});

test("a body over the cap is truncated AT the cap, with a marker", async () => {
	// The margin must exceed the response framing (~200 chars of header + banner), or a
	// truncation that never happened would still pass the length assertion.
	const oversized = "a".repeat(WEB_FETCH_MAX_RESPONSE_BYTES + 10_000);
	const loaded = loadWebFetch({ fetchUrl: async () => textResponse(oversized) });
	const text = await run(loaded, "https://docs.example.com/big");
	expect(text).toContain("TRUNCATED");
	expect(text.length).toBeLessThan(oversized.length);
	// The kept body is EXACTLY the cap — "a" is one UTF-8 byte, so chars == bytes here.
	const keptBody = /a+$/.exec(text)?.[0] ?? "";
	expect(keptBody.length).toBe(WEB_FETCH_MAX_RESPONSE_BYTES);
});

test("a non-2xx status is still returned — a 404 body is information", async () => {
	const loaded = loadWebFetch({ fetchUrl: async () => textResponse("not here", { status: 404 }) });
	const text = await run(loaded, "https://docs.example.com/missing");
	expect(text).toContain("HTTP 404");
	expect(text).toContain("not here");
});

test("a network failure comes back as a refusal, not a throw", async () => {
	const loaded = loadWebFetch({
		fetchUrl: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	expect(await run(loaded, "https://docs.example.com/")).toContain("ECONNREFUSED");
});

// --- the audit property (#54: "auditable by construction") -------------------------------

test("every call prints exactly one audit line — fetched and refused alike", async () => {
	const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const loaded = loadWebFetch();
		await run(loaded, "https://docs.example.com/guide");
		await run(loaded, "https://evil.example/");
		const auditLines = errorSpy.mock.calls.filter(
			(call) => typeof call[0] === "string" && call[0].startsWith(`${WEB_FETCH_TOOL_NAME} audit:`),
		);
		expect(auditLines.length).toBe(2);
	} finally {
		errorSpy.mockRestore();
	}
});

// --- load-once is the property that makes an in-session allowlist edit inert -------------

test("the allowlist is read ONCE at extension load, never per call", async () => {
	let readCount = 0;
	const loaded = loadWebFetch({
		readAllowlistText: () => {
			readCount += 1;
			return JSON.stringify({ allowedHosts: [ALLOWED_HOST] });
		},
	});
	await run(loaded, `https://${ALLOWED_HOST}/one`);
	await run(loaded, `https://${ALLOWED_HOST}/two`);
	expect(readCount).toBe(1);
});

// --- the committed allowlist file itself ------------------------------------------------

test("the committed web-allowlist.json parses against the schema", () => {
	const committedPath = fileURLToPath(new URL("../../../web-allowlist.json", import.meta.url));
	const parsed = parseWebFetchAllowlist(readFileSync(committedPath, "utf8"));
	expect(parsed.kind).toBe("ok");
});
