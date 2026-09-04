import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

/**
 * pi's rpc wire protocol, and the transport seams around it — transcribed from `docs/rpc.md`
 * of pi 0.84.4.
 *
 * ⚠ DELIBERATELY NOT EXHAUSTIVE, AND THE SCHEMAS ARE OPEN.
 * Only what the transport must understand to ROUTE a record is described. Event payloads
 * stay unconstrained, so an unmodelled event validates and is forwarded rather than
 * rejected. pi's event list will grow, and a schema that closed every event would turn a
 * new event type into a parse failure — converting "we do not render this yet" into "the
 * transport is broken".
 *
 * ⚠ FOUR SCHEMAS BELOW CARRY FUNCTIONS: `PiProcessCallbacks`, `PiTransport`,
 * `PiRpcClientOptions`, `PiProcessHandle`. TypeBox can express those, and its validator
 * does check `typeof === "function"` — but they serialise to `{"type": "function"}`, a
 * TypeBox extension rather than standard JSON Schema, so those four are NOT usable by an
 * OpenAPI consumer. Declared as schemas anyway, by decision: one rule the next session can
 * follow without judgement beats a finer rule that is correct and needs explaining.
 */

/** Base64 image content, accepted by `prompt`, `steer` and `follow_up`. */
export const PiImageContent = Type.Object({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String(),
});
export type PiImageContent = Static<typeof PiImageContent>;

/** What to do when a prompt arrives while the agent is already streaming. */
export const PiStreamingBehavior = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
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
 * One entry from pi's `get_commands`.
 *
 * ⚠ `source` matters for a reason the field name does not convey: these are the ONLY
 * commands invokable over rpc. pi's docs are explicit that built-in TUI commands
 * (`/settings`, `/hotkeys`, …) are excluded and "would not execute if sent via `prompt`" —
 * so a `/`-prefixed message absent from this list is not a command at all, it is prose the
 * model will try to answer. See `session.ts` for why that has to be refused rather than
 * forwarded.
 */
export const PiCommand = Type.Object({
	name: Type.String(),
	source: Type.Union([Type.Literal("extension"), Type.Literal("prompt"), Type.Literal("skill")]),
	description: Type.Optional(Type.String()),
	location: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
});
export type PiCommand = Static<typeof PiCommand>;

const commandValidator = Compile(PiCommand);

export function isPiCommand(value: unknown): value is PiCommand {
	return commandValidator.Check(value);
}

/**
 * ── The function-bearing schemas ─────────────────────────────────────────────────────────
 *
 * ⚠ These four serialise to `{"type": "function"}`, which is a TypeBox extension rather
 * than standard JSON Schema — so unlike every schema above them, they are NOT usable by an
 * OpenAPI consumer, and their validators can assert nothing beyond `typeof === "function"`.
 *
 * They are declared as schemas regardless, deliberately. The alternative was a rule saying
 * "data gets a schema, behaviour stays an interface", which is defensible and which I
 * applied inconsistently the first time — `PiProcessHandle` carries a `pid`, so it fell on
 * both sides of my own line. A single rule the next session can follow without judgement
 * beats a finer rule that is correct and needs explaining, in a codebase where every
 * session starts at week zero.
 *
 * ⓘ The `Static<>` types are what consumers actually use; the schemas exist so that every
 * shape in this repo is declared the same way and lives in one package.
 */

/** Notified for anything pi writes to stderr, and once the child exits. */
export const PiProcessCallbacks = Type.Object({
	onStderr: Type.Optional(Type.Function([Type.String()], Type.Void())),
	onExit: Type.Optional(Type.Function([Type.Union([Type.Number(), Type.Null()]), Type.Unknown()], Type.Void())),
});
export type PiProcessCallbacks = Static<typeof PiProcessCallbacks>;

/** What `spawnPiRpcProcess` takes: validated launch data plus unvalidatable behaviour. */
export type PiProcessOptions = PiLaunchConfig & PiProcessCallbacks;

/**
 * The complete IO surface between the client and a pi process.
 *
 * Implemented over a child process at the composition root — which is what keeps pi's
 * LOCATION a parameter, so it can run locally, in a container, or in a worktree without a
 * consumer changing (#24).
 */
export const PiTransport = Type.Object({
	/** Write one framed command line. */
	write: Type.Function([Type.String()], Type.Void()),
	/** Register the stdout consumer. Called once. */
	onData: Type.Function([Type.Function([Type.String()], Type.Void())], Type.Void()),
	/** Register the close consumer, so a pending command can be rejected rather than hang. */
	onClose: Type.Function([Type.Function([], Type.Void())], Type.Void()),
});
export type PiTransport = Static<typeof PiTransport>;

/** A spawned pi process, as its owner sees it. */
export const PiProcessHandle = Type.Object({
	transport: PiTransport,
	/**
	 * Ask pi to stop. Returns once the signal is sent, not once it has exited — and the
	 * implementation escalates to SIGKILL after a grace period, so a pi that ignores
	 * SIGTERM cannot outlive its run (#34). Idempotent: later calls are no-ops.
	 */
	stop: Type.Function([], Type.Void()),
	/** ⓘ Data, unlike its siblings — which is why this type fell on both sides of the
	 *  data-versus-behaviour rule that used to govern this file. */
	pid: Type.Union([Type.Number(), Type.Undefined()]),
});
export type PiProcessHandle = Static<typeof PiProcessHandle>;

/**
 * Everything `PiRpcClient` is constructed with.
 *
 * ⚠ `onParseError` is separate from `onEvent` and never silent: a dropped record looks
 * exactly like pi having nothing to say, which is the failure this transport exists to
 * avoid.
 */
export const PiRpcClientOptions = Type.Object({
	transport: PiTransport,
	/** Injected so tests are deterministic and ids stay greppable in a log. */
	nextCommandId: Type.Optional(Type.Function([], Type.String())),
	/**
	 * Notified for every non-response record, including types we do not model.
	 *
	 * ⚠ `Type.Unsafe` here, and the reason is a cost of declaring behaviour as a schema
	 * that is worth recording rather than hiding. `Type.Function([PiRpcEventSchema], …)`
	 * infers its parameter as `Static<typeof PiRpcEventSchema>` — which DROPS the
	 * `& Record<string, unknown>` intersection that makes an event's unmodelled fields
	 * reachable. Consumers then get `{ type: string }` and cannot read `event.willRetry`.
	 *
	 * `Type.Unsafe<T>(schema)` keeps the schema for uniformity and the precise TypeScript
	 * type for consumers. It is named "unsafe" because the two are no longer derived from
	 * one another — so if the schema changes, this annotation must change with it.
	 */
	onEvent: Type.Optional(Type.Unsafe<(event: PiRpcEvent) => void>(Type.Function([PiRpcEventSchema], Type.Void()))),
	/** Notified when a record fails to parse, or when a response cannot be correlated. */
	onParseError: Type.Optional(Type.Unsafe<(error: unknown) => void>(Type.Function([Type.Unknown()], Type.Void()))),
});
export type PiRpcClientOptions = Static<typeof PiRpcClientOptions>;
