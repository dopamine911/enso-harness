import { expect, test } from 'bun:test'
import { describeThreadEvent, type EnsoThreadEvent, isEnsoThreadId, threadEventColumns } from '../thread-inspection.ts'
import { describeTranscriptEntry } from '../transcript.ts'

// The row formats are shared by the `?debug` drawer and `enso-thread.ts` (PR #100 review: one
// definition, after the #86 pair had drifted). What a human reads off either surface is pinned here.

test('a transcript entry row: time, kind, custom type, message role, tool name, and the mode when the entry carries one', () => {
  expect(
    describeTranscriptEntry({
      kind: 'custom',
      id: 'm',
      customType: 'modes',
      at: '2026-09-08T12:34:56.000Z',
      data: { mode: 'plan' },
    }),
  ).toBe('12:34:56 custom:modes mode=plan')
  expect(
    describeTranscriptEntry({ kind: 'message', id: 'u', at: '2026-09-08T12:34:56.000Z', role: 'user', parts: [] }),
  ).toBe('12:34:56 message user')
  expect(
    describeTranscriptEntry({
      kind: 'tool-result',
      id: 'r',
      toolCallId: 'c',
      toolName: 'bash',
      text: '',
      isError: true,
    }),
  ).toBe('tool-result bash error')
  // An unmodelled kind shows its type; a missing time reads as absent, never as "undefined".
  expect(describeTranscriptEntry({ kind: 'other', id: 'x', type: 'model_change' })).toBe('model_change')
  // A non-primitive `mode` is not printed: `[object Object]` in a row reads as the row lying.
  expect(
    describeTranscriptEntry({ kind: 'custom', id: 'm', customType: 'modes', data: { mode: { nested: true } } }),
  ).toBe('custom:modes')
})

// The id names a FILE (#95): what a filesystem could read is out; what the browser mints is in.
test('a thread id is a UUID or the like — never a path, never a flag, never unbounded', () => {
  expect(isEnsoThreadId(crypto.randomUUID())).toBe(true)
  expect(isEnsoThreadId('stored-1')).toBe(true)
  expect(isEnsoThreadId('a'.repeat(64))).toBe(true)
  expect(isEnsoThreadId('a'.repeat(65))).toBe(false)
  expect(isEnsoThreadId('')).toBe(false)
  expect(isEnsoThreadId('../../evil')).toBe(false)
  expect(isEnsoThreadId('with space')).toBe(false)
  expect(isEnsoThreadId('a.b')).toBe(false)
  expect(isEnsoThreadId('-flag')).toBe(false)
  expect(isEnsoThreadId(42)).toBe(false)
})

function threadEvent(overrides: Partial<EnsoThreadEvent>): EnsoThreadEvent {
  return {
    sequence: 1,
    type: 'entry_appended',
    provenance: 'live',
    at: '2026-09-08T12:34:56.000Z',
    count: 1,
    ...overrides,
  }
}

// The provenance IS the finding — a `held` or `dropped` row is what an ordering bug looks like — so
// every row must show it, and a coalesced row its count, or the tail hides what it was built to show.
test('an event row names its provenance, its coalesced count, and the inner name when there is one', () => {
  expect(describeThreadEvent(threadEvent({ provenance: 'held', count: 3, name: 'modes' }))).toBe(
    '12:34:56 held ×3 entry_appended modes',
  )
  expect(describeThreadEvent(threadEvent({ type: 'RUN_STARTED', provenance: 'sent' }))).toBe(
    '12:34:56 sent RUN_STARTED',
  )
  // The columns are what a table lays out: the count rides with the provenance, the name with the type.
  expect(threadEventColumns(threadEvent({ provenance: 'held', count: 3, name: 'modes' }))).toEqual({
    when: '12:34:56',
    provenance: 'held ×3',
    subject: 'entry_appended modes',
  })
})
