import { type Static, Type } from 'typebox'

/**
 * The permission mode's shape on the wire (#84), and — until #162 workstream 4's step B
 * lands — the one vendor fact the browser still reads: picc-permission-modes persists its
 * mode as a session entry (`pi.appendEntry("modes", { mode, … })`), and two browser readers
 * (`permission-mode.tsx`, `mode-lines.ts`) take a mode change from that entry as it rides the
 * `zen.entry` chunk. Everything else picc — its registered set, its initial mode, the walk
 * that finds a branch's current mode — lives below the `AgentHost` seam in
 * `web/src/host/permission-mode-adapter.ts` (step A), where a vendor pivot is one file.
 *
 * Step B moves the browser onto a mode OBSERVATION the host emits; then `readPiccPersistedMode`
 * and `PICC_MODES_CUSTOM_TYPE` follow the rest below the seam and this file is
 * `ZenPermissionModeState` alone.
 */

/** The `customType` picc persists its state under. */
export const PICC_MODES_CUSTOM_TYPE = 'modes'

/**
 * The receipt a run starts with (#84) — and the value of the `zen.mode` CUSTOM chunk that
 * carries it to the browser. `mode` is picc's current mode; `available` is what the mode
 * dropdown may offer: the modes the runtime's mode extension registers, intersected with the
 * commands this session actually registers, in the extension's order (the host decides).
 */
export const ZenPermissionModeState = Type.Object({
  mode: Type.String(),
  available: Type.Array(Type.String()),
})
export type ZenPermissionModeState = Static<typeof ZenPermissionModeState>

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
