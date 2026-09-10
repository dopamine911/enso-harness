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

const modesEntry = (mode: unknown): { customType: string; data: { mode: unknown } } => ({
  customType: 'modes',
  data: { mode },
})
const renderedMessages = (): string[] => notifications.get().map((notification) => notification.message)

// ⚠ The first value RENDERS, deliberately: picc persists on every session start, so the
// opening line tells the user which mode the session is actually in. State wording
// ("Mode: x") is what makes that honest — it is never a claim that something changed.
test('the first mode value renders as a state line', () => {
  modeLines.apply(modesEntry('default'))
  expect(renderedMessages()).toEqual(['Mode: default'])
})

// ⚠ The distinct-value gate: picc re-persists the SAME mode on rule updates and session
// starts, and each re-persist must render nothing — or every allow-rule edit would echo
// a phantom mode line.
test('re-persists of the same mode render nothing; a real change renders once', () => {
  modeLines.apply(modesEntry('default'))
  modeLines.apply(modesEntry('default'))
  modeLines.apply(modesEntry('default'))
  modeLines.apply(modesEntry('acceptEdits'))
  modeLines.apply(modesEntry('acceptEdits'))
  expect(renderedMessages()).toEqual(['Mode: default', 'Mode: acceptEdits'])
})

test('switching back to an earlier mode renders again — the gate is last-value, not a set', () => {
  modeLines.apply(modesEntry('default'))
  modeLines.apply(modesEntry('plan'))
  modeLines.apply(modesEntry('default'))
  expect(renderedMessages()).toEqual(['Mode: default', 'Mode: plan', 'Mode: default'])
})

// Some other extension's persisted state is not ours to render.
test('a custom entry of another type is ignored', () => {
  modeLines.apply({ customType: 'tanstack:interruptBinding', data: { mode: 'sneaky' } })
  expect(renderedMessages()).toEqual([])
})

test('malformed values are ignored, never thrown from the stream loop', () => {
  modeLines.apply(undefined)
  modeLines.apply('modes')
  modeLines.apply({ customType: 'modes' })
  modeLines.apply({ customType: 'modes', data: null })
  modeLines.apply(modesEntry(42))
  modeLines.apply(modesEntry(''))
  expect(renderedMessages()).toEqual([])
})
