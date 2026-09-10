import { expect, test } from 'bun:test'
import { createEventTail, describePiRpcEvent } from '../event-tail.ts'

/**
 * #97's tail is a debugging surface: what it must not do is lie by omission. Coalescing
 * keeps the count exact, the ring keeps the newest, and provenance is a coalescing key —
 * a held-then-replayed pair MUST stay two rows, because that pair is the finding.
 */

test('consecutive events of one type, name and provenance fold into one row with an exact count', () => {
  const tail = createEventTail()
  for (let index = 0; index < 5; index += 1) tail.record('message_update', undefined, 'live')
  tail.record('agent_settled', undefined, 'live')
  expect(tail.recent()).toMatchObject([
    { sequence: 1, type: 'message_update', count: 5 },
    { sequence: 2, type: 'agent_settled', count: 1 },
  ])
})

test('⚠ a change of provenance or name starts a new row — held vs replayed is the ordering evidence', () => {
  const tail = createEventTail()
  tail.record('entry_appended', 'modes', 'held')
  tail.record('entry_appended', 'modes', 'replayed')
  tail.record('entry_appended', 'other', 'replayed')
  expect(tail.recent().map((event) => `${event.provenance} ${event.type} ${event.name}`)).toEqual([
    'held entry_appended modes',
    'replayed entry_appended modes',
    'replayed entry_appended other',
  ])
})

test('the ring drops the oldest row past capacity; sequence numbers keep counting', () => {
  const tail = createEventTail(2)
  tail.record('a', undefined, 'live')
  tail.record('b', undefined, 'live')
  tail.record('c', undefined, 'live')
  expect(tail.recent().map((event) => [event.sequence, event.type])).toEqual([
    [2, 'b'],
    [3, 'c'],
  ])
})

test('recent() is a copy: mutating it does not reach the ring', () => {
  const tail = createEventTail()
  tail.record('a', undefined, 'live')
  const snapshot = tail.recent() as unknown[]
  snapshot.length = 0
  expect(tail.recent()).toHaveLength(1)
})

test("a pi event's inner name: the custom entry's type, a ui method, a tool; nothing when there is none", () => {
  expect(
    describePiRpcEvent({ type: 'entry_appended', entry: { type: 'custom', customType: 'modes' } } as never),
  ).toEqual({ type: 'entry_appended', name: 'modes' })
  expect(describePiRpcEvent({ type: 'entry_appended', entry: { type: 'message' } } as never)).toEqual({
    type: 'entry_appended',
    name: 'message',
  })
  expect(describePiRpcEvent({ type: 'extension_ui_request', method: 'select' } as never)).toEqual({
    type: 'extension_ui_request',
    name: 'select',
  })
  expect(describePiRpcEvent({ type: 'tool_execution_start', toolName: 'bash' } as never)).toEqual({
    type: 'tool_execution_start',
    name: 'bash',
  })
  expect(describePiRpcEvent({ type: 'agent_settled' })).toEqual({ type: 'agent_settled', name: undefined })
})
