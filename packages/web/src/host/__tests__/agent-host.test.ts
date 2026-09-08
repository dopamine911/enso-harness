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

// ⚠ #89. pi runs in this process and every `bash` child inherits its environment, so a
// secret still in `process.env` at host creation reaches the model's tools. The host
// quarantines at creation — before any session — and says which names it removed
// (never values). This test plants a secret-shaped variable and checks it is gone.
test("⚠ creating a host removes secret-shaped variables from its environment, naming them, before any session", () => {
	const environment: Record<string, string | undefined> = { PATH: "/usr/bin", PLANTED_API_KEY: "must-not-survive" };
	const problems: unknown[] = [];
	createAgentHost({
		cwd: repoRoot,
		agentDir: mkdtempSync(join(tmpdir(), "zen-host-quarantine-")),
		harnessPackageDir: harnessDir,
		onProblem: (problem) => problems.push(problem),
		environment,
	});
	expect(environment).toEqual({ PATH: "/usr/bin" });
	const notice = problems.find((problem) => String(problem).includes("#89"));
	expect(String(notice)).toContain("PLANTED_API_KEY");
	expect(String(notice)).not.toContain("must-not-survive");
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

// ⚠ THE HOST MUST BE LISTENING WHILE session_start RUNS (#88). Extensions persist state
// during that hook — picc writes its opening `modes` entry there — and pi emits
// `entry_appended` for it to whoever is subscribed AT THAT MOMENT. Subscribing after
// `bindExtensions` returned meant those entries were emitted to nobody: the held-until-
// first-subscriber buffer sits behind the host's subscription, so nothing put them in it.
// Found by the #86 drawer: two `modes` entries on the branch, one `zen.entry` in the browser.
test("⚠ an entry an extension persists during session_start reaches the first subscriber (#88)", async () => {
	const probe: InlineExtension = {
		name: "zen-host-startup-entry-probe",
		factory: (pi) => {
			pi.on("session_start", () => {
				pi.appendEntry("probe-startup", { seen: true }); // the same call picc makes for `modes`
			});
		},
	};
	const hosted = await hostedSession([probe]);
	const events = collectEvents(hosted);
	const entries = events
		.filter((event) => event.type === "entry_appended")
		.map((event) => (event as { entry?: { customType?: unknown; data?: unknown } }).entry ?? {});
	const probeEntry = entries.find((entry) => entry.customType === "probe-startup");
	expect(probeEntry?.data).toEqual({ seen: true });
	// And the one that matters in production: picc's opening mode, persisted at session start,
	// is the transcript's first `Mode:` line only if it crosses — it is what #88 was missing.
	const openingMode = entries.find((entry) => entry.customType === "modes");
	expect(openingMode?.data).toMatchObject({ mode: "default" });
});

test("listCommands is synchronous and names picc's /mode", async () => {
	const hosted = await hostedSession();
	const commands = hosted.session.listCommands();
	expect(commands.some((command) => command.name === "mode" && command.source === "extension")).toBe(true);
});

function noopListener(): void {
	// A subscriber that only exists so the host has one: the tail records the delivery, not this.
}

/** Emits a notify on command — used to produce an event while nobody is subscribed. */
const lateNotifyProbe: InlineExtension = {
	name: "zen-host-late-notify-probe",
	factory: (pi) => {
		pi.registerCommand("zen-late-notify", {
			description: "emit a notify while nobody is listening",
			handler: async (_args, extensionContext) => {
				extensionContext.ui.notify("late notify", "info");
			},
		});
	},
};

test("⚠ events are held only until the FIRST subscriber; with nobody listening afterwards they are dropped, not replayed", async () => {
	// Per-thread sessions (#69 PR 2) subscribe one pump per run. If the host kept holding
	// between runs, an aborted run's `agent_settled` would replay into the next run's pump
	// and end it before its first token. The probe command emits a notify while no one is
	// subscribed; the next subscriber must NOT see it.
	const hosted = await hostedSession([lateNotifyProbe]);
	const firstSubscriberEvents: PiRpcEvent[] = [];
	const unsubscribeFirst = hosted.session.subscribe((event) => firstSubscriberEvents.push(event));
	// Startup records were replayed to the first subscriber.
	expect(firstSubscriberEvents.some((event) => event.method === "notify")).toBe(true);
	unsubscribeFirst();

	await new Promise<void>((resolve, reject) => {
		hosted.session.prompt(
			{ message: "/zen-late-notify" },
			{ onAccepted: resolve, onRejected: (reason) => reject(new Error(reason)) },
		);
	});

	const secondSubscriberEvents: PiRpcEvent[] = [];
	hosted.session.subscribe((event) => secondSubscriberEvents.push(event));
	expect(secondSubscriberEvents.filter((event) => String(event.message).includes("late notify"))).toHaveLength(0);
	// And the startup records are not replayed a second time either.
	expect(secondSubscriberEvents).toHaveLength(0);
});

// #88 and #69 were both ordering bugs reconstructed from source. The tail (#97) is the record
// that would have shown each in one glance: the provenance column says HOW every event through
// the host's funnel was delivered, and a held/replayed pair or a dropped row is the finding.
test("⚠ the emitted tail records each event's provenance: held at startup, replayed to the first subscriber, live, dropped (#97)", async () => {
	const hosted = await hostedSession([lateNotifyProbe]);
	const atStartup = hosted.emittedEvents();
	// Before anyone subscribes every startup record is `held` — picc's `modes` entry among them.
	expect(atStartup.length).toBeGreaterThan(0);
	expect(atStartup.every((event) => event.provenance === "held")).toBe(true);
	expect(atStartup.some((event) => event.type === "entry_appended" && event.name === "modes")).toBe(true);

	const unsubscribe = hosted.session.subscribe(noopListener);
	// The replay is recorded as it happens, in the held order, after the held rows.
	const afterSubscribe = hosted.emittedEvents();
	const heldModes = afterSubscribe.find((event) => event.provenance === "held" && event.name === "modes");
	const replayedModes = afterSubscribe.find((event) => event.provenance === "replayed" && event.name === "modes");
	expect(heldModes).toBeDefined();
	expect(replayedModes).toBeDefined();
	expect((replayedModes?.sequence ?? 0) > (heldModes?.sequence ?? 0)).toBe(true);
	// Every held event is replayed exactly once: the two provenances carry the same total.
	const totalOf = (provenance: string): number =>
		afterSubscribe.filter((event) => event.provenance === provenance).reduce((total, event) => total + event.count, 0);
	expect(totalOf("replayed")).toBe(totalOf("held"));

	// With a subscriber attached the command's notify is `live`; with none, `dropped`.
	await new Promise<void>((resolve, reject) => {
		hosted.session.prompt(
			{ message: "/zen-late-notify" },
			{ onAccepted: resolve, onRejected: (reason) => reject(new Error(reason)) },
		);
	});
	unsubscribe();
	await new Promise<void>((resolve, reject) => {
		hosted.session.prompt(
			{ message: "/zen-late-notify" },
			{ onAccepted: resolve, onRejected: (reason) => reject(new Error(reason)) },
		);
	});
	const notifies = hosted
		.emittedEvents()
		.filter(
			(event) =>
				event.type === "extension_ui_request" &&
				event.name === "notify" &&
				event.provenance !== "held" &&
				event.provenance !== "replayed",
		)
		.map((event) => event.provenance);
	expect(notifies).toEqual(["live", "dropped"]);
});

// #96's source tag: the subscriber is TOLD which events are a replay of the session's own
// start. multi-account's two startup notices arrive `replayed`; a notice the same extension
// emits during a run arrives `live`. This is what lets the browser group the first without
// guessing from position — and the guess would have swallowed a run's early refusal.
test("⚠ subscribe delivers startup records as `replayed` and a run's events as `live` (#96)", async () => {
	const hosted = await hostedSession([lateNotifyProbe]);
	const deliveries: Array<[string, string]> = [];
	hosted.session.subscribe((event, delivery) => {
		if (event.type === "extension_ui_request" && event.method === "notify") {
			deliveries.push([String(event.message).slice(0, 16), delivery]);
		}
	});
	// Everything replayed so far came from session_start — multi-account's notices among them.
	expect(deliveries.length).toBeGreaterThan(0);
	expect(deliveries.every(([, delivery]) => delivery === "replayed")).toBe(true);
	expect(deliveries.some(([message]) => message.startsWith("pi-multi-account"))).toBe(true);

	await new Promise<void>((resolve, reject) => {
		hosted.session.prompt(
			{ message: "/zen-late-notify" },
			{ onAccepted: resolve, onRejected: (reason) => reject(new Error(reason)) },
		);
	});
	expect(deliveries.at(-1)).toEqual(["late notify", "live"]);
});
