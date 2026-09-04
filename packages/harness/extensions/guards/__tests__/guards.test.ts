import { expect, test } from "bun:test";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import guards from "../index.ts";

type Handler = (event: unknown, extensionContext: unknown) => { block?: boolean; reason?: string } | undefined;

/** ONE guard instance's captured handlers — the #10 sequences need state across calls. */
interface GuardRuntime {
	toolCall: Handler;
	toolResult: Handler;
	sessionStart: Handler;
}

/** pi's shipped tool set, as `getAllTools` returns it (probed live 2026-09-04). */
const PI_SHIPPED_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/**
 * Minimal stand-in for pi's ExtensionAPI — captures every registered handler.
 * `getAllTools` defaults to pi's real shipped set so session_start's policy check (#4)
 * passes; the mismatch tests inject their own list, or a throwing implementation.
 */
function loadGuardRuntime(
	getAllTools: () => { name: string }[] = () => PI_SHIPPED_TOOL_NAMES.map((name) => ({ name })),
): GuardRuntime {
	const handlers = new Map<string, Handler>();
	guards({ on: (e: string, h: Handler) => handlers.set(e, h), getAllTools } as never);
	const toolCall = handlers.get("tool_call");
	const toolResult = handlers.get("tool_result");
	const sessionStart = handlers.get("session_start");
	if (!(toolCall && toolResult && sessionStart)) {
		throw new Error("guards did not register tool_call + tool_result + session_start");
	}
	return { toolCall, toolResult, sessionStart };
}

/** The original single-handler loader — per-call tests that need no cross-call state. */
function loadGuard(): Handler {
	return loadGuardRuntime().toolCall;
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

// ── #21: persistence vectors are denied on the write path, allowed on the read path ──────
test("write to .mcp.json inside the workspace is blocked", () => {
	const r = call("write", { path: ".mcp.json" });
	expect(r?.block).toBe(true);
	expect(r?.reason).toContain("persistence");
});
test("edit of a .vscode task inside the workspace is blocked", () => {
	const r = call("edit", { path: ".vscode/tasks.json" });
	expect(r?.block).toBe(true);
	expect(r?.reason).toContain("persistence");
});
test("READING a persistence path is not blocked — the danger is installation", () =>
	expect(call("read", { path: ".mcp.json" })).toBeUndefined());

// ── #10: write requires knowledge of the file it replaces ─────────────────────────────────
// These share ONE runtime instance across calls, deliberately — the read-set is state, and
// a suite that rebuilds the instance per call can never see stale or leaking state.

/** A fresh workspace with one pre-existing file the session has NOT read. */
function readPreconditionFixture(): { runtime: GuardRuntime; cwd: string; existingFile: string } {
	const workspace = mkdtempSync(join(tmpdir(), "zen-guard-10-"));
	writeFileSync(join(workspace, "existing.ts"), "content the session has never seen");
	return { runtime: loadGuardRuntime(), cwd: workspace, existingFile: "existing.ts" };
}

const toolCallEvent = (toolName: string, path: string) =>
	({ type: "tool_call", toolCallId: "t", toolName, input: { path } }) as const;
const toolResultEvent = (toolName: string, path: string, isError: boolean) =>
	({ type: "tool_result", toolCallId: "t", toolName, input: { path }, content: [], isError }) as const;

test("write to an EXISTING file the session has not read is blocked, naming file and remedy", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	const result = runtime.toolCall(toolCallEvent("write", existingFile), { cwd });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain(existingFile);
	expect(result?.reason).toContain("Read");
});

test("write to a path that does not exist is unaffected — creation is the common case", () => {
	const { runtime, cwd } = readPreconditionFixture();
	expect(runtime.toolCall(toolCallEvent("write", "brand-new.ts"), { cwd })).toBeUndefined();
});

test("a successful read permits a later write of the same file, on the same instance", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })).toBeUndefined();
});

// ⚠ isError gates recording: a FAILED read saw nothing.
test("a failed read confers no knowledge", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, true), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })?.block).toBe(true);
});

// Identity is resolved, not spelled: read via a `sub/../` spelling, write via the plain one.
test("a read via a dotted spelling permits a write via the plain spelling", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", `sub/../${existingFile}`, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })).toBeUndefined();
});

// The deliberate widening: the session's own successful write authored every byte.
test("the session's own write confers knowledge — create-then-revise never self-blocks", () => {
	const { runtime, cwd } = readPreconditionFixture();
	expect(runtime.toolCall(toolCallEvent("write", "created.ts"), { cwd })).toBeUndefined();
	// The tool executes between the call and the result — by tool_result time the file exists.
	writeFileSync(join(cwd, "created.ts"), "v1");
	runtime.toolResult(toolResultEvent("write", "created.ts", false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", "created.ts"), { cwd })).toBeUndefined();
});

// ⚠ edit is NOT knowledge-conferring: a successful edit proved one matched fragment
// (liftable from grep output), not the whole file a follow-up `write` would claim.
test("a successful edit does NOT permit a whole-file write", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("edit", existingFile, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })?.block).toBe(true);
});

