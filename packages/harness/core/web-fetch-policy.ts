import { WEB_FETCH_MAX_URL_LENGTH } from "@zen/core";

/**
 * web_fetch's pure policy (#54) — every decision that needs no IO. The extension in
 * `extensions/web-fetch/` wires these to the filesystem, DNS and fetch.
 *
 * The gate's evasion dimensions, each pinned by a test (the #55 lesson — enumerate the
 * dimensions BEFORE writing vectors):
 *   - protocol   — `ftp:`, `file:`, `javascript:`, `data:` refused; http(s) only.
 *   - credentials — `https://user:pass@host/` refused outright; also kills the
 *     `https://allowed.example@evil.example/` confusion (the hostname is evil.example,
 *     but the refusal fires first and names the real reason).
 *   - case       — hostnames match case-insensitively on both sides.
 *   - spelling   — `example.com.` (trailing dot) and a punycoded unicode lookalike are
 *     DIFFERENT strings from `example.com` and fail closed; exact match, no wildcard, no
 *     subdomain inheritance — `api.example.com` needs its own allowlist entry.
 *   - address    — an allowlisted host resolving to a private/reserved address is refused
 *     ({@link isPublicIpAddress}); an IP-literal URL classifies the literal directly.
 *   - redirect   — never followed (the extension reports the target instead), so an open
 *     redirect on an allowlisted host cannot reach an unlisted one.
 *
 * ⚠ Stated non-coverage, deliberate (MVP posture): the address check is ADVISORY — the
 * classifier resolves once and fetch resolves again, so a DNS answer that flips between
 * the two (rebinding) gets through, and hex-form mapped/NAT64 IPv6 addresses are not
 * decoded. Closing that needs a resolve-once pinned transport (deepseek-harness carries
 * one); recorded here and in the tests rather than half-built.
 */

export type WebFetchUrlDecision = { kind: "ok"; url: URL } | { kind: "refused"; reason: string };

/** Parse and gate a raw URL string. Refusal reasons are written for the model to read. */
export function parseWebFetchUrl(rawUrl: string): WebFetchUrlDecision {
	if (rawUrl.length > WEB_FETCH_MAX_URL_LENGTH) {
		return {
			kind: "refused",
			reason: `the URL is ${rawUrl.length} characters, over the ${WEB_FETCH_MAX_URL_LENGTH}-character cap`,
		};
	}
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { kind: "refused", reason: "it is not parseable as an absolute URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { kind: "refused", reason: `only http and https URLs are fetchable, got "${url.protocol}"` };
	}
	if (url.username.length > 0 || url.password.length > 0) {
		return { kind: "refused", reason: "URLs carrying credentials (user:password@host) are never fetched" };
	}
	return { kind: "ok", url };
}

/**
 * Exact, case-insensitive hostname match. No wildcards and no subdomain inheritance,
 * deliberately: one allowlist entry is one reviewable grant, and `api.example.com` is a
 * different grant from `example.com`. Ports are not part of the match — the protocol gate
 * already confines the scheme, and a host grant is a host grant on any port.
 */
export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
	const candidate = hostname.toLowerCase();
	return allowedHosts.some((allowed) => allowed.toLowerCase() === candidate);
}

/** Media types fetchable beyond the `text/` prefix. */
const FETCHABLE_EXACT_MEDIA_TYPES: readonly string[] = ["application/json", "application/xml", "application/xhtml+xml"];
/** Structured-syntax suffixes (RFC 6839) that stay textual whatever the vendor prefix. */
const FETCHABLE_MEDIA_TYPE_SUFFIXES: readonly string[] = ["+json", "+xml"];

/**
 * True for response bodies worth returning as text. An ABSENT Content-Type header is
 * refused — web_fetch is a docs-reader, and "the server did not say" fails closed.
 */
export function isFetchableContentType(contentTypeHeader: string | null): boolean {
	if (contentTypeHeader === null) return false;
	const mediaType = (contentTypeHeader.split(";")[0] ?? "").trim().toLowerCase();
	if (mediaType.startsWith("text/")) return true;
	if (FETCHABLE_EXACT_MEDIA_TYPES.includes(mediaType)) return true;
	return FETCHABLE_MEDIA_TYPE_SUFFIXES.some((suffix) => mediaType.endsWith(suffix));
}

const IPV4_OCTET_COUNT = 4;
const IPV4_MAX_OCTET = 255;

/** Parse a dotted-quad string into octets, or undefined when it is not one. */
function ipv4OctetsOf(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== IPV4_OCTET_COUNT) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > IPV4_MAX_OCTET) return undefined;
		octets.push(octet);
	}
	return octets;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the range table IS the function — one boolean per reserved block, in RFC order; splitting it would scatter the table.
function isPublicIpv4(octets: readonly number[]): boolean {
	const [first, second] = octets;
	if (first === undefined || second === undefined) return false;
	if (first === 0) return false; // 0.0.0.0/8 "this network"
	if (first === 10) return false; // 10.0.0.0/8 private
	if (first === 100 && second >= 64 && second <= 127) return false; // 100.64.0.0/10 CGNAT
	if (first === 127) return false; // loopback
	if (first === 169 && second === 254) return false; // link-local
	if (first === 172 && second >= 16 && second <= 31) return false; // 172.16.0.0/12 private
	if (first === 192 && second === 168) return false; // private
	if (first >= 224) return false; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
	return true;
}

/**
 * ADVISORY public-address classifier — see the module header's stated non-coverage.
 * Anything not provably public (unparseable included) classifies as non-public: the
 * check gates a refusal, so unknown must fail closed.
 */
export function isPublicIpAddress(address: string): boolean {
	const trimmed = address.trim().toLowerCase();
	if (trimmed.length === 0) return false;
	const octets = ipv4OctetsOf(trimmed);
	if (octets !== undefined) return isPublicIpv4(octets);
	if (!trimmed.includes(":")) return false; // neither dotted-quad nor IPv6 — not provably public
	// IPv6. A dotted tail (`::ffff:10.0.0.1`, NAT64 `64:ff9b::10.0.0.1`) embeds a v4
	// address — classify the embedded one. Hex-form embeddings are the stated gap.
	if (trimmed.includes(".")) {
		const embedded = trimmed.slice(trimmed.lastIndexOf(":") + 1);
		const embeddedOctets = ipv4OctetsOf(embedded);
		return embeddedOctets !== undefined && isPublicIpv4(embeddedOctets);
	}
	if (trimmed === "::" || trimmed === "::1") return false; // unspecified, loopback
	if (trimmed.startsWith("fc") || trimmed.startsWith("fd")) return false; // fc00::/7 ULA
	if (/^fe[89ab]/.test(trimmed)) return false; // fe80::/10 link-local
	return true;
}
