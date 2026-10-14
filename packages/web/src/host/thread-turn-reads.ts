import type { EnsoGitFileChange, EnsoThreadPromptRuns } from '@enso/core'
import type { ChangedFilePaths, ChangedFileTexts } from '@enso/core/git'
import { readSnapshotChanges, readSnapshotFileTexts, readSnapshotTrees } from '@enso/core/snapshot-store'
import type { StoredThreads } from './stored-threads.ts'
import { openLog, type ThreadLog } from './thread-log.ts'
import {
  type RecordedPromptRuns,
  recordedPromptRunsOf,
  snapshotHashesOf,
  withStoreTrees,
} from './thread-prompt-runs.ts'
import type { TreeMaking } from './thread-tree-making.ts'

/**
 * The Diff Viewer's reads (#553), live or stored: the thread's prompts off its branch, and two of its
 * snapshots compared in its store. ⚠ READ-ONLY, ALL OF IT: the log is read (one `open`, nothing
 * built, #86), the store only through `@enso/core/git`'s read-only runner, and neither the tree
 * nor the session is touched — browsing prompts is never a restore or a fork.
 */

/** What reading two of a thread's snapshots answers: the read, or why there was none. */
export type TurnRead<Read> =
  | { readonly kind: 'read'; readonly read: Read }
  | { readonly kind: 'no-thread'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/** What the reads need of the host (#801): the live logs, the stored threads, the stores. */
export interface ThreadTurnReadsHost {
  readonly environment: Record<string, string | undefined>
  readonly liveLogs: ReadonlyMap<string, ThreadLog>
  readonly storedSession: StoredThreads['storedSession']
  readonly storeOf: TreeMaking['storeOf']
}

export interface ThreadTurnReads {
  readonly threadPromptRuns: (threadId: string) => Promise<EnsoThreadPromptRuns | undefined>
  readonly readTurnChanges: (
    threadId: string,
    from: string,
    to: string,
  ) => Promise<TurnRead<{ files: EnsoGitFileChange[]; truncated: boolean }>>
  readonly readTurnFileTexts: (
    threadId: string,
    pair: { readonly from: string; readonly to: string },
    paths: ChangedFilePaths,
  ) => Promise<TurnRead<ChangedFileTexts>>
}

export function createThreadTurnReads(host: ThreadTurnReadsHost): ThreadTurnReads {
  const { environment, liveLogs, storedSession, storeOf } = host

  /** The thread's recorded prompts and its store, or undefined for a thread held nowhere. */
  async function recordedOf(
    threadId: string,
  ): Promise<{ readonly recorded: RecordedPromptRuns; readonly store: string | undefined } | undefined> {
    const live = liveLogs.get(threadId)
    const located = await storedSession(threadId)
    const threadLog = live ?? (located === undefined ? undefined : openLog(located.path))
    if (threadLog === undefined) return undefined
    const recorded = recordedPromptRunsOf(threadId, threadLog.transcript(), located?.parentThreadId)
    return { recorded, store: storeOf(threadId, threadLog.cwd) }
  }

  async function threadPromptRuns(threadId: string): Promise<EnsoThreadPromptRuns | undefined> {
    const found = await recordedOf(threadId)
    if (found === undefined) return undefined
    const { recorded, store } = found
    if (store === undefined) return withStoreTrees(recorded, new Map(), 'this host keeps no snapshot store')
    try {
      const trees = await readSnapshotTrees({ directory: store, hashes: snapshotHashesOf(recorded), environment })
      return withStoreTrees(recorded, trees, undefined)
    } catch (error) {
      return withStoreTrees(recorded, new Map(), `the snapshot store could not be read: ${String(error)}`)
    }
  }

  /**
   * The thread's store, when `from` and `to` are both snapshots its prompts name — a page never names
   * a commit of its own choosing to compare.
   */
  async function pairStore(
    threadId: string,
    pair: { readonly from: string; readonly to: string },
  ): Promise<TurnRead<string>> {
    const found = await recordedOf(threadId)
    if (found === undefined) return { kind: 'no-thread', reason: `no session for thread ${threadId}` }
    if (found.store === undefined) return { kind: 'refused', reason: 'this host keeps no snapshot store' }
    const named = new Set(snapshotHashesOf(found.recorded))
    const stranger = [pair.from, pair.to].find((hash) => !named.has(hash))
    if (stranger !== undefined) {
      return { kind: 'refused', reason: `${stranger} is not a snapshot thread ${threadId}'s prompts record` }
    }
    return { kind: 'read', read: found.store }
  }

  async function readTurnChanges(
    threadId: string,
    from: string,
    to: string,
  ): Promise<TurnRead<{ files: EnsoGitFileChange[]; truncated: boolean }>> {
    const store = await pairStore(threadId, { from, to })
    if (store.kind !== 'read') return store
    return { kind: 'read', read: await readSnapshotChanges({ directory: store.read, from, to, environment }) }
  }

  async function readTurnFileTexts(
    threadId: string,
    pair: { readonly from: string; readonly to: string },
    paths: ChangedFilePaths,
  ): Promise<TurnRead<ChangedFileTexts>> {
    const store = await pairStore(threadId, pair)
    if (store.kind !== 'read') return store
    const read = await readSnapshotFileTexts({ directory: store.read, ...pair, environment, paths })
    return { kind: 'read', read }
  }

  return { threadPromptRuns, readTurnChanges, readTurnFileTexts }
}
