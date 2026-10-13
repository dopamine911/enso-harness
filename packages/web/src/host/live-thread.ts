import { existsSync } from 'node:fs'
import type {
  EnsoForkPoint,
  EnsoPermissionCheckRequest,
  EnsoPermissionVerdict,
  EnsoRiskThresholds,
  EnsoSystemPromptChoice,
  EnsoSystemPromptPreview,
  EnsoThreadEvent,
  EnsoTranscriptEntry,
  RuntimeCommand,
  ThreadRuntime,
} from '@enso/core'
import type { BranchContext, BranchRequestDetail } from './branch-context.ts'
import type { BranchEval } from './branch-eval.ts'
import type { BranchIncidentHistory } from './branch-incident-history.ts'
import type { BranchJudgeCases } from './branch-judge-cases.ts'
import type { BranchStats } from './branch-stats.ts'
import type { StoredThreads } from './stored-threads.ts'
import type { ThreadLog } from './thread-log.ts'

/**
 * What a live thread hands the server (#69, #801): the run contract (`ThreadRuntime`) and the host's
 * read-only view beside it. Built over pi by `hosted-thread.ts`; the server, the registry and the one
 * fake read only this, so nothing above the host names the runtime.
 */

/**
 * What pi's session for one hosted thread actually contains, read straight off its log (#86).
 *
 * Everything a run shows the browser is derived from the event stream; this is the source those
 * views derive from, for a human or an agent to cross-check against.
 */
export interface HostedThreadInspection {
  readonly sessionId: string
  readonly cwd: string
  readonly sessionDir: string
  /** The session file once pi has flushed it; null while the session lives only in memory. */
  readonly sessionFile: string | null
  /**
   * The branch, root to leaf, as the transcript of ours (L2): the runtime's entry shapes stay in
   * `transcript.ts`. Built when READ (#739), each read a fresh build: an inspection for the cwd
   * pays nothing for it.
   */
  readonly entries: readonly EnsoTranscriptEntry[]
  /** Slash commands this session registers. */
  readonly commands: readonly string[]
  /** The name a person gave the thread (#670): pi's newest `session_info`; `undefined` when none. */
  readonly name: string | undefined
}

export interface HostedThread {
  readonly runtime: ThreadRuntime
  /** How many extensions the loader found — the load receipt a caller may assert. */
  readonly loadedExtensionPaths: readonly string[]
  /**
   * Read-only view of the session as pi holds it. Deliberately here and NOT on
   * `ThreadRuntime`: that is the run contract, pinned by the one fake and the refusal-path
   * tests, and inspection is a host concern.
   */
  inspect(): HostedThreadInspection
  /** The emitted tail (#97): what the host's `emit` funnel saw, with provenance. A fresh copy per call. */
  emittedEvents(): EnsoThreadEvent[]
  /** The branch analysed (#45 phase 2): per request, per turn, per tool, off pi's own entries. */
  branchStats(): BranchStats
  /** The branch as the session eval reads it (#441): the transcript and the turns' usage. */
  branchEval(): BranchEval
  /** The branch's incident history (#468): records, their entries as stored, and a replay under `thresholds`. */
  branchIncidentHistory(thresholds: EnsoRiskThresholds): BranchIncidentHistory
  /** The branch's judge cases (#469): each call the judge would be asked about, and its redacted state. */
  branchJudgeCases(thresholds: EnsoRiskThresholds): BranchJudgeCases
  /** The branch's context, request by request (#361): what each was assembled from, by pi's own assembly. */
  branchContext(): BranchContext
  /**
   * The system prompt the next request would carry under `candidate` — pi's default for `null` —
   * section by section (#443). Changes nothing: the thread keeps its own choice. `busy` while a run
   * is in flight; `unsplittable` when pi's rendering does not split back into itself.
   */
  previewSystemPrompt(candidate: EnsoSystemPromptChoice | null): SystemPromptPreviewOutcome
  /** One request's context, element by element (#361 phase 3); undefined for a turn the branch does not have. */
  branchRequestDetail(request: number | 'next'): BranchRequestDetail | undefined
  /** The branch's fork point (#435): identity, then what it runs under — the manifest's live half. */
  forkPoint(): Promise<EnsoForkPoint>
  /**
   * What the loaded extensions would say about a tool call, through the runtime's own hook
   * runner — the verdict a model's call would meet, without a model. Inspection, like the
   * rest of this interface: the guards' contract is pinned in their own suite against a
   * hand-built ExtensionAPI; this is the one place the REAL runner, the real load order and
   * the real participants are asked together (docs/flows/guarded-tool-call.md, stated gap).
   * Runs no tool: a pass here is the hook's silence, not an execution.
   */
  probeToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallVerdict | undefined>
  /**
   * The thread's verdict for a value on a surface, in its mode NOW (#474, #881), layer by layer as a
   * call meets them: the guards' answer first (a refusal decides, in every mode), then the permission
   * engine's — the pattern that decided it and where that rule came from (`global`, the user's file;
   * `agent`, the mode's preset). Asked of the session's own guard and engine, never a second matcher,
   * and nothing is recorded. `undefined` when the engine has published no service for the session.
   */
  checkPermission(request: EnsoPermissionCheckRequest): EnsoPermissionVerdict | undefined
  /**
   * The project this session answers to, and whether it reads that project's own configuration NOW
   * (#502): pi's `trust.json`, the thread's "Trust this thread" record, or the default — and true
   * after a Trust answered in this session. What the project's own prompt library is read from and
   * gated on (#470). ⚠ The PROJECT, not the cwd: a thread on a tree (#551) answers with its checkout.
   */
  projectTrust(): ProjectTrustState
}

