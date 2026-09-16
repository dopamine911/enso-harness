import { expect, test } from 'bun:test'
import {
  freshPermissionModeState,
  persistedPermissionMode,
  piccModeCommand,
  storedPermissionModeState,
} from '../permission-mode-adapter.ts'
import { transcriptOf } from '../transcript.ts'

const piccEntry = (mode: string, id: string): unknown => ({ type: 'custom', customType: 'modes', data: { mode }, id })

// picc's own restore rule, applied to the raw branch, below the seam (L3 step A). One walk,
// two readers: a live thread's `permissionModeState`, a stored thread's opening mode (#95).
test("the branch's LAST modes entry wins, and a branch with none is picc's initial default", () => {
  expect(persistedPermissionMode([piccEntry('acceptEdits', 'a'), piccEntry('plan', 'b')])).toBe('plan')
  expect(persistedPermissionMode([{ type: 'message', id: 'x', parentId: null, timestamp: '' }])).toBe('default')
  // Another extension's custom entry is not a mode.
  expect(persistedPermissionMode([{ type: 'custom', customType: 'other', data: { mode: 'plan' }, id: 'o' }])).toBe(
    'default',
  )
  expect(persistedPermissionMode([])).toBe('default')
})

test('a stored thread answers from its transcript alone: the walk for the mode, the full registered set to offer', () => {
  const transcript = transcriptOf([piccEntry('acceptEdits', 'a'), piccEntry('plan', 'b')])
  expect(storedPermissionModeState(transcript)).toEqual({
    mode: 'plan',
    available: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
  })
})

// A stored thread with NO mode entry reads exactly as a fresh one — the same object shape, the
// same set to offer — so a cold rail and a new thread never disagree about what "default" is.
test('a transcript with no modes entry is the fresh state, identically', () => {
  expect(storedPermissionModeState([])).toEqual(freshPermissionModeState())
  expect(
    storedPermissionModeState(transcriptOf([{ type: 'message', id: 'x', parentId: null, timestamp: '' }])),
  ).toEqual(freshPermissionModeState())
  expect(freshPermissionModeState().available).toContain(freshPermissionModeState().mode)
})

// The vendor's setter is its per-mode slash command, named exactly the mode (L3 step C).
test('the mode command is the mode, as a slash command', () => {
  expect(piccModeCommand('plan')).toBe('/plan')
  expect(piccModeCommand('acceptEdits')).toBe('/acceptEdits')
})
