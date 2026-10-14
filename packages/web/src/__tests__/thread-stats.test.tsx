import { expect, test } from 'bun:test'
import type { EnsoThreadStats, EnsoToolCallStats } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { headlineOf, type RefusedCalls, rankCalls, rankTools, toolSummaries } from '../thread-stats-analysis.ts'
import { ThreadStatsView } from '../thread-stats.tsx'

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

/** No call refused (#387). */
const NONE_REFUSED: RefusedCalls = new Map()

const text = (stats: EnsoThreadStats, refused: RefusedCalls = NONE_REFUSED): string =>
  renderToStaticMarkup(<ThreadStatsView outcome={{ kind: 'read', payload: stats }} refused={refused} />).replace(
    /<[^>]*>/g,
    ' ',
  )

test("the headline is livecraft's cards: mean and median cost per turn, tools per turn, failures over calls", () => {
  expect(headlineOf(STATS, NONE_REFUSED)).toEqual({
    turnCount: 2,
    averageTurnCost: 0.25,
    medianTurnCost: 0.25,
    pricing: 'priced',
    unpricedTurnCount: 0,
    averageToolsPerTurn: 1.5,
    toolCalls: 3,
    failedToolCalls: 1,
    nonZeroExits: 0,
    refusedToolCalls: 0,
    refusedBy: [],
    failureRate: 1 / 3,
    offBranchCost: 0,
  })
  // Spend the branch does not account for is its own figure — and float noise is not spend.
  expect(headlineOf({ ...STATS, usage: { ...STATS.usage, cost: 0.75 } }, NONE_REFUSED).offBranchCost).toBe(0.25)
  expect(headlineOf({ ...STATS, usage: { ...STATS.usage, cost: 0.50001 } }, NONE_REFUSED).offBranchCost).toBe(0)
})

/** STATS run on a model pi has no price for: every turn billed 0, every token still counted. */
const UNPRICED: EnsoThreadStats = {
  ...STATS,
  usage: { ...STATS.usage, cost: 0 },
  branchCost: 0,
  turnStats: STATS.turnStats.map((turn) => ({ ...turn, model: 'gpt-5.6-luna', cost: 0 })),
  promptStats: STATS.promptStats.map((prompt) => ({ ...prompt, cost: 0 })),
}

// #692: a model pi has no price for (the Codex subscription models multi-account learns from the
// live catalog) bills every turn 0, and Stats said $0.0000 — read as free, not unknown. Its cost
// says unknown; its tokens are what they were.
test('⚠ a model with no price shows its cost as unknown, not $0.0000; its tokens stay', () => {
  expect(headlineOf(UNPRICED, NONE_REFUSED)).toMatchObject({
    pricing: 'unpriced',
    unpricedTurnCount: 2,
    averageTurnCost: undefined,
    medianTurnCost: undefined,
  })
  const rendered = text(UNPRICED)
  expect(rendered).not.toContain('$0.0000')
  expect(rendered).toContain('total cost  unknown')
  expect(rendered).toContain('no price for this model — its tokens are counted, not its cost')
  expect(rendered).toContain('average cost / turn  unknown')
  expect(rendered).toContain('median unknown')
  expect(rendered).toContain('no price for this model, so no cost to chart')
  // The costliest prompt names its cost unknown too, and the tokens read as before.
  expect(rendered).toMatch(/list the files\s+2 model calls · 3 tools\s+unknown/)
  expect(rendered).toContain('cache miss  3,943')
  expect(rendered).toContain('output  853')
})

// A turn that used no tokens really cost nothing, priced or not: $0, not unknown. And a thread
// that switched models mid-way says the priced part as a floor and names the turns left out.
test('a turn that really cost nothing still shows $0; a partly priced thread shows a floor', () => {
  const nothingUsed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const free: EnsoThreadStats = {
    ...UNPRICED,
    usage: { ...UNPRICED.usage, ...nothingUsed },
    turnStats: UNPRICED.turnStats.map((turn) => ({ ...turn, ...nothingUsed })),
  }
  expect(headlineOf(free, NONE_REFUSED).pricing).toBe('priced')
  expect(text(free)).toContain('total cost  $0.0000')
  expect(text(free)).not.toContain('unknown')

  const [priced, unpriced] = STATS.turnStats
  if (priced === undefined || unpriced === undefined) throw new Error('STATS has a first and a second turn')
  const partly: EnsoThreadStats = {
    ...STATS,
    usage: { ...STATS.usage, cost: 0.2 },
    branchCost: 0.2,
    turnStats: [priced, { ...unpriced, cost: 0 }],
    promptStats: STATS.promptStats.map((prompt) => ({ ...prompt, cost: 0.2 })),
  }
  expect(headlineOf(partly, NONE_REFUSED)).toMatchObject({ pricing: 'partly', unpricedTurnCount: 1 })
  const rendered = text(partly)
  expect(rendered).toContain('total cost  ≥ $0.2000')
  expect(rendered).toContain('1 turn on a model with no price — not in the cost')
  expect(rendered).toContain('average cost / turn  unknown')
  expect(rendered).toMatch(/list the files\s+2 model calls · 3 tools\s+≥ \$0\.2000/)
})

