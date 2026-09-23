import { expect, test } from 'bun:test'
import type { EnsoThreadStats } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadStatsView } from '../thread-stats.tsx'

/**
 * #45 phase 2: the stats drawer, as a static render of its pure view — what it says it measured,
 * and what it says it could not.
 */

const NONE = { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 }

const STATS: EnsoThreadStats = {
  threadId: 't1',
  live: true,
  usage: { cost: 0.5, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, context: null },
  branchCost: 0.5,
  turnStats: [
    {
      turn: 1,
      prompt: 1,
      model: 'claude-test',
      cost: 0.5,
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      toolCalls: 3,
      stopReason: 'stop',
    },
  ],
  promptStats: [{ prompt: 1, text: 'list the files', turnCount: 1, cost: 0.5, toolCalls: 3, failedToolCalls: 1 }],
  toolStats: [
    {
      toolName: 'bash',
      calls: 3,
      failures: 1,
      inputChars: 30,
      outputChars: 300,
      durations: { count: 2, minMs: 100, maxMs: 400, meanMs: 250, totalMs: 500 },
    },
  ],
  latency: { prompts: NONE, firstDelta: NONE },
  logDays: ['2026-09-22'],
}

const text = (stats: EnsoThreadStats): string =>
  renderToStaticMarkup(<ThreadStatsView outcome={{ kind: 'read', stats }} />).replace(/<[^>]*>/g, ' ')

// ⚠ pi's total is the cost; what the branch accounts for is beside it, and a difference is NAMED —
// never spread over the turns, and never shown when there is none.
test("spend off the branch is its own line, present only when pi's total exceeds what the branch accounts for", () => {
  expect(text(STATS)).not.toContain('off this branch')
  const compacted = text({ ...STATS, usage: { ...STATS.usage, cost: 0.75 } })
  expect(compacted).toContain('off this branch')
  expect(compacted).toContain('$0.2500')
})

// The log keeps 14 days and a resumed thread's older calls were never timed here: a duration says
// how many calls it covers, and what the log does not have is said, not drawn as a zero.
test("a tool's duration says how many of its calls were timed; latency the log lacks is said as such", () => {
  const rendered = text(STATS)
  expect(rendered).toContain('2/3')
  expect(rendered).toContain('250')
  expect(rendered).toContain('not in the log')
  expect(rendered).toContain('1 of 3 (33%)')
})

test('a branch with no turn says what it is waiting for instead of drawing empty charts', () => {
  const rendered = text({ ...STATS, turnStats: [], promptStats: [], toolStats: [], branchCost: 0 })
  expect(rendered).toContain('no model request on this branch yet')
  expect(rendered).toContain('no tool called on this branch yet')
})