// edit itself stays un-gated by this rule — its exact-match already fails a blind edit.
test("edit of an unread existing file is not gated by the read precondition", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	expect(runtime.toolCall(toolCallEvent("edit", existingFile), { cwd })).toBeUndefined();
});

// ⚠ The session-scope proof, both halves on one instance: knowledge persists across calls
// within a session, and session_start clears it (reload/resume keep the runtime alive).
test("session_start resets the read-set on a live instance", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })).toBeUndefined();
	runtime.sessionStart({ type: "session_start", reason: "resume" }, { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })?.block).toBe(true);
});

// ── #11: a file changed underneath the session is refused, loudly and distinctly ─────────

/** Move a file's mtime one full second forward — unambiguous at any stat resolution. */
function touchForward(filePath: string): void {
	const later = new Date(Date.now() + 1000);
	utimesSync(filePath, later, later);
}

test("write to a file that changed after the session read it is blocked as CHANGED", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	touchForward(join(cwd, existingFile));
	const result = runtime.toolCall(toolCallEvent("write", existingFile), { cwd });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("CHANGED");
	expect(result?.reason).toContain(existingFile);
	// ⚠ The acceptance asks for DISTINCT causes: this is not #10's never-read message.
	expect(result?.reason).not.toContain("has not read");
});

// ⚠ The asymmetry with #10: edit passes on an UNKNOWN file (above) but is refused on a
// STALE one — an exact-match can survive an external change and clobber around it.
test("edit of a file that changed after the session read it is blocked too", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	touchForward(join(cwd, existingFile));
	const result = runtime.toolCall(toolCallEvent("edit", existingFile), { cwd });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("CHANGED");
});

test("re-reading the changed file clears the staleness and the write passes", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	touchForward(join(cwd, existingFile));
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })?.block).toBe(true);
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })).toBeUndefined();
});

// ⚠ THE RECORDED INCIDENT, replayed with real git: a tracked-but-unstaged mutation
// restored from the index (`git checkout -- <file>`) destroys the unstaged work with no
// error anywhere — untracked files fail loudly, and that asymmetry is the trap. The two
// contents are the SAME LENGTH deliberately, so only the mtime leg of the stamp can catch
// the restore — this test is what pins that git's restore actually moves mtime.
const isGitAvailable = Bun.which("git") !== null;
test.skipIf(!isGitAvailable)("the incident shape: staged, mutated, restored from index — the write is refused", () => {
	const repo = mkdtempSync(join(tmpdir(), "zen-guard-incident-"));
	const runGit = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: repo });
		if (result.exitCode !== 0) {
			throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
		}
	};
	runGit("init", "-q");
	runGit("config", "user.email", "test@example.invalid");
	runGit("config", "user.name", "guard-test");
	const filePath = join(repo, "work.ts");
	writeFileSync(filePath, "version-one\n");
	runGit("add", "work.ts");
	// The session's work: a tracked-but-unstaged mutation, same byte length.
	writeFileSync(filePath, "version-two\n");
	// ⚠ Backdate the mutation two seconds: in the real incident the observation and the
	// restore are separated by wall-clock time, and compressing them into one test tick
	// put both inside the SAME mtimeMs — the restore classified fresh and this test
	// failed. That was the documented same-size-same-millisecond gap manifesting, not a
	// broken guard; backdating restores the realistic separation deterministically.
	const twoSecondsAgo = new Date(Date.now() - 2000);
	utimesSync(filePath, twoSecondsAgo, twoSecondsAgo);
	const runtime = loadGuardRuntime();
	runtime.toolResult(toolResultEvent("read", "work.ts", false), { cwd: repo });
	const observed = statSync(filePath);
	// The concurrent agent's restore.
	runGit("checkout", "--", "work.ts");
	const restored = statSync(filePath);
	// Assert the CAUSE before the effect: the restore moved mtime while size is equal,
	// so a pass below is attributable to the mtime leg, not to a size difference.
	expect(restored.size).toBe(observed.size);
	expect(restored.mtimeMs).not.toBe(observed.mtimeMs);
	const result = runtime.toolCall(toolCallEvent("write", "work.ts"), { cwd: repo });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("CHANGED");
});

// ⚠ The session's OWN successful edit must not make the file stale to itself: an edit
// moves mtime/size, confers no whole-file knowledge (#10), but must refresh the stamp of
// an already-known file — read → edit → edit refused the second edit before this, live,
// blaming an external actor for the session's own work.
test("the session's own edit refreshes a known file's stamp — read → edit → edit passes", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	// The edit tool's own successful mutation: content changes, then its result arrives.
	writeFileSync(join(cwd, existingFile), "content after the session's first edit");
	touchForward(join(cwd, existingFile));
	runtime.toolResult(toolResultEvent("edit", existingFile, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("edit", existingFile), { cwd })).toBeUndefined();
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })).toBeUndefined();
});

// The refresh is IF-KNOWN only: an edit of a never-read file still confers nothing, so a
// later whole-file write is still gated by #10.
test("an edit result on an UNKNOWN file still confers no knowledge", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("edit", existingFile, false), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })?.block).toBe(true);
});