/**
 * A project's trust as a thread sees it (#470): the project's directory — a tree's checkout (#551),
 * else the session's cwd — and whether the thread reads that project's own configuration.
 */
export interface ProjectTrustState {
  readonly directory: string
  readonly trusted: boolean
}

/** A refusal from the `tool_call` hook, as the runtime's runner returns it — nothing when every handler passed. */
export interface ToolCallVerdict {
  readonly block: boolean
  readonly reason: string | undefined
}

/** What a preview answers (#443): the preview, or why there is none. */
export type SystemPromptPreviewOutcome =
  | { readonly kind: 'preview'; readonly preview: EnsoSystemPromptPreview }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unsplittable' }

/**
 * Stop: tell the runtime, then settle every pending question WHILE it stops, then wait for it.
 *
 * @invariant dialog-ask-answer-settled/stop-stops Stop stops: the run's abort settles every pending dialog as `aborted`.
 * The runtime is told FIRST so its loop holds the abort signal when a blocked `tool_call` handler returns
 * (a permission prompt): pi's `abort()` raises it synchronously, before its first `await`
 * (`agent-session.js` `abort` → `agent.abort()`). Then, while the runtime winds down, `abortAllDialogs()`
 * resolves each pending question to its cancel value with the glossary's outcome for exactly this,
 * `aborted`, and every follower hears `dialog-settled`; `refuseDialogsUntil` answers any question asked
 * before the stop finishes with its cancel value, showing nothing (ask_user's multi-select asks the next
 * option). Never only after the abort resolves: a question from a tool's `execute` (ask_user) holds the
 * run, pi's `abort()` waits for idle, and such a stop would wait on the card for ever (#376). The
 * vendor's permission prompt passes no signal of its own, so without this a Stop during it would wait
 * on a human: if the user says stop, it is stop.
 *
 * A stop must stop (thread-registry.test.ts's rule, one layer down): the dialogs settle even if the
 * runtime's abort rejects; the rejection still propagates, the cards still drop. Exported so that path
 * is pinned against a stop that rejects, which the real runtime's is not made to do.
 */
export async function stopRunSettlingDialogs(
  stopRuntime: () => Promise<void>,
  settleDialogs: (stopping: Promise<void>) => void,
): Promise<void> {
  const stopping = stopRuntime()
  settleDialogs(stopping)
  await stopping
}

/** What a live thread's view reads straight off its log (#801), beside what only the runtime knows. */
export interface LogReadsHost {
  readonly threadLog: ThreadLog
  /** The thread's commands now: an inspection lists their names. */
  readonly listCommands: () => RuntimeCommand[]
  readonly locate: StoredThreads['locate']
  readonly judgeCaseInputs: StoredThreads['judgeCaseInputs']
}

/** The inspection and the branch's readings of a live thread, read off its log (#86, #801). */
export function logReads(
  host: LogReadsHost,
): Pick<
  HostedThread,
  | 'inspect'
  | 'branchStats'
  | 'branchEval'
  | 'branchIncidentHistory'
  | 'branchJudgeCases'
  | 'branchContext'
  | 'branchRequestDetail'
  | 'forkPoint'
> {
  const { threadLog, listCommands, locate, judgeCaseInputs } = host
  return {
    branchStats: () => threadLog.stats(),
    branchEval: () => threadLog.eval(),
    branchIncidentHistory: (thresholds: EnsoRiskThresholds) => threadLog.incidentHistory(thresholds),
    branchJudgeCases: (thresholds: EnsoRiskThresholds) =>
      threadLog.judgeCases(judgeCaseInputs(threadLog.cwd, thresholds)),
    branchContext: () => threadLog.context(),
    branchRequestDetail: (request: number | 'next') => threadLog.requestDetail(request),
    async forkPoint(): Promise<EnsoForkPoint> {
      const threadId = threadLog.threadId
      return threadLog.forkPoint({
        threadId,
        cwd: threadLog.cwd,
        parentThreadId: (await locate(threadId))?.parentThreadId,
      })
    },
    inspect(): HostedThreadInspection {
      // ⚠ The log names the file the runtime WILL write, from creation — but the runtime flushes
      // lazily, holding every entry until the first assistant message. So the path is reported only
      // once the file exists; before that the branch below is the only copy.
      const plannedFile = threadLog.file
      return {
        sessionId: threadLog.threadId,
        cwd: threadLog.cwd,
        sessionDir: threadLog.directory,
        sessionFile: plannedFile !== undefined && existsSync(plannedFile) ? plannedFile : null,
        // ⚠ BUILT WHEN READ, not when inspected (#739): most callers want the cwd or the file, and the
        // transcript is the whole branch rebuilt, per `/git` or `/tree`. Read it at once: a getter read
        // later sees the branch as it is then.
        get entries() {
          return threadLog.transcript()
        },
        commands: listCommands().map((command) => command.name),
        name: threadLog.name(),
      }
    },
  }
}
