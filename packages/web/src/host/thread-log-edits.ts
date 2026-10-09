import { ensoLogger, ENSO_TREE_RESTORED_ENTRY, type EnsoTreeSetupOutcome, type ThreadTreeRecord } from '@enso/core'
import { restoreThreadTree } from '@enso/core/thread-tree'
import type { StoredThreads } from './stored-threads.ts'
import { openLog, type ThreadLog } from './thread-log.ts'
import type { TreeMaking } from './thread-tree-making.ts'
import { hasEntry, lastRestoreOf, snapshotAtEntry, treeRecordOf } from './thread-trees.ts'
import { treeSetupOf } from './tree-setup.ts'

/**
 * What changes a thread in place, live or stored (#551, #565, #670): its name, and its tree put back to a
 * snapshot — written through the live log when the thread is built, else through its file, never through
 * a second log beside the live one (control plane, invariant 4). And where its tree is (#650). Over
 * `ThreadLog` (#801), so nothing here names the runtime.
 */

const log = ensoLogger('host')

/**
 * What restoring a thread's tree to an entry's snapshot answers (#551): the restored hash and the
 * safety snapshot of the files it replaced, or why nothing was restored.
 */
export type ThreadRestoreOutcome =
  | { readonly kind: 'restored'; readonly hash: string; readonly safety: string }
  | {
      readonly kind: 'no-thread' | 'no-entry' | 'no-tree' | 'no-snapshot' | 'no-restore' | 'superseded'
      readonly reason: string
    }
  | { readonly kind: 'refused'; readonly reason: string }

/** A rename (#670), or why not: `no-thread` — no session under the id, live or in a served project. */
export type ThreadRenameOutcome = { readonly kind: 'renamed' } | { readonly kind: 'no-thread'; readonly reason: string }

/** A thread's tree as its branch records it, and the snapshot store beside its session (#551). */
export interface ThreadTreePlace {
  readonly record: ThreadTreeRecord
  readonly store: string
  /** What preparing the tree did (#754), when its branch records it (`treeSetupOf`). */
  readonly setup?: EnsoTreeSetupOutcome
}

/** What editing a thread in place reads from the host: the live logs, the restores in flight, the stored threads, the stores (#801). */
export interface ThreadLogEditsHost {
  readonly environment: Record<string, string | undefined>
  readonly liveLogs: ReadonlyMap<string, ThreadLog>
  readonly restoringTrees: Set<string>
  readonly storedSession: StoredThreads['storedSession']
  readonly storeOf: TreeMaking['storeOf']
}

/** Renaming a thread, restoring its tree, and finding its tree (#801). */
export interface ThreadLogEdits {
  readonly renameThread: (threadId: string, name: string) => Promise<ThreadRenameOutcome>
  readonly threadTree: (threadId: string) => Promise<ThreadTreePlace | undefined>
  readonly restoreThreadAt: (threadId: string, entryId: string) => Promise<ThreadRestoreOutcome>
  readonly undoLastRestore: (threadId: string, safety: string) => Promise<ThreadRestoreOutcome>
}

