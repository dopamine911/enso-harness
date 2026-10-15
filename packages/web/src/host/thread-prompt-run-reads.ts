import type { EnsoGitFileChange, EnsoThreadPromptRuns } from '@enso/core'
import { GitReadError, type ChangedFilePaths, type ChangedFileTexts } from '@enso/core/git'
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
 * The Diff Viewer's reads (#553), live or stored: the thread's prompt runs off its branch, and two
 * of its snapshots compared in its store. ⚠ READ-ONLY, ALL OF IT: the log is read (one `open`,
 * nothing built, #86), the store only through `@enso/core/git`'s read-only runner, and neither the
 * tree nor the session is touched — browsing prompt runs is never a restore or a fork.
 */

/**
 * What reading two of a thread's snapshots answers: the read, or why there was none — the thread
 * held nowhere, or a pair refused (a hash its prompt runs do not record, no store, or git could
 * not compare the two). Anything else that fails throws: a fault, not a refusal.
 */
export type PromptRunRead<Read> =
  | { readonly kind: 'read'; readonly read: Read }
  | { readonly kind: 'no-thread'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/** What the reads need of the host (#801): the live logs, the stored threads, the stores. */
export interface ThreadPromptRunReadsHost {
  readonly environment: Record<string, string | undefined>
  /** Only where a live thread works and its branch are read. */
  readonly liveLogs: ReadonlyMap<string, Pick<ThreadLog, 'cwd' | 'transcript'>>
  readonly storedSession: StoredThreads['storedSession']
  readonly storeOf: TreeMaking['storeOf']
}

export interface ThreadPromptRunReads {
  readonly threadPromptRuns: (threadId: string) => Promise<EnsoThreadPromptRuns | undefined>
  readonly readPromptRunChanges: (
    threadId: string,
    from: string,
    to: string,
  ) => Promise<PromptRunRead<{ files: EnsoGitFileChange[]; truncated: boolean }>>
  readonly readPromptRunFileTexts: (
    threadId: string,
    pair: { readonly from: string; readonly to: string },
    paths: ChangedFilePaths,
  ) => Promise<PromptRunRead<ChangedFileTexts>>
}

export function createThreadPromptRunReads(host: ThreadPromptRunReadsHost): ThreadPromptRunReads {
  const { environment, liveLogs, storedSession, storeOf } = host

  /** The thread's recorded prompt runs and its store, or undefined for a thread held nowhere. */
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
   * The thread's store, when `from` and `to` are both snapshots its prompt runs name — a page never
   * names a commit of its own choosing to compare.
   */
  async function pairStore(
    threadId: string,
    pair: { readonly from: string; readonly to: string },
  ): Promise<PromptRunRead<string>> {
    const found = await recordedOf(threadId)
    if (found === undefined) return { kind: 'no-thread', reason: `no session for thread ${threadId}` }
    if (found.store === undefined) return { kind: 'refused', reason: 'this host keeps no snapshot store' }
    const named = new Set(snapshotHashesOf(found.recorded))
    const stranger = [pair.from, pair.to].find((hash) => !named.has(hash))
    if (stranger !== undefined) {
      return { kind: 'refused', reason: `${stranger} is not a snapshot thread ${threadId}'s prompt runs record` }
    }
    return { kind: 'read', read: found.store }
  }

  /**
   * Two recorded snapshots compared. git failing to compare them — a commit the store no longer
   * holds — is a refusal with git's words; only a {@link GitReadError} is caught, so any other
   * fault of the read, or a log or directory read that fails, still throws.
   */
  async function readPromptRunChanges(
    threadId: string,
    from: string,
    to: string,
  ): Promise<PromptRunRead<{ files: EnsoGitFileChange[]; truncated: boolean }>> {
    const store = await pairStore(threadId, { from, to })
    if (store.kind !== 'read') return store
    try {
      return { kind: 'read', read: await readSnapshotChanges({ directory: store.read, from, to, environment }) }
    } catch (error) {
      if (!(error instanceof GitReadError)) throw error
      return { kind: 'refused', reason: `git could not compare the snapshots: ${error.message}` }
    }
  }

  /** One file at two recorded snapshots; a side git cannot read is `unavailable` with git's words, never a throw. */
  async function readPromptRunFileTexts(
    threadId: string,
    pair: { readonly from: string; readonly to: string },
    paths: ChangedFilePaths,
  ): Promise<PromptRunRead<ChangedFileTexts>> {
    const store = await pairStore(threadId, pair)
    if (store.kind !== 'read') return store
    const read = await readSnapshotFileTexts({ directory: store.read, ...pair, environment, paths })
    return { kind: 'read', read }
  }

  return { threadPromptRuns, readPromptRunChanges, readPromptRunFileTexts }
}
