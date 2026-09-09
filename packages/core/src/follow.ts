import { type Static, Type } from "typebox";
import { ZenObservation } from "./observation.ts";
import { PiPermissionModeState } from "./permission-mode.ts";
import { ZenInterruptedTail } from "./session-inspection.ts";

/**
 * The server↔browser wire (#112): a thread's feed, as the follow route serves it.
 *
 * Every follow opens with exactly one `snapshot` — the thread as of `asOfSeq` — and then
 * carries only `observation` frames (each `seq` greater than the last) and `status`
 * frames (the thread's lifecycle as the server sees it). A reconnect is a new follow and
 * a new snapshot; there is no cursor to resume from, because the snapshot IS the resync
 * (deepseek-harness: one complete snapshot per generation, then only deltas).
 *
 * The payload is `ZenObservation` — the same layer the event tails and the debug pane
 * reason in. AG-UI is not on this wire; a browser adapter derives it if a renderer wants it
 * (`docs/architecture.md`, decided constraints).
 */

export const ZenFollowSnapshot = Type.Object(
	{
		type: Type.Literal("snapshot"),
		threadId: Type.String(),
		/** The feed's position this snapshot is exact as of; every later observation's `seq` is greater. */
		asOfSeq: Type.Integer({ minimum: 0 }),
		/** A pi session exists for the thread on this server. False: served cold from the file, or empty. */
		live: Type.Boolean(),
		busy: Type.Boolean(),
		/** See `ZenThreadSummary.generation`. */
		generation: Type.Integer({ minimum: 0 }),
		permissionMode: PiPermissionModeState,
		/** The branch as TanStack `UIMessage`s — `Unknown` because the shape is the renderer's, not zen's. */
		messages: Type.Array(Type.Unknown()),
		interrupted: Type.Optional(ZenInterruptedTail),
	},
	{ additionalProperties: false },
);
export type ZenFollowSnapshot = Static<typeof ZenFollowSnapshot>;

export const ZenFollowObservation = Type.Object(
	{
		type: Type.Literal("observation"),
		seq: Type.Integer({ minimum: 1 }),
		observation: ZenObservation,
	},
	{ additionalProperties: false },
);
export type ZenFollowObservation = Static<typeof ZenFollowObservation>;

export const ZenFollowStatus = Type.Object(
	{
		type: Type.Literal("status"),
		live: Type.Boolean(),
		busy: Type.Boolean(),
		generation: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type ZenFollowStatus = Static<typeof ZenFollowStatus>;

export const ZenFollowFrame = Type.Union([ZenFollowSnapshot, ZenFollowObservation, ZenFollowStatus]);
export type ZenFollowFrame = Static<typeof ZenFollowFrame>;

/**
 * What `POST /api/threads/:id/prompt` answers with: ADMISSION, not a result. A run is not
 * one prompt's reply — steering, follow-ups and retries can all land inside it — so the
 * receipt names the message and the acquisition it took or queued behind, and the follow
 * carries everything after (deepseek-harness: `followup()` returns void).
 */
export const ZenPromptReceipt = Type.Object(
	{
		threadId: Type.String(),
		/** Minted at admission — the identity a client correlates this message by. */
		messageId: Type.String(),
		/** The acquisition this prompt took, or the one it queued behind. */
		generation: Type.Integer({ minimum: 0 }),
		/** The thread was busy: pi queued the message behind the run in flight (#75). */
		queued: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type ZenPromptReceipt = Static<typeof ZenPromptReceipt>;
