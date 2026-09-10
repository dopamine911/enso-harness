import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	EXTERNAL_WEB_CONTENT_NOTICE,
	findRepoRoot,
	parseZenConfig,
	WEB_FETCH_MAX_RESPONSE_BYTES,
	WEB_FETCH_TIMEOUT_MS,
	WEB_FETCH_TOOL_NAME,
	WebFetchToolParameters,
	ZEN_CONFIG_EXAMPLE,
	ZEN_CONFIG_FILENAME,
	zenConfigPath,
	zenLogger,
} from "@zen/core";
import { isFetchableContentType, isHostAllowed, isPublicIpAddress, parseWebFetchUrl } from "../../core/index.ts";

/**
 * The web_fetch tool (#54) — the sanctioned web access that replaces the ad-hoc network
 * clients #9 denies in bash. Three properties the shell path could never have:
 *
 * 1. **A committed, empty-by-default host allowlist.** The `webFetch.allowedHosts`
 *    section of `zen.config.json` at the REPOSITORY root (#59) names every fetchable
 *    host; it ships EMPTY as the recorded policy, and each host a human adds is one
 *    reviewable diff line. ⚠ Read ONCE at extension load, deliberately: the running
 *    session cannot widen its own egress by editing the file — an edit takes effect next
 *    session, after it has sat in `git status` where a human sees it. (write/edit on the
 *    file are also denied by the guard's `protectedWriteFragments`; a bash redirect into
 *    it is the stated residual, made inert within the session by the load-once read.)
 *    ⚠ The config belongs to the zen-harness INSTALL: located via `findRepoRoot` from
 *    this module's own tree, never from the session cwd — a foreign checkout's
 *    `zen.config.json` must not become this session's allowlist (see config.ts).
 * 2. **An audit line per call** — every outcome, refusals included, prints one stderr line
 *    naming the URL and what happened.
 * 3. **Bounded response handling** — http(s) only, no credentials in URLs, redirects
 *    REPORTED but never followed, textual content types only, body capped at
 *    {@link WEB_FETCH_MAX_RESPONSE_BYTES} bytes, whole call capped at
 *    {@link WEB_FETCH_TIMEOUT_MS}. A docs-reader, not a browser.
 *
 * The pure policy (URL gate, host match, content-type gate, the ADVISORY public-address
 * classifier and its stated SSRF non-coverage) lives in `core/web-fetch-policy.ts`.
 * Refusals are returned as ordinary tool results, never thrown: a policy refusal is
 * information the model should read and adapt to, not an error in the loop.
 */

/**
 * The IO seams, injected so tests never touch the network, DNS or the real config file —
 * same pattern as the guards' `analyzeBashCommand`.
 */
export interface WebFetchDependencies {
	/**
	 * Where `zen.config.json` lives — read from AND named in refusal messages. May throw
	 * (a broken install has no findable root); the extension fails CLOSED on that.
	 */
	locateConfigFile: () => string;
	readConfigText: (path: string) => string;
	fetchUrl: (
		url: string,
		init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
	) => Promise<Response>;
	/** Resolve a hostname to its addresses. Rejects on NXDOMAIN/timeouts. */
	resolveHostAddresses: (hostname: string) => Promise<string[]>;
}

const USER_AGENT = "zen-harness-web-fetch";

