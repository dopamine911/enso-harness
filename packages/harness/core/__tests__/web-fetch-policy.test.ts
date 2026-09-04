import { expect, test } from "bun:test";
import { WEB_FETCH_MAX_URL_LENGTH } from "@zen/core";
import { isFetchableContentType, isHostAllowed, isPublicIpAddress, parseWebFetchUrl } from "../web-fetch-policy.ts";

/**
 * web_fetch's pure policy (#54). Vectors are organised by EVASION DIMENSION (the #55
 * lesson): protocol, credentials, case, spelling, address. The redirect dimension lives in
 * the extension tests — redirect handling is IO-shaped.
 */

// --- parseWebFetchUrl: the protocol dimension ------------------------------------------

test("a plain https URL parses ok", () => {
	const decision = parseWebFetchUrl("https://docs.example.com/guide?x=1");
	expect(decision.kind).toBe("ok");
});

test("a plain http URL parses ok — the protocol gate allows both http and https", () => {
	expect(parseWebFetchUrl("http://docs.example.com/").kind).toBe("ok");
});

for (const hostileUrl of [
	"ftp://example.com/file",
	"file:///etc/passwd",
	"javascript:alert(1)",
	"data:text/html,hello",
	"ws://example.com/socket",
]) {
	test(`non-http(s) protocol is refused: ${hostileUrl}`, () => {
		const decision = parseWebFetchUrl(hostileUrl);
		// Capture-then-assert: an "ok" decision fails the reason assertion instead of skipping it.
		const reason = decision.kind === "refused" ? decision.reason : "(not refused)";
		expect(reason).toContain("http");
	});
}

test("a relative or garbage URL is refused as unparseable", () => {
	expect(parseWebFetchUrl("docs/guide.md").kind).toBe("refused");
	expect(parseWebFetchUrl("not a url at all").kind).toBe("refused");
});

// --- parseWebFetchUrl: the credentials dimension ---------------------------------------

test("URL credentials are refused — user:password@host", () => {
	const decision = parseWebFetchUrl("https://user:secret@example.com/");
	const reason = decision.kind === "refused" ? decision.reason : "(not refused)";
	expect(reason).toContain("credentials");
});

test("a bare username is refused too — and kills the allowed@evil hostname confusion", () => {
	// The hostname here is evil.example (everything before @ is userinfo); the credentials
	// refusal fires before any host comparison could be fooled.
	expect(parseWebFetchUrl("https://docs.example.com@evil.example/").kind).toBe("refused");
});

// --- parseWebFetchUrl: the length cap --------------------------------------------------

test("a URL over the length cap is refused; one at the cap is not", () => {
	const base = "https://example.com/";
	const atCap = base + "a".repeat(WEB_FETCH_MAX_URL_LENGTH - base.length);
	expect(parseWebFetchUrl(atCap).kind).toBe("ok");
	expect(parseWebFetchUrl(`${atCap}a`).kind).toBe("refused");
});

// --- isHostAllowed: the case and spelling dimensions -----------------------------------

const ALLOWED = ["docs.example.com", "Example.ORG"];

test("exact host matches, case-insensitively on BOTH sides", () => {
	expect(isHostAllowed("docs.example.com", ALLOWED)).toBe(true);
	expect(isHostAllowed("DOCS.EXAMPLE.COM", ALLOWED)).toBe(true);
	expect(isHostAllowed("example.org", ALLOWED)).toBe(true);
});

test("no subdomain inheritance in either direction", () => {
	expect(isHostAllowed("api.example.org", ALLOWED)).toBe(false); // child of an allowed host
	expect(isHostAllowed("example.com", ALLOWED)).toBe(false); // parent of an allowed host
});

test("spelling variants fail closed: trailing dot and lookalike suffix", () => {
	// `docs.example.com.` is the same origin to DNS but a DIFFERENT string — exact match
	// refuses it, which is the safe direction for an allowlist.
	expect(isHostAllowed("docs.example.com.", ALLOWED)).toBe(false);
	expect(isHostAllowed("docs.example.com.evil.example", ALLOWED)).toBe(false);
});

test("a punycoded unicode lookalike does not match its ascii target", () => {
	// URL turns `exаmple.com` (Cyrillic а) into xn--exmple-4nf.com — never equal to the
	// ascii allowlist entry, so the homograph fails closed without any unicode logic here.
	const homograph = new URL("https://exаmple.com/");
	expect(homograph.hostname.startsWith("xn--")).toBe(true);
	expect(isHostAllowed(homograph.hostname, ["example.com"])).toBe(false);
});

