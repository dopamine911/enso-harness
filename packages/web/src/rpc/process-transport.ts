import type {
	PiProcessCallbacks,
	PiProcessHandle,
	PiProcessOptions,
	PiTransport,
} from "@zen/core";

/**
 * `PiTransport` over a real pi process (#24), spawned with `Bun.spawn` (#30).
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
 *
 * ⚠ WHY `Bun.spawn` AND NOT `node:child_process` (#30)
 * The old transport listened for Node's `close` event over `exit` to avoid dropping a final
 * record still buffered at exit — and its own comment admitted that choice was REASONED,
 * NOT PROVEN, then #30 moved the process onto bun where the claim was about a compat shim
 * nobody had read. Here the ordering is structural instead of evented: `onClose` consumers
 * fire only after BOTH stdio pumps have read their streams to end-of-stream, so everything
 * pi wrote — including an unterminated final record — has already been delivered to the
 * data consumers by the time close is announced. There is no event to pick wrongly.
 */

const DEFAULT_PI_COMMAND = "pi";
/** `--mode rpc` is the whole reason this transport exists; it is not caller-overridable. */
const RPC_MODE_ARGS = ["--mode", "rpc"] as const;

/**
 * The slice of `Bun.Subprocess` the transport touches, named so a test can hand in a fake
 * without reproducing the full `Subprocess` surface (ipc, ref-counting, resource usage).
 * A real `Subprocess<"pipe", "pipe", "pipe">` satisfies it structurally.
 */
