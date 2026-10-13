import { EnsoPermissionModeState } from '@enso/core'
import { Check } from 'typebox/value'
import type { NotificationsStore } from './notifications.tsx'

/**
 * Permission-mode lines in the transcript (#29, the remaining half).
 *
 * A SUCCESSFUL mode change is silent at the source: the mode extension changes the mode,
 * persists, and never notifies. The host sees the persist and emits the `permission-mode`
 * observation (L3, #162 workstream 4), which arrives here as the `permission-mode` chunk — the same
 * chunk the run-start receipt rides, so this store never learns which extension's entry it
 * was or what that entry looks like.
 *
 * ⚠ The chunk is a STATE receipt, not a change event: the extension persists at session start
 * and on rule updates too, with the mode unchanged, and the run-start receipt restates it. So
 * this store renders one line per DISTINCT mode value — worded as state ("Mode: acceptEdits"),
 * which is never false — and repeated receipts of the same mode render nothing. The first
 * arriving value renders too: state wording makes a first line honest whether it is a change
 * or a restatement. ⓘ A fresh thread's first line here IS its initial mode — the extension
 * persists it during `session_start`, and since #88 the host subscribes to session events
 * BEFORE `bindExtensions`, so that receipt rides #69's held-until-first-subscriber buffer into
 * the first run like every other startup record. The CURRENT mode is a different view —
 * `permission-mode.tsx`, fed by the same chunk.
 *
 * A malformed value is ignored, never thrown on: this runs inside the state layer's stream.
 */

/** How a mode line begins: `Mode: acceptEdits`. */
const MODE_LINE_PREFIX = 'Mode: '

/**
 * Whether a notification is one of these mode lines — for the launch panel (#417), whose Mode chip
 * already says the mode the session starts in, so the record would say the one setting twice.
 */
export function isModeLine(message: string): boolean {
  return message.startsWith(MODE_LINE_PREFIX)
}

export interface ModeLines {
  /** The `permission-mode` CUSTOM-chunk consumer — called by the router with the chunk's value. */
  readonly apply: (value: unknown) => void
}

/** One per thread: the distinct-value gate is the thread's, and the lines go to its notifications. */
export function createModeLines(notifications: NotificationsStore): ModeLines {
  let lastRenderedMode: string | undefined
  return {
    apply: (value: unknown) => {
      if (!Check(EnsoPermissionModeState, value)) return
      if (value.mode === lastRenderedMode) return
      lastRenderedMode = value.mode
      // The harness's own line, not an extension's notice: never grouped with the startup
      // chatter (#96), however early the receipt was replayed — #84/#88 made it visible.
      notifications.push(`${MODE_LINE_PREFIX}${value.mode}`, 'info', 'run')
    },
  }
}