test("an empty allowlist matches nothing", () => {
	expect(isHostAllowed("docs.example.com", [])).toBe(false);
});

// --- isFetchableContentType ------------------------------------------------------------

test("textual media types are fetchable, parameters ignored", () => {
	expect(isFetchableContentType("text/html; charset=utf-8")).toBe(true);
	expect(isFetchableContentType("text/plain")).toBe(true);
	expect(isFetchableContentType("application/json")).toBe(true);
	expect(isFetchableContentType("application/xhtml+xml")).toBe(true);
	expect(isFetchableContentType("application/vnd.api+json")).toBe(true);
	expect(isFetchableContentType("APPLICATION/XML")).toBe(true);
});

test("binary and absent content types are refused — absent fails closed", () => {
	expect(isFetchableContentType("application/octet-stream")).toBe(false);
	expect(isFetchableContentType("image/png")).toBe(false);
	expect(isFetchableContentType("application/pdf")).toBe(false);
	expect(isFetchableContentType(null)).toBe(false);
});

// --- isPublicIpAddress: the address dimension ------------------------------------------
// Boundary pairs are DISAGREEING vectors: each private range's edge sits next to the
// public address one step outside it, so an off-by-one in a range check goes red.

const NON_PUBLIC_ADDRESSES = [
	"0.1.2.3", // 0.0.0.0/8
	"10.0.0.1", // private
	"100.64.0.1", // CGNAT low edge
	"100.127.255.254", // CGNAT high edge
	"127.0.0.1", // loopback
	"169.254.169.254", // link-local (the cloud metadata endpoint)
	"172.16.0.1", // 172.16/12 low edge
	"172.31.255.254", // 172.16/12 high edge
	"192.0.0.170", // 192.0.0.0/24 IETF assignments (PR #58 review, nit 1)
	"192.0.2.1", // TEST-NET-1
	"192.168.1.1", // private
	"198.18.0.1", // 198.18.0.0/15 benchmarking low edge
	"198.19.255.254", // benchmarking high edge
	"198.51.100.7", // TEST-NET-2
	"203.0.113.9", // TEST-NET-3
	"224.0.0.1", // multicast
	"255.255.255.255", // reserved
	"::", // unspecified
	"::1", // v6 loopback
	"fe80::1", // v6 link-local
	"fc00::1", // ULA
	"fd12:3456::1", // ULA
	"::ffff:10.0.0.1", // v4-mapped private (dotted form)
	"64:ff9b::192.168.0.1", // NAT64-embedded private (dotted form)
	"not-an-address", // unparseable — not provably public, fails closed
	"", // empty — same
];

for (const address of NON_PUBLIC_ADDRESSES) {
	test(`non-public: ${JSON.stringify(address)}`, () => expect(isPublicIpAddress(address)).toBe(false));
}

const PUBLIC_ADDRESSES = [
	"8.8.8.8",
	"100.63.255.254", // one below the CGNAT range
	"100.128.0.1", // one above it
	"172.15.255.254", // one below 172.16/12
	"172.32.0.1", // one above it
	"9.255.255.255", // one below 10/8
	"11.0.0.1", // one above it
	"192.0.1.1", // between 192.0.0/24 and TEST-NET-1
	"192.0.3.1", // one /24 above TEST-NET-1
	"198.17.255.254", // one below the benchmarking range
	"198.20.0.1", // one above it
	"198.51.99.254", // one /24 below TEST-NET-2
	"198.51.101.1", // one /24 above it
	"203.0.112.254", // one /24 below TEST-NET-3
	"203.0.114.1", // one /24 above it
	"223.255.255.254", // one below multicast
	"2607:f8b0:4004:c07::66", // public v6
	"::ffff:8.8.8.8", // v4-mapped PUBLIC — the embedded address decides
];

for (const address of PUBLIC_ADDRESSES) {
	test(`public: ${address}`, () => expect(isPublicIpAddress(address)).toBe(true));
}

// ⚠ STATED NON-COVERAGE, pinned so a future session finds the record instead of a gap:
// the classifier does not decode HEX-form embedded v4 (`::ffff:a00:1` is 10.0.0.1) and the
// whole check is advisory — fetch resolves DNS again after the check (TOCTOU/rebinding).
// Closing either needs a resolve-once pinned transport, recorded on #54's PR as the
// follow-up shape. This test documents today's boundary; if it goes red, the gap CLOSED —
// update the record, don't re-open the gap.
test("recorded non-coverage: hex-form mapped v4 is not decoded (classifies by v6 rules)", () => {
	expect(isPublicIpAddress("::ffff:a00:1")).toBe(true);
});
