import { afterAll, expect, test } from 'bun:test'
import type { EnsoPromptStats, EnsoThreadStats, EnsoToolCallStats, EnsoTurnStats } from '@enso/core'
import { locateStatsTarget, promptBubbleIndex } from '../transcript-reveal.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * #359: a stats target → the transcript row it names. The transcript on screen is not the branch
 * row for row (a live run is ONE assistant bubble; a prompt another tab queued has no bubble), so
 * these pin the rules that find a row in either shape, and that a row which is not there is not
 * guessed at.
 */

ensureDom()
afterAll(releaseDom)

const prompt = (number: number, text: string): EnsoPromptStats => ({
  prompt: number,
  text,
  turnCount: 1,
  cost: 0,
  toolCalls: 0,
  failedToolCalls: 0,
})

test('equal counts: the bubbles ARE the prompts, in order — whatever the text says', () => {
  const prompts = [prompt(1, 'first'), prompt(2, 'second')]
  expect(promptBubbleIndex(['markdown mangled it', 'unrelated'], prompts, 2)).toBe(1)
})

test('unequal counts: found by text, markdown and truncation aside, the n-th of a repeated prompt', () => {
  // The branch has three prompts; the view shows four bubbles (a prompt this tab still holds).
  const prompts = [prompt(1, 'continue'), prompt(2, 'fix **the** `build`'), prompt(3, 'continue')]
  const bubbles = ['continue', 'fix the build', 'held, not yet sent', 'continue']
  expect(promptBubbleIndex(bubbles, prompts, 2)).toBe(1)
  expect(promptBubbleIndex(bubbles, prompts, 3)).toBe(3)
  const long = `${'word '.repeat(30)}`.trim()
  const truncated = [prompt(1, `${long.slice(0, 119)}…`)]
  expect(promptBubbleIndex(['queued elsewhere', long], truncated, 1)).toBe(1)
})

test('a prompt no bubble reads as — a queued one another tab sent — is not found, never guessed', () => {
  const prompts = [prompt(1, 'first'), prompt(2, 'sent from the other tab')]
  expect(promptBubbleIndex(['first'], prompts, 2)).toBeUndefined()
  expect(promptBubbleIndex(['first'], prompts, 7)).toBeUndefined()
})

const turn = (number: number, promptNumber: number): EnsoTurnStats => ({
  turn: number,
  prompt: promptNumber,
  model: 'm',
  cost: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  toolCalls: 0,
  stopReason: 'stop',
})

const call = (toolCallId: string, turnNumber: number): EnsoToolCallStats => ({
  toolCallId,
  toolName: 'bash',
  turn: turnNumber,
  prompt: 1,
  inputChars: 0,
  outputChars: 0,
  isError: false,
  pending: false,
})

const NONE = { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 }

/** Two prompts; turn 1 calls a tool, turn 2 answers prompt 1, turn 3 answers prompt 2. */
const STATS: EnsoThreadStats = {
  threadId: 't1',
  live: true,
  usage: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null },
  branchCost: 0,
  turnStats: [turn(1, 1), turn(2, 1), turn(3, 2)],
  promptStats: [prompt(1, 'list the files'), prompt(2, 'now count them')],
  callStats: [call('toolu_01|fc_9', 1)],
  latency: { prompts: NONE, firstDelta: NONE },
  logDays: [],
}

/** The shape a LIVE run draws: one assistant bubble per prompt, every turn inside it. */
function liveTranscript(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-role="user">list the files</div>
    <div data-role="assistant" id="reply-1">
      <details data-tool-call-id="toolu_01|fc_9"><summary>bash</summary></details>
      three files
    </div>
    <div data-role="user">now count them</div>
    <div data-role="assistant" id="reply-2">3</div>`
  return root
}

test('a call by its id — an id with CSS-special characters included — and a turn by its first call', () => {
  const root = liveTranscript()
  const row = root.querySelector('details')
  expect(locateStatsTarget(root, STATS, { kind: 'tool-call', toolCallId: 'toolu_01|fc_9' })).toBe(row ?? undefined)
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 1 })).toBe(row ?? undefined)
})

test("a turn with no call is its prompt's reply: the last assistant bubble before the next prompt", () => {
  const root = liveTranscript()
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 2 })?.id).toBe('reply-1')
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 3 })?.id).toBe('reply-2')
  expect(locateStatsTarget(root, STATS, { kind: 'prompt', prompt: 2 })?.textContent).toBe('now count them')
})

test('a target the transcript does not draw is undefined, not the nearest row', () => {
  const root = liveTranscript()
  expect(locateStatsTarget(root, STATS, { kind: 'tool-call', toolCallId: 'compacted-away' })).toBeUndefined()
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 9 })).toBeUndefined()
})
