import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

/**
 * pi rpc wire types (#24), as TypeBox schemas — transcribed from `docs/rpc.md` of pi 0.84.4.
 *
 * These describe input from another process, so they are the one place in the web package
 * where runtime validation is not optional. TypeBox gives the schema, the TypeScript type
 * and the validator from a single declaration, which is why there is no hand-written guard
 * beside a hand-written interface here.
 *
 * ⚠ DELIBERATELY NOT EXHAUSTIVE, AND THE SCHEMAS ARE OPEN.
 * Only what the transport must understand to ROUTE a record is described. Event payloads
 * stay unconstrained, so an unmodelled event validates and is forwarded rather than
 * rejected. pi's event list will grow, and a schema that closed every event would turn a
 * new event type into a parse failure — converting "we don't render this yet" into "the
 * transport is broken".
 */

/** Base64 image content, accepted by `prompt`, `steer` and `follow_up`. */
export const PiImageContent = Type.Object({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String(),
});
export type PiImageContent = Static<typeof PiImageContent>;

/** What to do when a prompt arrives while the agent is already streaming. */
export const PiStreamingBehavior = Type.Union([
	Type.Literal("steer"),
	Type.Literal("followUp"),
]);
export type PiStreamingBehavior = Static<typeof PiStreamingBehavior>;

/**
 * ⚠ Open-object types need an explicit intersection.
 *
 * `additionalProperties: Type.Unknown()` makes the SCHEMA accept extra fields, but
 * `Static<>` does not synthesise an index signature from it — verified against typebox
 * 1.3.25. So the runtime shape comes from the schema and the open-record ergonomics come
 * from the intersection. Both halves are needed; neither alone is enough.
 */
type OpenRecord = Record<string, unknown>;

const openObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: Type.Unknown() });

/**
 * A command written to pi's stdin, one JSON object per line.
 *
 * `id` is optional in the protocol but mandatory here: the client assigns one so every
 * command is correlatable. An uncorrelated command's failure is unattributable.
 */
export const PiRpcCommandSchema = openObject({
	id: Type.String({ minLength: 1 }),
	type: Type.String({ minLength: 1 }),
});
export type PiRpcCommand = Static<typeof PiRpcCommandSchema> & OpenRecord;

/**
 * A command as a caller supplies it — the client assigns `id`.
 *
 * ⚠ Declared as its own schema rather than an `Omit` of the above. When this was a plain
 * interface, `Omit<PiRpcCommand, "id">` silently discarded the wrong field: the interface
 * carried an index signature, so `keyof` it was `string | number` and
 * `Exclude<string | number, "id">` removed nothing — `Omit` dropped the named `type`
 * instead. Two declarations, no derivation, no recurrence.
 */
export const PiRpcCommandInputSchema = openObject({
	type: Type.String({ minLength: 1 }),
});
export type PiRpcCommandInput = Static<typeof PiRpcCommandInputSchema> & OpenRecord;

/** A command acknowledgement. Emitted once per `id`. */
export const PiRpcResponseSchema = openObject({
	type: Type.Literal("response"),
	command: Type.String(),
	success: Type.Boolean(),
	id: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});
export type PiRpcResponse = Static<typeof PiRpcResponseSchema> & OpenRecord;

/** Anything else pi writes to stdout. Only `type` is constrained — see the header. */
export const PiRpcEventSchema = openObject({
	type: Type.String({ minLength: 1 }),
});
export type PiRpcEvent = Static<typeof PiRpcEventSchema> & OpenRecord;

export type PiRpcRecord = PiRpcResponse | PiRpcEvent;

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
	// Validated against the schema rather than by hand-checking `typeof`, so the shape
	// requirement lives in one place and the error message can name what failed.
	if (!recordValidator.Check(parsed)) {
		throw new PiRpcParseError(raw, new Error("record does not match the pi rpc record schema"));
	}
	return parsed;
}
