import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ENSO_RUN_CONTEXT_ENTRY,
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_RESTORED_ENTRY,
  type EnsoTranscriptEntry,
  type ThreadTreeRecord,
} from '@enso/core'
import { openSnapshotStore } from '@enso/core/snapshot-store'
import type { ThreadLog } from '../thread-log.ts'
import { recordedPromptRunsOf, snapshotHashesOf, withStoreTrees } from '../thread-prompt-runs.ts'
import { createThreadTurnReads } from '../thread-turn-reads.ts'

/**
 * The Diff Viewer's prompts (#553), off a branch: which two snapshots each turn compares, what a fork
 * compares with, and which prompts have nothing to compare — never a diff made up for them.
 */

const runContext = (id: string, snapshot: { hash: string } | null | undefined): EnsoTranscriptEntry => ({
  kind: 'custom',
  id,
  customType: ENSO_RUN_CONTEXT_ENTRY,
  data: {
    git: null,
    config: { hash: 'c'.repeat(64), sources: [] },
    skills: [],
    contextFiles: [],
    mode: null,
    ...(snapshot === undefined ? {} : { snapshot }),
  },
})
const user = (id: string): EnsoTranscriptEntry => ({
  kind: 'message',
  id,
  role: 'user',
  parts: [{ type: 'text', text: id }],
})
const reply = (id: string): EnsoTranscriptEntry => ({ kind: 'message', id, role: 'assistant', parts: [] })
const tree = (id: string, base: string): EnsoTranscriptEntry => {
  const record: ThreadTreeRecord = { kind: 'worktree', project: '/p', path: '/t', branch: 'enso/t', base }
  return { kind: 'custom', id, customType: ENSO_THREAD_TREE_ENTRY, data: record }
}
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

test("⚠ a turn compares the snapshot its run began with to the one the next run began with; an unchanged run writes no record, and the last turn's result is pending", () => {
  const recorded = recordedPromptRunsOf(
    't',
    [
      tree('tree', A),
      runContext('rc1', { hash: A }),
      user('u1'),
      reply('r1'),
      runContext('rc2', { hash: B }),
      user('u2'),
      reply('r2'),
      user('u3'),
      reply('r3'),
    ],
    undefined,
  )
  expect(recorded.baseline).toEqual({ kind: 'tree', snapshot: { kind: 'taken', hash: A }, fork: null })
  expect(recorded.prompts.map((turn) => [turn.turn, turn.prompt, turn.entryId, turn.start, turn.end])).toEqual([
    [1, 1, 'u1', { kind: 'taken', hash: A }, { kind: 'taken', hash: B }],
    // u3's run changed nothing, so wrote no record: it began with B, as u2's result.
    [2, 2, 'u2', { kind: 'taken', hash: B }, { kind: 'taken', hash: B }],
    [3, 3, 'u3', { kind: 'taken', hash: B }, { kind: 'pending' }],
  ])
  const trees = new Map([
    [A, 'tree-a'],
    [B, 'tree-b'],
  ])
  const prompts = withStoreTrees(recorded, trees, undefined).prompts
  expect(prompts.map((turn) => turn.idle)).toEqual([false, true, false])
})

test('⚠ a missing snapshot is said as what it is — failed, unrecorded, or one the store does not hold — never idle and never compared', () => {
  const recorded = recordedPromptRunsOf(
    't',
    [
      runContext('old', undefined),
      user('u1'),
      runContext('rc2', null),
      user('u2'),
      runContext('rc3', { hash: C }),
      user('u3'),
      runContext('rc4', { hash: D }),
      user('u4'),
    ],
    undefined,
  )
  // A thread in its checkout: the first snapshot it records is its baseline.
  expect(recorded.baseline).toEqual({ kind: 'first-snapshot', snapshot: { kind: 'taken', hash: C } })
  const prompts = withStoreTrees(recorded, new Map([[D, 'tree-d']]), undefined).prompts
  expect(prompts.map((turn) => [turn.start.kind, turn.end.kind, turn.idle])).toEqual([
    ['unrecorded', 'failed', false],
    ['failed', 'unavailable', false],
    ['unavailable', 'taken', false],
    ['taken', 'pending', false],
  ])
  expect(snapshotHashesOf(recorded).toSorted()).toEqual([C, D])
})

