/**
 * pi rpc wire types (#24), transcribed from `docs/rpc.md` of pi 0.84.4.
 *
 * Deliberately NOT exhaustive. Only what the transport must understand to route a record
 * is typed here; event payloads stay `unknown` until the mapping layer claims them, so an
 * unmodelled event is forwarded rather than dropped.
 *
 * ⚠ That is the important property. pi's event list will grow, and a transport that
 * narrowed every event to a closed union would silently discard whatever it did not
 * recognise — the failure this project keeps finding. Routing needs `type` and `id`; it
 * does not need to understand `compaction_start`.
 */

/** Base64 image content, accepted by `prompt`, `steer` and `follow_up`. */
export interface PiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** What to do when a prompt arrives while the agent is already streaming. */
export type PiStreamingBehavior = "steer" | "followUp";

/**
 * A command written to pi's stdin, one JSON object per line.
 *
 * `id` is optional in the protocol but mandatory here: the client assigns one so every
 * command is correlatable. An uncorrelated command's failure is unattributable.
 */
export interface PiRpcCommand {
	id: string;
	type: string;
	[field: string]: unknown;
}

/**
 * A command as a caller supplies it — the client assigns `id`.
 *
 * ⚠ Declared explicitly rather than as `Omit<PiRpcCommand, "id">`. `PiRpcCommand` carries
 * an index signature, so `keyof` it is `string | number` and `Exclude<string | number,
 * "id">` removes nothing — `Omit` silently discards the named `type` field instead of the
 * `id` one. The typechecker caught it; the shape is spelled out so it cannot recur.
 */
export interface PiRpcCommandInput {
	type: string;
	[field: string]: unknown;
}

/** A command acknowledgement. Emitted once per `id`. */
export interface PiRpcResponse {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	error?: string;
}

/** Anything else pi writes to stdout. */
export interface PiRpcEvent {
	type: string;
	[field: string]: unknown;
}

export type PiRpcRecord = PiRpcResponse | PiRpcEvent;

export function isPiRpcResponse(record: PiRpcRecord): record is PiRpcResponse {
	return record.type === "response";
}

/**
 * ⚠ `agent_end` reports ONE low-level run and may be followed by an automatic retry;
 * `agent_settled` is the session-level settle. A client that treats `agent_end` as
 * completion presents "done" in the middle of a retry (`docs/rpc.md` § agent_end).
 */
export function isRunComplete(event: PiRpcEvent): boolean {
	return event.type === "agent_settled";
}

/** True for an `agent_end` that will be followed by an automatic retry. */
export function willRetryAfter(event: PiRpcEvent): boolean {
	return event.type === "agent_end" && event.willRetry === true;
}

/** Thrown when a record is not parseable JSON. Carries the raw line for diagnosis. */
export class PiRpcParseError extends Error {
	constructor(
		readonly raw: string,
		cause: unknown,
	) {
		super(`pi rpc record was not valid JSON: ${raw.slice(0, 200)}`);
		this.name = "PiRpcParseError";
		this.cause = cause;
	}
}

/**
 * Parse one JSONL record.
 *
 * ⚠ Throws rather than returning undefined on bad JSON. A silently dropped record is
 * indistinguishable from pi having nothing to say, and pi itself reports malformed input
 * as `{"command":"parse","success":false}` — so both directions surface.
 */
export function parsePiRpcRecord(raw: string): PiRpcRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new PiRpcParseError(raw, cause);
	}
	if (typeof parsed !== "object" || parsed === null || typeof (parsed as PiRpcRecord).type !== "string") {
		throw new PiRpcParseError(raw, new Error("record has no string `type`"));
	}
	return parsed as PiRpcRecord;
}
