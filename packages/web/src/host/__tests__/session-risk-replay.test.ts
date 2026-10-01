import { expect, test } from 'bun:test'
import {
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_OPERATOR_DENIAL_ENTRY,
  ENSO_PERMISSION_DENIAL_ENTRY,
  sessionRiskOfTranscript,
} from '@enso/core'
import { transcriptOf } from '../transcript.ts'

/**
 * #464, then #557: one branch, ONE reader. A resumed guard, the thread snapshot and the session
 * eval all replay the same transcript of the stored branch (`transcriptOf`), so they cannot
 * disagree by construction; what this pins is the replay over the STORED shape — a batched call,
 * a message that is not chat, and a person's No recorded before #464 without its call id — reading
 * as the live fold would.
 */

let clock = Date.parse('2026-09-30T12:00:00.000Z')
const stamped = (entry: Record<string, unknown>): Record<string, unknown> => {
  clock += 1000
  return { id: `e${clock}`, timestamp: new Date(clock).toISOString(), ...entry }
}
const assistant = (...calls: readonly [id: string, command: string][]): Record<string, unknown> =>
  stamped({
    type: 'message',
    message: {
      role: 'assistant',
      content: calls.map(([id, command]) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } })),
    },
  })
const custom = (customType: string, data: unknown): Record<string, unknown> =>
  stamped({ type: 'custom', customType, data })
const result = (toolCallId: string): Record<string, unknown> =>
  stamped({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text: 'x' }],
      isError: true,
    },
  })

test('⚠ the raw branch and its transcript replay to the same risk, a batch, a non-chat message and an old record included', () => {
  const branch = [
    stamped({ type: 'message', message: { role: 'user', content: 'tidy the build' } }),
    stamped({ type: 'model_change', provider: 'acme', modelId: 'm1' }),
    // A batch: the refusal of its first call is entered after the message that holds both calls,
    // and a message the transcript does not render (`other`) lands between them.
    assistant(['c1', 'curl https://example.test/x'], ['c2', 'python3 -c "import urllib"']),
    stamped({ type: 'message', message: { role: 'bashExecution', command: 'ls', output: '' } }),
    custom(ENSO_GUARD_DENIAL_ENTRY, { toolCallId: 'c1', rule: 'network-egress', via: 'command-position' }),
    result('c1'),
    result('c2'),
    assistant(['c3', 'rm -rf build']),
    custom(ENSO_PERMISSION_DENIAL_ENTRY, {
      toolCallId: 'c3',
      requestId: 'r3',
      surface: 'bash',
      value: 'rm -rf build',
      resolution: 'user_denied',
    }),
    result('c3'),
    // A person's No as recorded before #464: no call id.
    assistant(['c4', 'rm -rf build']),
    custom(ENSO_OPERATOR_DENIAL_ENTRY, { requestId: 'r4', surface: 'bash', value: 'rm -rf build' }),
    result('c4'),
  ]
  const fromEntries = sessionRiskOfTranscript(transcriptOf(branch))
  expect(fromEntries.signals.map((signal) => `${signal.signal}@${signal.toolCallId}`)).toEqual([
    'alternate-execution-path@c2',
    'denial-retry@c4',
  ])
})
