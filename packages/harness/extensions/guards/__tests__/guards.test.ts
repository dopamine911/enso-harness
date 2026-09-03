import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import guards from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => { block?: boolean; reason?: string } | undefined;

/** Minimal stand-in for pi's ExtensionAPI — captures the registered tool_call handler. */
function loadGuard(): Handler {
	let handler: Handler | undefined;
	guards({ on: (e: string, h: Handler) => { if (e === "tool_call") handler = h; } } as never);
	if (!handler) throw new Error("guards registered no tool_call handler");
	return handler;
}

const cwd = mkdtempSync(join(tmpdir(), "zen-guard-live-"));
const call = (toolName: string, input: Record<string, unknown>) =>
	loadGuard()({ type: "tool_call", toolCallId: "t", toolName, input }, { cwd });

test("registers a tool_call handler", () => expect(typeof loadGuard()).toBe("function"));
test("write inside the workspace passes", () => expect(call("write", { path: "src/a.ts" })).toBeUndefined());
test("write outside the workspace is blocked", () => {
	const r = call("write", { path: "/etc/passwd" });
	expect(r?.block).toBe(true);
	expect(r?.reason).toContain("outside the workspace");
});
test("write into .git is blocked", () => expect(call("write", { path: ".git/config" })?.block).toBe(true));
test("read of .env is blocked", () => {
	const r = call("read", { path: ".env" });
	expect(r?.block).toBe(true);
	expect(r?.reason).toContain("credential");
});
test("read of ordinary source passes", () => expect(call("read", { path: "src/i.ts" })).toBeUndefined());
test("bash without timeout is PATCHED not blocked", () => {
	const input: Record<string, unknown> = { command: "sleep 999" };
	expect(loadGuard()({ type: "tool_call", toolCallId: "t", toolName: "bash", input }, { cwd })).toBeUndefined();
	expect(input.timeout).toBe(120);
});
test("an explicit bash timeout is preserved", () => {
	const input: Record<string, unknown> = { command: "x", timeout: 5 };
	loadGuard()({ type: "tool_call", toolCallId: "t", toolName: "bash", input }, { cwd });
	expect(input.timeout).toBe(5);
});
test("a tool with no path argument is ignored", () => expect(call("grep", { pattern: "f" })).toBeUndefined());

// --- #8: the reader set is an exclusion, so every path-bearing tool is gated.
// pi ships read/grep/find/ls with a `path`; an inclusion list naming only `read`
// left `grep` over a credential directory returning the secret line.
for (const readingTool of ["read", "grep", "find", "ls"]) {
	test(`${readingTool} of a credential path is blocked`, () => {
		const result = call(readingTool, { path: ".env" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("credential");
	});
	test(`${readingTool} of ordinary source passes`, () => {
		expect(call(readingTool, { path: "src/ordinary.ts" })).toBeUndefined();
	});
}

// A tool pi does not ship today must still be gated — that is what "exclusion" buys,
// and it is the case an inclusion list can never cover.
test("an unknown path-bearing tool is gated as a reader", () => {
	const result = call("someFutureSearchTool", { path: ".aws/credentials" });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("credential");
});

// The reason names the tool, so a denial is attributable without reading the guard.
test("the denial names the tool that was refused", () => {
	expect(call("grep", { path: ".ssh/id_rsa" })?.reason).toContain("grep");
});

// ⚠ Writes must be claimed BEFORE the reader fallthrough: write/edit also carry a
// `path`, so a dispatch that checked readers first would give them the weaker check
// and silently drop workspace confinement.
test("write outside the workspace is still confined, not treated as a read", () => {
	const result = call("write", { path: "/etc/passwd" });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("outside the workspace");
});
