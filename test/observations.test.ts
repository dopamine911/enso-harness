import { expect, test } from 'bun:test'
import { adapterResult } from '../scripts/docs/observations.ts'

/**
 * WHAT THE OBSERVATION INVENTORY SAYS THE ADAPTER EMITS (#162 workstream 5, #832).
 *
 * `docs/reference/observations.md` reads each kind's `case` block in `to-agui.ts` and publishes
 * what it emits. A kind the adapter does not handle is a FINDING the page prints, not a refusal;
 * an adapter the reader cannot delimit, or one that names CUSTOM two ways, is refused. These pin
 * both halves on a fixture, because the live adapter holds only the shapes it holds today.
 */

const ADAPTER = `
export function observationToAguiEvents(observation, ids) {
  switch (observation.kind) {
    case 'text-delta':
      return [{ type: EventType.TEXT_MESSAGE_CONTENT, delta: observation.delta }]

    case 'tool-call':
      return [
        { type: EventType.TOOL_CALL_START },
        { type: EventType.TOOL_CALL_ARGS },
        { type: EventType.TOOL_CALL_START },
      ]

    case 'tool-result': {
      if (!observation.complete) return []
      return [{ type: EventType.TOOL_CALL_RESULT }]
    }

    case 'dialog':
      return [custom(observation)]

    case 'notice':
      return observation.quiet ? [] : [custom(observation)]

    case 'session-ended':
      return []

    case 'mystery':
      record(observation)
  }
}
`

test('a case emits its event types once each, in source order', () => {
  expect(adapterResult(ADAPTER, 'text-delta')).toEqual({
    labels: ['EventType.TEXT_MESSAGE_CONTENT'],
    custom: false,
    dropped: false,
    classified: true,
  })
  expect(adapterResult(ADAPTER, 'tool-call').labels).toEqual(['EventType.TOOL_CALL_START', 'EventType.TOOL_CALL_ARGS'])
})

test('a kind riding CUSTOM is labelled by its kind, and an empty-array branch as dropped', () => {
  expect(adapterResult(ADAPTER, 'dialog')).toEqual({
    labels: ['dialog'],
    custom: true,
    dropped: false,
    classified: true,
  })
  // A guard that returns nothing for one state drops that state; the rest still emits.
  expect(adapterResult(ADAPTER, 'tool-result')).toEqual({
    labels: ['EventType.TOOL_CALL_RESULT', 'dropped'],
    custom: false,
    dropped: true,
    classified: true,
  })
  // The ternary spelling drops too.
  expect(adapterResult(ADAPTER, 'notice').labels).toEqual(['notice', 'dropped'])
  expect(adapterResult(ADAPTER, 'session-ended').labels).toEqual(['dropped'])
})

test('a kind with no case, or a case with no recognized output, is printed UNCLASSIFIED, not refused', () => {
  expect(adapterResult(ADAPTER, 'compaction')).toEqual({
    labels: ['UNCLASSIFIED (no adapter case)'],
    custom: false,
    dropped: false,
    classified: false,
  })
  // The last case ends where the switch closes, not at the end of the file.
  expect(adapterResult(ADAPTER, 'mystery')).toEqual({
    labels: ['UNCLASSIFIED (case has no recognized output)'],
    custom: false,
    dropped: false,
    classified: false,
  })
})

test('an adapter the reader cannot read unambiguously is refused by kind', () => {
  const repeated = ADAPTER.replace("case 'session-ended':", "case 'dialog':")
  expect(() => adapterResult(repeated, 'dialog')).toThrow('observations: adapter repeats case dialog')
  const twice = ADAPTER.replace(
    'return [custom(observation)]',
    'return [custom(observation), { type: EventType.CUSTOM }]',
  )
  expect(() => adapterResult(twice, 'dialog')).toThrow('observations: adapter case dialog spells CUSTOM twice')
  const unclosed = ADAPTER.replace('\n  }\n}\n', '\n')
  expect(() => adapterResult(unclosed, 'mystery')).toThrow('observations: could not delimit adapter case mystery')
})