export function createWebFetch(dependencies: WebFetchDependencies): (pi: ExtensionAPI) => void {
	return function webFetch(pi: ExtensionAPI): void {
		// Load ONCE at extension load — see the header's property 1 for why. Every failure
		// mode (unfindable root, unreadable file, wrong shape) fails CLOSED: the tool still
		// registers, and every call refuses with the reason, because "could not read the
		// policy" must never render as "no policy" (and a throw here could wedge pi's load,
		// the way a throwing session_start handler wedges print mode).
		let allowedHosts: readonly string[] = [];
		let configProblem: string | undefined;
		let configPath: string | undefined;
		try {
			configPath = dependencies.locateConfigFile();
			const parsed = parseZenConfig(dependencies.readConfigText(configPath));
			if (parsed.kind === "ok") {
				allowedHosts = parsed.config.webFetch.allowedHosts;
			} else {
				configProblem = parsed.reason;
			}
		} catch (error) {
			configProblem = `the config file could not be read: ${String(error)}`;
		}
		// A locate failure leaves no path to name; the filename plus its home still tells
		// the human where to look.
		const configDisplayPath = configPath ?? `${ZEN_CONFIG_FILENAME} (at the zen-harness repository root)`;

		pi.registerTool({
			name: WEB_FETCH_TOOL_NAME,
			label: "Web fetch",
			description:
				`Fetch one absolute http(s) URL and return the response body as text (capped at ` +
				`${WEB_FETCH_MAX_RESPONSE_BYTES} bytes; redirects are reported, never followed). ` +
				`Only hosts on the committed allowlist are fetchable` +
				(allowedHosts.length > 0 ? ` (currently: ${allowedHosts.join(", ")})` : ` — and it is currently EMPTY`) +
				`; a refusal names the file a human can extend.`,
			promptSnippet: `${WEB_FETCH_TOOL_NAME}: fetch an allowlisted http(s) URL as text`,
			parameters: WebFetchToolParameters,
			execute: async (_toolCallId, params, signal): Promise<AgentToolResult<undefined>> => {
				const rawUrl = params.url;

				// --- the policy gates, in cheapest-first order; each refusal is final.
				const urlDecision = parseWebFetchUrl(rawUrl);
				if (urlDecision.kind === "refused") return refusal(rawUrl, urlDecision.reason);
				const url = urlDecision.url;

				if (configProblem !== undefined) {
					return refusal(
						rawUrl,
						`the ${WEB_FETCH_TOOL_NAME} host allowlist could not be used — ${configProblem}. ` +
							`Nothing is fetchable until a human fixes ${configDisplayPath} ` +
							`(expected shape: ${ZEN_CONFIG_EXAMPLE}) and restarts the session.`,
					);
				}
				if (allowedHosts.length === 0) {
					return refusal(
						rawUrl,
						`the ${WEB_FETCH_TOOL_NAME} host allowlist is EMPTY — the recorded default policy (#54), ` +
							`not an accident. No host is fetchable until a human adds one: edit ` +
							`${configDisplayPath} to name exact hostnames, e.g. ${ZEN_CONFIG_EXAMPLE}, ` +
							`commit the change so it is reviewed like code, and restart the session — the allowlist ` +
							`is read once at session start. Do not edit that file from this session; ask the human.`,
					);
				}
				if (!isHostAllowed(url.hostname, allowedHosts)) {
					return refusal(
						rawUrl,
						`"${url.hostname}" is not on the ${WEB_FETCH_TOOL_NAME} host allowlist ` +
							`(allowed: ${allowedHosts.join(", ")}). Hosts match exactly — no wildcards, no subdomain ` +
							`inheritance. A human can add it in ${configDisplayPath} and restart the session.`,
					);
				}

				// --- the ADVISORY address gate (see web-fetch-policy.ts's stated non-coverage:
				// resolve-here vs resolve-in-fetch is a TOCTOU window, accepted for MVP).
				const addressProblem = await addressGateReason(url.hostname, dependencies.resolveHostAddresses);
				if (addressProblem !== undefined) return refusal(rawUrl, addressProblem);

				return await fetchUnderDeadline(url, rawUrl, dependencies, signal);
			},
		});
	};
}

function refusal(rawUrl: string, reason: string): AgentToolResult<undefined> {
	auditLine("refused", rawUrl, reason);
	return { content: [{ type: "text", text: `Not fetched: ${reason}` }], details: undefined };
}

/**
 * The advisory address gate: refuse a host whose addresses are not all provably public.
 * Returns the refusal reason, or undefined when the fetch may proceed. An IP-literal
 * hostname classifies directly (URL brackets IPv6 literals; strip them).
 */
async function addressGateReason(
	hostname: string,
	resolveHostAddresses: WebFetchDependencies["resolveHostAddresses"],
): Promise<string | undefined> {
	const bareHost = hostname.replace(/^\[/, "").replace(/\]$/, "");
	let addresses: readonly string[];
	if (isIP(bareHost) !== 0) {
		addresses = [bareHost];
	} else {
		try {
			addresses = await resolveHostAddresses(bareHost);
		} catch (error) {
			return `"${bareHost}" did not resolve (${String(error)})`;
		}
	}
	const nonPublicAddress = addresses.find((address) => !isPublicIpAddress(address));
	if (addresses.length === 0 || nonPublicAddress !== undefined) {
		return (
			`"${bareHost}" resolves to a non-public address` +
			(nonPublicAddress !== undefined ? ` (${nonPublicAddress})` : "") +
			` — ${WEB_FETCH_TOOL_NAME} reaches the public web only.`
		);
	}
	return undefined;
}

/** The fetch itself, under the whole-call deadline AND the caller's abort signal. */
async function fetchUnderDeadline(
	url: URL,
	rawUrl: string,
	dependencies: WebFetchDependencies,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<undefined>> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(new Error(`${WEB_FETCH_TOOL_NAME} timed out after ${WEB_FETCH_TIMEOUT_MS}ms`)),
		WEB_FETCH_TIMEOUT_MS,
	);
	const abortWithCaller = (): void => controller.abort(signal?.reason);
	// A signal that is ALREADY aborted never fires the event (addEventListener is not
	// retroactive), so an execute() entered post-abort would otherwise run until the
	// deadline (PR #58 review, nit 3).
	if (signal?.aborted === true) {
		abortWithCaller();
	} else {
		signal?.addEventListener("abort", abortWithCaller, { once: true });
	}
	try {
		let response: Response;
		try {
			response = await dependencies.fetchUrl(url.href, {
				redirect: "manual",
				signal: controller.signal,
				headers: { "user-agent": USER_AGENT },
			});
		} catch (error) {
			return refusal(rawUrl, `the request failed: ${String(error)}`);
		}
		return await renderResponse(url, rawUrl, response);
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", abortWithCaller);
	}
}

