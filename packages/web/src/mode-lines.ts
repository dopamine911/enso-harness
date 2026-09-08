import { readPiccPersistedMode } from "@zen/core";
import type { NotificationsStore } from "./notifications.tsx";

/**
 * Permission-mode lines in the transcript (#29, the remaining half).
 *
 * A SUCCESSFUL mode change is silent at the source: picc-permission-modes' `setMode`
 * changes the mode, persists, and never notifies (its only `ctx.ui.notify` is the
 * unknown-mode error path), and its `updateStatus` is a stub — a TUI concern that never
 * reaches RPC. The one RPC-observable artifact of a mode change is the CUSTOM session
 * entry picc persists, which arrives here as a `zen.entry` chunk.
 *
 * ⚠ That entry is a STATE receipt, not a change event: picc persists at session start
 * and on rule updates too, with the mode unchanged. So this store renders one line per
 * DISTINCT mode value — worded as state ("Mode: acceptEdits"), which is never false — and
 * repeated persists of the same mode render nothing. The first arriving value renders too:
 * state wording makes a first line honest whether it is a change or a restatement.
 * ⓘ A fresh thread's first line here IS its initial `default` — picc persists `modes:
 * default` during `session_start`, and since #88 the host subscribes to session events
 * BEFORE `bindExtensions`, so that entry rides #69's held-until-first-subscriber buffer
 * into the first run like every other startup record. Until #88 it did not: the host
 * subscribed after binding, the entry was emitted to nobody, and the first line a user saw
 * was the first CHANGE. Two earlier notes here got the cause wrong (a race with the run
 * stream; picc persisting only on a change); the #86 drawer found the real one within
 * minutes of existing. The CURRENT mode is still a different view — `permission-mode.tsx`,
 * fed by the receipt the server synthesises at run start, deterministic on its own.
 *
 * ⚠ VENDOR SHAPE — read through `readPiccPersistedMode` in `@zen/core`, which is the ONE
 * place picc's `modes` entry (`pi.appendEntry("modes", { mode, … })`, v0.1.1) is spelled
 * out; the host reads a thread's current mode through the same helper (#84). An
 * unrecognised `customType`, or a `data` without a string `mode`, is ignored here — some
 * other extension's state, not ours to render.
 */

export interface ModeLines {
	/** The `zen.entry` CUSTOM-chunk consumer — called by the router with the chunk's value. */
	readonly apply: (value: unknown) => void;
}

/** One per thread: the distinct-value gate is the thread's, and the lines go to its notifications. */
export function createModeLines(notifications: NotificationsStore): ModeLines {
	let lastRenderedMode: string | undefined;
	return {
		apply: (value) => {
			const mode = readPiccPersistedMode(value);
			if (mode === undefined) return;
			if (mode === lastRenderedMode) return;
			lastRenderedMode = mode;
			notifications.push(`Mode: ${mode}`, "info");
		},
	};
}
