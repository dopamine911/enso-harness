import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import { branchStats } from '../branch-stats.ts'

/**
 * #45 phase 2: the branch, analysed off pi's own entries — built here with pi's real session
 * manager, so the shapes read are the ones pi writes.
 */

type RecordedUsage = Extract<SessionEntry, { type: 'usage' }>['usage']

const spend = (input: number, total: number): RecordedUsage => ({
  input,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
})

/** An assistant message as pi stores one; `parts` are its content. */
function assistant(parts: unknown[], cost: number, stopReason = 'stop'): never {
  return {
    role: 'assistant',
    content: parts,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    usage: spend(100, cost),
    stopReason,
    timestamp: Date.now(),
  } as never
}

interface StoredResult {
  readonly toolCallId: string
  readonly toolName: string
  readonly text: string
  readonly isError: boolean
  /** A summarised result's own model call. */
  readonly cost?: number
}

function toolResult({ toolCallId, toolName, text, isError, cost }: StoredResult): never {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    ...(cost === undefined ? {} : { usage: spend(10, cost) }),
    timestamp: Date.now(),
  } as never
}

const call = (id: string, name: string, args: Record<string, unknown>): unknown => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
})

// ⚠ The branch, not the session: the answer left behind by `branch()` is spent (pi's total has
// it) but is no turn of this conversation's.
test("turn, prompt and tool stats follow the branch; a failure is pi's isError; a summarised result is its prompt's spend", () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'first question', timestamp: Date.now() })
  const forkPoint = session.getLeafId()
  if (forkPoint === null) throw new Error('no leaf after the first prompt')
  session.appendMessage(assistant([{ type: 'text', text: 'an answer left behind' }], 9))
  session.branch(forkPoint)
  session.appendMessage(
    assistant([call('c1', 'bash', { command: 'ls' }), call('c2', 'read', { path: '/etc/hosts' })], 0.5),
  )
  session.appendMessage(toolResult({ toolCallId: 'c1', toolName: 'bash', text: 'out', isError: false }))
  session.appendMessage(toolResult({ toolCallId: 'c2', toolName: 'read', text: 'denied', isError: true, cost: 0.25 }))
  session.appendMessage(assistant([{ type: 'text', text: 'done' }], 0.125))
  session.appendMessage({ role: 'user', content: 'second   question\n  here', timestamp: Date.now() })
  session.appendMessage(assistant([], 0.0625, 'error'))

  const stats = branchStats(session.getBranch())

  expect(stats.turnStats.map((turn) => [turn.turn, turn.prompt, turn.cost, turn.toolCalls, turn.stopReason])).toEqual([
    [1, 1, 0.5, 2, 'stop'],
    [2, 1, 0.125, 0, 'stop'],
    [3, 2, 0.0625, 0, 'error'],
  ])
  expect(stats.promptStats).toEqual([
    { prompt: 1, text: 'first question', turnCount: 2, cost: 0.875, toolCalls: 2, failedToolCalls: 1 },
    { prompt: 2, text: 'second question here', turnCount: 1, cost: 0.0625, toolCalls: 0, failedToolCalls: 0 },
  ])
  expect(stats.branchCost).toBe(0.9375)
  expect(stats.toolStats).toEqual([
    { toolName: 'bash', calls: 1, failures: 0, inputChars: '{"command":"ls"}'.length, outputChars: 3 },
    { toolName: 'read', calls: 1, failures: 1, inputChars: '{"path":"/etc/hosts"}'.length, outputChars: 6 },
  ])
  expect(stats.firstAt).toBeDefined()
})

// A resumed fork or a command can put a turn before any prompt; it is a row then, and not before.
test('a turn before the first prompt is prompt 0 — a row only when there is one', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage(assistant([{ type: 'text', text: 'unprompted' }], 0.5))
  session.appendMessage({ role: 'user', content: 'then a question', timestamp: Date.now() })
  expect(branchStats(session.getBranch()).promptStats.map((prompt) => [prompt.prompt, prompt.turnCount])).toEqual([
    [0, 1],
    [1, 0],
  ])
  const prompted = SessionManager.inMemory(tmpdir())
  prompted.appendMessage({ role: 'user', content: 'a question', timestamp: Date.now() })
  expect(branchStats(prompted.getBranch()).promptStats.map((prompt) => prompt.prompt)).toEqual([1])
})
