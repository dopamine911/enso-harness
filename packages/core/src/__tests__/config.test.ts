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

test("zenConfigPath joins the filename onto the root", () => {
	expect(zenConfigPath("/repo")).toBe("/repo/zen.config.json");
});
