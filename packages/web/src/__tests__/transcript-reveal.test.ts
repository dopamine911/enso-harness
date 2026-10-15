import { afterAll, expect, test } from 'bun:test'
import type { EnsoPromptStats, EnsoThreadStats, EnsoToolCallStats, EnsoTurnStats } from '@enso/core'
import { locateStatsTarget, promptBubbleIndex } from '../transcript-reveal.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * #359: a stats target → the transcript row it names. The transcript on screen is not the branch
 * row for row (a live attempt refused before its first token draws no bubble; a prompt another tab
 * queued has none), so these pin the rules that find a row in either shape, and that a row which is
 * not there is not guessed at.
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
  const long = 'word '.repeat(30).trim()
  const truncated = [prompt(1, `${long.slice(0, 119)}…`)]
  expect(promptBubbleIndex(['queued elsewhere', long], truncated, 1)).toBe(1)
})

// PR #360 review: a whole prompt text must read as the WHOLE bubble — as a prefix, `hi` also
// matched the `hi there` bubble drawn before it. Only a truncated text (`…`) is a prefix.
test('an untruncated prompt matches its whole bubble, not a longer one it starts; an image marker is not text', () => {
  const prompts = [prompt(1, 'hi there'), prompt(2, 'hi'), prompt(3, '[image content]what is this')]
  const bubbles = ['held, not yet sent', 'hi there', 'hi', 'what is this']
  expect(promptBubbleIndex(bubbles, prompts, 2)).toBe(2)
  expect(promptBubbleIndex(bubbles, prompts, 3)).toBe(3)
  expect(promptBubbleIndex(['held, not yet sent', 'hi there'], [prompt(1, 'hi')], 1)).toBeUndefined()
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

/** One bubble per pi message — what a reload draws and, since #921, a live run. */
function liveTranscript(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-role="user">list the files</div>
    <div data-role="assistant" id="turn-1">
      <details data-tool-call-id="toolu_01|fc_9"><summary>bash</summary></details>
    </div>
    <div data-role="assistant" id="turn-2">three files</div>
    <div data-role="user">now count them</div>
    <div data-role="assistant" id="turn-3">3</div>`
  return root
}

test('a call by its id — an id with CSS-special characters included — and a turn by its first call', () => {
  const root = liveTranscript()
  const row = root.querySelector('details')
  expect(locateStatsTarget(root, STATS, { kind: 'tool-call', toolCallId: 'toolu_01|fc_9' })).toBe(row ?? undefined)
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 1 })).toBe(row ?? undefined)
})

test('a turn with no call is its own bubble, at its place among its prompt’s model calls', () => {
  const root = liveTranscript()
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 2 })?.id).toBe('turn-2')
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 3 })?.id).toBe('turn-3')
  expect(locateStatsTarget(root, STATS, { kind: 'prompt', prompt: 2 })?.textContent).toBe('now count them')
})

test('a target the transcript does not draw is undefined, not the nearest row', () => {
  const root = liveTranscript()
  expect(locateStatsTarget(root, STATS, { kind: 'tool-call', toolCallId: 'compacted-away' })).toBeUndefined()
  expect(locateStatsTarget(root, STATS, { kind: 'turn', turn: 9 })).toBeUndefined()
})

// PR #360 review: a failed turn pi retries stays on the branch with no call (`_prepareRetry`
// keeps it in raw history), and the retry follows under the SAME prompt. Resumed, each has its
// own bubble, and the error turn must land on its own — the one a reader goes looking for. Live,
// an attempt refused before its first token draws nothing (PR #986 review): it is no row, and the
// retry is still its own.
test('a retried error turn lands on its own bubble; live, where it drew none, it is no row and the retry is still found', () => {
  const retried: EnsoThreadStats = {
    ...STATS,
    turnStats: [{ ...turn(1, 1), stopReason: 'error' }, turn(2, 1)],
    promptStats: [prompt(1, 'list the files')],
    callStats: [],
  }
  const resumed = document.createElement('div')
  resumed.innerHTML = `
    <div data-role="user">list the files</div>
    <div data-role="assistant" id="failed"></div>
    <div data-role="assistant" id="retry">three files</div>`
  expect(locateStatsTarget(resumed, retried, { kind: 'turn', turn: 1 })?.id).toBe('failed')
  expect(locateStatsTarget(resumed, retried, { kind: 'turn', turn: 2 })?.id).toBe('retry')
  const live = document.createElement('div')
  live.innerHTML = `
    <div data-role="user">list the files</div>
    <div data-role="assistant" id="retry">three files</div>`
  expect(locateStatsTarget(live, retried, { kind: 'turn', turn: 1 })).toBeUndefined()
  expect(locateStatsTarget(live, retried, { kind: 'turn', turn: 2 })?.id).toBe('retry')
})

// PR #986 review: a missing bubble no unfinished turn accounts for is not guessed at — before,
// every turn of the prompt landed on its last bubble, an early one included.
test('fewer bubbles than finished model calls: no turn is found, not the last bubble', () => {
  const root = document.createElement('div')
  root.innerHTML = `
    <div data-role="user">list the files</div>
    <div data-role="assistant" id="only">three files</div>`
  const noCalls: EnsoThreadStats = { ...STATS, callStats: [] }
  expect(locateStatsTarget(root, noCalls, { kind: 'turn', turn: 1 })).toBeUndefined()
  expect(locateStatsTarget(root, noCalls, { kind: 'turn', turn: 2 })).toBeUndefined()
})