// A FAILED edit refreshes nothing: pi reports isError before mutating, so the stamp must
// keep describing the file the session last actually observed.
test("a failed edit result does not refresh the stamp", () => {
	const { runtime, cwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("read", existingFile, false), { cwd });
	touchForward(join(cwd, existingFile));
	runtime.toolResult(toolResultEvent("edit", existingFile, true), { cwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd })?.block).toBe(true);
});

// ── #4 gap 2: tool identity is case-insensitive, and the policy is checked live ───────────
// Claude-Code-style vendors register capitalised tool names (picc's own types carry
// `tool: "Bash"`), so two naming conventions are live in one process. Every branch must
// match by canonical name — these are DISAGREEING vectors (event case ≠ policy case), or
// they would assert x === x.

test("a capitalised Write is still confined — case cannot skip the write branch", () => {
	const result = call("Write", { path: "/etc/passwd" });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("outside the workspace");
});

test("a capitalised Bash still gets the timeout patch, not the reader fallthrough", () => {
	const input: Record<string, unknown> = { command: "sleep 999" };
	expect(loadGuard()({ type: "tool_call", toolCallId: "t", toolName: "BASH", input }, { cwd })).toBeUndefined();
	expect(input.timeout).toBe(120);
});

test("a capitalised Read result confers knowledge for a later lowercase write", () => {
	const { runtime, cwd: fixtureCwd, existingFile } = readPreconditionFixture();
	runtime.toolResult(toolResultEvent("Read", existingFile, false), { cwd: fixtureCwd });
	expect(runtime.toolCall(toolCallEvent("write", existingFile), { cwd: fixtureCwd })).toBeUndefined();
});

// ── #4 gap 2, half two: a policy naming a tool pi does not register must FAIL CLOSED ──────
// A mismatch is otherwise a silent no-op: the guard loads, never fires, nothing reports it.
// ⚠ Deny-all, never a throw — a throwing session_start handler WEDGES print mode (probed
// 2026-09-04: 120s hang, zero output), which is a hang, not a refusal.

test("a policy tool missing from pi's registry denies every subsequent call, naming it", () => {
	const runtime = loadGuardRuntime(() =>
		PI_SHIPPED_TOOL_NAMES.filter((name) => name !== "write").map((name) => ({ name })),
	);
	runtime.sessionStart({ type: "session_start", reason: "start" }, { cwd });
	const result = runtime.toolCall(toolCallEvent("read", "src/a.ts"), { cwd });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("write");
});

test("registry names are matched canonically — a capitalised registry entry is not a mismatch", () => {
	const runtime = loadGuardRuntime(() => PI_SHIPPED_TOOL_NAMES.map((name) => ({ name: name.toUpperCase() })));
	runtime.sessionStart({ type: "session_start", reason: "start" }, { cwd });
	expect(runtime.toolCall(toolCallEvent("read", "src/a.ts"), { cwd })).toBeUndefined();
});

test("an unreadable tool list fails closed too — 'could not check' is not 'checked, fine'", () => {
	const runtime = loadGuardRuntime(() => {
		throw new Error("registry unavailable");
	});
	// The session_start handler itself must NOT throw (the print-mode wedge).
	expect(() => runtime.sessionStart({ type: "session_start", reason: "start" }, { cwd })).not.toThrow();
	const result = runtime.toolCall(toolCallEvent("read", "src/a.ts"), { cwd });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("enumerate");
});

test("a matching registry leaves every call ungated by the mismatch floor", () => {
	const runtime = loadGuardRuntime();
	runtime.sessionStart({ type: "session_start", reason: "start" }, { cwd });
	expect(runtime.toolCall(toolCallEvent("read", "src/a.ts"), { cwd })).toBeUndefined();
});

// ⚠ The pre-session_start window (PR #52 review): pi's ordering — session_start before any
// tool_call — is an assumption, not a contract, and an unchecked floor reading `undefined`
// as "checked, fine" fails OPEN through exactly the window this feature exists to close.
// The lazy leg verifies on the first tool_call instead, so the floor is ordering-independent.
test("a mismatch denies the FIRST tool_call even when session_start never fired", () => {
	const runtime = loadGuardRuntime(() =>
		PI_SHIPPED_TOOL_NAMES.filter((name) => name !== "write").map((name) => ({ name })),
	);
	// No sessionStart call, deliberately — this is the window under test.
	const result = runtime.toolCall(toolCallEvent("read", "src/a.ts"), { cwd });
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("write");
});

test("the lazy check runs once — a healthy registry is not re-enumerated per call", () => {
	let enumerations = 0;
	const runtime = loadGuardRuntime(() => {
		enumerations += 1;
		return PI_SHIPPED_TOOL_NAMES.map((name) => ({ name }));
	});
	runtime.toolCall(toolCallEvent("read", "src/a.ts"), { cwd });
	runtime.toolCall(toolCallEvent("read", "src/b.ts"), { cwd });
	expect(enumerations).toBe(1);
});