export interface PiChildProcess {
	/** Bun's `FileSink`: writes are buffered until `flush()`; `end()` closes the pipe. */
	readonly stdin: {
		write(chunk: string): number | Promise<number>;
		flush(): number | Promise<number>;
		end(): number | Promise<number>;
	};
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly pid: number;
	/** Resolves when the process exits — what tells the stop escalation to stand down. */
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Decode a stdio stream as UTF-8 and hand each non-empty text chunk to `consume`; resolves
 * once the stream ends (the child closed that pipe and everything buffered was read).
 *
 * ⚠ ONE `TextDecoder` PER STREAM, IN STREAMING MODE. A multibyte character can be split
 * across pipe chunks; `decode(value, { stream: true })` holds the partial sequence instead
 * of emitting U+FFFD into the middle of a JSON line. The final bare `decode()` flushes a
 * sequence left dangling by a child that died mid-character.
 */
async function pumpUtf8Stream(
	stream: ReadableStream<Uint8Array>,
	consume: (text: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		if (text.length > 0) consume(text);
	}
	const tail = decoder.decode();
	if (tail.length > 0) consume(tail);
}

export function piTransportFromChild(
	child: PiChildProcess,
	callbacks: Pick<PiProcessCallbacks, "onStderr"> = {},
): PiTransport {
	const dataConsumers: Array<(chunk: string) => void> = [];
	const closeConsumers: Array<() => void> = [];

	// ⚠ The stdout pump starts NOW, possibly before any consumer has registered. Node's
	// paused-mode streams buffered early output until a 'data' listener attached; a pump has
	// no such courtesy, and pi DOES write unsolicited stdout at startup (the multi-account
	// extension's notify). So chunks that arrive consumer-less are held here and flushed to
	// the first `onData` registration — dropped-on-the-floor is not an acceptable default.
	const chunksBeforeFirstConsumer: string[] = [];
	const stdoutDrained = pumpUtf8Stream(child.stdout, (text) => {
		if (dataConsumers.length === 0) {
			chunksBeforeFirstConsumer.push(text);
			return;
		}
		for (const consume of dataConsumers) consume(text);
	});
	const stderrDrained = pumpUtf8Stream(child.stderr, (text) => callbacks.onStderr?.(text));

	// Close = both pipes fully drained, matching what Node's `close` event promised — but as
	// an ordering guarantee of this code, not a property of someone else's event scheduling.
	// The flag makes a LATE `onClose` registration see the close instead of hanging forever,
	// the same courtesy the held-chunk buffer extends to a late `onData`.
	let isClosed = false;
	void Promise.all([stdoutDrained, stderrDrained]).then(() => {
		isClosed = true;
		for (const consume of closeConsumers) consume();
	});

	return {
		write: (line) => {
			// A FileSink buffers; flush pushes the frame down the pipe now. An rpc command
			// must not sit in a buffer waiting for later writes that may never come.
			//
			// ⚠ A write to a DEAD pipe is silent under bun — no sync throw, no async EPIPE
			// (observed 2026-09-03: write/flush after child exit return normally). Node threw
			// EPIPE here; bun reports nothing, so the close handling above is the ONLY signal
			// that a command went to a pi that is gone. Do not add error handling here
			// expecting one.
			child.stdin.write(line);
			child.stdin.flush();
		},
		onData: (consume) => {
			dataConsumers.push(consume);
			// Flush anything that arrived before a consumer existed, preserving order. Splice
			// first so a consumer that triggers more pump activity cannot double-deliver.
			const held = chunksBeforeFirstConsumer.splice(0);
			for (const chunk of held) consume(chunk);
		},
		onClose: (consume) => {
			if (isClosed) {
				consume();
				return;
			}
			closeConsumers.push(consume);
		},
	};
}

/**
 * The spawn call, injectable so argument construction is assertable without launching pi.
 * The options shape is the subset of `Bun.SpawnOptions` this module actually passes.
 */
export type SpawnLike = (
	cmd: string[],
	options: {
		cwd: string;
		env?: Record<string, string | undefined>;
		stdin: "pipe";
		stdout: "pipe";
		stderr: "pipe";
		onExit?: (child: unknown, exitCode: number | null, signalCode: number | null) => void;
	},
) => PiChildProcess;

/** The real spawn, adapted once so the seam type stays narrower than `typeof Bun.spawn`. */
const spawnWithBun: SpawnLike = (cmd, options) => Bun.spawn(cmd, options);

/**
 * How long `stop()` gives pi to exit on its own before SIGKILL (#34).
 *
 * Measured: a healthy pi exits on SIGTERM within ~2s, idle or mid-tool (⚠ an earlier
 * "pi defers SIGTERM mid-tool" reading was FALSE — the signal it appeared to defer was
 * never delivered, because the request-close hook that should have sent it was inert
 * under bun; see the response-close comment in server/index.ts). The escalation is
 * therefore insurance against a WEDGED pi — SIGTERM is caught by a handler (SigCgt
 * receipt) and needs pi's cooperation; SIGKILL does not. 5s is comfortably past the
 * healthy exit, not a tuning knob.
 */
const STOP_ESCALATION_GRACE_MS = 5_000;

export function spawnPiRpcProcess(
	options: PiProcessOptions,
	spawnImpl: SpawnLike = spawnWithBun,
	stopEscalationGraceMs: number = STOP_ESCALATION_GRACE_MS,
): PiProcessHandle {
	const child = spawnImpl(
		[options.command ?? DEFAULT_PI_COMMAND, ...RPC_MODE_ARGS, ...(options.args ?? [])],
		{
			cwd: options.cwd,
			// `Bun.spawn` inherits the parent environment when `env` is omitted; passing an
			// explicit object replaces it entirely. Both are legitimate — the caller chooses.
			...(options.env === undefined ? {} : { env: options.env }),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Bun's callback leads with the subprocess itself; the `PiProcessCallbacks`
			// contract is (code, signal), so the extra argument is dropped here.
			onExit: (_child, exitCode, signalCode) => options.onExit?.(exitCode, signalCode),
		},
	);

	// ⚠ Idempotent, and that is load-bearing (#34): stop() has THREE callers per run — the
	// response-close handler, the run's `finally`, and the dialog registry's TTL eviction —
	// and the first call owns the whole shutdown. Later calls must not stack more timers
	// or signals.
	let stopHasRun = false;
	const stop = (): void => {
		if (stopHasRun) return;
		stopHasRun = true;
		child.stdin.end();
		child.kill("SIGTERM");
		// pi installs a SIGTERM handler (/proc/<pid>/status SigCgt receipt) and exits
		// promptly through it when healthy — but a handler means the exit is COOPERATIVE,
		// and a wedged pi would simply keep running. SIGKILL after the grace needs no
		// cooperation.
		const escalation = setTimeout(() => {
			child.kill("SIGKILL");
		}, stopEscalationGraceMs);
		// `unref` so a pending escalation never holds the server open on shutdown; cleared
		// on exit so the timer does not fire into a dead pid.
		escalation.unref?.();
		void child.exited.then(() => clearTimeout(escalation));
	};

	return {
		transport: piTransportFromChild(child, options),
		stop,
		get pid() {
			return child.pid;
		},
	};
}
