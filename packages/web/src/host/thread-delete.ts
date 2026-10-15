import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensoLogger,
  type EnsoThreadDeletePreview,
  type EnsoTreeOnDisk,
  type EnsoTreesListing,
  type ThreadTreeRecord,
} from '@enso/core'
import { projectIdOfCwd, projectSnapshotsDir, projectTreesDir, realpathOrSelf } from '@enso/core/paths'
import { forksOfStore } from '@enso/core/snapshot-store'
import {
  disposeThreadTree,
  holdingReason,
  inventoryThreadTree,
  releaseThreadStore,
  diskUsageOf,
  measureBudget,
} from '@enso/core/thread-tree'
import type { StoredThreads } from './stored-threads.ts'
import { openLog } from './thread-log.ts'
import type { TreeMaking } from './thread-tree-making.ts'
import { treeRecordOf } from './thread-trees.ts'

/**
 * Deleting a thread (#571): its tree through the inventory, its store and the project's object store
 * collected (#573), its files last; what a delete would do, as the dialog says it; and what thread trees
 * cost on disk, by the same inventory (#578). Over `ThreadLog` (#801), so nothing here names the runtime.
 */

const log = ensoLogger('host')

/**
 * What deleting a thread answers (#571): deleted — its session file, its tree and its store, or the
 * store kept for the forks that lean on it — or why nothing was deleted. `holds-work` is the
 * tree's inventory refusing (forceable); `busy`, a run, a move, a restore or another delete holding
 * the thread; `refused`, a removal that failed.
 */
export type ThreadDeleteOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'no-thread' | 'busy' | 'holds-work' | 'refused'; readonly reason: string }

/** A thread deleted, or being deleted, is never built again under its id (#571): a stale page's prompt is refused. */
export class ThreadDeleted extends Error {
  override readonly name = 'ThreadDeleted'
}

/** How long a delete preview measures its tree (#578): past it, the size is `partial` — at least. */
const PREVIEW_MEASURE_MS = 5000

/** How long the trees listing measures every tree and object store in all (#578). */
const TREES_MEASURE_MS = 15_000

/** How many trees the listing reads at once: each inventory runs git, each measurement a walk. */
const TREES_AT_ONCE = 4

/** `jobs` run `TREES_AT_ONCE` at a time; their results in `jobs`' order. */
async function inBatches<T>(jobs: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = []
  for (let start = 0; start < jobs.length; start += TREES_AT_ONCE) {
    results.push(...(await Promise.all(jobs.slice(start, start + TREES_AT_ONCE).map((job) => job()))))
  }
  return results
}

/** What deleting reads from the host: the threads a delete or a restore holds, the stored threads, the stores (#801). */
export interface ThreadDeleteHost {
  readonly projectsDir: string | undefined
  readonly environment: Record<string, string | undefined>
  readonly deletingThreads: Set<string>
  readonly deletedThreads: Set<string>
  readonly restoringTrees: ReadonlySet<string>
  readonly storedSession: StoredThreads['storedSession']
  readonly sessionFilesOf: StoredThreads['sessionFilesOf']
  readonly listSessions: StoredThreads['listSessions']
  readonly storeOf: TreeMaking['storeOf']
}

/** What a delete is asked with: `force`, the work the user confirmed, and the live session's retire. */
interface ThreadDeleteRequest {
  readonly force: boolean
  readonly confirmedWork?: string | undefined
  readonly retire: () => boolean
}

/** Deleting a thread, previewing it, and listing what trees cost (#801). */
export interface ThreadDelete {
  readonly threadDeleted: (threadId: string) => boolean
  readonly deleteThread: (threadId: string, options: ThreadDeleteRequest) => Promise<ThreadDeleteOutcome>
  readonly previewThreadDelete: (
    threadId: string,
  ) => Promise<
    | { readonly kind: 'preview'; readonly preview: EnsoThreadDeletePreview }
    | { readonly kind: 'no-thread'; readonly reason: string }
  >
  readonly listTrees: () => Promise<EnsoTreesListing>
}

