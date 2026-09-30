import { expect, test } from 'bun:test'
import {
  freshPermissionModeState,
  livePermissionModeState,
  modeCommand,
  storedPermissionModeState,
} from '../permission-mode-adapter.ts'
import { transcriptOf } from '../transcript.ts'

const modeEntry = (agent: string | null, id: string): unknown => ({
  type: 'custom',
  customType: 'active_agent',
  data: { name: agent },
  id,
})

const EVERY_MODE = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto']

// A live session offers only the modes it registered a command for, in the menu's order, and
// never a command that is not a mode.
test('a live session reads its last active_agent entry and offers the modes it registered, in order', () => {
  const entries = [modeEntry('enso-mode-plan', 'a'), modeEntry('enso-mode-auto', 'b')]
  expect(livePermissionModeState(entries, new Set(['auto', 'model', 'default', 'plan']))).toEqual({
    mode: 'auto',
    available: ['default', 'plan', 'auto'],
  })
  // Back to default is an entry naming no agent, not the absence of one.
  expect(livePermissionModeState([...entries, modeEntry(null, 'c')], new Set()).mode).toBe('default')
})

// @pins resume/opening-mode
test('a stored thread answers from its transcript alone: the last mode entry, every mode to offer', () => {
  const transcript = transcriptOf([modeEntry('enso-mode-acceptEdits', 'a'), modeEntry('enso-mode-plan', 'b')])
  expect(storedPermissionModeState(transcript)).toEqual({ mode: 'plan', available: EVERY_MODE })
})

// An agent that is not one of Enso's modes records no mode: the walk goes past it.
test("a stored thread skips an active_agent entry naming someone else's agent", () => {
  const transcript = transcriptOf([modeEntry('enso-mode-plan', 'a'), modeEntry('reviewer', 'b')])
  expect(storedPermissionModeState(transcript).mode).toBe('plan')
})

// A stored thread with NO mode entry reads exactly as a fresh one — the same object shape, the
// same set to offer — so a cold rail and a new thread never disagree about what "default" is.
test('a transcript with no active_agent entry is the fresh state, identically', () => {
  expect(storedPermissionModeState([])).toEqual(freshPermissionModeState())
  expect(
    storedPermissionModeState(transcriptOf([{ type: 'message', id: 'x', parentId: null, timestamp: '' }])),
  ).toEqual(freshPermissionModeState())
  expect(freshPermissionModeState()).toEqual({ mode: 'default', available: EVERY_MODE })
})

// The extension's setter is its per-mode slash command, named exactly the mode (L3 step C).
test('the mode command is the mode, as a slash command', () => {
  expect(modeCommand('plan')).toBe('/plan')
  expect(modeCommand('acceptEdits')).toBe('/acceptEdits')
})
