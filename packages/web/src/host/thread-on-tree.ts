import { existsSync, unlinkSync } from 'node:fs'
import {
  type EnsoObservation,
  ensoLogger,
  type PromptOutcome,
  type ThreadRuntime,
  type ThreadTreeRecord,
} from '@enso/core'
import { disposeThreadTree } from '@enso/core/thread-tree'
import { HostCommandRefused } from './host-commands.ts'
import type { HostedThread } from './live-thread.ts'
import type { ThreadLog } from './thread-log.ts'
import type { TreeMaking } from './thread-tree-making.ts'

/**
 * A new thread that moves onto its own tree when it first runs (#551): see `treeOnFirstRun`. Over
 * `ThreadLog` (#801), so nothing here names the runtime.
 */

const log = ensoLogger('host')

/** A new thread's move onto its tree (#551), and what it reads from the host to make it (#801). */
export interface TreeMove {
  readonly threadId: string
  /** The project whose tree the thread moves onto. */
  readonly project: string
  /** The log the thread was built on in the checkout. */
  readonly checkout: ThreadLog
  readonly liveLogs: Map<string, ThreadLog>
  readonly environment: Record<string, string | undefined>
  readonly mintTree: TreeMaking['mintTree']
  readonly logOnTree: TreeMaking['logOnTree']
  readonly storeOf: TreeMaking['storeOf']
  readonly buildHosted: (threadId: string, threadLog: ThreadLog) => Promise<HostedThread>
}

/**
 * A new thread that moves onto its own tree when it first runs (#551). Until
 * then it runs nowhere — it is pi built in the checkout, answering previews and permission
 * checks there. At the first `prompt` (or `continueRun`) the tree is minted from the checkout as
 * it is THEN, the session — everything chosen before (model, thinking, mode, system prompt), the
 * tree's record, a header naming the tree — is written as the thread's file, and pi is built
 * again on it; the old build is disposed. Every runtime call goes to the build of the moment,
 * and every observer stays subscribed across the move. Runs that arrive while it moves wait for
 * it. A mint that is refused refuses the run, never runs it in the checkout instead, and the next
 * run tries again.
 *
 * ⚠ A MOVE THAT FAILS AFTER THE MINT IS UNDONE (#551): the tree and its branch are named
 * by the thread's id, so a tree left behind would refuse every later mint for this thread. Any
 * step failing after the mint — the write, the build, a dispose that came meanwhile — removes the
 * tree, its branch and store, and the file the move wrote, and puts the checkout session back.
 *
 * ⚠ DISPOSE STOPS THE MOVE: a build that finishes after the thread was disposed (the registry's
 * shutdown disposes busy threads too) is disposed in turn, and the run that waited is refused —
 * no pi is left running that nothing would dispose.
 *
 * ⚠ NO CHANGE WHILE IT MOVES: a mode, system prompt, host command or incident resolution would
 * land on the checkout session after its entries were written for the tree, and be lost. The
 * server's control routes cannot reach this (a moving run holds the thread's lease); the wrapper
 * refuses them itself, so no caller can.
 */
