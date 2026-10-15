import { join } from 'node:path'
import {
  ensoLogger,
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_SETUP_ENTRY,
  type EnsoProjectThreadSettings,
  type EnsoProjectTierPending,
  type EnsoTreeSetupOutcome,
  type ThreadTreeKind,
  type ThreadTreeRecord,
} from '@enso/core'
import { ensoHome, projectIdOfCwd, projectSnapshotsDir, realpathOrSelf } from '@enso/core/paths'
import { knownSecretValues } from '@enso/core/secrets'
import { mintThreadTree, treeKindFor } from '@enso/core/thread-tree'
import { prepareThreadTree } from '@enso/core/tree-setup'
import { movedLog, type ThreadLog } from './thread-log.ts'
import { treeLocation, treeRecordOf } from './thread-trees.ts'
import { type ProjectThreadSettingsSource, resolveProjectThreadSettings, treeSetupOf } from './tree-setup.ts'

/** A project's new-tree settings, and its own tiers that are not the version approved (#753). */
interface TreeSettings {
  readonly threads: EnsoProjectThreadSettings
  readonly pending: readonly EnsoProjectTierPending[]
}

/**
 * A thread's own tree (#551), made and prepared (#754): minted at the checkout or at a parent's snapshot,
 * its project's files copied in and its setup run, recorded on the thread's log; and the snapshot store
 * beside it. Over `ThreadLog` (#801), so nothing here names the runtime.
 */

const log = ensoLogger('host')

/** The tree kind a project's settings give its new threads (#551): none for `off`, or no settings. */
function treeKindIn(settings: TreeSettings | undefined): ThreadTreeKind | undefined {
  const chosen = settings?.threads.tree.value
  return chosen === undefined || chosen === 'off' ? undefined : chosen
}

/** A tree just made, and what preparing it did (#754) — absent when there was nothing to set up. */
export type MintedTree = { kind: 'minted'; record: ThreadTreeRecord; setup?: EnsoTreeSetupOutcome }

/** What making trees reads from the host: where trees go, the agent dir and settings their kind is read from, and the environment setup runs in (#801). */
export interface TreeMakingHost {
  readonly projectsDir: string | undefined
  readonly agentDir: string
  readonly environment: Record<string, string | undefined>
  readonly threadSettings: ProjectThreadSettingsSource | undefined
}

/** Making a thread's tree, recording it, and finding its store (#801). */
export interface TreeMaking {
  readonly treeKindOf: (project: string) => ThreadTreeKind | undefined
  readonly mintTree: (request: {
    readonly threadId: string
    readonly project: string
    readonly name: string
    readonly from: Parameters<typeof mintThreadTree>[0]['from']
    /** A fork of a thread on a tree keeps its source's kind, whatever new threads get now. */
    readonly kind?: ThreadTreeKind | undefined
  }) => Promise<MintedTree | { kind: 'refused'; reason: string }>
  readonly logOnTree: (checkout: ThreadLog, minted: MintedTree) => ThreadLog
  readonly recordTree: (threadLog: ThreadLog, minted: MintedTree) => void
  readonly prepareTreeOnTrust: (threadId: string, threadLog: ThreadLog) => Promise<void>
  readonly storeOf: (threadId: string, cwd: string) => string | undefined
}

