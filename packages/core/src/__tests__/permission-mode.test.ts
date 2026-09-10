import { expect, test } from 'bun:test'
import { persistedPermissionMode } from '../permission-mode.ts'

const piccEntry = (mode: string, id: string): unknown => ({ type: 'custom', customType: 'modes', data: { mode }, id })

// picc's own restore rule, applied to the raw branch. One walk, three readers: the host's
// `permissionModeState`, the drawer's cross-check, a resumed thread's opening mode (#95).
test("the branch's LAST modes entry wins, and a branch with none is picc's initial default", () => {
  expect(persistedPermissionMode([piccEntry('acceptEdits', 'a'), piccEntry('plan', 'b')])).toBe('plan')
  expect(persistedPermissionMode([{ type: 'message', id: 'x', parentId: null, timestamp: '' }])).toBe('default')
  // Another extension's custom entry is not a mode.
  expect(persistedPermissionMode([{ type: 'custom', customType: 'other', data: { mode: 'plan' }, id: 'o' }])).toBe(
    'default',
  )
  expect(persistedPermissionMode([])).toBe('default')
})
