import { expect, test } from 'bun:test'
import {
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_SETUP_ENTRY,
  type EnsoTranscriptEntry,
  type EnsoTreeSetupOutcome,
} from '@enso/core'
import { treeSetupOf } from '../tree-setup.ts'

/** What a branch says its tree's setup did (#754): the record after its last tree record. */

const OUTCOME: EnsoTreeSetupOutcome = {
  ok: true,
  copied: ['.env'],
  missing: [],
  steps: [{ command: 'bun install', exitCode: 0, durationMs: 12, output: 'done\n', truncated: false }],
  tiers: { setup: 'shared', copy: 'local' },
}

const custom = (id: string, customType: string, data: unknown): EnsoTranscriptEntry => ({
  kind: 'custom',
  id,
  customType,
  data,
})

const TREE = { kind: 'worktree', project: '/work/app', path: '/trees/a', branch: 'enso/a', base: 'a'.repeat(40) }

test("the setup recorded after the tree is the thread's", () => {
  expect(treeSetupOf([custom('t', ENSO_THREAD_TREE_ENTRY, TREE), custom('s', ENSO_TREE_SETUP_ENTRY, OUTCOME)])).toEqual(
    OUTCOME,
  )
})

// ⚠ A fork's branch holds its source's records before its own: a fork whose tree had nothing to set
// up must not show its source's setup as its own.
test("⚠ a fork's own tree with no setup of its own has none, whatever its source's branch recorded", () => {
  const forked = [
    custom('t1', ENSO_THREAD_TREE_ENTRY, TREE),
    custom('s1', ENSO_TREE_SETUP_ENTRY, OUTCOME),
    custom('t2', ENSO_THREAD_TREE_ENTRY, { ...TREE, path: '/trees/b' }),
  ]
  expect(treeSetupOf(forked)).toBeUndefined()
})

test('a record that does not read is no setup, and a thread with no tree has none', () => {
  expect(
    treeSetupOf([custom('t', ENSO_THREAD_TREE_ENTRY, TREE), custom('s', ENSO_TREE_SETUP_ENTRY, { ok: 'yes' })]),
  ).toBeUndefined()
  expect(treeSetupOf([])).toBeUndefined()
})