// ⚠ livecraft's rules: a duration ranking lists only what the log timed — an untimed call is not
// the fastest, it is unmeasured — and a failure ranking lists only calls pi marked failed.
test('rankings by duration and by failure leave out calls that have neither', () => {
  expect(rankCalls(CALLS, 'input', NONE_REFUSED).map((ranked) => ranked.toolCallId)).toEqual(['c1', 'c2', 'c3'])
  expect(rankCalls(CALLS, 'duration', NONE_REFUSED).map((ranked) => ranked.toolCallId)).toEqual(['c1', 'c2'])
  expect(rankCalls(CALLS, 'failure', NONE_REFUSED).map((ranked) => ranked.toolCallId)).toEqual(['c2'])
  const tools = toolSummaries(CALLS, NONE_REFUSED)
  expect(tools.find((tool) => tool.toolName === 'read')).toEqual({
    toolName: 'read',
    calls: 2,
    failed: 1,
    exited: 0,
    refused: 0,
    inputChars: 95,
    outputChars: 2115,
    durationMs: 12,
    measured: 1,
  })
  expect(rankTools(tools, 'output').map((tool) => tool.toolName)).toEqual(['read', 'bash'])
  expect(rankTools(toolSummaries([call('c9', 'find')], NONE_REFUSED), 'duration')).toEqual([])
})

// #407: pi hands a guard's refusal over as the same `isError` result a failed command makes. The
// same call, refused by a guard, is policy doing its job — counted apart, never a failure, never
// ranked as one — and the drawer says so beside the failures instead of painting it as danger.
test('⚠ a refused call is counted as refused, not failed: the headline, the tool, the failure ranking, the drawer', () => {
  const c2Refused: RefusedCalls = new Map([['c2', { by: 'guard', rule: 'secret-read' }]])
  expect(headlineOf(STATS, c2Refused)).toMatchObject({ failedToolCalls: 0, refusedToolCalls: 1, failureRate: 0 })
  expect(toolSummaries(CALLS, c2Refused).find((tool) => tool.toolName === 'read')).toMatchObject({
    calls: 2,
    failed: 0,
    refused: 1,
  })
  expect(rankCalls(CALLS, 'failure', c2Refused)).toEqual([])
  const drawer = text(STATS, c2Refused)
  expect(drawer).toContain('1 refused by Enso guard — not failures')
  // Costliest calls tags the row: `refused`, where the same call unmarked reads `failed`.
  expect(drawer).not.toContain('failed')
  expect(text(STATS)).toContain('failed')
  expect(text(STATS)).not.toContain('refused')
})

// #928: the drawer said every refusal was "by a guard" — `auto`'s classifier's too. Each refuser
// is named by its count, in the refusal card's words.
test("⚠ a guard's refusal and auto's classifier's are each named by who refused, never both 'by a guard'", () => {
  const refused: RefusedCalls = new Map([
    ['c1', { by: 'guard', rule: 'network-egress' }],
    ['c2', { by: 'auto' }],
  ])
  expect(headlineOf(STATS, refused)).toMatchObject({
    refusedToolCalls: 2,
    refusedBy: [
      ['guard', 1],
      ['auto', 1],
    ],
  })
  // The static render escapes the apostrophe in "auto's".
  const drawer = text(STATS, refused).replaceAll('&#x27;', "'")
  expect(drawer).toContain("2 refused: 1 by Enso guard, 1 by auto's classifier — not failures")
  expect(drawer).not.toContain('by a guard')
})

// #928: pi marks a command's non-zero exit `isError` — `grep` with no match — the same as a call
// that broke. The thread from #928's acceptance: a `grep` that found nothing, a timed-out command
// and an `edit` that could not apply are 2 failures and 1 non-zero exit; the rate counts the 2.
test('⚠ a non-zero exit is counted apart from the failures: the headline, the rate, the tool, the ranking, the drawer', () => {
  const calls = [
    call('g1', 'bash', { isError: true, exitCode: 1 }),
    call('t1', 'bash', { isError: true }),
    call('e1', 'edit', { isError: true }),
  ]
  const stats: EnsoThreadStats = { ...STATS, callStats: calls }
  expect(headlineOf(stats, NONE_REFUSED)).toMatchObject({
    toolCalls: 3,
    failedToolCalls: 2,
    nonZeroExits: 1,
    failureRate: 2 / 3,
  })
  expect(toolSummaries(calls, NONE_REFUSED).find((tool) => tool.toolName === 'bash')).toMatchObject({
    calls: 2,
    failed: 1,
    exited: 1,
  })
  expect(rankCalls(calls, 'failure', NONE_REFUSED).map((ranked) => ranked.toolCallId)).toEqual(['t1', 'e1'])
  const drawer = text(stats)
  expect(drawer).toContain('2 · 66.7%')
  expect(drawer).toContain('1 exited non-zero — not failures')
  // Costliest calls tags the `grep` with its code, not as failed.
  expect(drawer).toContain('exit 1')
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
