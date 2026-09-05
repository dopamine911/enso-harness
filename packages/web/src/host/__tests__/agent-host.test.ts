import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { findRepoRoot, harnessPackageDir, type PiRpcEvent } from "@zen/core";
import { createAgentHost, type HostedSession, seedMultiAccountChildProxyOff } from "../agent-host.ts";

/**
 * The in-process host against the REAL harness package (#69) — every extension the manifest
 * names loads, and inline probe extensions observe what the host does. No model, no key, no
 * network: nothing here prompts. What is asserted are the spike's receipts, pinned:
 *
 *   - the isolation env is set before the first services (else multi-account reads ~/.pi/agent) —
 *     proven by WHERE multi-account resolved its config, not by reading the env back
 *   - `childProxy: false` is seeded (else the second session in a process hangs under Bun)
 *   - exactly the manifest's five extensions load, with no load errors
 *   - `session_start` fires exactly once per session, and two sessions do not share closures
 *   - a dialog an extension opens reaches a subscriber as `extension_ui_request` and its
 *     answer resolves the extension's promise — the #27 round trip without a wire
 *   - a throwing `session_start` becomes an `extension_error` record; the host stays usable
 */

const repoRoot = findRepoRoot(import.meta.url);
const harnessDir = harnessPackageDir(repoRoot);
const agentDir = mkdtempSync(join(tmpdir(), "zen-host-agent-"));
const problems: unknown[] = [];
const openSessions: HostedSession[] = [];

afterAll(() => {
	for (const hosted of openSessions) hosted.session.dispose();
});

/** The five extension path suffixes the harness manifest declares, in load order. */
const MANIFEST_EXTENSION_MARKERS = [
	"extensions/guards/index.ts",
	"extensions/web-fetch/index.ts",
	"extensions/web-search/index.ts",
	"picc-permission-modes/index.ts",
	"pi-multi-account/index.ts",
];

/** Collect every event a session emits, from its first subscriber on (the host replays what came before). */
function collectEvents(hosted: HostedSession): PiRpcEvent[] {
	const events: PiRpcEvent[] = [];
	hosted.session.subscribe((event) => events.push(event));
	return events;
}

async function hostedSession(extensionFactories: InlineExtension[] = []): Promise<HostedSession> {
	const host = createAgentHost({
		cwd: repoRoot,
		agentDir,
		harnessPackageDir: harnessDir,
		onProblem: (problem) => problems.push(problem),
		extensionFactories,
	});
	const hosted = await host.createSession();
	openSessions.push(hosted);
	return hosted;
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("⚠ childProxy is pinned off in the agent dir's multi-account config, other keys preserved", () => {
	const scratch = mkdtempSync(join(tmpdir(), "zen-host-seed-"));
	const configPath = join(scratch, "provider-failover.json");
	// absent → created with just the pin
	seedMultiAccountChildProxyOff(scratch);
	expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ childProxy: false });
	// present with the operator's keys → merged, not clobbered
	writeFileSync(configPath, JSON.stringify({ childProxy: true, showUsage: false, providerOrder: ["anthropic"] }));
	seedMultiAccountChildProxyOff(scratch);
	expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
		childProxy: false,
		showUsage: false,
		providerOrder: ["anthropic"],
	});
	// and creating a host seeds it in the host's own agent dir — before any session exists
	const hostAgentDir = mkdtempSync(join(tmpdir(), "zen-host-seed-at-boot-"));
	createAgentHost({ cwd: repoRoot, agentDir: hostAgentDir, harnessPackageDir: harnessDir, onProblem: undefined });
	expect(existsSync(join(hostAgentDir, "provider-failover.json"))).toBe(true);
	expect(JSON.parse(readFileSync(join(hostAgentDir, "provider-failover.json"), "utf8"))).toEqual({ childProxy: false });
});

test("exactly the manifest's five extensions load, in order, with no load errors", async () => {
	const hosted = await hostedSession();
	const loaded = hosted.loadedExtensionPaths;
	expect(loaded).toHaveLength(MANIFEST_EXTENSION_MARKERS.length);
	MANIFEST_EXTENSION_MARKERS.forEach((marker, index) => {
		expect(loaded[index]?.endsWith(marker)).toBe(true);
	});
	expect(problems.filter((problem) => String(problem).includes("failed to load"))).toEqual([]);
});