export function createThreadDelete(host: ThreadDeleteHost): ThreadDelete {
  const {
    projectsDir,
    environment,
    deletingThreads,
    deletedThreads,
    restoringTrees,
    storedSession,
    sessionFilesOf,
    listSessions,
    storeOf,
  } = host

  function threadDeleted(threadId: string): boolean {
    return deletedThreads.has(threadId)
  }

  /**
   * A deleting thread's tree and store gone (#571, #573): its tree disposed with the store, or a
   * store alone released. Undefined when done; the outcome to answer when not — `busy` while the
   * project's stores are migrated or collected, `refused` when they cannot be migrated or a fork
   * left unmigrated still reads this store (no inventory: nothing went), else the tree's work. A
   * collection that could not run is logged, never a refusal: the store is gone.
   */
  async function removeTreeAndStore(
    threadId: string,
    tree: ThreadTreeRecord | undefined,
    store: string | undefined,
    force: boolean,
  ): Promise<ThreadDeleteOutcome | undefined> {
    let uncollected: string | undefined
    if (tree !== undefined && store !== undefined) {
      const disposed = await disposeThreadTree({ record: tree, store, force, environment })
      if (disposed.kind === 'busy') return { kind: 'busy', reason: disposed.reason }
      if (disposed.kind === 'refused') {
        return disposed.inventory === undefined
          ? { kind: 'refused', reason: disposed.reason }
          : { kind: 'holds-work', reason: disposed.reason }
      }
      uncollected = disposed.uncollected
    } else if (store !== undefined && existsSync(store)) {
      const released = await releaseThreadStore(store, environment)
      if (released.kind !== 'removed') return { kind: released.kind, reason: released.reason }
      uncollected = released.uncollected
    }
    if (uncollected !== undefined) {
      log.warn('thread {threadId}: snapshot objects not collected: {reason}', { threadId, reason: uncollected })
    }
    return undefined
  }

  /** Why a delete of `threadId` cannot start: deleted already, being deleted, or restoring files. */
  function deleteRefusal(threadId: string): ThreadDeleteOutcome | undefined {
    if (deletedThreads.has(threadId)) return { kind: 'no-thread', reason: `thread ${threadId} was deleted` }
    if (deletingThreads.has(threadId)) return { kind: 'busy', reason: `thread ${threadId} is being deleted` }
    if (restoringTrees.has(threadId)) {
      return { kind: 'busy', reason: `thread ${threadId} is restoring its files; delete it once that is done` }
    }
    return undefined
  }

  /**
   * The work the tree holds that the user did not confirm, or `undefined` when none blocks. The
   * inventory always runs: force takes only the work the user confirmed (#572) — a run that
   * wrote more since the list was shown has that named first, never deleted unseen.
   */
  async function unconfirmedWork(
    tree: ThreadTreeRecord | undefined,
    store: string | undefined,
    { force, confirmedWork }: ThreadDeleteRequest,
  ): Promise<string | undefined> {
    if (tree === undefined || store === undefined) return undefined
    const held = holdingReason(await inventoryThreadTree({ record: tree, store, environment }))
    const confirmed =
      force &&
      confirmedWork ===
        createHash('sha256')
          .update(held ?? '')
          .digest('hex')
    return held !== undefined && !confirmed ? held : undefined
  }

  /** The delete itself, once claimed: every step after the claim, in `deleteThread`'s order. */
  async function deleteClaimed(threadId: string, request: ThreadDeleteRequest): Promise<ThreadDeleteOutcome> {
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session file in a project this server serves` }
    }
    const tree = treeRecordOf(openLog(located.path).transcript())
    const store = storeOf(threadId, located.cwd)
    const held = await unconfirmedWork(tree, store, request)
    if (held !== undefined) return { kind: 'holds-work', reason: held }
    if (!request.retire()) return { kind: 'busy', reason: `thread ${threadId} is running; delete it when it settles` }
    const removed = await removeTreeAndStore(threadId, tree, store, request.force)
    if (removed !== undefined) return removed
    for (const file of await sessionFilesOf(threadId)) rmSync(file, { force: true })
    deletedThreads.add(threadId)
    log.info('thread {threadId} deleted: session, {tree} and store', {
      threadId,
      tree: tree === undefined ? 'no tree' : `its ${tree.kind} ${tree.path}`,
    })
    return { kind: 'deleted' }
  }

  /**
   * Delete the thread (#571). Fail-closed, in this order: the tree's inventory first (refused, the
   * thread is untouched — not even retired); then the live session retired; then the tree and the
   * store, the project's object store collected (#573); the session files last, so a delete that
   * stops partway leaves a thread that still lists and can be deleted again.
   */
  async function deleteThread(threadId: string, request: ThreadDeleteRequest): Promise<ThreadDeleteOutcome> {
    const refusal = deleteRefusal(threadId)
    if (refusal !== undefined) return refusal
    // Claimed before the first await (#572): a second delete meanwhile is `busy`, never a second run
    // of this one beside it.
    deletingThreads.add(threadId)
    try {
      return await deleteClaimed(threadId, request)
    } catch (error) {
      log.error('thread {threadId} could not be deleted: {error}', { threadId, error })
      return { kind: 'refused', reason: `thread ${threadId} could not be deleted: ${String(error)}` }
    } finally {
      deletingThreads.delete(threadId)
    }
  }

  /**
   * What `deleteThread` would do (#571), read the way it reads: the tree from the branch, the work
   * from the same inventory and rule (`holdingReason`), the forks whose histories keep this
   * thread's snapshots ({@link forksOfStore}).
   */
  async function previewThreadDelete(
    threadId: string,
  ): Promise<
    | { readonly kind: 'preview'; readonly preview: EnsoThreadDeletePreview }
    | { readonly kind: 'no-thread'; readonly reason: string }
  > {
    if (threadDeleted(threadId)) return { kind: 'no-thread', reason: `thread ${threadId} was deleted` }
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session file in a project this server serves` }
    }
    const tree = treeRecordOf(openLog(located.path).transcript())
    const store = storeOf(threadId, located.cwd)
    const [holdsWork, size] = await Promise.all([
      tree !== undefined && store !== undefined
        ? inventoryThreadTree({ record: tree, store, environment }).then(holdingReason)
        : undefined,
      tree === undefined ? null : diskUsageOf(tree.path, Date.now() + PREVIEW_MEASURE_MS),
    ])
    const keptFor = (store === undefined ? [] : forksOfStore(store)).map((fork) => ({ threadId: fork }))
    return {
      kind: 'preview',
      preview: {
        tree: tree === undefined ? null : { kind: tree.kind, path: tree.path, branch: tree.branch },
        size,
        holdsWork: holdsWork ?? null,
        keptFor,
      },
    }
  }

  /**
   * What thread trees cost on disk (#578). Every served thread whose branch records a tree, by the
   * project its tree is under; then every directory under that project's `trees/` no thread records
   * — a mint or a delete that stopped partway — named with no thread. A project with no tree but a
   * snapshot object store (threads run in the checkout snapshot too) is listed for the store.
   * ⚠ Every size starts at once, under one deadline and one {@link measureBudget} served in turns
   * (#579): measured a batch at a time, the trees in the last batches would start past the deadline
   * and never be walked. A tree's work is the delete inventory's, a few at a time — each one runs git.
   */
  async function listTrees(): Promise<EnsoTreesListing> {
    if (projectsDir === undefined) return { projects: [] }
    const deadline = Date.now() + TREES_MEASURE_MS
    const budget = measureBudget()
    const recorded = new Map<string, { threadId: string; record: ThreadTreeRecord; cwd: string }[]>()
    for (const stored of await listSessions()) {
      const projectId = projectIdOfCwd(projectsDir, stored.cwd)
      const record = treeRecordOf(openLog(stored.path).transcript())
      const trees = recorded.get(projectId) ?? []
      if (record !== undefined) trees.push({ threadId: stored.id, record, cwd: stored.cwd })
      recorded.set(projectId, trees)
    }
    const projects = await Promise.all(
      [...recorded]
        .toSorted(([first], [second]) => first.localeCompare(second))
        .map(async ([projectId, threads]) => {
          const known = new Set(threads.map(({ record }) => realpathOrSelf(record.path)))
          const orphans = treeDirectoriesOf(projectId).filter((path) => !known.has(realpathOrSelf(path)))
          const objects = join(projectSnapshotsDir(projectsDir, projectId), '.objects')
          // Every size is started here, before any is awaited; the inventories run alongside, a few at a time.
          const works = inBatches(threads.map((thread) => (): Promise<string | undefined> => workIn(thread)))
          const [trees, objectStore] = await Promise.all([
            Promise.all([
              ...threads.map(async ({ threadId, record }, at): Promise<EnsoTreeOnDisk> => ({
                threadId,
                path: record.path,
                kind: record.kind,
                branch: record.branch,
                size: await diskUsageOf(record.path, deadline, budget),
                holdsWork: (await works)[at] ?? null,
              })),
              ...orphans.map(async (path): Promise<EnsoTreeOnDisk> => ({
                threadId: null,
                path,
                kind: existsSync(join(path, '.git')) ? 'worktree' : 'copy',
                branch: null,
                size: await diskUsageOf(path, deadline, budget),
                holdsWork: null,
              })),
            ]),
            existsSync(objects) ? diskUsageOf(objects, deadline, budget) : null,
          ])
          return { projectId, objectStore, trees }
        }),
    )
    return { projects: projects.filter((project) => project.trees.length > 0 || project.objectStore !== null) }
  }

  /** The work a recorded tree holds, as the delete would refuse for it; none without a store to compare with. */
  async function workIn(thread: {
    threadId: string
    record: ThreadTreeRecord
    cwd: string
  }): Promise<string | undefined> {
    const store = storeOf(thread.threadId, thread.cwd)
    if (store === undefined) return undefined
    return holdingReason(await inventoryThreadTree({ record: thread.record, store, environment }))
  }

  /** The directories under a project's `trees/`, by path; none when it has no such folder or it cannot be read. */
  function treeDirectoriesOf(projectId: string): string[] {
    if (projectsDir === undefined) return []
    const trees = projectTreesDir(projectsDir, projectId)
    try {
      return readdirSync(trees, { withFileTypes: true })
        .filter((treeEntry) => treeEntry.isDirectory())
        .map((treeEntry) => join(trees, treeEntry.name))
        .toSorted()
    } catch {
      return []
    }
  }

  return { threadDeleted, deleteThread, previewThreadDelete, listTrees }
}
