import { expect, test } from "bun:test";
import { isPiLaunchConfig, type PiRpcEvent } from "@zen/core";
import { PiRpcClient } from "../client.ts";
import {
	type PiChildProcess,
	piTransportFromChild,
	type SpawnLike,
	spawnPiRpcProcess,
} from "../process-transport.ts";

/**
 * These drive a REAL child process (`bun -e`, since `process.execPath` under `bun test` is
 * bun itself) rather than a fake, so they exercise real pipes, real chunk boundaries and a
 * real close — none of which a fake reproduces, and all of which the transport exists to
 * handle.
 */
const bunEmitting = (script: string): PiChildProcess =>
	Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

function collect(child: PiChildProcess) {
	const events: PiRpcEvent[] = [];
	const problems: unknown[] = [];
	const closed = new Promise<void>((resolve) => {
		const transport = piTransportFromChild(child);
		const wrapped = {
			...transport,
			onClose: (consume: () => void) =>
				transport.onClose(() => {
					consume();
					resolve();
				}),
		};
		new PiRpcClient({
			transport: wrapped,
			onEvent: (event) => events.push(event),
			onParseError: (error) => problems.push(error),
		});
	});
	return { events, problems, closed };
}

test("records written by a real process arrive parsed and in order", async () => {
	const child = bunEmitting(
		`process.stdout.write('{"type":"agent_start"}\\n{"type":"turn_start"}\\n')`,
	);
	const { events, closed } = collect(child);
	await closed;
	expect(events.map((event) => event.type)).toEqual(["agent_start", "turn_start"]);
});

test("a record split across real writes is reassembled", async () => {
	const child = bunEmitting(
		`process.stdout.write('{"type":"message_');` +
			`setTimeout(() => process.stdout.write('update","delta":"x"}\\n'), 20)`,
	);
	const { events, closed } = collect(child);
	await closed;
	expect(events).toHaveLength(1);
	expect(events[0]?.type).toBe("message_update");
});

// ⚠ pi may exit without a trailing newline — the final record must still land. The transport
// guarantees this structurally: `onClose` fires only after the stdout pump has read the
// stream to its end, so the splitter has flushed before close is announced.
test("an unterminated final record survives process exit", async () => {
	const child = bunEmitting(`process.stdout.write('{"type":"agent_settled"}')`);
	const { events, closed } = collect(child);
	await closed;
	expect(events.map((event) => event.type)).toEqual(["agent_settled"]);
});

// ⚠⚠ The separator case, end to end through a real pipe rather than a string in a test.
test("U+2028 inside a real process's JSON output is data, not a boundary", async () => {
	const child = bunEmitting(
		`process.stdout.write('{"type":"message_update","text":"a\\u2028b"}\\n')`,
	);
	const { events, closed } = collect(child);
	await closed;
	expect(events).toHaveLength(1);
	// The escape, not a pasted literal — U+2028 renders exactly like a space in an editor.
	expect(events[0]?.text).toBe("a\u2028b");
});

test("a command written to a real process reaches its stdin", async () => {
	// Echoes back whatever it is sent, so the write path is observable.
	const child = bunEmitting(
		`let buf=""; process.stdin.on("data", c => { buf += c; ` +
			`if (buf.includes("\\n")) { process.stdout.write('{"id":"zen-1","type":"response","command":"prompt","success":true}\\n'); process.exit(0); } })`,
	);
	const transport = piTransportFromChild(child);
	const client = new PiRpcClient({ transport });
	const response = await client.send({ type: "prompt", message: "hi" });
	expect(response.success).toBe(true);
	expect(response.command).toBe("prompt");
});

