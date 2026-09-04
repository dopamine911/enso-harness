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
 * ⚠ That entry is a STATE receipt, not a change event: picc re-persists on session start
 * and on rule updates too, with the mode unchanged. So this store renders one line per
 * DISTINCT mode value — worded as state ("Mode: acceptEdits"), which is never false — and
 * repeated persists of the same mode render nothing. The first arriving value renders too:
 * state wording makes a first line honest whether it is a change or a restatement.
 * ⓘ Observed live (2026-09-04): picc's session-start persist fires before the run stream
 * attaches, so that entry never reaches the browser — in practice the first line the user
 * sees is the first mode change, not an opening "Mode: default".
 *
 * ⚠ VENDOR SHAPE, and this module owns the coupling (not the transport): the names below
 * come from `@ladbabynpm/picc-permission-modes` v0.1.1 — `persistState()` calls
 * `pi.appendEntry("modes", entry)` where `ModesPersistedEntry.mode` is the current
 * `PermissionMode`. An unrecognised `customType`, or a `data` without a string `mode`, is
 * ignored here — some other extension's state, not ours to render.
 */
const PICC_MODES_CUSTOM_TYPE = "modes";

let lastRenderedMode: string | undefined;

/** The `zen.entry` CUSTOM-chunk consumer — called from the chat options' onCustomEvent. */
export function applyZenCustomEntry(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	const entry = value as { customType?: unknown; data?: unknown };
	if (entry.customType !== PICC_MODES_CUSTOM_TYPE) return;
	if (typeof entry.data !== "object" || entry.data === null) return;
	const mode = (entry.data as { mode?: unknown }).mode;
	if (typeof mode !== "string" || mode.length === 0) return;
	if (mode === lastRenderedMode) return;
	lastRenderedMode = mode;
	pushZenNotification(`Mode: ${mode}`, "info");
}

/** Test seam: reset the distinct-value gate between cases. Never called from production code. */
export function clearModeLinesForTest(): void {
	lastRenderedMode = undefined;
}
