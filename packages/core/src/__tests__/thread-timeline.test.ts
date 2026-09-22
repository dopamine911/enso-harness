import { expect, test } from 'bun:test'
import type { EnsoLogLine } from '../log.ts'
import type { EnsoThreadEvent, EnsoThreadEvents } from '../thread-inspection.ts'
import { threadTimeline, timelineJoinKeys } from '../thread-timeline.ts'

/**
 * One thread, one ordering (#144 slice 3): the two tails and the log, by time, with the
 * arrival order kept inside a tie and an unreadable stamp kept rather than dropped.
 */

const THREAD = '6923e620-856a-4f1e-9d33-000000000001'

function event(at: string, type: string, provenance: EnsoThreadEvent['provenance'] = 'live'): EnsoThreadEvent {
  return { sequence: 1, type, provenance, at, count: 1 }
}

function line(at: string, message: string, properties: Record<string, unknown> = {}): EnsoLogLine {
  return {
    '@timestamp': at,
    level: 'INFO',
    message,
    logger: 'enso.server.threads',
    properties: { threadId: THREAD, ...properties },
  }
}

test('the tails and the log interleave by time, whichever source each row came from', () => {
  const events: EnsoThreadEvents = {
    threadId: THREAD,
    emitted: [event('2026-09-22T10:00:01.000Z', 'message_start'), event('2026-09-22T10:00:03.000Z', 'message_end')],
    sent: [event('2026-09-22T10:00:01.500Z', 'TEXT_MESSAGE_START', 'sent')],
  }
  const lines = [
    line('2026-09-22T10:00:00.000Z', 'run 1 acquired'),
    line('2026-09-22T10:00:02.000Z', 'tool bash denied'),
  ]
  const rows = threadTimeline(events, lines).map((entry) =>
    entry.source === 'log' ? `log ${entry.line.message}` : `${entry.source} ${entry.event.type}`,
  )
  expect(rows).toEqual([
    'log run 1 acquired',
    'emitted message_start',
    'sent TEXT_MESSAGE_START',
    'log tool bash denied',
    'emitted message_end',
  ])
})

// ⚠ Inside one millisecond the stamps say nothing, so the order must be the one the
// producers ran in and must be the SAME every time: emitted, then sent, then logged.
test('⚠ a tie keeps the arrival order: emitted, sent, log — deterministically', () => {
  const at = '2026-09-22T10:00:00.000Z'
  const events: EnsoThreadEvents = { threadId: THREAD, emitted: [event(at, 'a')], sent: [event(at, 'b', 'sent')] }
  const sources = threadTimeline(events, [line(at, 'c')]).map((entry) => entry.source)
  expect(sources).toEqual(['emitted', 'sent', 'log'])
})

test('⚠ a stamp that does not parse sorts first and is not dropped', () => {
  const rows = threadTimeline(undefined, [line('2026-09-22T10:00:00.000Z', 'readable'), line('whenever', 'unreadable')])
  expect(rows.map((entry) => (entry.source === 'log' ? entry.line.message : ''))).toEqual(['unreadable', 'readable'])
  expect(rows[0]?.at).toBe(0)
})

test('a thread with no live session is its log alone', () => {
  const rows = threadTimeline(undefined, [line('2026-09-22T10:00:00.000Z', 'what remains')])
  expect(rows).toHaveLength(1)
  expect(rows[0]?.source).toBe('log')
})

test('the join keys are the three a record carries, as strings, and only when present', () => {
  expect(timelineJoinKeys(line('x', 'm', { generation: 2, seq: 17, toolCallId: 'call_1' }))).toEqual({
    generation: '2',
    seq: '17',
    toolCallId: 'call_1',
  })
  expect(timelineJoinKeys(line('x', 'm'))).toEqual({})
  // A shape where a number was expected is not a key: nothing is stringified into `[object Object]`.
  expect(timelineJoinKeys(line('x', 'm', { generation: { nested: true } }))).toEqual({})
})
