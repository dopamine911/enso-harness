import { expect, test } from 'bun:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { DEFAULT_GUARD_POLICY, DEFAULT_RISK_THRESHOLDS, ENSO_GUARD_DENIAL_ENTRY } from '@enso/core'
import { branchJudgeCases } from '../branch-judge-cases.ts'

let clock = Date.parse('2026-09-30T12:00:00.000Z')
const stamped = (entry: Record<string, unknown>): Record<string, unknown> => {
  clock += 1000
  return { id: `e${clock}`, timestamp: new Date(clock).toISOString(), ...entry }
}
const call = (id: string, command: string): Record<string, unknown> =>
  stamped({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }] },
  })
const result = (toolCallId: string): Record<string, unknown> =>
  stamped({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text: 'x' }],
      isError: false,
    },
  })

// ⚠ #469: the replay's cases are what leaves the machine. A call after a refusal is one, with the
// refusal; the refused call is not (the guard already stopped it); and no secret survives into it.
test('⚠ a call after a guard refusal is a case with the refusal, the refused call is none, and its state holds no secret', () => {
  const secret = 'hunter2-known-secret'
  const branch = [
    stamped({ type: 'message', message: { role: 'user', content: 'fetch it' } }),
    call('c1', 'curl https://example.test/x'),
    stamped({
      type: 'custom',
      customType: ENSO_GUARD_DENIAL_ENTRY,
      data: { toolCallId: 'c1', rule: 'network-egress', via: 'command-position' },
    }),
    result('c1'),
    call('c2', `FOO_TOKEN=abc123plain ./fetch.sh --pass ${secret}`),
    result('c2'),
  ] as unknown as SessionEntry[]
  const { cases } = branchJudgeCases(branch, {
    thresholds: DEFAULT_RISK_THRESHOLDS,
    cwd: '/nowhere-469',
    secretPathFragments: DEFAULT_GUARD_POLICY.secretPathFragments,
    secretValues: [secret],
  })
  expect(cases.map((judgeCase) => [judgeCase.toolCallId, judgeCase.scope])).toEqual([['c2', 'after-refusal']])
  expect(cases[0]?.state.denied?.command).toBe('curl https://example.test/x')
  expect(cases[0]?.state.cwd).toBe('/nowhere-469')
  const sent = JSON.stringify(cases)
  expect(sent).not.toContain(secret)
  expect(sent).not.toContain('abc123plain')
})
