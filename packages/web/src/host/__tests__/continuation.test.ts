import { expect, test } from 'bun:test'
import type { ContextMessage } from '../context-elements.ts'
import { type ContinuationLead, continuationLead, LOST_TOOL_RESULT_TEXT } from '../continuation.ts'

/**
 * `continuationLead` (#436): whether a torn thread can be continued from its stored state, and what
 * closes it first. pi's run lifecycle has no guard of its own, so a wrong answer here is a second
 * reply to nothing, or an orphan call the file keeps.
 */

const NOW = 1_790_000_000_000

const user = (text: string): ContextMessage => ({ role: 'user', content: text, timestamp: 1 })
const system = (): ContextMessage => ({ role: 'system', content: 'instructions', timestamp: 1 }) as ContextMessage
const assistant = (...calls: Array<{ id: string; name: string }>): ContextMessage =>
  ({
    role: 'assistant',
    content: [
      { type: 'text', text: 'working' },
      ...calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: {} })),
    ],
    api: 'faux',
    provider: 'faux',
    model: 'faux-1',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length === 0 ? 'stop' : 'toolUse',
    timestamp: 1,
  }) as ContextMessage
const result = (toolCallId: string, toolName: string): ContextMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 1,
})
const lost = (toolCallId: string, toolName: string): ContinuationLead[number] => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: [{ type: 'text', text: LOST_TOOL_RESULT_TEXT }],
  isError: true,
  timestamp: NOW,
})

test('an unanswered prompt continues with nothing ahead of it — no second copy of the prompt', () => {
  expect(continuationLead([system(), user('first'), assistant(), user('second')], NOW)).toEqual([])
})

test("an extension's custom message at the tail continues like a prompt", () => {
  const custom = { role: 'custom', customType: 'x', content: 'go on', display: true, timestamp: 1 } as ContextMessage
  expect(continuationLead([user('first'), assistant(), custom], NOW)).toEqual([])
})

test('a turn whose every call has its result continues with nothing ahead of it', () => {
  const calls = [
    { id: 'c1', name: 'read' },
    { id: 'c2', name: 'bash' },
  ]
  expect(continuationLead([user('q'), assistant(...calls), result('c1', 'read'), result('c2', 'bash')], NOW)).toEqual(
    [],
  )
})

test('⚠ a tool call without its result is closed with one error result per open call, then continued', () => {
  const calls = [
    { id: 'c1', name: 'read' },
    { id: 'c2', name: 'bash' },
  ]
  expect(continuationLead([user('q'), assistant(...calls)], NOW)).toEqual([lost('c1', 'read'), lost('c2', 'bash')])
})

test('⚠ a parallel call whose sibling result landed: only the call still open is closed', () => {
  const calls = [
    { id: 'c1', name: 'read' },
    { id: 'c2', name: 'bash' },
  ]
  expect(continuationLead([user('q'), assistant(...calls), result('c1', 'read')], NOW)).toEqual([lost('c2', 'bash')])
})

test('⚠ a completed reply is refused — continuing it would answer nothing a second time', () => {
  expect(continuationLead([user('q'), assistant()], NOW)).toBeUndefined()
  // A system message after the reply is an instruction, not a turn: still nothing to continue.
  expect(continuationLead([user('q'), assistant(), system()], NOW)).toBeUndefined()
})

test('an empty thread, or one holding only instructions, is refused', () => {
  expect(continuationLead([], NOW)).toBeUndefined()
  expect(continuationLead([system()], NOW)).toBeUndefined()
})

test('a tail that is no prompt and no turn — a compaction summary — is refused', () => {
  const summary = { role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 1 } as ContextMessage
  expect(continuationLead([user('q'), assistant(), summary], NOW)).toBeUndefined()
})
