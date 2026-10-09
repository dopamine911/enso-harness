import { existsSync, writeFileSync } from 'node:fs'
import { type CreateAgentSessionFromServicesOptions, SessionManager } from '@earendil-works/pi-coding-agent'
import {
  customEntriesOf,
  type EnsoForkPoint,
  type EnsoRecordedModel,
  type EnsoRiskThresholds,
  type EnsoSessionIncidents,
  type EnsoSessionUsage,
  type EnsoTranscriptEntry,
  sessionIncidentsOf,
} from '@enso/core'
import { type BranchContext, type BranchRequestDetail, branchContext, branchRequestDetail } from './branch-context.ts'
import { type BranchEval, branchEval } from './branch-eval.ts'
import { type BranchIncidentHistory, branchIncidentHistory } from './branch-incident-history.ts'
import { type BranchJudgeCases, branchJudgeCases, type JudgeCaseInputs } from './branch-judge-cases.ts'
import { type BranchStats, branchStats } from './branch-stats.ts'
import { forkPointOf } from './fork-point.ts'
import { storedSessionUsage } from './session-usage.ts'
import { hasSentRequest } from './system-prompt.ts'
import { recordedModelOf, transcriptOf } from './transcript.ts'

/**
 * A thread's log (#801): the runtime's durable record of one thread, read and written in our terms,
 * and the store that opens, creates and forks it. The storage seam (#102, `docs/seams/storage.md`):
 * THE ONE FILE that touches the runtime's session manager or its file layout, so a later store is a
 * change here and nowhere else. Everything above reads a log through {@link ThreadLog}; what crosses
 * is ours — the transcript as `EnsoTranscriptEntry`, the branch's readings as the host's own shapes.
 *
 * A log is open in memory and writes nothing until an append. The runtime writes a log's file only at
 * its first assistant message, so a log holding none has no file until {@link ThreadLog.writeIfUnflushed}
 * writes it the way the runtime's first flush does.
 *
 * A FORK IS TAKEN FROM THE FILE, OUTSIDE ANY RUNTIME (#433): the source is opened (building nothing,
 * #86) and forked as the runtime's `/fork` does at its default position `before` — the new log's
 * branch ends at the forked message's PARENT ({@link forkedLog}), or is empty when the message is the
 * root, naming its parent either way. A live source and a cold one fork alike: a live thread's file
 * holds every entry its memory does once flushed, and one never flushed has no file to fork. Outside
 * a runtime its `session_before_fork` extension hook does not fire; no loaded extension handles it.
 */

/** What a log answers for the prompt at an entry (#433): its words, or why the entry is not a prompt. */
export type PromptAtEntry =
  | {
      readonly kind: 'prompt'
      readonly text: string
      /** The entry before it: where a fork's branch ends; `null` for the root. */
      readonly parentEntryId: string | null
    }
  | { readonly kind: 'no-entry' }
  | { readonly kind: 'not-a-user-message' }

/** The model and level a log recorded before its first message (#616): the runtime restores neither then. */
export interface ChoiceBeforeFirstMessage {
  readonly provider: string
  readonly modelId: string
  readonly thinkingLevel: string | undefined
}