export function treeOnFirstRun(first: HostedThread, move: TreeMove): HostedThread {
  const { threadId, project, checkout, liveLogs, environment, mintTree, logOnTree, storeOf, buildHosted } = move
  let current = first
  let moved = false
  let disposed = false
  let moving: Promise<string | undefined> | undefined
  const observers = new Set<(observation: EnsoObservation) => void>()
  const fanOut = (observation: EnsoObservation): void => {
    for (const observer of observers) observer(observation)
  }
  let unbind = current.runtime.subscribe(fanOut)
  const whileMoving = `thread ${threadId} is moving onto its tree; try again once its first run has started`
  const isMoving = (): boolean => moving !== undefined && !moved

  /**
   * The mint undone: the tree, its branch and store, the file the move wrote; the checkout's log
   * back. The live log is touched only while it is still `treeLog`, the one this move built (a build
   * that threw had set it): the checkout's log takes it back, or — the thread disposed meanwhile —
   * it goes. Any other entry is a newer build's under the same id, and stays.
   */
  async function undoMove(tree: ThreadTreeRecord, why: string, treeLog?: ThreadLog): Promise<string> {
    const file = checkout.file
    if (file !== undefined && existsSync(file)) unlinkSync(file)
    if (treeLog !== undefined && liveLogs.get(threadId) === treeLog) {
      if (disposed) liveLogs.delete(threadId)
      else liveLogs.set(threadId, checkout)
    }
    const store = storeOf(threadId, tree.path)
    const removed =
      store === undefined ? undefined : await disposeThreadTree({ record: tree, store, force: true, environment })
    if (removed?.kind !== 'disposed') {
      log.error('thread {threadId}: the tree {tree} of a failed move could not be removed: {reason}', {
        threadId,
        tree: tree.path,
        reason: removed?.reason ?? 'no projects folder',
      })
    }
    return why
  }

  async function moveOntoTree(): Promise<string | undefined> {
    const minted = await mintTree({ threadId, project, name: threadId, from: { kind: 'checkout' } })
    if (minted.kind === 'refused') return minted.reason
    if (disposed) return undoMove(minted.record, `thread ${threadId} was disposed before it ran`)
    let next: HostedThread
    let treeLog: ThreadLog | undefined
    try {
      treeLog = logOnTree(checkout, minted)
      next = await buildHosted(threadId, treeLog)
    } catch (error) {
      log.error('thread {threadId} could not be built on its tree: {error}', { threadId, error })
      return undoMove(minted.record, `its build on the tree failed: ${String(error)}`, treeLog)
    }
    if (disposed) {
      next.runtime.dispose()
      return `thread ${threadId} was disposed before it ran`
    }
    unbind()
    const previous = current
    current = next
    unbind = next.runtime.subscribe(fanOut)
    moved = true
    previous.runtime.dispose()
    return undefined
  }
  /** Run `start` on the build on the tree — moving there first, once. */
  function onTree(outcome: PromptOutcome, start: () => void): void {
    if (disposed) {
      outcome.onRejected(`thread ${threadId} was disposed`)
      return
    }
    if (moved) {
      start()
      return
    }
    moving ??= moveOntoTree()
    moving.then(
      (refusal) => {
        if (refusal === undefined) {
          start()
          return
        }
        moving = undefined
        outcome.onRejected(`thread ${threadId} has no tree to run in: ${refusal}`)
      },
      (error: unknown) => {
        moving = undefined
        log.error('thread {threadId} could not move onto its tree: {error}', { threadId, error })
        outcome.onRejected(`thread ${threadId} could not move onto its tree: ${String(error)}`)
      },
    )
  }

  const runtime: ThreadRuntime = {
    prompt: (request, outcome) => onTree(outcome, () => current.runtime.prompt(request, outcome)),
    continueRun: (outcome) => onTree(outcome, () => current.runtime.continueRun(outcome)),
    answerDialog: (response) => current.runtime.answerDialog(response),
    openDialogs: () => current.runtime.openDialogs(),
    listCommands: () => current.runtime.listCommands(),
    modelState: () => current.runtime.modelState(),
    sessionUsage: () => current.runtime.sessionUsage(),
    runHostCommand: (run) =>
      isMoving() ? Promise.reject(new HostCommandRefused(whileMoving)) : current.runtime.runHostCommand(run),
    startHostFlow: (run, outcome) =>
      isMoving() ? outcome.onRejected(whileMoving) : current.runtime.startHostFlow(run, outcome),
    loginInProgress: () => current.runtime.loginInProgress(),
    cancelLogin: () => current.runtime.cancelLogin(),
    permissionModeState: () => current.runtime.permissionModeState(),
    setPermissionMode: (mode, outcome) =>
      isMoving() ? outcome.onRejected(whileMoving) : current.runtime.setPermissionMode(mode, outcome),
    setSystemPrompt: (choice) => (isMoving() ? whileMoving : current.runtime.setSystemPrompt(choice)),
    setModelRole: (record) => current.runtime.setModelRole(record),
    resolveIncident: (incidentId, resolution) =>
      isMoving() ? whileMoving : current.runtime.resolveIncident(incidentId, resolution),
    subscribe: (observer) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
    // A Stop while the thread moves stops the run it is about to start.
    abort: async () => {
      await moving
      return current.runtime.abort()
    },
    clearQueue: () => current.runtime.clearQueue(),
    dispose: () => {
      disposed = true
      unbind()
      current.runtime.dispose()
    },
  }
  return {
    runtime,
    get loadedExtensionPaths() {
      return current.loadedExtensionPaths
    },
    inspect: () => current.inspect(),
    emittedEvents: () => current.emittedEvents(),
    branchStats: () => current.branchStats(),
    branchEval: () => current.branchEval(),
    branchIncidentHistory: (thresholds) => current.branchIncidentHistory(thresholds),
    branchJudgeCases: (thresholds) => current.branchJudgeCases(thresholds),
    branchContext: () => current.branchContext(),
    previewSystemPrompt: (candidate) => current.previewSystemPrompt(candidate),
    branchRequestDetail: (request) => current.branchRequestDetail(request),
    forkPoint: () => current.forkPoint(),
    probeToolCall: (toolName, input) => current.probeToolCall(toolName, input),
    checkPermission: (request) => current.checkPermission(request),
    projectTrust: () => current.projectTrust(),
  }
}
