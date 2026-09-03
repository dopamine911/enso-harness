import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, test } from "bun:test";
import { PiRpcClient } from "../client.ts";
import { piTransportFromChild, spawnPiRpcProcess, type SpawnLike } from "../process-transport.ts";
import type { PiRpcEvent } from "../protocol.ts";

/**
 * These drive a REAL child process (`node -e`) rather than a fake, so they exercise real
 * pipes, real chunk boundaries and a real close — none of which a fake reproduces, and all
 * of which the transport exists to handle.
 */
const nodeEmitting = (script: string): ChildProcessWithoutNullStreams =>
	spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });

function collect(child: ChildProcessWithoutNullStreams) {
	const events: PiRpcEvent[] = [];
	const problems: unknown[] = [];
	const closed = new Promise<void>((resolve) => {
		const transport = piTransportFromChild(child);
		const wrapped = {
			...transport,
			onClose: (consume: () => void) => transport.onClose(() => { consume(); resolve(); }),
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
	const child = nodeEmitting(
		`process.stdout.write('{"type":"agent_start"}\\n{"type":"turn_start"}\\n')`,
	);
	const { events, closed } = collect(child);
	await closed;
	expect(events.map((event) => event.type)).toEqual(["agent_start", "turn_start"]);
});

test("a record split across real writes is reassembled", async () => {
	const child = nodeEmitting(
		`process.stdout.write('{"type":"message_');` +
			`setTimeout(() => process.stdout.write('update","delta":"x"}\\n'), 20)`,
	);
	const { events, closed } = collect(child);
	await closed;
	expect(events).toHaveLength(1);
	expect(events[0]?.type).toBe("message_update");
});

// ⚠ pi may exit without a trailing newline — the final record must still land, which is
// why the transport listens for `close` and not `exit`.
test("an unterminated final record survives process exit", async () => {
	const child = nodeEmitting(`process.stdout.write('{"type":"agent_settled"}')`);
	const { events, closed } = collect(child);
	await closed;
	expect(events.map((event) => event.type)).toEqual(["agent_settled"]);
});

// ⚠⚠ The separator case, end to end through a real pipe rather than a string in a test.
test("U+2028 inside a real process's JSON output is data, not a boundary", async () => {
	const child = nodeEmitting(
		`process.stdout.write('{"type":"message_update","text":"a\\u2028b"}\\n')`,
	);
	const { events, closed } = collect(child);
	await closed;
	expect(events).toHaveLength(1);
	expect(events[0]?.text).toBe("a b");
});

test("a command written to a real process reaches its stdin", async () => {
	// Echoes back whatever it is sent, so the write path is observable.
	const child = nodeEmitting(
		`let buf=""; process.stdin.on("data", c => { buf += c; ` +
			`if (buf.includes("\\n")) { process.stdout.write('{"id":"zen-1","type":"response","command":"prompt","success":true}\\n'); process.exit(0); } })`,
	);
	const transport = piTransportFromChild(child);
	const client = new PiRpcClient({ transport });
	const response = await client.send({ type: "prompt", message: "hi" });
	expect(response.success).toBe(true);
	expect(response.command).toBe("prompt");
});

test("stderr is surfaced to its consumer", async () => {
	const child = nodeEmitting(`process.stderr.write("a warning")`);
	const chunks: string[] = [];
	await new Promise<void>((resolve) => {
		piTransportFromChild(child, { onStderr: (c) => chunks.push(c), onExit: () => resolve() });
	});
	expect(chunks.join("")).toContain("a warning");
});

// --- argument construction, asserted via an injected spawn rather than by launching pi
test("`--mode rpc` is always first and is not caller-overridable", () => {
	let captured: readonly string[] = [];
	const fakeSpawn = ((_command: string, args: readonly string[]) => {
		captured = args;
		return nodeEmitting("");
	}) as unknown as SpawnLike;
	spawnPiRpcProcess({ cwd: "/tmp", args: ["--model", "x", "--mode", "text"] }, fakeSpawn);
	expect(captured.slice(0, 2)).toEqual(["--mode", "rpc"]);
	// a caller's contradictory --mode lands after ours; the point is ours is never dropped
	expect(captured).toContain("--model");
});

test("the executable and cwd are parameters, so pi's location is not assumed", () => {
	let capturedCommand = "";
	let capturedCwd: string | undefined;
	const fakeSpawn = ((command: string, _args: readonly string[], opts: { cwd?: string }) => {
		capturedCommand = command;
		capturedCwd = opts.cwd;
		return nodeEmitting("");
	}) as unknown as SpawnLike;
	spawnPiRpcProcess({ command: "/opt/container/pi-wrapper", cwd: "/work/repo" }, fakeSpawn);
	expect(capturedCommand).toBe("/opt/container/pi-wrapper");
	expect(capturedCwd).toBe("/work/repo");
});

test("the default executable is `pi` on PATH", () => {
	let capturedCommand = "";
	const fakeSpawn = ((command: string) => {
		capturedCommand = command;
		return nodeEmitting("");
	}) as unknown as SpawnLike;
	spawnPiRpcProcess({ cwd: "/tmp" }, fakeSpawn);
	expect(capturedCommand).toBe("pi");
});
