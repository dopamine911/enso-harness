import { expect, test } from 'bun:test'
import {
  isZenToolResultDescriptor,
  PromptImageContent,
  ZenObservation,
  ZenToolResultDescriptor,
  ZenUsage,
} from '@zen/core'
import { Check } from 'typebox/value'
import { mapPiEvent } from '../../host/map-events.ts'
import { observationKindsDeclaredByTheUnion } from './observation-kinds.ts'

/**
 * These prove the TypeBox conversion bought RUNTIME VALIDATION and a JSON Schema, not just
 * types. Without them the schemas would be decorative — the "built claims need a caller"
 * failure, applied to a refactor of my own.
 */

// --- the schemas really are JSON Schema objects, which is the reason for choosing TypeBox
test('a schema is literally a JSON Schema object', () => {
  expect(ZenToolResultDescriptor).toMatchObject({ type: 'object' })
  expect(ZenToolResultDescriptor.required).toContain('kind')
  expect(ZenToolResultDescriptor.required).toContain('props')
  // optional fields are absent from `required`, which is what an OpenAPI consumer reads
  expect(ZenToolResultDescriptor.required).not.toContain('truncated')
})

test('the observation union is expressed as a JSON Schema union', () => expect(ZenObservation).toHaveProperty('anyOf'))

// --- and the validators actually reject
test('the descriptor validator rejects every malformed shape', () => {
  expect(isZenToolResultDescriptor({ kind: 'diff', props: {} })).toBe(true)
  expect(isZenToolResultDescriptor({ kind: '', props: {} })).toBe(false)
  expect(isZenToolResultDescriptor({ kind: 'diff' })).toBe(false)
  expect(isZenToolResultDescriptor({ props: {} })).toBe(false)
  expect(isZenToolResultDescriptor('diff')).toBe(false)
  expect(isZenToolResultDescriptor(null)).toBe(false)
})

test('a negative truncation count is rejected, not silently rendered', () =>
  expect(isZenToolResultDescriptor({ kind: 'd', props: {}, truncated: { shown: -1, total: 5, unit: 'lines' } })).toBe(
    false,
  ))

test('an unknown truncation unit is rejected by the schema', () =>
  expect(isZenToolResultDescriptor({ kind: 'd', props: {}, truncated: { shown: 1, total: 5, unit: 'furlongs' } })).toBe(
    false,
  ))

test('usage rejects non-integer token counts', () => {
  expect(Check(ZenUsage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(true)
  expect(Check(ZenUsage, { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(false)
  expect(Check(ZenUsage, { input: 1, output: 2 })).toBe(false)
})

// --- pi wire schemas
test('image content is validated, so a malformed attachment fails at the boundary', () => {
  expect(Check(PromptImageContent, { type: 'image', data: 'aGk=', mimeType: 'image/png' })).toBe(true)
  expect(Check(PromptImageContent, { type: 'file', data: 'aGk=', mimeType: 'image/png' })).toBe(false)
  expect(Check(PromptImageContent, { type: 'image', data: 'aGk=' })).toBe(false)
})

// --- the mapper's output validates against the union it claims to produce
test('EVERY observation the mapper can emit validates against ZenObservation', () => {
  const events = [
    {
      type: 'message_update',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a' },
    },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'b' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    { type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'ls' } },
    {
      type: 'tool_execution_update',
      toolCallId: 'c',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'x' }] },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'c',
      toolName: 'bash',
      result: { content: 'y', details: { truncation: { shown: 1, total: 9, unit: 'lines' } } },
      isError: false,
    },
    { type: 'tool_execution_end', toolCallId: 'c', toolName: 'write', result: { content: 'denied' }, isError: true },
    { type: 'extension_error', extensionPath: '/g.ts', event: 'tool_call', error: 'boom' },
    { type: 'extension_ui_request', id: 'u1', method: 'notify', message: 'Mode: acceptEdits', notifyType: 'info' },
    { type: 'extension_ui_settled', id: 'u1', outcome: 'answered' },
    {
      type: 'message_end',
      message: { role: 'assistant', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
    },
    { type: 'message_start', message: { role: 'user', content: 'hi' } },
    { type: 'turn_start' },
    { type: 'turn_end', message: {}, toolResults: [] },
    { type: 'queue_update', steering: [], followUp: ['x'] },
    { type: 'entry_appended', entry: { type: 'custom', customType: 'modes', data: { mode: 'acceptEdits' } } },
    { type: 'permission_mode', mode: 'acceptEdits', available: ['default', 'acceptEdits'] },
    { type: 'agent_end', willRetry: true },
    { type: 'agent_settled' },
    { type: 'totally_unknown', payload: [1, 2, 3] },
  ]
  for (const event of events) {
    const observation = mapPiEvent(event)
    expect(Check(ZenObservation, observation)).toBe(true)
  }
  // and the set above actually covers every member of the union — derived from the union
  // itself, never a hard-coded count: the count drifted once (566e8b1 bumped the sibling
  // sweep in to-agui.test.ts to 9 and left this one at 8), and a count cannot say WHICH
  // kind is missing. Kinds the SERVER synthesises (never off a pi event) are named here,
  // and must validate too.
  const synthesised = [
    { kind: 'prompt-rejected', messageId: 'm', reason: 'r' },
    { kind: 'permission-mode-rejected', mode: 'plan', reason: 'r' },
  ] as const
  for (const observation of synthesised) expect(Check(ZenObservation, observation)).toBe(true)
  const coveredKinds: string[] = [
    ...new Set([
      ...events.map((event) => mapPiEvent(event).kind),
      ...synthesised.map((observation) => observation.kind),
    ]),
  ]
  expect(coveredKinds.sort()).toEqual(observationKindsDeclaredByTheUnion())
})
