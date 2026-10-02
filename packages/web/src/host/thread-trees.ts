import { join } from 'node:path'
import {
  ENSO_THREAD_TREE_ENTRY,
  type EnsoTranscriptEntry,
  lastCustomEntryData,
  readEnsoRunContext,
  readEnsoThreadTree,
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

/** Where a thread's tree and its snapshot store go, under its project's folder. `name` is the tree's directory name (a new thread's id; a fresh one for a fork, whose id pi picks only when it branches). */
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
    branch: `enso/${name}`,
  }
}

/** The thread's tree as its branch records it: the last `enso-thread-tree` entry that reads; `undefined` for a thread in its checkout. */
export function treeRecordOf(transcript: readonly EnsoTranscriptEntry[]): ThreadTreeRecord | undefined {
  return readEnsoThreadTree(ENSO_THREAD_TREE_ENTRY, lastCustomEntryData(transcript, ENSO_THREAD_TREE_ENTRY))
}

/**
 * The tree as it was when the turn opened by `entryId` began: the snapshot on the newest
 * `enso-run-context` record at or before that entry, root first — the record a run writes at its
 * start precedes its user message on the branch. `undefined` when the entry is not on the branch, or
 * no record before it carries a snapshot (a thread from before #551, or a run whose snapshot failed).
 */
export function snapshotAtEntry(
  transcript: readonly EnsoTranscriptEntry[],
  entryId: string,
): { readonly hash: string; readonly revision: string | null } | undefined {
  const position = transcript.findIndex((entry) => entry.id === entryId)
  if (position === -1) return undefined
  for (let entryIndex = position; entryIndex >= 0; entryIndex -= 1) {
    const entry = transcript[entryIndex]
    if (entry?.kind !== 'custom') continue
    const record = readEnsoRunContext(entry.customType, entry.data)
    if (record === undefined) continue
    // The newest record decides: one without a snapshot means the tree was not captured there, and
    // an older record's snapshot is an older tree — never offered in its place.
    if (record.snapshot === undefined || record.snapshot === null) return undefined
    return { hash: record.snapshot.hash, revision: record.git?.revision ?? null }
  }
  return undefined
}

/** True when `entryId` is on the branch at all — `snapshotAtEntry`'s `undefined` says why not otherwise. */
export function hasEntry(transcript: readonly EnsoTranscriptEntry[], entryId: string): boolean {
  return transcript.some((entry) => entry.id === entryId)
}