// ⚠ The parity Node's paused-mode streams gave for free: output that arrives before any
// consumer registers must be HELD, not dropped — pi writes unsolicited stdout at startup
// (the multi-account extension's notify), and a consumer one task late must still see it.
// This test fails on a transport whose pump dispatches into an empty consumer list.
test("output arriving before onData registers is buffered, not dropped", async () => {
	const child = bunEmitting(`process.stdout.write('{"type":"agent_start"}\\n')`);
	const transport = piTransportFromChild(child);
	// Close fires only after both pumps drained — so at this point EVERYTHING the child
	// wrote has been pumped, and no data consumer existed to receive it: held, or gone.
	await new Promise<void>((resolve) => transport.onClose(resolve));
	const chunks: string[] = [];
	transport.onData((chunk) => chunks.push(chunk));
	expect(chunks.join("")).toContain('"agent_start"');
	// And a consumer arriving after close must see the close (synchronous replay), not hang.
	let lateCloseSeen = false;
	transport.onClose(() => {
		lateCloseSeen = true;
	});
	expect(lateCloseSeen).toBe(true);
});

// Deterministic, not a coalescing accident: close waits for BOTH stdio pumps, so by the
// time it fires the stderr chunk has been delivered.
test("stderr is surfaced to its consumer", async () => {
	const child = bunEmitting(`process.stderr.write("a warning")`);
	const chunks: string[] = [];
	const transport = piTransportFromChild(child, { onStderr: (chunk) => chunks.push(chunk) });
	await new Promise<void>((resolve) => transport.onClose(resolve));
	expect(chunks.join("")).toContain("a warning");
});

// --- argument construction, asserted via an injected spawn rather than by launching pi.
// ⓘ `cmd[0]` is the executable — Bun.spawn takes one array, not (command, args).

test("`--mode rpc` is always first and is not caller-overridable", () => {
	let captured: readonly string[] = [];
	const fakeSpawn: SpawnLike = (cmd) => {
		captured = cmd;
		return bunEmitting("");
	};
	spawnPiRpcProcess({ cwd: "/tmp", args: ["--model", "x", "--mode", "text"] }, fakeSpawn);
	expect(captured.slice(1, 3)).toEqual(["--mode", "rpc"]);
	// a caller's contradictory --mode lands after ours; the point is ours is never dropped
	expect(captured).toContain("--model");
});

test("the executable and cwd are parameters, so pi's location is not assumed", () => {
	let capturedCommand = "";
	let capturedCwd: string | undefined;
	const fakeSpawn: SpawnLike = (cmd, options) => {
		capturedCommand = cmd[0] ?? "";
		capturedCwd = options.cwd;
		return bunEmitting("");
	};
	spawnPiRpcProcess({ command: "/opt/container/pi-wrapper", cwd: "/work/repo" }, fakeSpawn);
	expect(capturedCommand).toBe("/opt/container/pi-wrapper");
	expect(capturedCwd).toBe("/work/repo");
});

test("the default executable is `pi` on PATH", () => {
	let capturedCommand = "";
	const fakeSpawn: SpawnLike = (cmd) => {
		capturedCommand = cmd[0] ?? "";
		return bunEmitting("");
	};
	spawnPiRpcProcess({ cwd: "/tmp" }, fakeSpawn);
	expect(capturedCommand).toBe("pi");
});

// Bun's own onExit leads with the subprocess; the `PiProcessCallbacks` contract is
// (code, signal). This asserts the adapter drops the extra argument rather than shifting it.
test("onExit is delivered as (code, signal), without Bun's leading subprocess argument", () => {
	let capturedOnExit:
		| ((child: unknown, exitCode: number | null, signalCode: number | null) => void)
		| undefined;
	const fakeSpawn: SpawnLike = (_cmd, options) => {
		capturedOnExit = options.onExit;
		return bunEmitting("");
	};
	const received: unknown[] = [];
	spawnPiRpcProcess(
		{ cwd: "/tmp", onExit: (code, signal) => received.push(code, signal) },
		fakeSpawn,
	);
	expect(capturedOnExit).toBeDefined();
	capturedOnExit?.({ notTheCode: true }, 143, 15);
	expect(received).toEqual([143, 15]);
});