/** One thread's log, open in memory. Its facts are read when asked: a fork turns the log it was taken through into the fork. */
export interface ThreadLog {
  readonly threadId: string
  /** The directory the thread runs in, as the log's header records it. */
  readonly cwd: string
  /** The directory the log's file is in. */
  readonly directory: string
  /** The file the log is written to, from creation — even before the runtime has written it. */
  readonly file: string | undefined
  /** The name a person gave the thread (#670): the newest one recorded; `undefined` when none. */
  name(): string | undefined
  /** The branch, root to leaf, as the transcript of ours (L2). */
  transcript(): EnsoTranscriptEntry[]
  /** Every entry on every branch, as the transcript of ours: where the permission mode is read (#496). */
  everyEntry(): EnsoTranscriptEntry[]
  /** Every usage in the log, on every branch, by the runtime's rule (`session-usage.ts`, #45). */
  usage(): EnsoSessionUsage
  /** What the branch records it last ran on (#434). */
  recordedModel(): EnsoRecordedModel | undefined
  /** The branch's incidents (#466), folded as the guard folds them on replay. */
  incidents(): EnsoSessionIncidents
  /** Whether the branch holds a request already (#443): a system prompt is fixed from then on. */
  hasSentRequest(): boolean
  /** The branch analysed (#45 phase 2): per request, per turn, per tool. */
  stats(): BranchStats
  /** The branch's context, request by request (#361). */
  context(): BranchContext
  /** One request's context, element by element (#361 phase 3); undefined for a turn the branch does not have. */
  requestDetail(request: number | 'next'): BranchRequestDetail | undefined
  /** The branch as the session eval reads it (#441). */
  eval(): BranchEval
  /** The branch's incident history (#468), replayed under `thresholds`. */
  incidentHistory(thresholds: EnsoRiskThresholds): BranchIncidentHistory
  /** The branch's judge cases (#469). */
  judgeCases(inputs: JudgeCaseInputs): BranchJudgeCases
  /** The branch's fork point (#435), for the thread these facts name. */
  forkPoint(facts: {
    readonly threadId: string
    readonly cwd: string
    readonly parentThreadId: string | undefined
  }): EnsoForkPoint
  /** The prompt at `entryId` (#433). */
  promptAt(entryId: string): PromptAtEntry
  /** The model and level chosen before the first message (#616); undefined once the branch has a message, or when none was chosen. */
  choiceBeforeFirstMessage(): ChoiceBeforeFirstMessage | undefined
  /** Append a custom entry of ours. */
  record(customType: string, data: unknown): void
  /** Name the thread (#670): the entry the runtime's own `/name` writes and its listing reads back. */
  rename(name: string): void
  /** Write the log's file the way the runtime's first flush does, when it has none yet (#433). A file already there is left alone. */
  writeIfUnflushed(): void
}

/** The runtime's own handle on a log: what building a live thread hands the runtime, and nothing else may hold. */
export type RuntimeLog = CreateAgentSessionFromServicesOptions['sessionManager']

/** Each log's runtime handle, kept here so nothing above the seam reaches it except through {@link runtimeLogOf}. */
const runtimeLogs = new WeakMap<ThreadLog, SessionManager>()

function logOver(manager: SessionManager): ThreadLog {
  const log: ThreadLog = {
    get threadId() {
      return manager.getSessionId()
    },
    get cwd() {
      return manager.getCwd()
    },
    get directory() {
      return manager.getSessionDir()
    },
    get file() {
      return manager.getSessionFile()
    },
    name: () => manager.getSessionName(),
    transcript: () => transcriptOf(manager.getBranch()),
    everyEntry: () => transcriptOf(manager.getEntries()),
    usage: () => storedSessionUsage(manager.getEntries()),
    recordedModel: () => recordedModelOf(manager.getBranch()),
    incidents: () => sessionIncidentsOf(customEntriesOf(transcriptOf(manager.getBranch()))),
    hasSentRequest: () => hasSentRequest(manager.getBranch()),
    stats: () => branchStats(manager.getBranch()),
    context: () => branchContext(manager.getBranch()),
    requestDetail: (request) => branchRequestDetail(manager.getBranch(), request),
    eval: () => branchEval(manager.getBranch()),
    incidentHistory: (thresholds) => branchIncidentHistory(manager.getBranch(), thresholds),
    judgeCases: (inputs) => branchJudgeCases(manager.getBranch(), inputs),
    forkPoint: (facts) => forkPointOf(manager.getBranch(), facts),
    promptAt(entryId) {
      const entry = manager.getEntry(entryId)
      if (entry === undefined) return { kind: 'no-entry' }
      if (entry.type !== 'message' || entry.message.role !== 'user') return { kind: 'not-a-user-message' }
      return { kind: 'prompt', text: userMessageText(entry.message.content), parentEntryId: entry.parentId }
    },
    choiceBeforeFirstMessage() {
      if (manager.buildSessionContext().messages.length > 0) return undefined
      const branch = manager.getBranch()
      const modelEntry = branch.findLast((entry) => entry.type === 'model_change')
      if (modelEntry?.type !== 'model_change') return undefined
      const thinkingEntry = branch.findLast((entry) => entry.type === 'thinking_level_change')
      return {
        provider: modelEntry.provider,
        modelId: modelEntry.modelId,
        thinkingLevel: thinkingEntry?.type === 'thinking_level_change' ? thinkingEntry.thinkingLevel : undefined,
      }
    },
    record: (customType, data) => {
      manager.appendCustomEntry(customType, data)
    },
    rename: (name) => {
      manager.appendSessionInfo(name)
    },
    writeIfUnflushed() {
      const file = manager.getSessionFile()
      if (file === undefined || existsSync(file)) return
      const lines = [manager.getHeader(), ...manager.getEntries()].map((fileEntry) => `${JSON.stringify(fileEntry)}\n`)
      writeFileSync(file, lines.join(''), { flag: 'wx' })
    },
  }
  runtimeLogs.set(log, manager)
  return log
}

