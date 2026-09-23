import { expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { growsSessionSpend } from '../session-usage.ts'

/**
 * #45: which session events make the host re-read pi's totals. The live order (`message_end`
 * reads one request short, `turn_end` does not) is pinned against a real turn in
 * `agent-host.test.ts`; this pins the set — in particular the cache warmer's between-runs
 * spend, which arrives as nothing but an appended `usage` entry. The warmer itself is driven by
 * its own timers and probabilities, so its event is built here rather than provoked.
 */

/** One event, typed as pi hands it to a listener — only the fields the predicate reads are real. */
const event = (shape: Record<string, unknown>): AgentSessionEvent => shape as unknown as AgentSessionEvent

test('the turn, the run and a compaction are spend boundaries; a message ending is not', () => {
  expect(growsSessionSpend(event({ type: 'turn_end', message: {}, toolResults: [] }))).toBe(true)
  expect(growsSessionSpend(event({ type: 'agent_end', messages: [] }))).toBe(true)
  expect(growsSessionSpend(event({ type: 'compaction_end', reason: 'manual' }))).toBe(true)
  expect(growsSessionSpend(event({ type: 'message_end', message: { role: 'assistant' } }))).toBe(false)
})

// PR #357 review: in pi's `idle` warming mode the warm lands BETWEEN runs — no turn follows it.
test("⚠ an appended usage entry (pi's cache warmer) is a spend boundary; any other entry is not", () => {
  expect(growsSessionSpend(event({ type: 'entry_appended', entry: { type: 'usage', kind: 'cache_warm' } }))).toBe(true)
  expect(growsSessionSpend(event({ type: 'entry_appended', entry: { type: 'custom', customType: 'modes' } }))).toBe(
    false,
  )
})
