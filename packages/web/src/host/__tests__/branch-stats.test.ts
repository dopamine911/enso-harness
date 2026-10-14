import { expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createBashTool, createEditTool, type SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
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
test("turn, prompt and call stats follow the branch; a failure is pi's isError; a call with no result is pending", () => {
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
  session.appendMessage(assistant([call('c3', 'grep', { pattern: 'x' })], 0.0625, 'error'))

  const stats = branchStats(session.getBranch())

  expect(stats.turnStats.map((turn) => [turn.turn, turn.prompt, turn.cost, turn.toolCalls, turn.stopReason])).toEqual([
    [1, 1, 0.5, 2, 'stop'],
    [2, 1, 0.125, 0, 'stop'],
    [3, 2, 0.0625, 1, 'error'],
  ])
  // `toMatchObject`: each prompt's `durationMs` is the clock's (pinned in its own test below).
  expect(stats.promptStats).toMatchObject([
    { prompt: 1, text: 'first question', turnCount: 2, cost: 0.875, toolCalls: 2, failedToolCalls: 1 },
    { prompt: 2, text: 'second question here', turnCount: 1, cost: 0.0625, toolCalls: 1, failedToolCalls: 0 },
  ])
  expect(stats.branchCost).toBe(0.9375)
  expect(stats.callStats).toEqual([
    {
      toolCallId: 'c1',
      toolName: 'bash',
      turn: 1,
      prompt: 1,
      inputChars: '{"command":"ls"}'.length,
      outputChars: 3,
      isError: false,
      pending: false,
    },
    {
      toolCallId: 'c2',
      toolName: 'read',
      turn: 1,
      prompt: 1,
      inputChars: '{"path":"/etc/hosts"}'.length,
      outputChars: 6,
      isError: true,
      pending: false,
    },
    {
      toolCallId: 'c3',
      toolName: 'grep',
      turn: 3,
      prompt: 2,
      inputChars: '{"pattern":"x"}'.length,
      outputChars: 0,
      isError: false,
      pending: true,
    },
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

/** A call through pi's own tool, its result as pi's agent loop stores it: a throw is an error result carrying the message. */
async function ran(tool: AgentTool, toolCallId: string, args: Record<string, unknown>): Promise<StoredResult> {
  try {
    const result = await tool.execute(toolCallId, args, undefined)
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    return { toolCallId, toolName: tool.name, text, isError: result.isError === true }
  } catch (error) {
    return {
      toolCallId,
      toolName: tool.name,
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    }
  }
}

// #928: pi marks a non-zero exit `isError` like a broken call. Run through pi's own tools, so a
// change to the status pi appends breaks here: `grep` finding nothing is the command answering,
// with its code; a timed-out command and an `edit` that cannot apply are failures.
test("⚠ a command's non-zero exit carries its code and is not the prompt's failure; a timeout and an edit error are", async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'enso-branch-stats-'))
  const bash = createBashTool(cwd)
  const edit = createEditTool(cwd)
  const results = [
    await ran(bash, 'g1', { command: 'grep needle /dev/null' }),
    await ran(bash, 't1', { command: 'sleep 5', timeout: 0.2 }),
    await ran(edit, 'e1', { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] }),
  ]
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'look around', timestamp: Date.now() })
  session.appendMessage(
    assistant(
      [
        call('g1', 'bash', { command: 'grep needle /dev/null' }),
        call('t1', 'bash', { command: 'sleep 5', timeout: 0.2 }),
        call('e1', 'edit', { path: 'missing.txt' }),
      ],
      0.1,
    ),
  )
  for (const result of results) session.appendMessage(toolResult(result))

  const stats = branchStats(session.getBranch())

  expect(stats.callStats.map((stat) => [stat.toolCallId, stat.isError, stat.exitCode])).toEqual([
    ['g1', true, 1],
    ['t1', true, undefined],
    ['e1', true, undefined],
  ])
  expect(stats.promptStats).toMatchObject([{ prompt: 1, toolCalls: 3, failedToolCalls: 2 }])
})

// #359: a prompt's own duration, off the stamps pi puts on each entry as it appends it — so a
// thread of any age has one, which the 14-day log cannot promise. The clock is pinned per entry.
test("a prompt's duration runs from its entry to the last entry answering it; an unanswered one has none", () => {
  const session = SessionManager.inMemory(tmpdir())
  const at = (instant: string): void => {
    setSystemTime(new Date(instant))
  }
  try {
    at('2026-09-23T10:00:00.000Z')
    session.appendMessage({ role: 'user', content: 'list them', timestamp: Date.now() })
    at('2026-09-23T10:00:04.000Z')
    session.appendMessage(assistant([call('c1', 'bash', { command: 'ls' })], 0.1))
    at('2026-09-23T10:00:05.500Z')
    session.appendMessage(toolResult({ toolCallId: 'c1', toolName: 'bash', text: 'a b', isError: false }))
    at('2026-09-23T10:00:09.000Z')
    session.appendMessage(assistant([{ type: 'text', text: 'two files' }], 0.1))
    at('2026-09-23T10:01:00.000Z')
    session.appendMessage({ role: 'user', content: 'and now?', timestamp: Date.now() })
  } finally {
    setSystemTime()
  }
  expect(branchStats(session.getBranch()).promptStats.map((prompt) => [prompt.prompt, prompt.durationMs])).toEqual([
    [1, 9000],
    [2, undefined],
  ])
})