test("⚠ multi-account resolved its config inside the scratch agent dir, not ~/.pi/agent — the env was set first", async () => {
	const hosted = await hostedSession();
	const events = collectEvents(hosted);
	// The startup notify is emitted during session_start — before any subscriber existed —
	// and replayed to the first one. Its text names the config path multi-account resolved.
	const startupNotify = events.find(
		(event) => event.method === "notify" && String(event.message).includes("provider-failover.json"),
	);
	expect(String(startupNotify?.message)).toContain(agentDir);
});

test("⚠ session_start fires exactly once per session, and two sessions do not share an extension instance", async () => {
	let factoryRuns = 0;
	const startsPerInstance: number[] = [];
	const probe: InlineExtension = {
		name: "zen-host-probe",
		factory: (pi) => {
			factoryRuns += 1;
			const mine = factoryRuns - 1;
			startsPerInstance[mine] = 0;
			pi.on("session_start", () => {
				startsPerInstance[mine] = (startsPerInstance[mine] ?? 0) + 1;
			});
		},
	};
	await hostedSession([probe]);
	await hostedSession([probe]);
	expect(factoryRuns).toBe(2);
	expect(startsPerInstance).toEqual([1, 1]);
});

test("⚠⚠ a dialog an extension opens reaches the subscriber and its answer resolves the extension", async () => {
	let confirmed: boolean | undefined;
	let settled = false;
	const probe: InlineExtension = {
		name: "zen-host-dialog-probe",
		factory: (pi) => {
			pi.on("session_start", (_event, extensionContext) => {
				// Fire-and-forget on purpose: awaiting here would block bindExtensions until the
				// test answers, and the test cannot answer what it has not yet observed.
				void extensionContext.ui.confirm("Apply the change?", "It is reversible").then((answer) => {
					confirmed = answer;
					settled = true;
				});
			});
		},
	};
	const hosted = await hostedSession([probe]);
	const events = collectEvents(hosted);
	const request = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
	expect(request).toMatchObject({ method: "confirm", title: "Apply the change?", message: "It is reversible" });
	expect(typeof request?.id).toBe("string");
	expect(settled).toBe(false);

	hosted.session.answerDialog({ id: String(request?.id), confirmed: true });
	await nextTick();
	expect(settled).toBe(true);
	expect(confirmed).toBe(true);
});

test("a cancelled dialog resolves to pi's cancel value, and dispose cancels what is still pending", async () => {
	const answers: unknown[] = [];
	const probe: InlineExtension = {
		name: "zen-host-cancel-probe",
		factory: (pi) => {
			pi.on("session_start", (_event, extensionContext) => {
				void extensionContext.ui.select("Pick", ["a", "b"]).then((answer) => answers.push(answer));
				void extensionContext.ui.input("Name?").then((answer) => answers.push(answer));
			});
		},
	};
	const hosted = await hostedSession([probe]);
	const events = collectEvents(hosted);
	const select = events.find((event) => event.method === "select");
	hosted.session.answerDialog({ id: String(select?.id), cancelled: true });
	await nextTick();
	expect(answers).toEqual([undefined]);
	// the input is still pending; dispose cancels it
	hosted.session.dispose();
	await nextTick();
	expect(answers).toEqual([undefined, undefined]);
});

test("an answer naming no pending dialog is reported, never thrown", async () => {
	const hosted = await hostedSession();
	const before = problems.length;
	expect(() => hosted.session.answerDialog({ id: "never-asked", cancelled: true })).not.toThrow();
	expect(problems.slice(before).some((problem) => String(problem).includes("never-asked"))).toBe(true);
});

test("⚠ a throwing session_start becomes an extension_error record; the session is still created", async () => {
	const probe: InlineExtension = {
		name: "zen-host-throwing-probe",
		factory: (pi) => {
			pi.on("session_start", () => {
				throw new Error("probe: session_start threw");
			});
		},
	};
	const hosted = await hostedSession([probe]);
	const events = collectEvents(hosted);
	const error = events.find((event) => event.type === "extension_error");
	expect(error).toMatchObject({ event: "session_start", error: "probe: session_start threw" });
	expect(String(error?.extensionPath)).toContain("zen-host-throwing-probe");
});

test("listCommands is synchronous and names picc's /mode", async () => {
	const hosted = await hostedSession();
	const commands = hosted.session.listCommands();
	expect(commands.some((command) => command.name === "mode" && command.source === "extension")).toBe(true);
});
