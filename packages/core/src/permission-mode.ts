import { type Static, Type } from 'typebox'

/**
 * picc-permission-modes' PERSISTED MODE, as zen reads it (#84).
 *
 * ⚠ VENDOR SHAPE, declared ONCE. picc (`@ladbabynpm/picc-permission-modes`) keeps its
 * current mode in a closure — `let currentMode = "default"` — with no getter and no
 * setter beyond its own slash commands. The one observable artifact is the session entry
 * it persists on every change: `pi.appendEntry("modes", { mode, … })`. Two zen consumers
 * read that entry and both used to spell the shape themselves:
 *
 *   • the browser store, from the `zen.entry` chunk the change arrives on;
 *   • the host, which computes a thread's CURRENT mode the way picc's own `restoreState`
 *     does — the last `modes` entry in the session branch, else the initial `default` —
 *     so a run can start with a state receipt instead of the browser guessing.
 *
 * One definition means a picc rename lands on both sides at once, or on neither.
 *
 * ⚠ `PICC_PERMISSION_MODES` is the set picc registers a slash command for (`/default`,
 * `/acceptEdits`, …). It is what the mode DROPDOWN may offer: the host intersects it
 * with `listCommands()`, so a mode picc stops registering disappears from the menu and a
 * mode zen has never heard of is never offered. Order is picc's own, and is the display
 * order.
 */

/** The `customType` picc persists its state under. */
export const PICC_MODES_CUSTOM_TYPE = 'modes'

/** picc's initial mode — a fresh session with no `modes` entry is in this mode by construction. */
export const PICC_DEFAULT_PERMISSION_MODE = 'default'

/** Every mode picc registers a per-mode slash command for, in picc's order. */
export const PICC_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const

/**
 * The receipt a run starts with (#84) — and the value of the `zen.mode` CUSTOM chunk that
 * carries it to the browser. `mode` is picc's current mode; `available` is what the mode
 * dropdown may offer: `PICC_PERMISSION_MODES` intersected with the commands this session
 * actually registers, in picc's order.
 */
export const PiPermissionModeState = Type.Object({
  mode: Type.String(),
  available: Type.Array(Type.String()),
})
export type PiPermissionModeState = Static<typeof PiPermissionModeState>

/**
 * The mode carried by ONE persisted custom entry, or undefined when the entry is not
 * picc's (`customType` differs), is malformed, or carries no mode. Reads defensively —
 * every wire crossing does — so an unrelated extension's custom entry is ignored, never a
 * throw inside a stream loop.
 */
export function readPiccPersistedMode(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const { customType, data } = entry as { customType?: unknown; data?: unknown }
  if (customType !== PICC_MODES_CUSTOM_TYPE) return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const { mode } = data as { mode?: unknown }
  return typeof mode === 'string' && mode.length > 0 ? mode : undefined
}

/**
 * picc's own `restoreState` rule, applied to a branch (#84): the LAST `modes` entry wins,
 * and a branch with none is the initial mode. Walked from the end so the newest entry is
 * the first hit. THE definition — the host's `permissionModeState`, the `?debug` drawer's
 * cross-check, and a resumed thread's opening mode (#95) all read this one walk.
 *
 * ⚠ Deliberately NOT cached anywhere (PR #85 review): the branch is not append-only —
 * `/tree`, `/fork` and `/branch` move the leaf onto a path whose last `modes` entry can
 * differ, which is exactly why picc re-walks. Correctness under branch navigation is worth
 * microseconds per run.
 */
export function persistedPermissionMode(branch: readonly unknown[]): string {
  for (let position = branch.length - 1; position >= 0; position -= 1) {
    const entry = branch[position]
    if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'custom') continue
    const persisted = readPiccPersistedMode(entry)
    if (persisted !== undefined) return persisted
  }
  return PICC_DEFAULT_PERMISSION_MODE
}
