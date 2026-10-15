import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
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
import { createThreadPromptRunReads, type ThreadPromptRunReads } from '../thread-prompt-run-reads.ts'
import { recordedPromptRunsOf, snapshotHashesOf, withStoreTrees } from '../thread-prompt-runs.ts'

/**
 * The Diff Viewer's prompt runs (#553), off a branch: which two snapshots each prompt run compares,
 * what a fork compares with, and which prompt runs have nothing to compare — never a diff made up
 * for them. Then the reads on a real snapshot store: which pairs are compared, and what git's
 * failure and any other failure become.
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
/** A recorded snapshot the store never held: what a store that lost an object looks like to a read. */
const LOST_SNAPSHOT = 'e'.repeat(40)

/** A checkout of one file, one commit, under an environment that names no repository of its own. */
function checkoutAndEnvironment(): { readonly tree: string; readonly environment: NodeJS.ProcessEnv } {
  const environment: NodeJS.ProcessEnv = {
    PATH: dirname(Bun.which('git') ?? '/usr/bin/git'),
    HOME: mkdtempSync(join(tmpdir(), 'enso-prompts-home-')),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const checkout = mkdtempSync(join(tmpdir(), 'enso-prompts-tree-'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: checkout,
      env: environment,
    })
  }
  git('init', '--quiet')
  writeFileSync(join(checkout, 'a.txt'), 'one\n')
  git('add', '--all')
  git('commit', '--quiet', '-m', 'one')
  return { tree: checkout, environment }
}

/**
 * The reads on a live thread `t` on a real snapshot store, whose branch records four snapshots in
 * order, each as a prompt's run began: `first` (`a.txt` as `one`), `second` (`two`), `moved`
 * (`a.txt` moved to `b.txt`), then {@link LOST_SNAPSHOT}. `unrecorded` (`b.txt` as `three`) is held
 * by the store and recorded by no prompt run.
 */
async function promptRunsOnAStore(): Promise<{
  readonly reads: ThreadPromptRunReads
  readonly first: string
  readonly second: string
  readonly moved: string
  readonly unrecorded: string
}> {
  const { tree: checkout, environment } = checkoutAndEnvironment()
  const directory = join(mkdtempSync(join(tmpdir(), 'enso-prompts-store-')), 'store')
  const store = await openSnapshotStore({ directory, tree: checkout, environment })
  if (store === undefined) throw new Error('the store did not open')
  const hashOf = async (): Promise<string> => {
    const outcome = await store.snapshot()
    if (outcome.kind !== 'taken') throw new Error(outcome.refused.stderr)
    return outcome.taken.hash
  }
  const first = await hashOf()
  writeFileSync(join(checkout, 'a.txt'), 'two\n')
  const second = await hashOf()
  renameSync(join(checkout, 'a.txt'), join(checkout, 'b.txt'))
  const moved = await hashOf()
  writeFileSync(join(checkout, 'b.txt'), 'three\n')
  const unrecorded = await hashOf()
  const transcript = [
    runContext('rc1', { hash: first }),
    user('u1'),
    runContext('rc2', { hash: second }),
    user('u2'),
    runContext('rc3', { hash: moved }),
    user('u3'),
    runContext('rc4', { hash: LOST_SNAPSHOT }),
    user('u4'),
  ]
  const reads = createThreadPromptRunReads({
    environment,
    liveLogs: new Map([['t', { cwd: checkout, transcript: () => transcript }]]),
    storedSession: () => Promise.resolve(undefined),
    storeOf: () => directory,
  })
  return { reads, first, second, moved, unrecorded }
}

test("⚠ a prompt run compares the snapshot its run began with to the one the next prompt's run began with; an unchanged run writes no record, and the last one's result is pending", () => {
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
  expect(
    recorded.promptRuns.map((promptRun) => [
      promptRun.promptRun,
      promptRun.prompt,
      promptRun.entryId,
      promptRun.start,
      promptRun.end,
    ]),
  ).toEqual([
    [1, 1, 'u1', { kind: 'taken', hash: A }, { kind: 'taken', hash: B }],
    // u3's run changed nothing, so wrote no record: it began with B, as u2's result.
    [2, 2, 'u2', { kind: 'taken', hash: B }, { kind: 'taken', hash: B }],
    [3, 3, 'u3', { kind: 'taken', hash: B }, { kind: 'pending' }],
  ])
  const trees = new Map([
    [A, 'tree-a'],
    [B, 'tree-b'],
  ])
  const { promptRuns } = withStoreTrees(recorded, trees, undefined)
  expect(promptRuns.map((promptRun) => promptRun.idle)).toEqual([false, true, false])
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
  const { promptRuns } = withStoreTrees(recorded, new Map([[D, 'tree-d']]), undefined)
  expect(promptRuns.map((promptRun) => [promptRun.start.kind, promptRun.end.kind, promptRun.idle])).toEqual([
    ['unrecorded', 'failed', false],
    ['failed', 'unavailable', false],
    ['unavailable', 'taken', false],
    ['taken', 'pending', false],
  ])
  expect(snapshotHashesOf(recorded).toSorted()).toEqual([C, D])
})

