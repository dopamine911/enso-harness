import { expect, test } from 'bun:test'
import type { EnsoThreadStats, EnsoToolCallStats } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadStatsView } from '../thread-stats.tsx'
import { headlineOf, rankCalls, rankTools, toolSummaries } from '../thread-stats-analysis.ts'

/**
 * #45 phase 2: the stats drawer, livecraft's session analysis over our wire — its derivations as
 * pure functions, and a static render of what it says it measured and what it could not.
 */

const NONE = { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 }

const call = (toolCallId: string, toolName: string, overrides: Partial<EnsoToolCallStats> = {}): EnsoToolCallStats => ({
  toolCallId,
  toolName,
  turn: 1,
  prompt: 1,
  inputChars: 10,
  outputChars: 100,
  isError: false,
  pending: false,
  ...overrides,
})

const CALLS: EnsoToolCallStats[] = [
  call('c1', 'bash', { inputChars: 70, outputChars: 1500, durationMs: 30 }),
  call('c2', 'read', { inputChars: 50, outputChars: 115, isError: true, durationMs: 12 }),
  call('c3', 'read', { inputChars: 45, outputChars: 2000 }),
]

const STATS: EnsoThreadStats = {
  threadId: 't1',
  live: true,
  usage: { cost: 0.5, input: 3943, output: 853, cacheRead: 0, cacheWrite: 6546, context: null },
  branchCost: 0.5,
  turnStats: [
    {
      turn: 1,
      prompt: 1,
      model: 'claude-test',
      cost: 0.2,
      input: 3900,
      output: 400,
      cacheRead: 0,
      cacheWrite: 0,
      toolCalls: 3,
      stopReason: 'toolUse',
    },
    {
      turn: 2,
      prompt: 1,
      model: 'claude-test',
      cost: 0.3,
      input: 43,
      output: 453,
      cacheRead: 0,
      cacheWrite: 6546,
      toolCalls: 0,
      stopReason: 'stop',
    },
  ],
  promptStats: [{ prompt: 1, text: 'list the files', turnCount: 2, cost: 0.5, toolCalls: 3, failedToolCalls: 1 }],
  callStats: CALLS,
  latency: { prompts: NONE, firstDelta: NONE },
  logDays: ['2026-09-22'],
}

const text = (stats: EnsoThreadStats): string =>
  renderToStaticMarkup(<ThreadStatsView outcome={{ kind: 'read', payload: stats }} />).replace(/<[^>]*>/g, ' ')

test("the headline is livecraft's cards: mean and median cost per turn, tools per turn, failures over calls", () => {
  expect(headlineOf(STATS)).toEqual({
    turnCount: 2,
    averageTurnCost: 0.25,
    medianTurnCost: 0.25,
    averageToolsPerTurn: 1.5,
    toolCalls: 3,
    failedToolCalls: 1,
    failureRate: 1 / 3,
    offBranchCost: 0,
  })
  // Spend the branch does not account for is its own figure — and float noise is not spend.
  expect(headlineOf({ ...STATS, usage: { ...STATS.usage, cost: 0.75 } }).offBranchCost).toBe(0.25)
  expect(headlineOf({ ...STATS, usage: { ...STATS.usage, cost: 0.500_01 } }).offBranchCost).toBe(0)
})

// ⚠ livecraft's rules: a duration ranking lists only what the log timed — an untimed call is not
// the fastest, it is unmeasured — and a failure ranking lists only calls pi marked failed.
test('rankings by duration and by failure leave out calls that have neither', () => {
  expect(rankCalls(CALLS, 'input').map((ranked) => ranked.toolCallId)).toEqual(['c1', 'c2', 'c3'])
  expect(rankCalls(CALLS, 'duration').map((ranked) => ranked.toolCallId)).toEqual(['c1', 'c2'])
  expect(rankCalls(CALLS, 'failure').map((ranked) => ranked.toolCallId)).toEqual(['c2'])
  const tools = toolSummaries(CALLS)
  expect(tools.find((tool) => tool.toolName === 'read')).toEqual({
    toolName: 'read',
    calls: 2,
    failed: 1,
    inputChars: 95,
    outputChars: 2115,
    durationMs: 12,
    measured: 1,
  })
  expect(rankTools(tools, 'output').map((tool) => tool.toolName)).toEqual(['read', 'bash'])
  expect(rankTools(toolSummaries([call('c9', 'find')]), 'duration')).toEqual([])
})

test('the drawer says what it analysed, and names spend no turn on this branch accounts for', () => {
  const rendered = text(STATS)
  expect(rendered).toContain('1 prompt analysed')
  expect(rendered).toContain('1 · 33.3%')
  expect(rendered).not.toContain('not attributed')
  expect(text({ ...STATS, usage: { ...STATS.usage, cost: 0.75 } })).toContain('not attributed to a turn on this branch')
})

test('a branch with no turn says what it is waiting for instead of drawing zeros', () => {
  const rendered = text({ ...STATS, turnStats: [], promptStats: [], callStats: [], branchCost: 0 })
  expect(rendered).toContain('costs appear after the first response')
  expect(rendered).toContain('no tool called on this branch yet')
  expect(rendered).toContain('not in the log')
})
