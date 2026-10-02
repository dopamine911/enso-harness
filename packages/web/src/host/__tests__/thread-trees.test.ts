import { expect, test } from 'bun:test'
import {
  ENSO_RUN_CONTEXT_ENTRY,
  ENSO_THREAD_TREE_ENTRY,
  type EnsoTranscriptEntry,
  type ThreadTreeRecord,
} from '@enso/core'
import { projectIdOf, projectSessionsDir, projectTreesDir } from '@enso/core/paths'
import { projectIdOfCwd, sessionDirectoryFor, snapshotAtEntry, treeRecordOf } from '../thread-trees.ts'

/**
 * The host's reads for #551: which snapshot a turn began with, which tree a thread runs on, which
 * project a tree belongs to. Over our records (#555 rule 5), never pi's entry ids.
 */

const runContext = (
  id: string,
  snapshot: { hash: string } | null | undefined,
  revision = 'r'.repeat(40),
): EnsoTranscriptEntry => ({
  kind: 'custom',
  id,
  customType: ENSO_RUN_CONTEXT_ENTRY,
  data: {
    git: { revision, dirty: false },
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
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('⚠ a turn began with the snapshot on the newest run-context record at or before its user entry — never a later one, never an older one past a record that took none', () => {
  const branch = [
    runContext('rc1', { hash: A }),
    user('u1'),
    runContext('rc2', { hash: B }),
    user('u2'),
    runContext('rc3', null),
    user('u3'),
  ]
  expect(snapshotAtEntry(branch, 'u1')).toEqual({ hash: A, revision: 'r'.repeat(40) })
  expect(snapshotAtEntry(branch, 'u2')).toEqual({ hash: B, revision: 'r'.repeat(40) })
  // The run before u3 took no snapshot: its tree was not captured, and B is an older tree.
  expect(snapshotAtEntry(branch, 'u3')).toBeUndefined()
  // A record from before #551 carries no snapshot field: unknown, the same.
  expect(snapshotAtEntry([runContext('old', undefined), user('u')], 'u')).toBeUndefined()
  expect(snapshotAtEntry(branch, 'not-on-the-branch')).toBeUndefined()
})

test('the tree a thread runs on is the last tree record that reads; a thread in its checkout has none', () => {
  const record: ThreadTreeRecord = {
    kind: 'worktree',
    project: '/p',
    path: '/h/projects/x/trees/t',
    branch: 'enso/t',
    base: A,
  }
  expect(treeRecordOf([{ kind: 'custom', id: 't', customType: ENSO_THREAD_TREE_ENTRY, data: record }])).toEqual(record)
  expect(treeRecordOf([user('u')])).toBeUndefined()
  expect(
    treeRecordOf([{ kind: 'custom', id: 't', customType: ENSO_THREAD_TREE_ENTRY, data: { kind: 'nope' } }]),
  ).toBeUndefined()
})

test("⚠ a tree's sessions file under its PROJECT's folder, by the id its path names; a checkout's under its own", () => {
  const projectsDir = '/h/projects'
  const project = '/srv/app'
  const tree = `${projectTreesDir(projectsDir, projectIdOf(project))}/thread-1`
  expect(projectIdOfCwd(projectsDir, tree)).toBe(projectIdOf(project))
  expect(sessionDirectoryFor(projectsDir, tree)).toBe(projectSessionsDir(projectsDir, projectIdOf(project)))
  expect(projectIdOfCwd(projectsDir, project)).toBe(projectIdOf(project))
})
