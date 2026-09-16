import { beforeEach, expect, test } from 'bun:test'
import { createModeLines, type ModeLines } from '../mode-lines.ts'
import { createNotificationsStore, type NotificationsStore } from '../notifications.tsx'

/**
 * #29's remaining half: a mode change becomes a visible transcript line.
 *
 * ⚠ The subject has a distinct-value gate — state across calls — so each test drives a
 * SEQUENCE on one instance; a suite that rebuilt it per call would never see the gate
 * fail. One instance per thread (#90 PR 3), built fresh per case.
 */

let notifications: NotificationsStore
let modeLines: ModeLines
beforeEach(() => {
  notifications = createNotificationsStore()
  modeLines = createModeLines(notifications)
})

/** The `zen.mode` receipt's value: what the host says the mode is now. */
const modeState = (mode: unknown): { mode: unknown; available: string[] } => ({ mode, available: ['default', 'plan'] })
const renderedMessages = (): string[] => notifications.get().map((notification) => notification.message)

// ⚠ The first value RENDERS, deliberately: the run-start receipt restates the mode, so the
// opening line tells the user which mode the session is actually in. State wording
// ("Mode: x") is what makes that honest — it is never a claim that something changed.
test('the first mode value renders as a state line', () => {
  modeLines.apply(modeState('default'))
  expect(renderedMessages()).toEqual(['Mode: default'])
})

// ⚠ The distinct-value gate: the extension re-persists the SAME mode on rule updates and
// session starts, and every run start restates it; each must render nothing — or every
// allow-rule edit would echo a phantom mode line.
test('re-persists of the same mode render nothing; a real change renders once', () => {
  modeLines.apply(modeState('default'))
  modeLines.apply(modeState('default'))
  modeLines.apply(modeState('default'))
  modeLines.apply(modeState('acceptEdits'))
  modeLines.apply(modeState('acceptEdits'))
  expect(renderedMessages()).toEqual(['Mode: default', 'Mode: acceptEdits'])
})

test('switching back to an earlier mode renders again — the gate is last-value, not a set', () => {
  modeLines.apply(modeState('default'))
  modeLines.apply(modeState('plan'))
  modeLines.apply(modeState('default'))
  expect(renderedMessages()).toEqual(['Mode: default', 'Mode: plan', 'Mode: default'])
})

test('malformed values are ignored, never thrown from the stream loop', () => {
  modeLines.apply(undefined)
  modeLines.apply('plan')
  modeLines.apply({ mode: 'plan' })
  modeLines.apply({ customType: 'modes', data: { mode: 'plan' } })
  modeLines.apply(modeState(42))
  modeLines.apply(modeState(''))
  expect(renderedMessages()).toEqual([])
})
