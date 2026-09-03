import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { PiTransport } from "./client.ts";

/**
 * `PiTransport` over a real pi process (#24).
 *
 * ⚠ WHERE PI RUNS IS A PARAMETER, NOT AN ASSUMPTION
 * `command` and `args` are supplied, so this launches `pi` on PATH today and a container
 * entrypoint or a worktree-scoped wrapper tomorrow without any consumer changing. That is
 * what made deferring the sandbox cheap (#24) rather than a commitment we have to unwind.
 *
 * ⚠ AND IT IS NOT `pi --acp`.
 * TanStack AI's ACP adapter docs use `pi --acp -m <model>` as their worked example. pi has
 * no `--acp` flag — it prints help and exits 0. pi speaks `--mode rpc`, which is what this
 * launches, and that choice is what keeps images and streamed usage (both unsupported by
 * `@tanstack/ai-acp`).
 */

const DEFAULT_PI_COMMAND = "pi";
/** `--mode rpc` is the whole reason this transport exists; it is not caller-overridable. */
const RPC_MODE_ARGS = ["--mode", "rpc"] as const;

/**
 * WHERE PI RUNS, as data — a TypeBox schema because this is the half that can arrive from
 * a config file, a settings UI, or a request, and therefore the half that needs validating
 * at a boundary rather than trusting.
 *
 * ⚠ `cwd` is the tree pi will read and write. With no sandbox (#24), this value IS the
 * blast radius, so it is the last field that should be accepted unvalidated. `minLength`
 * is the floor, not the check — a caller still has to decide the path is one it meant.
 */
export const PiLaunchConfig = Type.Object({
	/** Executable. Defaults to `pi` on PATH; override to reach a container or wrapper. */
	command: Type.Optional(Type.String({ minLength: 1 })),
	/** Extra args appended after `--mode rpc` — e.g. `--model`, `--session-dir`. */
	args: Type.Optional(Type.Array(Type.String())),
	/** Working directory for the agent. This is the tree pi will read and write. */
	cwd: Type.String({ minLength: 1 }),
	/** Environment for the child. Passed through verbatim; the caller decides what leaks. */
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type PiLaunchConfig = Static<typeof PiLaunchConfig>;

const launchConfigValidator = Compile(PiLaunchConfig);

/** Validate a launch config from an untrusted source. */
export function isPiLaunchConfig(value: unknown): value is PiLaunchConfig {
	return launchConfigValidator.Check(value);
}

/**
 * The callbacks. A plain interface, deliberately.
 *
 * ⚠ WHY THESE ARE NOT A SCHEMA, WHILE THE CONFIG ABOVE IS
 * TypeBox can express a function — `Type.Function([...], ...)` — and its validator does
 * check `typeof === "function"`. But it emits `{"type": "function"}`, which is NOT standard
 * JSON Schema. So converting a callback bag costs the single property that made TypeBox the
 * right choice for this repo (a schema IS a JSON Schema, usable for the HTTP contract and
 * OpenAPI without a conversion step) and buys a `typeof` check.
 *
 * The rule, so the next session does not re-derive it: **data that crosses a boundary gets
 * a schema; behaviour wired at a composition root stays an interface.** By that rule
 * `PiTransport`, `PiRpcClientOptions` and `PiProcessHandle` are interfaces — they carry
 * methods and callbacks, never serialised state. `PiLaunchConfig` is a schema because it is
 * pure data that can come from outside the process.
 */
export interface PiProcessCallbacks {
	/** Notified for anything pi writes to stderr. */
	onStderr?: (chunk: string) => void;
	/** Notified once the child exits, with its code and signal. */
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** What `spawnPiRpcProcess` takes: validated launch data plus unvalidatable behaviour. */
export type PiProcessOptions = PiLaunchConfig & PiProcessCallbacks;

export interface PiProcessHandle {
	transport: PiTransport;
	/** Ask pi to stop. Returns once the signal is sent, not once it has exited. */
	stop(): void;
	readonly pid: number | undefined;
}

/**
 * Spawn pi in rpc mode and expose it as a `PiTransport`.
 *
 * ⚠ `stdout` is set to UTF-8 but NOT line-buffered by us — framing is the splitter's job
 * inside `PiRpcClient`, because a chunk boundary from a pipe falls wherever the OS decides
 * and a "line" here would be a guess. See `jsonl.ts` for why a generic line reader is
 * wrong for this protocol specifically.
 */
/**
 * Wrap an already-spawned child as a `PiTransport`.
 *
 * Split out from `spawnPiRpcProcess` so this half is testable against ANY process that
 * writes JSONL — the tests drive it with `node -e`, which exercises real pipes, real chunk
 * boundaries and a real close, none of which a fake would. Only argument construction is
 * left to the injected `spawn`.
 */
export function piTransportFromChild(
	child: ChildProcessWithoutNullStreams,
	options: PiProcessCallbacks = {},
): PiTransport {
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	if (options.onStderr !== undefined) {
		child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
	}
	if (options.onExit !== undefined) {
		child.on("exit", (code, signal) => options.onExit?.(code, signal));
	}

	return {
		write: (line) => {
			// A dead pipe throws EPIPE asynchronously; the client's close handling reports
			// outstanding commands, so swallowing here would hide the cause.
			child.stdin.write(line);
		},
		onData: (consume) => {
			child.stdout.on("data", (chunk: string) => consume(chunk));
		},
		onClose: (consume) => {
			// `close` rather than `exit`, because Node fires `close` only once every stdio
			// stream is done while `exit` can fire with stdout still buffered — which would
			// drop the final records the splitter holds.
			//
			// ⚠ REASONED, NOT PROVEN. Mutating this to `exit` leaves the whole suite green:
			// the tests here write little enough that the two events coalesce, and forcing a
			// buffered-at-exit race reliably is not something a test can promise. Kept
			// because it is the documented-correct listener, not because a test defends it —
			// so do not "simplify" it to `exit` on the strength of a passing suite.
			child.on("close", () => consume());
		},
	};
}

/** The spawn call, injectable so argument construction is assertable without launching pi. */
export type SpawnLike = typeof spawn;

export function spawnPiRpcProcess(
	options: PiProcessOptions,
	spawnImpl: SpawnLike = spawn,
): PiProcessHandle {
	const child: ChildProcessWithoutNullStreams = spawnImpl(
		options.command ?? DEFAULT_PI_COMMAND,
		[...RPC_MODE_ARGS, ...(options.args ?? [])],
		{
			cwd: options.cwd,
			// `spawn` inherits the parent environment when `env` is omitted; passing an
			// explicit object replaces it entirely. Both are legitimate — the caller chooses.
			...(options.env === undefined ? {} : { env: options.env }),
			stdio: ["pipe", "pipe", "pipe"],
		},
	) as ChildProcessWithoutNullStreams;

	return {
		transport: piTransportFromChild(child, options),
		stop: () => {
			child.stdin.end();
			child.kill("SIGTERM");
		},
		get pid() {
			return child.pid;
		},
	};
}
