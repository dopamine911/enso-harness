import { JsonLinesSplitter } from "./jsonl.ts";
import {
	claimsToBeResponse,
	isPiRpcResponse,
	parsePiRpcRecord,
	type PiRpcCommand,
	type PiRpcCommandInput,
	type PiRpcEvent,
	type PiRpcResponse,
} from "./protocol.ts";

/**
 * Correlating client for pi's rpc mode (#24).
 *
 * WHY AN INJECTED TRANSPORT
 * The repo's convention is injected seams at a composition root, not stubs. `PiTransport`
 * is the whole IO surface, so every test here runs against a fake and none of them spawn
 * pi — which also means the correlation logic is tested independently of whether pi is
 * installed, authenticated, or in a mode that would answer.
 *
 * ⚠ WHERE THE PI PROCESS LIVES IS NOT THIS FILE'S BUSINESS.
 * The transport is handed in, so pi may run locally, in a container, or in a worktree
 * without a line changing here (#24: "the pi process is launched by us, so its location
 * stays a parameter"). That is what makes the deferred sandbox decision cheap.
 */

/** The complete IO surface. Implemented over a child process at the composition root. */
export interface PiTransport {
	/** Write one framed command line. */
	write(line: string): void;
	/** Register the stdout consumer. Called once. */
	onData(consume: (chunk: string) => void): void;
	/** Register the close consumer, so a pending command can be rejected rather than hang. */
	onClose(consume: () => void): void;
}

export interface PiRpcClientOptions {
	transport: PiTransport;
	/** Injected so tests are deterministic and ids stay greppable in a log. */
	nextCommandId?: () => string;
	/** Notified for every non-response record, including types we do not model. */
	onEvent?: (event: PiRpcEvent) => void;
	/**
	 * Notified when a record fails to parse.
	 *
	 * ⚠ Separate from `onEvent` and never silent: a dropped record looks exactly like pi
	 * having nothing to say, which is the failure shape #24 exists to avoid.
	 */
	onParseError?: (error: unknown) => void;
}

/** Rejection when pi closes with a command still outstanding. */
export class PiTransportClosedError extends Error {
	constructor(readonly pendingCommandIds: readonly string[]) {
		super(`pi rpc transport closed with ${pendingCommandIds.length} command(s) outstanding`);
		this.name = "PiTransportClosedError";
	}
}

export class PiRpcClient {
	readonly #transport: PiTransport;
	readonly #splitter = new JsonLinesSplitter();
	readonly #pending = new Map<string, (response: PiRpcResponse) => void>();
	readonly #nextCommandId: () => string;
	readonly #onEvent: ((event: PiRpcEvent) => void) | undefined;
	readonly #onParseError: ((error: unknown) => void) | undefined;
	#closed = false;
	#sequence = 0;

	constructor(options: PiRpcClientOptions) {
		this.#transport = options.transport;
		this.#onEvent = options.onEvent;
		this.#onParseError = options.onParseError;
		this.#nextCommandId = options.nextCommandId ?? (() => `zen-${++this.#sequence}`);

		this.#transport.onData((chunk) => this.#consume(chunk));
		this.#transport.onClose(() => this.#handleClose());
	}

	/**
	 * Send a command and resolve with its acknowledgement.
	 *
	 * ⚠ Resolves on `success: false` rather than rejecting. Per `docs/rpc.md`, a false
	 * `success` means the command was rejected *before acceptance* — a normal protocol
	 * outcome the caller must inspect, not an exception. Only a closed transport rejects.
	 */
	send(command: PiRpcCommandInput): Promise<PiRpcResponse> {
		if (this.#closed) return Promise.reject(new PiTransportClosedError([]));
		const id = this.#nextCommandId();
		const framed: PiRpcCommand = { ...command, id }; // id last: a caller cannot displace it
		return new Promise<PiRpcResponse>((resolve) => {
			this.#pending.set(id, resolve);
			// One JSON object per line, LF-terminated — the same framing we parse.
			this.#transport.write(`${JSON.stringify(framed)}\n`);
		});
	}

	/** Commands awaiting an acknowledgement, in send order. */
	get pendingCommandIds(): readonly string[] {
		return [...this.#pending.keys()];
	}

	#consume(chunk: string): void {
		for (const raw of this.#splitter.push(chunk)) this.#dispatch(raw);
	}

	#dispatch(raw: string): void {
		let record: ReturnType<typeof parsePiRpcRecord>;
		try {
			record = parsePiRpcRecord(raw);
		} catch (error) {
			this.#onParseError?.(error);
			return;
		}

		// Route on the discriminant, validate after. A malformed response must be reported
		// as a protocol violation, not delivered into the event stream as if it were one.
		if (!claimsToBeResponse(record)) {
			this.#onEvent?.(record);
			return;
		}
		if (!isPiRpcResponse(record)) {
			this.#onParseError?.(record);
			return;
		}

		// ⚠ A response with no id cannot be correlated — pi emits one for a parse failure
		// of our own malformed input. Surface it as an error rather than discarding it.
		if (record.id === undefined) {
			this.#onParseError?.(record);
			return;
		}

		const resolve = this.#pending.get(record.id);
		// An unknown id is not ours to resolve. Do not guess; report.
		if (resolve === undefined) {
			this.#onParseError?.(record);
			return;
		}
		this.#pending.delete(record.id);
		resolve(record);
	}

	#handleClose(): void {
		this.#closed = true;
		// Drain anything unterminated before giving up — pi may exit without a final newline.
		for (const raw of this.#splitter.flush()) this.#dispatch(raw);
		if (this.#pending.size === 0) return;
		const outstanding = [...this.#pending.keys()];
		this.#pending.clear();
		// Report rather than leave promises pending forever. A hung await is the worst
		// available outcome: no error, no result, no timeout.
		this.#onParseError?.(new PiTransportClosedError(outstanding));
	}
}