export function createThreadLogEdits(host: ThreadLogEditsHost): ThreadLogEdits {
  const { environment, liveLogs, restoringTrees, storedSession, storeOf } = host

  /** The thread's session, live or stored (one `open`, nothing built, #86), or why there is none. */
  async function threadSession(
    threadId: string,
  ): Promise<
    { readonly threadLog: ThreadLog; readonly live: boolean } | { readonly kind: 'no-thread'; readonly reason: string }
  > {
    const live = liveLogs.get(threadId)
    if (live !== undefined) return { threadLog: live, live: true }
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session in a project this server serves` }
    }
    return { threadLog: openLog(located.path), live: false }
  }

  async function restoreSession(
    threadId: string,
  ): Promise<
    | { readonly threadLog: ThreadLog; readonly live: boolean; readonly tree: ThreadTreeRecord }
    | { readonly kind: 'no-thread' | 'no-tree'; readonly reason: string }
  > {
    const found = await threadSession(threadId)
    if ('kind' in found) return found
    const tree = treeRecordOf(found.threadLog.transcript())
    if (tree === undefined) {
      return {
        kind: 'no-tree',
        reason: `thread ${threadId} runs in its checkout, not a tree of its own: nothing to restore`,
      }
    }
    return { ...found, tree }
  }

  /**
   * Name the thread (#670): pi's own `session_info` entry — what pi's `/name` writes, and what its
   * listing reads back as the newest name — appended to the live session or to the stored file. A
   * file pi opened from disk takes the entry at once, an empty fork's too; a live thread not yet
   * written keeps it for its first write. The route holds the thread while it is written, so a name
   * never lands between a run's messages.
   */
  async function renameThread(threadId: string, name: string): Promise<ThreadRenameOutcome> {
    const found = await threadSession(threadId)
    if ('kind' in found) return found
    found.threadLog.rename(name)
    log.info('thread {threadId} named {name}', { threadId, name })
    return { kind: 'renamed' }
  }

  async function threadTree(threadId: string): Promise<ThreadTreePlace | undefined> {
    const live = liveLogs.get(threadId)
    const located = live === undefined ? await storedSession(threadId) : undefined
    const threadLog = live ?? (located === undefined ? undefined : openLog(located.path))
    if (threadLog === undefined) return undefined
    const transcript = threadLog.transcript()
    const record = treeRecordOf(transcript)
    const store = storeOf(threadId, threadLog.cwd)
    if (record === undefined || store === undefined) return undefined
    const setup = treeSetupOf(transcript)
    return setup === undefined ? { record, store } : { record, store, setup }
  }

  /**
   * Put the thread's tree back to `hash` and record it: the tree's current files are snapshotted
   * first (the safety), and a failed restore puts them back. The files only — the conversation is
   * not changed (its side is `/fork`).
   */
  async function restoreTreeTo(
    threadId: string,
    target: { readonly threadLog: ThreadLog; readonly live: boolean; readonly tree: ThreadTreeRecord },
    hash: string,
  ): Promise<ThreadRestoreOutcome> {
    const { threadLog, live, tree } = target
    const store = storeOf(threadId, threadLog.cwd)
    if (store === undefined) return { kind: 'refused', reason: 'this host has no projects folder' }
    restoringTrees.add(threadId)
    const restored = await restoreThreadTree({ store, tree: tree.path, hash, environment }).finally(() =>
      restoringTrees.delete(threadId),
    )
    if (restored.kind === 'refused') {
      log.error('restore of thread {threadId} to {hash} refused at {step}: {reason}', { threadId, hash, ...restored })
      return { kind: 'refused', reason: `${restored.step}: ${restored.reason}` }
    }
    threadLog.record(ENSO_TREE_RESTORED_ENTRY, { hash: restored.hash, safety: restored.safety })
    if (!live) threadLog.writeIfUnflushed()
    log.info('thread {threadId} tree restored to {hash}; its files before are {safety}', { threadId, ...restored })
    return { kind: 'restored', hash: restored.hash, safety: restored.safety }
  }

  /** Restore a thread's tree to the snapshot taken as the turn opened by `entryId` began (#551). */
  async function restoreThreadAt(threadId: string, entryId: string): Promise<ThreadRestoreOutcome> {
    const target = await restoreSession(threadId)
    if ('kind' in target) return target
    const transcript = target.threadLog.transcript()
    if (!hasEntry(transcript, entryId))
      return { kind: 'no-entry', reason: `thread ${threadId} has no entry ${entryId}` }
    const at = snapshotAtEntry(transcript, entryId)
    if (at === undefined) {
      return { kind: 'no-snapshot', reason: `thread ${threadId} recorded no snapshot of its tree when that turn began` }
    }
    return restoreTreeTo(threadId, target, at.hash)
  }

  /**
   * Undo the thread's last restore (#565): back to the safety snapshot its newest `enso-tree-restored`
   * record names. That is a restore too — recorded, with its own safety — so undoing again re-applies
   * the restore it undid; each undo reverses the restore before it. ⚠ Only when `safety` IS that
   * record's (#561): an undo pressed on an older restore's notice — or one another tab
   * replaced since — is refused, never applied to a restore it does not name.
   */
  async function undoLastRestore(threadId: string, safety: string): Promise<ThreadRestoreOutcome> {
    const target = await restoreSession(threadId)
    if ('kind' in target) return target
    const last = lastRestoreOf(target.threadLog.transcript())
    if (last === undefined) return { kind: 'no-restore', reason: `thread ${threadId} has no restore to undo` }
    if (last.safety !== safety) {
      return {
        kind: 'superseded',
        reason: `a later restore replaced these files (its safety is ${last.safety.slice(0, 7)}); undo that one instead`,
      }
    }
    return restoreTreeTo(threadId, target, last.safety)
  }

  return { renameThread, threadTree, restoreThreadAt, undoLastRestore }
}
