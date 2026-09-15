import { expect, test } from 'bun:test'
import { persistedPermissionMode, storedPermissionModeState } from '../permission-mode-adapter.ts'

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

test('a stored thread answers from its branch alone: the walk for the mode, the full registered set to offer', () => {
  expect(storedPermissionModeState([piccEntry('plan', 'a')])).toEqual({
    mode: 'plan',
    available: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
  })
})
