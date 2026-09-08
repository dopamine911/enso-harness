import { type Static, Type } from "typebox";
import { PiPermissionModeState } from "./permission-mode.ts";

/**
 * What a live thread's session ACTUALLY contains, as the server reports it (#86).
 *
 * Everything the web surface shows is a derived view of the stream; these are the shapes
 * that let a human or an agent see the thing they derive from and cross-check. Served by
 * `GET /api/threads` and `GET /api/threads/:threadId`, rendered by the debug drawer and
 * printed by `scripts/zen-session.mjs`.
 *
 * ⚠ READ-ONLY, LOOPBACK-ONLY, DEV-ONLY — the server that serves these binds `127.0.0.1`
 * and says so in its header. `entries` is the session branch itself: conversation, tool
 * output, extension state. That is the point, and it is why this never leaves loopback.
 * Nothing here is read from the agent dir's auth material; the schemas are closed
 * (`additionalProperties: false`) so a host internal cannot leak by an accidental spread.
 *
 * ⚠ THE FILE IS A LAGGING COPY. pi persists a session lazily — nothing reaches disk until
 * the first assistant message — so `sessionFile` is `null` for a thread that has only run
 * slash commands, while its branch is fully populated in memory. The branch is what pi
 * acts on; a reader who wants "the truth" reads `entries`, not the file.
 */

/** One live thread, at a glance. */
export const ZenThreadSummary = Type.Object(
	{
		threadId: Type.String(),
		sessionId: Type.String(),
		/** Where the session file is or will be. */
		sessionDir: Type.String(),
		/** The session file's path once pi has flushed it to disk; null while it lives only in memory. */
		sessionFile: Type.Union([Type.String(), Type.Null()]),
		/** picc's current mode, computed the way picc restores it. */
		mode: Type.String(),
		/** A run has acquired the session and not released it (in flight, or parked on a dialog). */
		busy: Type.Boolean(),
		/** A dialog is parked on this thread awaiting a human's answer. */
		parked: Type.Boolean(),
		/** When the thread was last acquired or released — ISO 8601. */
		lastActivityAt: Type.String(),
	},
	{ additionalProperties: false },
);
export type ZenThreadSummary = Static<typeof ZenThreadSummary>;

