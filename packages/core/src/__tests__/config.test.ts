import { expect, test } from "bun:test";
import { parseZenConfig, ZEN_CONFIG_EXAMPLE, zenConfigPath } from "../config.ts";

/**
 * The zen.config.json loading contract (#59): parse fails CLOSED — every non-conforming
 * input comes back `unreadable`, never as a silently-empty config.
 */

test("a conforming config parses, and the section reaches its owner", () => {
	const result = parseZenConfig(JSON.stringify({ webFetch: { allowedHosts: ["docs.example.com"] } }));
	expect(result.kind).toBe("ok");
	const allowedHosts = result.kind === "ok" ? result.config.webFetch.allowedHosts : [];
	expect(allowedHosts).toEqual(["docs.example.com"]);
});

test("the committed default shape — empty allowlist — is valid", () => {
	expect(parseZenConfig(`{ "webFetch": { "allowedHosts": [] } }`).kind).toBe("ok");
});

test("invalid JSON is unreadable, naming the file and the failure", () => {
	const result = parseZenConfig("{ webFetch: [");
	const reason = result.kind === "unreadable" ? result.reason : "(readable)";
	expect(reason).toContain("zen.config.json");
	expect(reason).toContain("not valid JSON");
});

test("a wrong shape is unreadable and shows the expected example", () => {
	const result = parseZenConfig(JSON.stringify({ hosts: [] }));
	const reason = result.kind === "unreadable" ? result.reason : "(readable)";
	expect(reason).toContain(ZEN_CONFIG_EXAMPLE);
});

// ⚠ STRICT on unknown keys, deliberately (see config.ts's header): this is a policy file,
// and a typo must refuse loudly rather than silently configure nothing. The forward-incompat
// cost (an older harness refuses a newer config) is the wanted failure direction.
test("a TYPO in a section key is unreadable — strict schema", () => {
	const result = parseZenConfig(JSON.stringify({ webFetch: { allowedHost: ["docs.example.com"] } }));
	expect(result.kind).toBe("unreadable");
});

test("an unknown top-level key is unreadable — strict schema", () => {
	const result = parseZenConfig(JSON.stringify({ webFetch: { allowedHosts: [] }, extra: true }));
	expect(result.kind).toBe("unreadable");
});

// ⚠ The webSearch section is OPTIONAL and must stay optional (#63): a required section
// would render every already-committed config unreadable, and unreadable fails CLOSED
// for every consumer at once — web_fetch would refuse everything until a human edit.
test("the webSearch section is optional — the pre-#63 committed shape still parses", () => {
	expect(parseZenConfig(`{ "webFetch": { "allowedHosts": [] } }`).kind).toBe("ok");
});

test("a full webSearch section parses: the deepseek pin and the tavily domain filters", () => {
	const result = parseZenConfig(
		JSON.stringify({
			webFetch: { allowedHosts: [] },
			webSearch: { backend: "deepseek", tavily: { includeDomains: ["example.com"], excludeDomains: [] } },
		}),
	);
	expect(result.kind).toBe("ok");
	const backend = result.kind === "ok" ? result.config.webSearch?.backend : undefined;
	expect(backend).toBe("deepseek");
});

test("webSearch is strict like every section: an unknown backend or a typo key is unreadable", () => {
	const unknownBackend = parseZenConfig(
		JSON.stringify({ webFetch: { allowedHosts: [] }, webSearch: { backend: "google" } }),
	);
	expect(unknownBackend.kind).toBe("unreadable");
	const typoKey = parseZenConfig(
		JSON.stringify({ webFetch: { allowedHosts: [] }, webSearch: { tavily: { includeDomain: [] } } }),
	);
	expect(typoKey.kind).toBe("unreadable");
});

test("zenConfigPath joins the filename onto the root", () => {
	expect(zenConfigPath("/repo")).toBe("/repo/zen.config.json");
});
