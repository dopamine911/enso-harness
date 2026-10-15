import { afterEach, expect, test } from 'bun:test'
import type { EnsoPromptRun, EnsoPromptRunBaseline, EnsoPromptRunSnapshot, EnsoThreadChangedFile } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { readChangedFile } from '../changed-file.ts'
import { ThreadStoresContext } from '../store.ts'
import {
  pairText,
  promptRunPairOf,
  type PromptRunDiffMode,
  type PromptRunsOutcome,
  ThreadPromptRunDiffsView,
} from '../thread-prompt-run-diffs.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'

/**
 * #553: the Diff Viewer never draws a diff it has no two snapshots for — an idle prompt run, a
 * missing snapshot and a result not yet captured are each said as what they are — and says which
 * two snapshots a diff compares, a fork's inherited one by name.
 */

afterEach(() => clearThreadsForTest())

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const taken = (hash: string): EnsoPromptRunSnapshot => ({ kind: 'taken', hash })
const promptRunOf = (
  number: number,
  start: EnsoPromptRunSnapshot,
  end: EnsoPromptRunSnapshot,
  idle = false,
): EnsoPromptRun => ({
  promptRun: number,
  prompt: number,
  entryId: `u${number}`,
  text: `prompt ${number}`,
  start,
  end,
  idle,
  restored: false,
})
const TREE: EnsoPromptRunBaseline = { kind: 'tree', snapshot: taken(A), fork: null }
const FORK: EnsoPromptRunBaseline = {
  kind: 'tree',
  snapshot: taken(A),
  fork: { parentThreadId: 'source-thread', inheritedPrompts: 2 },
}

/** Why `promptRunPairOf` shows no diff, or what it shows instead. */
const missing = (
  start: EnsoPromptRunSnapshot,
  end: EnsoPromptRunSnapshot,
  baseline: EnsoPromptRunBaseline = TREE,
  mode: PromptRunDiffMode = 'prompt-run',
): string => {
  const pair = promptRunPairOf(promptRunOf(1, start, end), baseline, mode)
  return pair.kind === 'missing' ? pair.why : `not missing: ${pair.kind}`
}

test('⚠ a prompt run compares its own two snapshots, and the baseline to its result cumulatively; with no pair it says why', () => {
  const edited = promptRunOf(2, taken(B), taken(C))
  expect(promptRunPairOf(edited, TREE, 'prompt-run')).toEqual({ kind: 'pair', from: B, to: C })
  expect(promptRunPairOf(edited, TREE, 'cumulative')).toEqual({ kind: 'pair', from: A, to: C })
  expect(promptRunPairOf(promptRunOf(1, taken(A), taken(A), true), TREE, 'prompt-run')).toEqual({ kind: 'idle' })
  expect(missing(taken(A), { kind: 'pending' })).toBe(
    "This prompt's result is not captured yet: the files are snapshotted when the next prompt's run begins.",
  )
  expect(missing({ kind: 'failed' }, taken(B))).toBe(
    'No snapshot of the files as this prompt began: the run recorded that none could be taken.',
  )
  expect(missing({ kind: 'unrecorded' }, taken(B))).toBe(
    'No snapshot of the files as this prompt began is recorded: the thread ran before snapshots were taken.',
  )
  expect(missing(taken(A), { kind: 'unavailable', hash: B, reason: 'gone' })).toBe(
    'The snapshot after this prompt (bbbbbbbb) cannot be read: gone',
  )
  expect(missing(taken(A), taken(B), { kind: 'none' }, 'cumulative')).toBe(
    'No baseline: the thread records no snapshot to compare its prompts with.',
  )
  expect(missing(taken(A), taken(B), { kind: 'first-snapshot', snapshot: { kind: 'failed' } }, 'cumulative')).toBe(
    'No baseline: No snapshot of the baseline: the run recorded that none could be taken.',
  )
})

// The bug the #985 review found: an unreadable baseline was said as "the snapshot as this turn
// began", blaming the prompt run's own start, which may be fine.
test('⚠ cumulatively, an unreadable baseline is said as the baseline, never as the prompt run’s own start', () => {
  const unreadable: EnsoPromptRunBaseline = {
    kind: 'tree',
    snapshot: { kind: 'unavailable', hash: A, reason: 'the store lost it' },
    fork: null,
  }
  expect(missing(taken(B), taken(C), unreadable, 'cumulative')).toBe(
    'No baseline: The baseline snapshot (aaaaaaaa) cannot be read: the store lost it',
  )
  // The prompt run's own diff does not need the baseline: it still compares its two snapshots.
  expect(promptRunPairOf(promptRunOf(1, taken(B), taken(C)), unreadable, 'prompt-run')).toEqual({
    kind: 'pair',
    from: B,
    to: C,
  })
})

