import { type Static, Type } from 'typebox'

/**
 * The permission mode's shape on the wire (#84; #162 workstream 4, L3): what a run starts
 * in and what it may switch to. Nothing here says which extension implements the mode or
 * how it persists it — that lives below the `AgentHost` seam, in
 * `web/src/host/permission-mode-adapter.ts`, and reaches the browser as the
 * `permission-mode` observation and the `zen.mode` receipt, both carrying this one shape.
 */

/**
 * The receipt a run starts with (#84) — and the value of the `zen.mode` CUSTOM chunk that
 * carries it to the browser, at run start and on every change. `mode` is the current mode;
 * `available` is what the mode dropdown may offer: the modes the runtime's mode extension
 * registers, intersected with the commands this session actually registers, in the
 * extension's order (the host decides).
 */
export const ZenPermissionModeState = Type.Object({
  mode: Type.String({ minLength: 1 }),
  available: Type.Array(Type.String({ minLength: 1 })),
})
export type ZenPermissionModeState = Static<typeof ZenPermissionModeState>
