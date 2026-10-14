import { join } from 'node:path'
import {
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_RESTORED_ENTRY,
  type EnsoRunContext,
  type EnsoTranscriptEntry,
  type EnsoTreeRestored,
  lastCustomEntryData,
  readEnsoRunContext,
  readEnsoThreadTree,
  readEnsoTreeRestored,
  type ThreadTreeRecord,
} from '@enso/core'
import {
  projectIdOf,
  projectSessionsDir,
  projectSnapshotsDir,
  projectTreesDir,
  realpathOrSelf,
  treeProjectId,
} from '@enso/core/paths'

/**
 * The host's side of #551's thread trees: where a thread's tree and its snapshot store go, which
 * project a thread's cwd belongs to, and what its branch records about its tree. The git of it is
 * `@enso/core/thread-tree`'s; this module decides only paths and reads only our records (#555
 * rule 5 — the branch's `enso-thread-tree` and `enso-run-context` entries, never pi's entry ids).
 *
 * ⚠ A THREAD ON A TREE RUNS IN A DIRECTORY THAT IS NO PROJECT. pi's cwd — and so the session
 * header, the listing's `cwd`, the guards' write root — is the tree. Everything filed or served BY
 * PROJECT asks {@link projectIdOfCwd} first: the session directory, the snapshot store, the server's
 * projects (`server/projects.ts`).
 */

/**
 * The project a cwd belongs to, by id: the one a minted tree's path names, else the cwd's own (its
 * canonical path, hashed — `projectIdOf`).
 */
export function projectIdOfCwd(projectsDir: string, cwd: string): string {
  return treeProjectId(projectsDir, cwd) ?? projectIdOf(realpathOrSelf(cwd))
}

/** The session directory a thread in `cwd` files under (#552): its project's, whether `cwd` is the checkout or one of its trees. */
export function sessionDirectoryFor(projectsDir: string, cwd: string): string {
  return projectSessionsDir(projectsDir, projectIdOfCwd(projectsDir, cwd))
}

/**
 * Where a thread's tree and its snapshot store go, under its project's folder, and its branch.
 * `name` is the tree's directory name — a new thread's id; a fresh one for a fork, whose tree is
 * its cwd from before pi picks its id as it branches. The branch and the store are named by the
 * thread's id, so an `enso/*` branch in the user's repository says which thread it is (PR #561
 * review): a fork's tree is minted after the branching, when the id is known.
 */
export function treeLocation(
  projectsDir: string,
  project: string,
  name: string,
  threadId: string,
): { readonly tree: string; readonly store: string; readonly branch: string } {
  const projectId = projectIdOf(realpathOrSelf(project))
  return {
    tree: join(projectTreesDir(projectsDir, projectId), name),
    store: join(projectSnapshotsDir(projectsDir, projectId), threadId),
    branch: `enso/${threadId}`,
  }
}

/** The thread's tree as its branch records it: the last `enso-thread-tree` entry that reads; `undefined` for a thread in its checkout. */
export function treeRecordOf(transcript: readonly EnsoTranscriptEntry[]): ThreadTreeRecord | undefined {
  return readEnsoThreadTree(ENSO_THREAD_TREE_ENTRY, lastCustomEntryData(transcript, ENSO_THREAD_TREE_ENTRY))
}

/** The thread's last restore (#565): the newest `enso-tree-restored` record on its branch — what Undo puts back. */
export function lastRestoreOf(transcript: readonly EnsoTranscriptEntry[]): EnsoTreeRestored | undefined {
  return readEnsoTreeRestored(ENSO_TREE_RESTORED_ENTRY, lastCustomEntryData(transcript, ENSO_TREE_RESTORED_ENTRY))
}

/**
 * The newest `enso-run-context` record at or before `position` on the branch, root first — the
 * record a run writes at its start precedes its user message — or `undefined` for none. The newest
 * decides: a record without a snapshot means the tree was not captured there, and an older
 * record's snapshot is an older tree, never to be offered in its place.
 */
export function runContextAt(transcript: readonly EnsoTranscriptEntry[], position: number): EnsoRunContext | undefined {
  for (let entryIndex = position; entryIndex >= 0; entryIndex -= 1) {
    const entry = transcript[entryIndex]
    const record = entry?.kind === 'custom' ? readEnsoRunContext(entry.customType, entry.data) : undefined
    if (record !== undefined) return record
  }
  return undefined
}

/**
 * The tree as it was when the turn opened by `entryId` began: the snapshot on {@link runContextAt}
 * that entry. `undefined` when the entry is not on the branch, or no record before it carries a
 * snapshot (a thread from before #551, or a run whose snapshot failed).
 */
export function snapshotAtEntry(
  transcript: readonly EnsoTranscriptEntry[],
  entryId: string,
): { readonly hash: string; readonly revision: string | null } | undefined {
  const position = transcript.findIndex((entry) => entry.id === entryId)
  const record = position === -1 ? undefined : runContextAt(transcript, position)
  if (record?.snapshot === undefined || record.snapshot === null) return undefined
  return { hash: record.snapshot.hash, revision: record.git?.revision ?? null }
}

/** True when `entryId` is on the branch at all — `snapshotAtEntry`'s `undefined` says why not otherwise. */
export function hasEntry(transcript: readonly EnsoTranscriptEntry[], entryId: string): boolean {
  return transcript.some((transcriptEntry) => transcriptEntry.id === entryId)
}
