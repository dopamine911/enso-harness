import { existsSync, unlinkSync } from 'node:fs'
import {
  ENSO_INCIDENT_OPENED_ENTRY,
  type EnsoIncidentOpened,
  ensoLogger,
  openIncidentOf,
  type ThreadTreeKind,
  type ThreadTreeRecord,
} from '@enso/core'
import { realpathOrSelf } from '@enso/core/paths'
import { mintThreadTree } from '@enso/core/thread-tree'
import type { StoredThreads } from './stored-threads.ts'
import { forkedLog, openLog, type ThreadLog } from './thread-log.ts'
import type { TreeMaking } from './thread-tree-making.ts'
import { snapshotAtEntry, treeLocation, treeRecordOf } from './thread-trees.ts'

/**
 * A fork (#433), taken from the source's file outside any runtime: the log forked before the chosen
 * prompt (`thread-log.ts`), its own tree minted at the source's snapshot when the source has one or new
 * threads get one (#551), and the source's open incident opened again on it (#466 decision 5). Over
 * `ThreadLog` (#801), so nothing here names the runtime.
 */

const log = ensoLogger('host')

/**
 * A fork (#433), or why not. The refusals are the host's to decide and the route's to say:
 * `no-thread` — no session file under the id in a served project; `no-entry` — the file has no
 * entry under the id; `not-a-user-message` — pi forks only at a user message; `tree-refused` — the
 * fork's own tree could not be minted (#551), so no fork was made.
 */
export type ThreadForkOutcome =
  | { readonly kind: 'forked'; readonly threadId: string; readonly prefill: string }
  | { readonly kind: 'no-thread' | 'no-entry' | 'not-a-user-message' | 'tree-refused'; readonly reason: string }

/**
 * The opening a fork records for the source's open incident (#466 decision 5): its own id, so the
 * fork is resolved on its own, and the source's signals, halt, suspension and model (when it named
 * one, #468), pointing back at the source's thread and incident.
 */
function inheritedOpening(sourceThreadId: string, source: EnsoIncidentOpened): EnsoIncidentOpened {
  return {
    incidentId: crypto.randomUUID(),
    signals: source.signals,
    halted: source.halted,
    suspended: source.suspended,
    ...(source.model === undefined ? {} : { model: source.model }),
    inheritedFrom: { threadId: sourceThreadId, incidentId: source.incidentId },
  }
}

/** What a fork reads from the host: the threads a delete holds, the stored threads, and tree making (#801). */
export interface ThreadForkHost {
  readonly projectsDir: string | undefined
  readonly deletingThreads: ReadonlySet<string>
  readonly deletedThreads: ReadonlySet<string>
  readonly storedSession: StoredThreads['storedSession']
  readonly treeKindOf: TreeMaking['treeKindOf']
  readonly mintTree: TreeMaking['mintTree']
  readonly recordTree: TreeMaking['recordTree']
  readonly storeOf: TreeMaking['storeOf']
}

/** Forking a stored thread (#801). */
export interface ThreadFork {
  readonly forkThread: (threadId: string, entryId: string) => Promise<ThreadForkOutcome>
}

