import { expect, test } from 'bun:test'
import { truncateTail } from '@earendil-works/pi-coding-agent'
import { EnsoObservation } from '@enso/core'
import { observationKindsDeclaredByTheUnion } from '@enso/core/observation-kinds'
import { Check } from 'typebox/value'
import { mapPiEvent } from '../map-events.ts'

// --- the mapper's output validates against the union it claims to produce
test('EVERY observation the mapper can emit validates against EnsoObservation', () => {
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
      // pi's own truncation (#411), so the descriptor branch is really exercised.
      result: { content: 'y', details: { truncation: truncateTail('y\n'.repeat(3000)) } },
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
    // The host's own model event (#338 slice 2), said by the watcher extension or a command.
    {
      type: 'model',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      thinkingLevel: 'medium',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
    // The host's own usage event (#45), said at turn, run and compaction boundaries.
    {
      type: 'session_usage',
      cost: 0.1,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      context: { tokens: 2, window: 200_000, percent: 0.001 },
    },
    { type: 'provider_refused', provider: 'anthropic', model: 'claude-sonnet-4-5', status: 429, message: '429 {}' },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '429 {}' },
    { type: 'auto_retry_end', success: false, attempt: 3, finalError: '429 {}' },
    { type: 'compaction_end', reason: 'overflow', result: { summary: 's' }, aborted: false, willRetry: true },
    { type: 'login', provider: 'Anthropic', waiting: true },
    { type: 'agent_end', willRetry: true },
    { type: 'agent_settled' },
    { type: 'totally_unknown', payload: [1, 2, 3] },
  ]
  for (const event of events) {
    const observation = mapPiEvent(event)
    expect(Check(EnsoObservation, observation)).toBe(true)
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
  for (const observation of synthesised) expect(Check(EnsoObservation, observation)).toBe(true)
  const coveredKinds: string[] = [
    ...new Set([
      ...events.map((event) => mapPiEvent(event).kind),
      ...synthesised.map((observation) => observation.kind),
    ]),
  ]
  expect(coveredKinds.sort()).toEqual(observationKindsDeclaredByTheUnion())
})