export function createTreeMaking(host: TreeMakingHost): TreeMaking {
  const { projectsDir, agentDir, environment, threadSettings } = host

  /**
   * `project`'s new-tree settings by tier (#754), as approved (#753), read fresh — an edit or an
   * approval applies to the next tree; none when this host mints no trees (no projects folder to put
   * them in, or no settings to read).
   */
  const threadSettingsOf = (project: string): TreeSettings | undefined =>
    projectsDir === undefined || threadSettings === undefined
      ? undefined
      : resolveProjectThreadSettings(realpathOrSelf(project), threadSettings, agentDir)

  /** The tree kind new threads in `project` get (#551), or none. */
  const treeKindOf = (project: string): ThreadTreeKind | undefined => treeKindIn(threadSettingsOf(project))

  /**
   * A thread's own tree, minted (#551): at the checkout's current state for a new thread, at the
   * parent's snapshot for a fork. `name` is the tree's directory (the thread's id, or a fresh one
   * for a fork); the store is the thread's (`threadId`). The kind is the project's settings'
   * (`threadSettingsOf`), except that a project which is no repository's top level gets a copy.
   * Then prepared (#754, `prepareTree`): a setup that fails does not refuse the tree.
   */
  async function mintTree(request: {
    readonly threadId: string
    readonly project: string
    readonly name: string
    readonly from: Parameters<typeof mintThreadTree>[0]['from']
    /** A fork of a thread on a tree keeps its source's kind, whatever new threads get now. */
    readonly kind?: ThreadTreeKind | undefined
  }): Promise<MintedTree | { kind: 'refused'; reason: string }> {
    const settings = threadSettingsOf(request.project)
    const requested = request.kind ?? treeKindIn(settings)
    if (projectsDir === undefined || requested === undefined) {
      return { kind: 'refused', reason: 'this host mints no trees (no projects folder, or trees are off)' }
    }
    const project = realpathOrSelf(request.project)
    const location = treeLocation(projectsDir, project, request.name, request.threadId)
    const kind = await treeKindFor(project, requested, environment)
    const minted = await mintThreadTree({
      project,
      tree: location.tree,
      store: location.store,
      kind,
      branch: location.branch,
      from: request.from,
      environment,
    })
    if (minted.kind === 'refused') {
      log.error('no tree for thread {threadId}: {step} refused — {reason}', { threadId: request.threadId, ...minted })
      return { kind: 'refused', reason: `its tree could not be made (${minted.step}): ${minted.reason}` }
    }
    log.info('thread {threadId} runs in its own tree {tree} ({kind}, base {base})', {
      threadId: request.threadId,
      tree: minted.record.path,
      kind: minted.record.kind,
      base: minted.record.base,
    })
    const setup = settings === undefined ? undefined : await prepareTree(request.threadId, minted.record, settings)
    return setup === undefined ? minted : { ...minted, setup }
  }

  /**
   * A new tree prepared (#754): the project's files to copy copied in, its setup commands run there
   * as Enso — in the quarantined environment pi's `bash` gets, their output redacted with the
   * user's secret values — and the outcome. ⚠ ONLY FROM APPROVED CONTENTS (#753): `settings` is the
   * approved resolution, and a tier that is not the version approved is named on the outcome, so the
   * thread says what was used — recorded even when there was nothing else to set up. ⚠ LONG SETUPS
   * HOLD THE THREAD'S FIRST RUN, which waits on its move; that is intended, the thread shows it is
   * moving. A failure is warned, naming the command, and the thread still opens: the operator fixes
   * it from there.
   */
  async function prepareTree(
    threadId: string,
    tree: ThreadTreeRecord,
    settings: TreeSettings,
  ): Promise<EnsoTreeSetupOutcome | undefined> {
    const prepared = await prepareThreadTree({
      project: tree.project,
      tree: tree.path,
      threads: settings.threads,
      environment,
      secretValues: knownSecretValues(ensoHome(environment), environment),
    })
    const pending = settings.pending.length === 0 ? {} : { pending: [...settings.pending] }
    const tiers = { setup: settings.threads.setup.tier, copy: settings.threads.copy.tier }
    if (prepared === undefined && settings.pending.length === 0) return undefined
    const outcome: EnsoTreeSetupOutcome =
      prepared === undefined
        ? { ok: true, copied: [], missing: [], steps: [], tiers, ...pending }
        : { ...prepared, ...pending }
    if (outcome.ok) {
      log.info('thread {threadId}: its tree {tree} is set up (#754)', { threadId, tree: tree.path })
      return outcome
    }
    const failed = outcome.steps.find((step) => step.exitCode !== 0)
    log.warn(
      'thread {threadId}: its tree {tree} is not fully set up (#754) — {command} exited {exitCode}, missing {missing}; the thread opens anyway',
      {
        threadId,
        tree: tree.path,
        command: failed?.command ?? null,
        exitCode: failed?.exitCode ?? null,
        missing: outcome.missing,
        tiers: outcome.tiers,
      },
    )
    return outcome
  }

  /**
   * The log a new thread built in its checkout moves onto its tree with (#551, `movedLog`), the tree's
   * record appended to it and its setup's after it (#754). Written at once, not at the runtime's first
   * flush: a thread disposed before its first message would otherwise have no file to be found by, and
   * its next build would mint again over the tree that exists.
   */
  function logOnTree(checkout: ThreadLog, minted: MintedTree): ThreadLog {
    const onTree = movedLog(checkout, minted.record.path)
    recordTree(onTree, minted)
    return onTree
  }

  /** The tree's record on the thread, and its setup's right after it when there was one (#754). */
  function recordTree(threadLog: ThreadLog, minted: MintedTree): void {
    threadLog.record(ENSO_THREAD_TREE_ENTRY, minted.record)
    if (minted.setup !== undefined) threadLog.record(ENSO_TREE_SETUP_ENTRY, minted.setup)
  }

  /**
   * A tree made before its project was trusted, prepared once it is (#754). A project's first thread
   * mints its tree at its first run, and the trust question is asked by that run's session — after
   * the tree exists. Untrusted at the mint, the project's own setup was not read; "Trust project"
   * prepares the tree now, before the run it held. Nothing when the thread has no tree, or its tree
   * already records a setup.
   */
  async function prepareTreeOnTrust(threadId: string, threadLog: ThreadLog): Promise<void> {
    const branch = threadLog.transcript()
    const tree = treeRecordOf(branch)
    if (tree === undefined || treeSetupOf(branch) !== undefined) return
    const settings = threadSettingsOf(tree.project)
    if (settings === undefined) return
    const setup = await prepareTree(threadId, tree, settings)
    if (setup !== undefined) threadLog.record(ENSO_TREE_SETUP_ENTRY, setup)
  }

  /** A thread's snapshot store (#551): beside its session, under its project — the checkout's or its tree's. */
  function storeOf(threadId: string, cwd: string): string | undefined {
    return projectsDir === undefined
      ? undefined
      : join(projectSnapshotsDir(projectsDir, projectIdOfCwd(projectsDir, cwd)), threadId)
  }

  return { treeKindOf, mintTree, logOnTree, recordTree, prepareTreeOnTrust, storeOf }
}
