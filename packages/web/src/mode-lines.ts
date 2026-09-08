import { readPiccPersistedMode } from "@zen/core";
import { pushZenNotification } from "./notifications.tsx";

/**
 * Permission-mode lines in the transcript (#29, the remaining half).
 *
 * A SUCCESSFUL mode change is silent at the source: picc-permission-modes' `setMode`
 * changes the mode, persists, and never notifies (its only `ctx.ui.notify` is the
 * unknown-mode error path), and its `updateStatus` is a stub — a TUI concern that never
 * reaches RPC. The one RPC-observable artifact of a mode change is the CUSTOM session
 * entry picc persists, which arrives here as a `zen.entry` chunk.
 *
 * ⚠ That entry is a STATE receipt, not a change event: picc re-persists on rule updates
 * too, with the mode unchanged. So this store renders one line per DISTINCT mode value —
 * worded as state ("Mode: acceptEdits"), which is never false — and repeated persists of
 * the same mode render nothing. The first arriving value renders too: state wording makes
 * a first line honest whether it is a change or a restatement.
 * ⓘ A fresh thread never announces its initial `default` here, and the reason is NOT
 * timing (an earlier note here guessed the session-start persist raced the stream; #69's
 * held-until-first-subscriber buffer replays session-start events fine — multi-account's
 * startup notifies arrive). Probed 2026-09-08 (#84): picc's `restoreState` only READS the
 * branch; it persists on a change. So the first line the user sees is the first mode
 * change. The CURRENT mode, including that initial `default`, is a different view —
 * `permission-mode.tsx`, fed by the receipt the server synthesises at run start.
 *
 * ⚠ VENDOR SHAPE — read through `readPiccPersistedMode` in `@zen/core`, which is the ONE
 * place picc's `modes` entry (`pi.appendEntry("modes", { mode, … })`, v0.1.1) is spelled
 * out; the host reads a thread's current mode through the same helper (#84). An
 * unrecognised `customType`, or a `data` without a string `mode`, is ignored here — some
 * other extension's state, not ours to render.
 */

let lastRenderedMode: string | undefined;

/** The `zen.entry` CUSTOM-chunk consumer — called from the chat options' onCustomEvent. */
export function applyZenCustomEntry(value: unknown): void {
	const mode = readPiccPersistedMode(value);
	if (mode === undefined) return;
	if (mode === lastRenderedMode) return;
	lastRenderedMode = mode;
	pushZenNotification(`Mode: ${mode}`, "info");
}

/** Test seam: reset the distinct-value gate between cases. Never called from production code. */
export function clearModeLinesForTest(): void {
	lastRenderedMode = undefined;
}