export function createThreadFork(host: ThreadForkHost): ThreadFork {
  const { projectsDir, deletingThreads, deletedThreads, storedSession, treeKindOf, mintTree, recordTree, storeOf } =
    host

  async function forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome> {
    if (deletingThreads.has(threadId) || deletedThreads.has(threadId)) {
      return { kind: 'no-thread', reason: `thread ${threadId} is deleted, or being deleted` }
    }
    const located = await storedSession(threadId)
    if (located === undefined) {
      return { kind: 'no-thread', reason: `thread ${threadId} has no session file in a project this server serves` }
    }
    const probe = openLog(located.path)
    const prompt = probe.promptAt(entryId)
    if (prompt.kind === 'no-entry') return { kind: 'no-entry', reason: `thread ${threadId} has no entry ${entryId}` }
    if (prompt.kind === 'not-a-user-message') {
      return { kind: 'not-a-user-message', reason: `entry ${entryId} is not a user message; a fork starts at one` }
    }
    // The fork's own tree (#551): whenever the source runs on one — two threads never share a tree
    // — or new threads get one. Minted at the source's snapshot as that turn began, so the fork's
    // files are the conversation's at the fork point, not the source's files now.
    const sourceTranscript = probe.transcript()
    const sourceTree = treeRecordOf(sourceTranscript)
    const plan =
      sourceTree !== undefined || treeKindOf(located.cwd) !== undefined
        ? forkTreePlan(threadId, located.cwd, sourceTree, snapshotAtEntry(sourceTranscript, entryId))
        : undefined
    if (plan?.kind === 'refused') return { kind: 'tree-refused', reason: plan.reason }
    // Opened with the fork's tree as its cwd, so the fork's header — written when it branches — names
    // the tree the fork runs in; the source's own file is not touched.
    const source = plan === undefined ? probe : openLog(located.path, plan.cwd)
    // Read off the source's CURRENT branch before the fork turns `source` into it: an open incident
    // passes on whatever the fork point (#466 decision 5) — a fork taken from before it would
    // otherwise be a way around its suspension. A resolved or ended one does not.
    const sourceIncident = openIncidentOf(source.incidents())
    // The runtime's `before`: the fork holds everything up to the message's parent — or nothing, naming its parent.
    const fork = forkedLog(source, prompt.parentEntryId, located.path)
    if (plan !== undefined) {
      const refusal = await giveForkItsTree(fork, plan)
      if (refusal !== undefined) return { kind: 'tree-refused', reason: refusal }
    }
    if (sourceIncident !== undefined) inheritOpenIncident(threadId, fork, sourceIncident)
    fork.writeIfUnflushed()
    return { kind: 'forked', threadId: fork.threadId, prefill: prompt.text }
  }

  /**
   * Mint the fork's tree under the fork's own id (pi picks it only as it branches) and record it on
   * the fork. The reason when it cannot be made: then there is no fork — the file pi may already
   * have written for it goes too, so no thread is left pointing at a tree that does not exist.
   */
  async function giveForkItsTree(
    fork: ThreadLog,
    plan: Extract<ReturnType<typeof forkTreePlan>, { kind: 'planned' }>,
  ): Promise<string | undefined> {
    const minted = await mintTree({
      threadId: fork.threadId,
      project: plan.project,
      name: plan.name,
      from: plan.from,
      kind: plan.treeKind,
    })
    if (minted.kind === 'refused') {
      const file = fork.file
      if (file !== undefined && existsSync(file)) unlinkSync(file)
      return `the fork's ${minted.reason}`
    }
    recordTree(fork, minted)
    return undefined
  }

  /** The source's open incident, opened again on the fork (#466 decision 5) — unless a fork taken after the opening already holds it, open. */
  function inheritOpenIncident(
    threadId: string,
    fork: ThreadLog,
    sourceIncident: NonNullable<ReturnType<typeof openIncidentOf>>,
  ): void {
    if (openIncidentOf(fork.incidents()) !== undefined) return
    const opening = inheritedOpening(threadId, sourceIncident.opened)
    fork.record(ENSO_INCIDENT_OPENED_ENTRY, opening)
    log.info('fork {forkThreadId} inherits incident {sourceIncidentId} as {incidentId}', {
      threadId,
      forkThreadId: fork.threadId,
      sourceIncidentId: sourceIncident.opened.incidentId,
      incidentId: opening.incidentId,
    })
  }

  /**
   * Where a fork's tree comes from (#551): the source's snapshot at the fork entry, in the source's
   * store — or, for a source in its checkout with no snapshot there (a thread from before #551), the
   * checkout as it is now. A source ON a tree with no snapshot at that turn is refused: its files at
   * the fork point were never captured, and the checkout's are not them.
   */
  function forkTreePlan(
    sourceThreadId: string,
    sourceCwd: string,
    sourceTree: ThreadTreeRecord | undefined,
    at: { readonly hash: string; readonly revision: string | null } | undefined,
  ):
    | {
        kind: 'planned'
        cwd: string
        project: string
        name: string
        treeKind: ThreadTreeKind | undefined
        from: Parameters<typeof mintThreadTree>[0]['from']
      }
    | { kind: 'refused'; reason: string } {
    const sourceStore = storeOf(sourceThreadId, sourceCwd)
    if (projectsDir === undefined || sourceStore === undefined) {
      return { kind: 'refused', reason: 'this host has no projects folder to put a tree in' }
    }
    if (sourceTree !== undefined && at === undefined) {
      return { kind: 'refused', reason: `thread ${sourceThreadId} recorded no snapshot of its tree at that turn` }
    }
    const project = sourceTree?.project ?? sourceCwd
    // pi picks the fork's id only when it branches, after the cwd is fixed: the tree's directory
    // gets a name of its own, and the store the fork's id (`mintTree`).
    const name = crypto.randomUUID()
    return {
      kind: 'planned',
      cwd: treeLocation(projectsDir, realpathOrSelf(project), name, name).tree,
      project,
      name,
      treeKind: sourceTree?.kind,
      from:
        at === undefined
          ? { kind: 'checkout' }
          : { kind: 'snapshot', hash: at.hash, revision: at.revision, storeDirectory: sourceStore },
    }
  }

  return { forkThread }
}