const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

/**
 * Resolve a Location header against the requested URL for display. A MALFORMED header
 * (`Location: https://`) must come back as undefined, never throw — the tool's contract is
 * that refusals are returned, and a server-controlled header must not crash the loop.
 */
function resolveRedirectTarget(locationHeader: string | null, base: URL): string | undefined {
	if (locationHeader === null) return undefined;
	try {
		return new URL(locationHeader, base).href;
	} catch {
		return undefined;
	}
}

/** Turn the HTTP response into the tool result: redirect report, content-type gate, capped body. */
async function renderResponse(url: URL, rawUrl: string, response: Response): Promise<AgentToolResult<undefined>> {
	// Redirects are REPORTED, never followed: an open redirect on an allowlisted host must
	// not become a fetch of an unlisted one. The model re-requests the target itself, where
	// the allowlist gate runs again.
	if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
		const locationHeader = response.headers.get("location");
		const target = resolveRedirectTarget(locationHeader, url);
		auditLine("redirect", rawUrl, target ?? "(no usable Location header)");
		let redirectTail: string;
		if (target !== undefined) {
			redirectTail =
				` redirecting to ${target}. ${WEB_FETCH_TOOL_NAME} never follows redirects — ` +
				`fetch that URL directly if its host is on the allowlist; otherwise it needs ` +
				`a human allowlist edit.`;
		} else if (locationHeader === null) {
			redirectTail = ` with no Location header.`;
		} else {
			redirectTail = ` with an unparseable Location header.`;
		}
		return {
			content: [
				{
					type: "text",
					text: `Not fetched: ${url.href} answered HTTP ${response.status}${redirectTail}`,
				},
			],
			details: undefined,
		};
	}

	const contentType = response.headers.get("content-type");
	if (!isFetchableContentType(contentType)) {
		const contentTypeDescription =
			contentType === null
				? "carries no Content-Type header, and absent fails closed"
				: `Content-Type "${contentType}" is not textual`;
		return refusal(
			rawUrl,
			`the response ${contentTypeDescription} — ${WEB_FETCH_TOOL_NAME} returns text, not binary content.`,
		);
	}

	const body = await readBodyUpTo(response, WEB_FETCH_MAX_RESPONSE_BYTES);
	auditLine(
		"fetched",
		rawUrl,
		`HTTP ${response.status}, ${body.text.length} chars${body.truncated ? " (truncated)" : ""}`,
	);
	return {
		content: [
			{
				type: "text",
				text:
					`Fetched ${url.href} — HTTP ${response.status}, ${contentType}` +
					(body.truncated ? `, TRUNCATED at ${WEB_FETCH_MAX_RESPONSE_BYTES} bytes` : "") +
					`.\n\n${EXTERNAL_WEB_CONTENT_NOTICE}\n\n${body.text}`,
			},
		],
		details: undefined,
	};
}

const log = zenLogger("extension", "web-fetch");

/** One record per call, every outcome — the audit property #54 names (#132: in the file, at `info`; a refusal at `warn`). */
function auditLine(outcome: string, url: string, detail: string): void {
	const properties = { outcome, url, detail };
	if (outcome === "refused") log.warn("audit: {outcome} {url} — {detail}", properties);
	else log.info("audit: {outcome} {url} — {detail}", properties);
}

/** Read up to `maxBytes` of the body as UTF-8, cancelling the stream past the cap. */
async function readBodyUpTo(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const body = response.body;
	if (body === null) return { text: "", truncated: false };
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let text = "";
	let bytesRead = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		bytesRead += value.byteLength;
		if (bytesRead > maxBytes) {
			const bytesToKeep = value.byteLength - (bytesRead - maxBytes);
			text += decoder.decode(value.subarray(0, bytesToKeep), { stream: true });
			await reader.cancel();
			return { text, truncated: true };
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return { text, truncated: false };
}

/**
 * The pi entry point — real filesystem, DNS and fetch, wired at the composition root.
 * `findRepoRoot` realpaths before walking, which is what keeps the named path the
 * COMMITTED file even when the print harness (#20) runs this extension through its
 * `.zen/print-harness/` symlink mirror (observed live 2026-09-04, PR #58).
 */
export default createWebFetch({
	locateConfigFile: () => zenConfigPath(findRepoRoot(import.meta.url)),
	readConfigText: (path) => readFileSync(path, "utf8"),
	fetchUrl: (url, init) => fetch(url, init),
	resolveHostAddresses: async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address),
});