// --- stop() escalation (#34): pi catches SIGTERM and defers it mid-tool, so stop() must
// follow up with SIGKILL after a grace — and must be idempotent, because it has three
// callers per run and stacked timers would mean stacked signals.

const STOP_TEST_GRACE_MS = 10;
const STOP_TEST_SETTLE_MS = 40;

function stoppableFakeChild(exited: Promise<number>): {
	child: PiChildProcess;
	signalsSent: (number | NodeJS.Signals | undefined)[];
} {
	const signalsSent: (number | NodeJS.Signals | undefined)[] = [];
	const emptyStream = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	const child: PiChildProcess = {
		stdin: { write: () => 0, flush: () => 0, end: () => 0 },
		stdout: emptyStream(),
		stderr: emptyStream(),
		pid: 4242,
		exited,
		kill: (signal) => {
			signalsSent.push(signal);
		},
	};
	return { child, signalsSent };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, STOP_TEST_SETTLE_MS));

test("stop() on a pi that exits within the grace sends SIGTERM only", async () => {
	const { child, signalsSent } = stoppableFakeChild(Promise.resolve(0));
	const handle = spawnPiRpcProcess({ cwd: "/tmp" }, () => child, STOP_TEST_GRACE_MS);
	handle.stop();
	await settle();
	expect(signalsSent).toEqual(["SIGTERM"]);
});

test("stop() on a pi that ignores SIGTERM escalates to SIGKILL after the grace", async () => {
	const neverExits = new Promise<number>(() => {});
	const { child, signalsSent } = stoppableFakeChild(neverExits);
	const handle = spawnPiRpcProcess({ cwd: "/tmp" }, () => child, STOP_TEST_GRACE_MS);
	handle.stop();
	expect(signalsSent).toEqual(["SIGTERM"]);
	await settle();
	expect(signalsSent).toEqual(["SIGTERM", "SIGKILL"]);
});

test("stop() is idempotent — a second call adds no signal and no second timer", async () => {
	const neverExits = new Promise<number>(() => {});
	const { child, signalsSent } = stoppableFakeChild(neverExits);
	const handle = spawnPiRpcProcess({ cwd: "/tmp" }, () => child, STOP_TEST_GRACE_MS);
	handle.stop();
	handle.stop();
	expect(signalsSent).toEqual(["SIGTERM"]);
	await settle();
	// Exactly one escalation, not one per call.
	expect(signalsSent).toEqual(["SIGTERM", "SIGKILL"]);
});

// --- PiLaunchConfig: the data half, validated because it can come from outside
test("a valid launch config passes", () =>
	expect(isPiLaunchConfig({ cwd: "/work/repo", command: "pi", args: ["--model", "x"] })).toBe(
		true,
	));

test("cwd is required — it is the blast radius with no sandbox", () => {
	expect(isPiLaunchConfig({ command: "pi" })).toBe(false);
	expect(isPiLaunchConfig({ cwd: "" })).toBe(false);
});

test("an empty command is rejected rather than silently defaulting", () =>
	expect(isPiLaunchConfig({ cwd: "/w", command: "" })).toBe(false));

test("args must be strings, so a number cannot reach the command line", () =>
	expect(isPiLaunchConfig({ cwd: "/w", args: ["--model", 7] })).toBe(false));

test("env values must be strings", () => {
	expect(isPiLaunchConfig({ cwd: "/w", env: { PATH: "/usr/bin" } })).toBe(true);
	expect(isPiLaunchConfig({ cwd: "/w", env: { PATH: 7 } })).toBe(false);
});

test("callbacks are absent from the schema, so passing them does not fail validation", () =>
	// they live on PiProcessCallbacks, an interface — the schema is open, so extra keys pass
	expect(isPiLaunchConfig({ cwd: "/w", onStderr: () => undefined })).toBe(true));