/** One live thread, in full: the summary plus the session branch and what it may run. */
export const ZenThreadInspection = Type.Object(
	{
		threadId: Type.String(),
		sessionId: Type.String(),
		cwd: Type.String(),
		sessionDir: Type.String(),
		sessionFile: Type.Union([Type.String(), Type.Null()]),
		permissionMode: PiPermissionModeState,
		/** Slash commands this session registers — extensions, prompt templates, skills. */
		commands: Type.Array(Type.String()),
		busy: Type.Boolean(),
		parked: Type.Boolean(),
		lastActivityAt: Type.String(),
		/**
		 * The session BRANCH — root to leaf — as pi holds it, verbatim. pi's own entry shapes
		 * (`message`, `custom`, `model_change`, …), not zen's: they are carried, not modelled,
		 * so a reader sees exactly what pi sees. Consumers read the base fields (`type`, `id`,
		 * `parentId`, `timestamp`, `customType`) defensively, like every wire crossing.
		 */
		entries: Type.Array(Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type ZenThreadInspection = Static<typeof ZenThreadInspection>;

/**
 * Where one recorded event came from (#97) — the axis an ordering bug lives on.
 *
 *   live      the host delivered it to a subscriber as it arrived
 *   held      it arrived before the FIRST subscriber and was buffered (#69)
 *   replayed  the buffer delivered it to the first subscriber — a `held` record's second life
 *   dropped   nobody was listening and the first subscriber had already come and gone
 *   sent      an AG-UI chunk the server wrote to the browser — the wire's own order
 */
export const ZenEventProvenance = Type.Union([
	Type.Literal("live"),
	Type.Literal("held"),
	Type.Literal("replayed"),
	Type.Literal("dropped"),
	Type.Literal("sent"),
]);
export type ZenEventProvenance = Static<typeof ZenEventProvenance>;

/**
 * One event in a thread's tail. Consecutive events of the same shape coalesce into one
 * record with a `count` — a model turn is hundreds of text deltas, and the tail exists to
 * be read, not scrolled.
 */
export const ZenThreadEvent = Type.Object(
	{
		/** Monotonic per thread — identity, since type + time can collide. */
		sequence: Type.Number(),
		/** pi's rpc event type for the host's tail; the AG-UI event type for the wire's. */
		type: Type.String(),
		/** The inner name when the type alone says nothing: a custom entry's `customType`, a ui request's method, a tool's name, a CUSTOM chunk's name. */
		name: Type.Optional(Type.String()),
		provenance: ZenEventProvenance,
		/** ISO 8601 — when the FIRST of a coalesced run was recorded. */
		at: Type.String(),
		/** How many consecutive same-shaped events this record stands for. */
		count: Type.Number({ minimum: 1 }),
	},
	{ additionalProperties: false },
);
export type ZenThreadEvent = Static<typeof ZenThreadEvent>;

/** A thread's two tails: what the host emitted (with how), and what the server sent. */
export const ZenThreadEvents = Type.Object(
	{
		threadId: Type.String(),
		emitted: Type.Array(ZenThreadEvent),
		sent: Type.Array(ZenThreadEvent),
	},
	{ additionalProperties: false },
);
export type ZenThreadEvents = Static<typeof ZenThreadEvents>;

/**
 * One entry of the branch as a row — `12:34:56 custom:modes mode=plan` — read defensively:
 * pi's shapes are carried, not modelled. THE definition (PR #100 review): the drawer and
 * `zen-session.mjs` had one each and they had already drifted apart.
 */
export function describeSessionEntry(entry: unknown): string {
	if (typeof entry !== "object" || entry === null) return String(entry);
	const fields = entry as {
		type?: unknown;
		customType?: unknown;
		timestamp?: unknown;
		message?: unknown;
		data?: unknown;
	};
	const kind = typeof fields.type === "string" ? fields.type : "?";
	const custom = typeof fields.customType === "string" ? `:${fields.customType}` : "";
	const role =
		typeof fields.message === "object" && fields.message !== null && "role" in fields.message
			? ` ${String(fields.message.role)}`
			: "";
	const mode =
		fields.customType === "modes" && typeof fields.data === "object" && fields.data !== null && "mode" in fields.data
			? ` mode=${String(fields.data.mode)}`
			: "";
	const when = typeof fields.timestamp === "string" ? fields.timestamp.slice(11, 19) : "";
	return `${when} ${kind}${custom}${role}${mode}`.trim();
}

/** The three columns of an event row: `12:34:56` · `held ×3` · `entry_appended modes`. */
export interface ThreadEventColumns {
	readonly when: string;
	/** Provenance, with the count when coalesced — the column a reader scans for `held`/`dropped`. */
	readonly provenance: string;
	/** Type, with the inner name when there is one. */
	readonly subject: string;
}

/**
 * THE definition of what each column holds — a new provenance value or inner name lands
 * here once. How the columns are joined is layout, the surface's own: the drawer joins
 * with a space (`describeThreadEvent`), `zen-session.mjs` pads them into a table.
 */
export function threadEventColumns(event: ZenThreadEvent): ThreadEventColumns {
	return {
		when: event.at.slice(11, 19),
		provenance: event.count > 1 ? `${event.provenance} ×${event.count}` : event.provenance,
		subject: event.name === undefined ? event.type : `${event.type} ${event.name}`,
	};
}

/** One event of a tail as a row — `12:34:56 held ×3 entry_appended modes`. */
export function describeThreadEvent(event: ZenThreadEvent): string {
	const columns = threadEventColumns(event);
	return `${columns.when} ${columns.provenance} ${columns.subject}`;
}