test("⚠ a fork's prompts are its own: the source's prompts before its tree record are not prompts, its baseline is the snapshot it inherited, and Chat's prompt numbers still count them", () => {
  const recorded = recordedPromptRunsOf(
    'fork',
    [
      tree('source-tree', A),
      runContext('rc1', { hash: A }),
      user('s1'),
      runContext('rc2', { hash: B }),
      user('s2'),
      tree('fork-tree', B),
      user('f1'),
      runContext('rc3', { hash: C }),
      user('f2'),
    ],
    'source',
  )
  expect(recorded.baseline).toEqual({
    kind: 'tree',
    snapshot: { kind: 'taken', hash: B },
    fork: { parentThreadId: 'source', inheritedPrompts: 2 },
  })
  expect(recorded.prompts.map((turn) => [turn.turn, turn.prompt, turn.entryId, turn.start, turn.end])).toEqual([
    [1, 3, 'f1', { kind: 'taken', hash: B }, { kind: 'taken', hash: C }],
    [2, 4, 'f2', { kind: 'taken', hash: C }, { kind: 'pending' }],
  ])
})

test('a restore inside a turn is marked on that turn alone', () => {
  const restored: EnsoTranscriptEntry = {
    kind: 'custom',
    id: 'restore',
    customType: ENSO_TREE_RESTORED_ENTRY,
    data: { hash: A, safety: B },
  }
  const recorded = recordedPromptRunsOf(
    't',
    [runContext('rc', { hash: A }), user('u1'), restored, user('u2')],
    undefined,
  )
  expect(recorded.prompts.map((turn) => turn.restored)).toEqual([true, false])
})

/** A checkout of one file, one commit, under an environment that names no repository of its own. */
function checkoutAndEnvironment(): { readonly tree: string; readonly environment: NodeJS.ProcessEnv } {
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(Bun.which('git') ?? '/usr/bin/git'),
    HOME: mkdtempSync(join(tmpdir(), 'enso-prompts-home-')),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const tree = mkdtempSync(join(tmpdir(), 'enso-prompts-tree-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: tree,
      env: environment,
    })
  }
  git('init', '--quiet')
  writeFileSync(join(tree, 'a.txt'), 'one\n')
  git('add', '--all')
  git('commit', '--quiet', '-m', 'one')
  return { tree, environment }
}

test("⚠ two snapshots are compared only when the thread's prompts record both: any other commit is refused, unread (#553)", async () => {
  const { tree, environment } = checkoutAndEnvironment()
  const directory = join(mkdtempSync(join(tmpdir(), 'enso-prompts-store-')), 'store')
  const store = await openSnapshotStore({ directory, tree, environment })
  if (store === undefined) throw new Error('the store did not open')
  const hashOf = async (): Promise<string> => {
    const outcome = await store.snapshot()
    if (outcome.kind !== 'taken') throw new Error(outcome.refused.stderr)
    return outcome.taken.hash
  }
  const first = await hashOf()
  writeFileSync(join(tree, 'a.txt'), 'two\n')
  const second = await hashOf()
  writeFileSync(join(tree, 'a.txt'), 'three\n')
  const unrecorded = await hashOf()
  const transcript = [runContext('rc1', { hash: first }), user('u1'), runContext('rc2', { hash: second }), user('u2')]
  const reads = createThreadTurnReads({
    environment,
    liveLogs: new Map([['t', { cwd: tree, transcript: () => transcript } as unknown as ThreadLog]]),
    storedSession: () => Promise.resolve(undefined),
    storeOf: () => directory,
  })

  const prompts = await reads.threadPromptRuns('t')
  expect(prompts?.prompts.map((turn) => [turn.start, turn.end, turn.idle])).toEqual([
    [{ kind: 'taken', hash: first }, { kind: 'taken', hash: second }, false],
    [{ kind: 'taken', hash: second }, { kind: 'pending' }, false],
  ])
  const read = await reads.readTurnChanges('t', first, second)
  expect(read.kind === 'read' ? read.read.files.map((file) => [file.path, file.status]) : read).toEqual([
    ['a.txt', 'modified'],
  ])
  expect((await reads.readTurnChanges('t', first, unrecorded)).kind).toBe('refused')
  expect(
    (await reads.readTurnFileTexts('t', { from: unrecorded, to: second }, { path: 'a.txt', oldPath: null })).kind,
  ).toBe('refused')
  expect((await reads.readTurnChanges('other', first, second)).kind).toBe('no-thread')
})
