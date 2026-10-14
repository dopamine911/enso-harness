import { afterEach, expect, test } from 'bun:test'
import type { EnsoThreadTurn, EnsoTurnBaseline, EnsoTurnSnapshot } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadStoresContext } from '../store.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'
import { pairText, type PromptRunsOutcome, ThreadTurnDiffsView, turnPairOf } from '../thread-turn-diffs.tsx'

/**
 * #553: the Diff Viewer never draws a diff it has no two snapshots for — an idle turn, a missing
 * snapshot and a result not yet captured are each said as what they are — and says which two
 * snapshots a diff compares, a fork's inherited one by name.
 */

afterEach(() => clearThreadsForTest())

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const taken = (hash: string): EnsoTurnSnapshot => ({ kind: 'taken', hash })
const turn = (number: number, start: EnsoTurnSnapshot, end: EnsoTurnSnapshot, idle = false): EnsoThreadTurn => ({
  turn: number,
  prompt: number,
  entryId: `u${number}`,
  text: `prompt ${number}`,
  start,
  end,
  idle,
  restored: false,
})
const TREE: EnsoTurnBaseline = { kind: 'tree', snapshot: taken(A), fork: null }
const FORK: EnsoTurnBaseline = {
  kind: 'tree',
  snapshot: taken(A),
  fork: { parentThreadId: 'source-thread', inheritedPrompts: 2 },
}

test('⚠ a turn compares its own two snapshots per turn, and the baseline to its result cumulatively; with no pair it says why', () => {
  const edited = turn(2, taken(B), taken(C))
  expect(turnPairOf(edited, TREE, 'turn')).toEqual({ kind: 'pair', from: B, to: C })
  expect(turnPairOf(edited, TREE, 'cumulative')).toEqual({ kind: 'pair', from: A, to: C })
  expect(turnPairOf(turn(1, taken(A), taken(A), true), TREE, 'turn')).toEqual({ kind: 'idle' })
  const missing = (
    start: EnsoTurnSnapshot,
    end: EnsoTurnSnapshot,
    baseline: EnsoTurnBaseline = TREE,
    mode: 'turn' | 'cumulative' = 'turn',
  ): string => {
    const pair = turnPairOf(turn(1, start, end), baseline, mode)
    return pair.kind === 'missing' ? pair.why : `not missing: ${pair.kind}`
  }
  expect(missing(taken(A), { kind: 'pending' })).toContain('not captured yet')
  expect(missing({ kind: 'failed' }, taken(B))).toContain('none could be taken')
  expect(missing({ kind: 'unrecorded' }, taken(B))).toContain('before snapshots were taken')
  expect(missing(taken(A), { kind: 'unavailable', hash: B, reason: 'gone' })).toContain('cannot be read: gone')
  expect(missing(taken(A), taken(B), { kind: 'none' }, 'cumulative')).toContain('No baseline')
  expect(missing(taken(A), taken(B), { kind: 'first-snapshot', snapshot: { kind: 'failed' } }, 'cumulative')).toContain(
    'No baseline',
  )
})

test("⚠ the compared snapshots are named: a fork's first turn and its cumulative view start from what it inherited", () => {
  const first = turn(1, taken(A), taken(B))
  expect(pairText(first, FORK, turnPairOf(first, FORK, 'turn'), 'turn')).toBe(
    'the snapshot this fork inherited from thread source-t after 2 prompts (aaaaaaaa) → the files after turn 1 (bbbbbbbb)',
  )
  const second = turn(2, taken(B), taken(C))
  expect(pairText(second, FORK, turnPairOf(second, FORK, 'turn'), 'turn')).toBe(
    'the files as turn 2 began (bbbbbbbb) → the files after turn 2 (cccccccc)',
  )
  expect(pairText(second, TREE, turnPairOf(second, TREE, 'cumulative'), 'cumulative')).toContain(
    "the snapshot this thread's tree was made from (aaaaaaaa)",
  )
  const checkout: EnsoTurnBaseline = { kind: 'first-snapshot', snapshot: taken(A) }
  expect(pairText(second, checkout, turnPairOf(second, checkout, 'cumulative'), 'cumulative')).toContain(
    "the thread's first snapshot (aaaaaaaa)",
  )
})

const render = (outcome: PromptRunsOutcome): string =>
  renderToStaticMarkup(
    <ThreadStoresContext.Provider value={mintThread(() => new Promise<Response>(() => undefined))}>
      <ThreadTurnDiffsView outcome={outcome} onShowInChat={() => Promise.resolve(true)} />
    </ThreadStoresContext.Provider>,
  )
const read = (prompts: EnsoThreadTurn[], baseline: EnsoTurnBaseline = TREE): PromptRunsOutcome => ({
  kind: 'read',
  payload: { threadId: 't', baseline, prompts },
})

test('the view opens on the last turn whose result is captured, marks every turn, and draws no diff for an idle one', () => {
  const markup = render(read([turn(1, taken(A), taken(A), true), turn(2, taken(A), { kind: 'pending' })]))
  expect(markup).toContain('Turn 1 of 2')
  expect(markup).toContain('No files changed in this turn')
  expect(markup).toContain('no file changes')
  expect(markup).toContain('result not captured yet')
  expect(markup).toContain('Show in Chat')
  const missing = render(read([turn(1, { kind: 'failed' }, taken(B)), turn(2, taken(B), taken(C))]))
  expect(missing).toContain('snapshot missing')
  expect(missing).toContain('reading the snapshots')
})

test('every other state is said as what it is', () => {
  expect(render({ kind: 'reading' })).toContain('reading the prompts')
  expect(render({ kind: 'none' })).toContain('Nothing has run in this thread yet')
  expect(render({ kind: 'failed', problem: 'boom' })).toContain('could not be read: boom')
  expect(render(read([], FORK))).toContain('the snapshot this fork inherited from thread source-t')
  expect(render(read([], { kind: 'none' }))).toContain('no baseline snapshot')
})
