import type { ZenPermissionModeState, ZenTranscriptEntry } from '@zen/core'

/**
 * picc-permission-modes' PERSISTED MODE, as the host reads it (#84; below the seam since
 * #162 workstream 4, L3). picc keeps its current mode in a closure — `let currentMode =
 * "default"` — with no getter and no setter beyond its own slash commands. The one
 * observable artifact is the session entry it persists on every change:
 * `pi.appendEntry("modes", { mode, … })`. This file is where zen knows that; above the
 * `AgentHost` seam a caller sees `ZenPermissionModeState` and nothing of picc's.
 *
 * ⚠ `PICC_PERMISSION_MODES` is the set picc registers a slash command for (`/default`,
 * `/acceptEdits`, …). It is what the mode DROPDOWN may offer: the host intersects it with the
 * commands a session registers, so a mode picc stops registering disappears from the menu
 * and a mode zen has never heard of is never offered. Order is picc's own, and is the
 * display order.
 */

/** The `customType` picc persists its state under. */
const PICC_MODES_CUSTOM_TYPE = 'modes'

/** picc's initial mode — a fresh session with no `modes` entry is in this mode by construction. */
const PICC_DEFAULT_PERMISSION_MODE = 'default'

/**
 * The mode carried by ONE persisted custom entry, or undefined when the entry is not
 * picc's (`customType` differs), is malformed, or carries no mode. Reads defensively —
 * every wire crossing does — so an unrelated extension's custom entry is ignored, never a
 * throw inside a stream loop.
 */
export function readPiccPersistedMode(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  if (!('customType' in entry) || entry.customType !== PICC_MODES_CUSTOM_TYPE) return undefined
  if (!('data' in entry) || typeof entry.data !== 'object' || entry.data === null) return undefined
  if (!('mode' in entry.data)) return undefined
  const { mode } = entry.data
  return typeof mode === 'string' && mode.length > 0 ? mode : undefined
}

/**
 * How a mode is SET (L3 step C): picc's setter is closure-private; its per-mode slash
 * command — named exactly the mode (picc index.ts:526-536) — is the only way in, run as a
 * prompt. The host runs this for `ThreadRuntime.setPermissionMode`; nothing above the seam
 * spells a command.
 */
export function piccModeCommand(mode: string): string {
  return `/${mode}`
}

/** Every mode picc registers a per-mode slash command for, in picc's order. */
export const PICC_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const

/**
 * picc's own `restoreState` rule, applied to a branch (#84): the LAST `modes` entry wins,
 * and a branch with none is the initial mode. Walked from the end so the newest entry is
 * the first hit. THE definition — a live thread's `permissionModeState` and a stored
 * thread's opening mode (#95) both read this one walk.
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

/**
 * What a FRESH thread starts in (#84): picc's initial mode, and every mode picc registers
 * unconditionally. Honest by construction — a new thread is a new session file with no
 * `modes` entry — and served before any run exists, so the header reads `default` from the
 * first paint rather than `unknown`.
 */
export function freshPermissionModeState(): ZenPermissionModeState {
  return { mode: PICC_DEFAULT_PERMISSION_MODE, available: [...PICC_PERMISSION_MODES] }
}

/**
 * A STORED thread's state, from its transcript alone (#95): the walk for the mode — over
 * entries of ours, so the custom entry's `customType` and `data` are read where the
 * transcript already put them — and the full registered set for `available`; no session is
 * built to ask what it registers (#86's rule: looking must not build), so the cold answer
 * offers what picc always offers.
 */
export function storedPermissionModeState(transcript: readonly ZenTranscriptEntry[]): ZenPermissionModeState {
  for (let position = transcript.length - 1; position >= 0; position -= 1) {
    const entry = transcript[position]
    if (entry?.kind !== 'custom') continue
    const persisted = readPiccPersistedMode({ customType: entry.customType, data: entry.data })
    if (persisted !== undefined) return { mode: persisted, available: [...PICC_PERMISSION_MODES] }
  }
  return freshPermissionModeState()
}
