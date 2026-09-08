import { readPiccPersistedMode } from "@zen/core";
import { useSyncExternalStore } from "react";

/**
 * The CURRENT permission mode, as state — and the control that changes it (#84).
 *
 * `mode-lines.ts` renders mode changes as transcript history. This is the other view: what
 * mode the thread is in NOW, kept in a module store like the session stats, so a user
 * refused with `user dismissed dialog` (#73) can see they are in `default` instead of
 * reading the refusal as a bug.
 *
 * Two feeds, one store:
 *   • `zen.mode` — the receipt the server synthesises at every run start, carrying the mode
 *     the run begins in and the modes this session's picc registers. This is what makes
 *     `default` visible: picc persists a `modes` entry only on a CHANGE, so a fresh thread
 *     never announces its initial mode on its own.
 *   • `zen.entry` — picc's persisted `modes` entry when the mode CHANGES mid-run, read
 *     through the same `readPiccPersistedMode` the host uses, so both sides share one
 *     definition of picc's shape.
 *
 * ⚠ HONESTY RULE: `mode` is `undefined` — rendered as `unknown` — until a real value has
 * arrived. Never assumed. Before the first prompt no session exists yet, and the one case
 * this control exists for is precisely the one a guess would get wrong.
 *
 * ⓘ The browser runs ONE thread per page (TanStack mints it; nothing here is keyed by
 * threadId), so a single value is the per-thread store. A reload is a new thread, and the
 * store starts over with it.
 */

export interface PermissionModeState {
	/** picc's current mode, or undefined until a receipt has arrived. */
	mode: string | undefined;
	/** The modes the dropdown may offer — the server's intersection of picc's set with what this session registers. */
	available: readonly string[];
}

const UNKNOWN: PermissionModeState = { mode: undefined, available: [] };

let state: PermissionModeState = UNKNOWN;
const listeners = new Set<() => void>();

function publish(next: PermissionModeState): void {
	state = next;
	for (const listener of listeners) listener();
}

/** Fold one `zen.mode` receipt's value in. Defensive like every wire crossing: a malformed value changes nothing. */
export function applyZenPermissionMode(data: unknown): void {
	if (typeof data !== "object" || data === null) return;
	const receipt = data as { mode?: unknown; available?: unknown };
	if (typeof receipt.mode !== "string" || receipt.mode.length === 0) return;
	const available = Array.isArray(receipt.available)
		? receipt.available.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		: state.available;
	publish({ mode: receipt.mode, available });
}

/**
 * Fold one `zen.entry` chunk's value in — a mode CHANGE persisted by picc. Any other
 * extension's custom entry, or a malformed one, is ignored here: `readPiccPersistedMode`
 * is the one place that decides what counts as picc's.
 */
export function applyZenPersistedModeEntry(data: unknown): void {
	const mode = readPiccPersistedMode(data);
	if (mode === undefined) return;
	publish({ mode, available: state.available });
}

export function subscribeToPermissionMode(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getPermissionModeSnapshot(): PermissionModeState {
	return state;
}

/** Test seam: reset the store between cases. Never called from production code. */
export function clearPermissionModeForTest(): void {
	state = UNKNOWN;
}

export function usePermissionMode(): PermissionModeState {
	return useSyncExternalStore(subscribeToPermissionMode, getPermissionModeSnapshot, getPermissionModeSnapshot);
}

export interface PermissionModeSelectProps {
	mode: string | undefined;
	available: readonly string[];
	/** True while a run is in flight — the same rule the send button follows, so a change never collides with a running turn (#75). */
	disabled: boolean;
	/** Called with the chosen mode; never with the current one (selecting it is a no-op here). */
	onSelect: (mode: string) => void;
}

/**
 * The header control: current mode, and a native `<select>` of the modes picc offers.
 *
 * Presentational and chat-agnostic on purpose — it can be rendered statically in a test
 * with no chat context. `chat-screen.tsx` wraps it with the send + loading wiring. A native
 * `<select>` rather than a vendored component: it is keyboard- and screen-reader-complete
 * out of the box, and this repo has spent effort on what each vendored dependency costs.
 *
 * ⓘ Empty `available` (nothing received yet) disables the control rather than offering a
 * hardcoded list: the options are picc's to declare, not ours to assume.
 */
export function PermissionModeSelect({
	mode,
	available,
	disabled,
	onSelect,
}: PermissionModeSelectProps): React.ReactNode {
	const known = mode !== undefined;
	return (
		<label
			className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs"
			title={
				known
					? "pi's permission mode for this thread — change it here or with /mode"
					: "not known until the first prompt has run — a fresh thread starts in picc's default"
			}
		>
			<span>mode</span>
			<select
				aria-label="permission mode"
				className="rounded-md border bg-background px-1.5 py-0.5 text-foreground text-xs disabled:opacity-60"
				disabled={disabled || available.length === 0}
				value={known ? mode : ""}
				onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
					const next = event.currentTarget.value;
					if (next.length === 0 || next === mode) return;
					onSelect(next);
				}}
			>
				{known ? null : (
					<option value="" disabled>
						unknown
					</option>
				)}
				{available.map((option) => (
					<option key={option} value={option}>
						{option}
					</option>
				))}
				{/* The current mode always renders even if the receipt's list somehow omitted it —
				    the readout must never lie about what it was told. */}
				{known && !available.includes(mode) ? <option value={mode}>{mode}</option> : null}
			</select>
		</label>
	);
}