test("⚠ the compared snapshots are named: a fork's first prompt run and its cumulative view start from what it inherited", () => {
  const first = promptRunOf(1, taken(A), taken(B))
  expect(pairText(first, FORK, promptRunPairOf(first, FORK, 'prompt-run'), 'prompt-run')).toBe(
    'the snapshot this fork inherited from thread source-t after 2 prompts (aaaaaaaa) → the files after prompt 1 (bbbbbbbb)',
  )
  const second = promptRunOf(2, taken(B), taken(C))
  expect(pairText(second, FORK, promptRunPairOf(second, FORK, 'prompt-run'), 'prompt-run')).toBe(
    'the files as prompt 2 began (bbbbbbbb) → the files after prompt 2 (cccccccc)',
  )
  expect(pairText(second, TREE, promptRunPairOf(second, TREE, 'cumulative'), 'cumulative')).toBe(
    "the snapshot this thread's tree was made from (aaaaaaaa) → the files after prompt 2 (cccccccc)",
  )
  const checkout: EnsoPromptRunBaseline = { kind: 'first-snapshot', snapshot: taken(A) }
  expect(pairText(second, checkout, promptRunPairOf(second, checkout, 'cumulative'), 'cumulative')).toBe(
    "the thread's first snapshot (aaaaaaaa) → the files after prompt 2 (cccccccc)",
  )
})

test('a file is read at the pair it was diffed between: `…/prompt-runs/file?from&to&path[&oldPath]`, not the live tree', async () => {
  const asked: string[] = []
  const file: EnsoThreadChangedFile = {
    threadId: 't 1',
    path: 'src/new.ts',
    oldPath: 'src/old.ts',
    oldText: { kind: 'text', text: 'one\n' },
    newText: { kind: 'text', text: 'two\n' },
  }
  const fetchImpl = (input: string): Promise<Response> => {
    asked.push(input)
    return Promise.resolve(Response.json(file))
  }
  const change = { path: 'src/new.ts', oldPath: 'src/old.ts' }
  expect(await readChangedFile('t 1', change, fetchImpl, { from: A, to: B })).toEqual({ kind: 'read', file })
  // Without a pair, the Diff tab's own route: the file now against the last push.
  await readChangedFile('t 1', { path: 'src/new.ts', oldPath: null }, fetchImpl)
  expect(asked).toEqual([
    `/api/threads/t%201/prompt-runs/file?from=${A}&to=${B}&path=src%2Fnew.ts&oldPath=src%2Fold.ts`,
    '/api/threads/t%201/changes/file?path=src%2Fnew.ts',
  ])
})

const render = (outcome: PromptRunsOutcome): string =>
  renderToStaticMarkup(
    <ThreadStoresContext.Provider value={mintThread(() => new Promise<Response>(() => undefined))}>
      <ThreadPromptRunDiffsView outcome={outcome} onShowInChat={() => Promise.resolve(true)} />
    </ThreadStoresContext.Provider>,
  )
const read = (promptRuns: EnsoPromptRun[], baseline: EnsoPromptRunBaseline = TREE): PromptRunsOutcome => ({
  kind: 'read',
  payload: { threadId: 't', baseline, promptRuns },
})

test('the view opens on the last prompt run whose result is captured, marks every one, and draws no diff for an idle one', () => {
  const markup = render(read([promptRunOf(1, taken(A), taken(A), true), promptRunOf(2, taken(A), { kind: 'pending' })]))
  expect(markup).toContain('Prompt 1 of 2')
  expect(markup).toContain('No files changed under this prompt')
  expect(markup).toContain('no file changes')
  expect(markup).toContain('result not captured yet')
  expect(markup).toContain('Show in Chat')
  const missingMarkup = render(read([promptRunOf(1, { kind: 'failed' }, taken(B)), promptRunOf(2, taken(B), taken(C))]))
  expect(missingMarkup).toContain('snapshot missing')
  expect(missingMarkup).toContain('reading the snapshots')
})

test('every other state is said as what it is', () => {
  expect(render({ kind: 'reading' })).toContain('reading the prompts')
  expect(render({ kind: 'none' })).toContain('Nothing has run in this thread yet')
  expect(render({ kind: 'failed', problem: 'boom' })).toContain('could not be read: boom')
  expect(render(read([], FORK))).toContain('the snapshot this fork inherited from thread source-t')
  expect(render(read([], { kind: 'none' }))).toContain('no baseline snapshot')
})