/** A user message's text as the runtime's `/fork` prefills it (`extractUserMessageText`): its text parts, joined; images dropped. */
function userMessageText(content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
}

/** The log in `file`, open in memory — building nothing, writing nothing (#86). `cwd` replaces the directory its header records, for a log about to be forked onto a tree (#551). */
export function openLog(file: string, cwd?: string): ThreadLog {
  return logOver(cwd === undefined ? SessionManager.open(file) : SessionManager.open(file, undefined, cwd))
}

/** A new log under `threadId` (#95), for a thread in `cwd`, its file in `directory` — the runtime's default when none. */
export function createLog(threadId: string, cwd: string, directory: string | undefined): ThreadLog {
  return logOver(SessionManager.create(cwd, directory, { id: threadId }))
}

/** A log of no thread, in memory only: the probe the catalogue's models are read through (#688). */
export function probeLog(agentDir: string): RuntimeLog {
  return SessionManager.inMemory(agentDir)
}

/**
 * The fork of `source` before its prompt at `parentEntryId` (#433): the branch up to that entry, or
 * nothing for a root prompt, under a new thread id, naming `sourceFile` as its parent. A branched fork
 * turns `source` into it; the file `sourceFile` is never written.
 */
export function forkedLog(source: ThreadLog, parentEntryId: string | null, sourceFile: string): ThreadLog {
  const manager = runtimeLogs.get(source)
  if (manager === undefined) throw new Error(`thread ${source.threadId}: its log was not opened here`)
  if (parentEntryId === null) {
    const fork = SessionManager.create(manager.getCwd(), manager.getSessionDir())
    fork.newSession({ parentSession: sourceFile })
    return logOver(fork)
  }
  manager.createBranchedSession(parentEntryId)
  return source
}

/**
 * The log of a thread built in its checkout, moved onto its tree (#551): everything it holds written
 * now as its file under a header naming `cwd`, then opened from that file. Written at once, not at the
 * runtime's first flush: a thread disposed before its first message would otherwise have no file to
 * be found by. Opened from the file so the runtime appends to it and never writes it a second time
 * (its first flush opens the file `wx`). The checkout's log is not touched: a move undone leaves it as
 * it was.
 */
export function movedLog(checkout: ThreadLog, cwd: string): ThreadLog {
  const manager = runtimeLogs.get(checkout)
  if (manager === undefined) throw new Error(`thread ${checkout.threadId}: its log was not opened here`)
  const file = manager.getSessionFile()
  if (file === undefined) throw new Error(`thread ${manager.getSessionId()} has no session file path`)
  const header = { ...manager.getHeader(), cwd }
  const lines = [header, ...manager.getEntries()].map((fileEntry) => `${JSON.stringify(fileEntry)}\n`)
  writeFileSync(file, lines.join(''))
  return logOver(SessionManager.open(file))
}

/** The runtime's handle on `log`: the one way a live thread is built on it. */
export function runtimeLogOf(log: ThreadLog): RuntimeLog {
  const manager = runtimeLogs.get(log)
  if (manager === undefined) throw new Error(`thread ${log.threadId}: its log was not opened here`)
  return manager
}
