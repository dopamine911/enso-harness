import {
	type PiRpcEvent,
	PiRpcEventSchema,
	type PiRpcRecord,
	type PiRpcResponse,
	PiRpcResponseSchema,
} from "@zen/core";
import { Compile } from "typebox/compile";

/**
 * Runtime behaviour over pi's rpc wire schemas.
 *
 * ⚠ The SCHEMAS live in `@zen/core`, not here. This module holds only what cannot be a
 * schema: compiled validators, the predicates that route a record, and the parse error.
 * Declaring a shape here would put it in two places at once, which is what `@zen/core`
 * exists to prevent.
 */

export type { PiRpcEvent, PiRpcRecord, PiRpcResponse } from "@zen/core";

/** Compiled once at module load — this runs on every record pi emits. */
const responseValidator = Compile(PiRpcResponseSchema);
const recordValidator = Compile(PiRpcEventSchema);

/**
 * Does this record CLAIM to be a response?
 *
 * ⚠ Separate from validating one, and the split matters. A record with
 * `type: "response"` but no `command` is a MALFORMED RESPONSE, not an event — routing it
 * to the event stream because it failed full validation would hide a protocol violation
 * inside normal traffic. The discriminant decides the route; the schema decides validity.
 */
export function claimsToBeResponse(record: PiRpcRecord): boolean {
	return record.type === "response";
}

export function isPiRpcResponse(record: PiRpcRecord): record is PiRpcResponse {
	return responseValidator.Check(record);
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
	/** Explicit field, not a parameter property — see `PiTransportClosedError` for why. */
	readonly raw: string;

	constructor(raw: string, cause: unknown) {
		super(`pi rpc record was not valid JSON: ${raw.slice(0, 200)}`);
		this.name = "PiRpcParseError";
		this.cause = cause;
		this.raw = raw;
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
	// Validated against the schema rather than by hand-checking `typeof`, so the shape
	// requirement lives in one place and the error message can name what failed.
	if (!recordValidator.Check(parsed)) {
		throw new PiRpcParseError(raw, new Error("record does not match the pi rpc record schema"));
	}
	return parsed;
}
