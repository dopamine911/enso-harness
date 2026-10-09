import {
  ENSO_DEFAULT_PERMISSION_MODE,
  ENSO_PERMISSION_MODES,
  type EnsoPermissionModeName,
  type EnsoPermissionModeState,
  type EnsoTranscriptEntry,
  readRecordedMode,
  recordedPermissionMode,
  transcriptEntryOf,
} from '@enso/core'

/**
 * The permission mode, as the host reads and sets it (#84, #496; below the seam since #162
 * workstream 4, L3). A session's mode is the last `active_agent` custom entry among its entries
 * (`packages/core/src/permission-modes.ts`): the permission engine applies that agent's preset, and Enso's
 * permission-modes extension appends the entry when a mode command runs. Above the `AgentHost`
 * seam a caller sees `EnsoPermissionModeState` and nothing of how it is recorded.
 *
 * ⚠ `ENSO_PERMISSION_MODES` is the set the extension registers a slash command for (`/default`,
 * `/acceptEdits`, …). A live session offers it intersected with the commands it registered, so
 * a session whose extension did not load offers nothing it cannot switch to. Its order is the
 * display order.
 */

/**
 * How a mode is SET (L3 step C): the extension's per-mode slash command, named exactly the
 * mode, run as a prompt. The command appends the `active_agent` entry, so the mode is recorded
 * where the engine reads it.
 *
 * The host runs this for `ThreadRuntime.setPermissionMode`; nothing above the seam spells a
 * command.
 */
export function modeCommand(mode: string): string {
  return `/${mode}`
}

/**
 * A LIVE session's state (#84): the mode from the session's entries, and the modes it
 * registered a command for.
 *
 * ⚠ `entries` is `sessionManager.getEntries()`, NOT `getBranch()`: the engine walks every entry
 * in file order, so after `/tree` moves the leaf the branch's last entry can name a mode the
 * engine is not enforcing (`recordedPermissionMode`'s ⚠). Re-walked on every call, never
 * cached: entries only grow, but a cache is one more thing to keep in step for microseconds.
 */
export function livePermissionModeState(
  entries: readonly EnsoTranscriptEntry[],
  registeredCommands: ReadonlySet<string>,
): EnsoPermissionModeState {
  return {
    mode: recordedPermissionMode(entries),
    available: ENSO_PERMISSION_MODES.filter((mode) => registeredCommands.has(mode)),
  }
}

/**
 * What a FRESH thread starts in (#84): `default`, and every mode.
 *
 * Honest by construction — a new thread is a new session file with no `active_agent` entry —
 * and served before any run exists, so the header reads `default` from the first paint rather
 * than `unknown`.
 */
export function freshPermissionModeState(): EnsoPermissionModeState {
  return { mode: ENSO_DEFAULT_PERMISSION_MODE, available: [...ENSO_PERMISSION_MODES] }
}

/**
 * A STORED thread's state, from its transcript alone (#95): the last `active_agent` entry for
 * the mode, and every mode for `available`; no session is built to ask what it registers (#86's
 * rule: looking must not build).
 *
 * ⚠ The stored transcript is the BRANCH (`readStoredThread`), not every entry. The two agree
 * unless `/tree` moved the leaf past a mode change; the live walk is the one the engine enforces,
 * and it replaces this reading as soon as the thread runs.
 */
export function storedPermissionModeState(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState {
  return { mode: recordedPermissionMode(transcript), available: [...ENSO_PERMISSION_MODES] }
}

/** The mode one appended entry records, if it is an `active_agent` entry naming one. */
export function appendedMode(entry: unknown): EnsoPermissionModeName | undefined {
  const record = transcriptEntryOf(entry, 0)
  return record.kind === 'custom' ? readRecordedMode(record.customType, record.data) : undefined
}