test("⚠ a fork's prompt runs are its own: the source's prompts before its tree record are not listed, its baseline is the snapshot it inherited, and Chat's prompt numbers still count them", () => {
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
  expect(
    recorded.promptRuns.map((promptRun) => [
      promptRun.promptRun,
      promptRun.prompt,
      promptRun.entryId,
      promptRun.start,
      promptRun.end,
    ]),
  ).toEqual([
    [1, 3, 'f1', { kind: 'taken', hash: B }, { kind: 'taken', hash: C }],
    [2, 4, 'f2', { kind: 'taken', hash: C }, { kind: 'pending' }],
  ])
})

test('a restore inside a prompt run is marked on that prompt run alone; a malformed restore entry records nothing', () => {
  const restore = (id: string, data: unknown): EnsoTranscriptEntry => ({
    kind: 'custom',
    id,
    customType: ENSO_TREE_RESTORED_ENTRY,
    data,
  })
  const recorded = recordedPromptRunsOf(
    't',
    [
      runContext('rc', { hash: A }),
      user('u1'),
      restore('restore', { hash: A, safety: B }),
      user('u2'),
      // The #985 review: read through its validator, like every other record here — a restore
      // that names no snapshot is no restore.
      restore('malformed', { hash: 'not a snapshot' }),
      user('u3'),
    ],
    undefined,
  )
  expect(recorded.promptRuns.map((promptRun) => promptRun.restored)).toEqual([true, false, false])
})

test("⚠ two snapshots are compared only when the thread's prompt runs record both: any other commit is refused, unread (#553)", async () => {
  const { reads, first, second, moved, unrecorded } = await promptRunsOnAStore()

  const listed = await reads.threadPromptRuns('t')
  expect(listed?.promptRuns.map((promptRun) => [promptRun.start, promptRun.end.kind, promptRun.idle])).toEqual([
    [{ kind: 'taken', hash: first }, 'taken', false],
    [{ kind: 'taken', hash: second }, 'taken', false],
    [{ kind: 'taken', hash: moved }, 'unavailable', false],
    [
      { kind: 'unavailable', hash: LOST_SNAPSHOT, reason: "the thread's snapshot store does not hold this snapshot" },
      'pending',
      false,
    ],
  ])
  const read = await reads.readPromptRunChanges('t', first, second)
  expect(read.kind === 'read' ? read.read.files.map((file) => [file.path, file.status]) : read).toEqual([
    ['a.txt', 'modified'],
  ])
  expect(await reads.readPromptRunChanges('t', first, unrecorded)).toEqual({
    kind: 'refused',
    reason: `${unrecorded} is not a snapshot thread t's prompt runs record`,
  })
  expect(
    (await reads.readPromptRunFileTexts('t', { from: unrecorded, to: second }, { path: 'a.txt', oldPath: null })).kind,
  ).toBe('refused')
  expect((await reads.readPromptRunChanges('other', first, second)).kind).toBe('no-thread')
})

// The #985 review: a recorded snapshot the store cannot read is git's failure to say, as a refusal
// with git's words — caught around the git read alone.
test('⚠ a recorded snapshot the store has lost is refused with git’s words, never an empty diff', async () => {
  const { reads, moved } = await promptRunsOnAStore()
  const read = await reads.readPromptRunChanges('t', moved, LOST_SNAPSHOT)
  expect(read.kind).toBe('refused')
  expect(read.kind === 'refused' ? read.reason : '').toStartWith('git could not compare the snapshots: ')
  expect(read.kind === 'refused' ? read.reason : '').toContain(LOST_SNAPSHOT)
})

test('a file is read whole at two recorded snapshots, the old side at `oldPath`; a path no file has is `none` on both sides', async () => {
  const { reads, first, moved } = await promptRunsOnAStore()
  expect(
    await reads.readPromptRunFileTexts('t', { from: first, to: moved }, { path: 'b.txt', oldPath: 'a.txt' }),
  ).toEqual({
    kind: 'read',
    read: { oldText: { kind: 'text', text: 'one\n' }, newText: { kind: 'text', text: 'two\n' } },
  })
  expect(
    await reads.readPromptRunFileTexts('t', { from: first, to: moved }, { path: 'nowhere.txt', oldPath: null }),
  ).toEqual({ kind: 'read', read: { oldText: { kind: 'none' }, newText: { kind: 'none' } } })
})

test('⚠ a file at a recorded snapshot the store has lost is `unavailable` with git’s words, never a throw', async () => {
  const { reads, moved } = await promptRunsOnAStore()
  const read = await reads.readPromptRunFileTexts(
    't',
    { from: moved, to: LOST_SNAPSHOT },
    { path: 'b.txt', oldPath: null },
  )
  expect(read).toMatchObject({
    kind: 'read',
    read: { oldText: { kind: 'text', text: 'two\n' }, newText: { kind: 'unavailable' } },
  })
})

test('a read that fails outside git — the sessions cannot be listed — throws, a fault and not a refusal', async () => {
  const reads = createThreadPromptRunReads({
    environment: {},
    liveLogs: new Map(),
    storedSession: () => Promise.reject(new Error('the sessions directory could not be read')),
    storeOf: () => undefined,
  })
  await expect(reads.readPromptRunChanges('t', A, B)).rejects.toThrow('the sessions directory could not be read')
})
