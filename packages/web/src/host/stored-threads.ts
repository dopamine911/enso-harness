import { existsSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  type EnsoForkPoint,
  type EnsoRecordedModel,
  type EnsoRiskThresholds,
  type EnsoSessionUsage,
  type EnsoTranscriptEntry,
  DEFAULT_GUARD_POLICY,
  isEnsoProjectId,
} from '@enso/core'
import { ensoHome, projectSessionsDir } from '@enso/core/paths'
import { knownSecretValues } from '@enso/core/secrets'
import type { BranchContext, BranchRequestDetail } from './branch-context.ts'
import type { BranchEval } from './branch-eval.ts'
import type { BranchIncidentHistory } from './branch-incident-history.ts'
import type { BranchJudgeCases, JudgeCaseInputs } from './branch-judge-cases.ts'
import type { BranchStats } from './branch-stats.ts'
import {
  createSessionFiles,
  piSessionDirectories,
  type SessionFileHeader,
  type SessionFileSummary,
  sessionFilesIn,
  threadIdOfFileName,
} from './session-files.ts'
import { openLog, runtimeAgentDir, type ThreadLog } from './thread-log.ts'

/**
 * A host's stored threads (#95, #739): the runtime's logs on disk in the directories it serves, listed,
 * located by id, and read cold — one open, nothing built (#86). Over `ThreadLog` (#801), so nothing
 * here names the runtime: `runtimeAgentDir` (`thread-log.ts`) is where it files logs by default.
 */

/** One of pi's session files in a directory this host serves, as pi lists it (#95). */
export interface StoredThread {
  /** pi's session id — the thread id it was created under. */
  readonly id: string
  readonly path: string
  /** The directory the session runs in — pi's header records it at creation, and it never changes (#395). */
  readonly cwd: string
  readonly modified: Date
  readonly messageCount: number
  /** The first user message, verbatim; empty for a session with none. */
  readonly firstMessage: string
  /** The name a person gave it (#670): pi's newest `session_info`; absent when none. */
  readonly name?: string
  /**
   * The thread it was forked from (#433): its header's `parentSession` file, as that file's
   * session id. Absent for a thread that is no fork, and for one whose parent file is gone.
   */
  readonly parentThreadId?: string
}

/** A thread's session file as a lookup by id finds it (#739): its header's facts, nothing counted. */
type LocatedThread = Pick<StoredThread, 'id' | 'path' | 'cwd' | 'parentThreadId'>

/** One stored session as `readStoredThread` reads it — both halves from one open of the file. */
export interface StoredThreadRead {
  /** The directory the session runs in (#395), from its header. */
  readonly cwd: string
  /** The branch, root to leaf. */
  readonly transcript: EnsoTranscriptEntry[]
  /** Every usage in the file, on every branch, by pi's rule (`session-usage.ts`); no context. */
  readonly usage: EnsoSessionUsage
  /** What the branch records it last ran on (#434); `undefined` when it records neither a model nor a level. */
  readonly recordedModel: EnsoRecordedModel | undefined
  /** The name a person gave it (#670): pi's newest `session_info`; `undefined` when none. */
  readonly name: string | undefined
}

/** A stored thread as `readStoredThreadStats` reads it. */
export interface StoredThreadStats {
  readonly usage: EnsoSessionUsage
  readonly branch: BranchStats
}

/** A stored thread as `readStoredThreadContext` reads it. */
export interface StoredThreadContext {
  readonly usage: EnsoSessionUsage
  readonly context: BranchContext
}

/** What the stored threads read from the host: its projects folder, the rule for what it serves, and its environment (#801). */
export interface StoredThreadsHost {
  readonly projectsDir: string | undefined
  readonly servesDirectory: (directory: string) => boolean
  readonly environment: Record<string, string | undefined>
}

/** A host's stored threads: the listing, a lookup by id, and every cold read (#801). */
export interface StoredThreads {
  readonly listSessions: () => Promise<StoredThread[]>
  readonly locate: (threadId: string) => Promise<LocatedThread | undefined>
  readonly storedSession: (threadId: string) => Promise<LocatedThread | undefined>
  readonly readStoredThread: (threadId: string) => Promise<StoredThreadRead | undefined>
  readonly readStoredThreadStats: (threadId: string) => Promise<StoredThreadStats | undefined>
  readonly readStoredThreadContext: (threadId: string) => Promise<StoredThreadContext | undefined>
  readonly readStoredRequestDetail: (
    threadId: string,
    request: number | 'next',
  ) => Promise<BranchRequestDetail | undefined>
  readonly readStoredForkPoint: (threadId: string) => Promise<EnsoForkPoint | undefined>
  readonly readStoredThreadEval: (threadId: string) => Promise<BranchEval | undefined>
  readonly readStoredIncidentHistory: (
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ) => Promise<BranchIncidentHistory | undefined>
  readonly judgeCaseInputs: (cwd: string, thresholds: EnsoRiskThresholds) => JudgeCaseInputs
  readonly readStoredJudgeCases: (
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ) => Promise<BranchJudgeCases | undefined>
  readonly sessionFilesOf: (threadId: string) => Promise<string[]>
}

export function createStoredThreads(host: StoredThreadsHost): StoredThreads {
  const { projectsDir, servesDirectory, environment } = host

  /**
   * The runtime's log files, each read once per change of it (#739): a lookup by id reads the
   * directories and the HEADER of the file named for the id; the listing summarizes a file once,
   * and again only when it changed. The runtime's own listing parses every line of every file on
   * every call, which a cold read cannot afford.
   */
  const sessionFiles = createSessionFiles()

  /**
   * The session files, in the order a thread id resolves (#552): one group per project folder's
   * `sessions/` — every folder, registered or not, `locate` must tell "none" from "not yours" — in
   * NAME order, then pi's default session directories under the ONE agent dir (the env pin above)
   * as the last group, where the terminal launcher filed sessions before the project folders and
   * where a session of a project whose directory is gone still sits. Sessions pi has not flushed
   * yet (no assistant message) have no file and are not here — there is nothing to come back to.
   */
  async function sessionFileGroups(): Promise<string[][]> {
    // pi's agent dir as the env names it NOW, as `listAll` read it: a later host in the process re-pins it.
    const piDirectories = await piSessionDirectories(runtimeAgentDir())
    const groups = [...projectSessionDirectories().map((directory) => [directory]), piDirectories]
    return Promise.all(groups.map(async (directories) => (await Promise.all(directories.map(sessionFilesIn))).flat()))
  }

  /**
   * One thread per id, in group order, and within a group the most recently written file first.
   * ⚠ The FIRST group holding an id is the thread's, never the newest copy: when the migration
   * kept a legacy copy beside a file the project folder already held (same name, same id), the
   * folder's copy is the thread and the legacy one is not — one thread, the same one on every call.
   */
  function firstPerId<File extends SessionFileHeader>(groups: readonly (readonly File[])[]): File[] {
    const byId = new Map<string, File>()
    for (const group of groups) {
      for (const file of group.toSorted((first, second) => second.fileModifiedMs - first.fileModifiedMs)) {
        if (!byId.has(file.id)) byId.set(file.id, file)
      }
    }
    return [...byId.values()]
  }

  /**
   * The thread a fork's header names by FILE (#433): that file's session id. The path is tried
   * first; it misses once the parent has moved into its project folder (#552's migration), so the
   * file's NAME — `<timestamp>_<id>.jsonl`, unique by id — is tried next among the listed files. A
   * parent file that is gone names no thread, so the fork carries none.
   */
  async function parentThreadIdOf(parentSessionPath: string, files: readonly string[]): Promise<string | undefined> {
    const wanted = resolve(parentSessionPath)
    const fileName = basename(wanted)
    const candidates = [
      ...files.filter((file) => resolve(file) === wanted),
      ...files.filter((file) => basename(file) === fileName && resolve(file) !== wanted),
    ]
    for (const candidate of candidates) {
      const header = await sessionFiles.header(candidate)
      if (header !== undefined) return header.id
    }
    return undefined
  }

  /**
   * Each file's summary, all read at once (#739). ⚠ A COLD listing holds every changed file's text
   * together, as the runtime's own listing does on every call. Here it is paid once per change of a
   * file: a listing after a run re-reads only what the run wrote, and an unchanged one reads nothing.
   */
  async function summariesOf(files: readonly string[]): Promise<SessionFileSummary[]> {
    const summaries = await Promise.all(files.map((file) => sessionFiles.summary(file)))
    return summaries.filter((summary): summary is SessionFileSummary => summary !== undefined)
  }

  /** The listing: every session file summarized — once per change of the file (#739). */
  async function everySession(): Promise<StoredThread[]> {
    const groups = await sessionFileGroups()
    const files = groups.flat()
    sessionFiles.retainOnly(new Set(files))
    const summarized = await Promise.all(groups.map(summariesOf))
    const listed = firstPerId(summarized)
    const stored = await Promise.all(
      listed.map(async (summary) => {
        const parentPath = summary.parentSessionPath
        return storedThreadOf(summary, parentPath === undefined ? undefined : await parentThreadIdOf(parentPath, files))
      }),
    )
    return stored.toSorted((first, second) => second.modified.getTime() - first.modified.getTime())
  }

  function storedThreadOf(summary: SessionFileSummary, parentThreadId: string | undefined): StoredThread {
    // ⚠ pi's `modified` is the last message's time, and a fork COPIES its source's messages
    // with their timestamps (#447): a fork taken now of a thread idle for hours read as hours
    // old, and sorted with it. The header's `created` is when the fork was made; for any other
    // session it is never later than its last message, so the later of the two changes nothing else.
    const created = summary.created.getTime()
    const modified = Number.isNaN(created) ? summary.modified : new Date(Math.max(summary.modified.getTime(), created))
    return {
      id: summary.id,
      path: summary.path,
      cwd: summary.cwd,
      modified,
      messageCount: summary.messageCount,
      // Empty for a file with none — an empty fork's (#433) — which is no title.
      firstMessage: summary.firstMessage,
      // A blank `session_info` already reads as no name: it clears the title.
      ...(summary.name === undefined ? {} : { name: summary.name }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    }
  }

  /**
   * Every project folder's `sessions/` — every folder, registered or not; none when there is no
   * projects folder. In NAME order, not the filesystem's: two folders holding one id (a hand-made
   * copy beside a moved checkout's) must resolve to the same one on every call and on every
   * machine — the lexically first folder's.
   */
  function projectSessionDirectories(): string[] {
    if (projectsDir === undefined || !existsSync(projectsDir)) return []
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((directoryEntry) => directoryEntry.isDirectory() && isEnsoProjectId(directoryEntry.name))
      .map((directoryEntry) => directoryEntry.name)
      .toSorted()
      .map((projectId) => projectSessionsDir(projectsDir, projectId))
      .filter((directory) => existsSync(directory))
  }

  async function listSessions(): Promise<StoredThread[]> {
    return (await everySession()).filter((stored) => servesDirectory(stored.cwd))
  }

  /**
   * Every file under `threadId`, the thread's own first (`firstPerId`'s order) — a legacy copy
   * beside a migrated one too — and the files of every group, for the parent's lookup. Only the
   * files NAMED for the id are opened, and only their headers (#739): another thread's file is
   * never read. A file whose name is not pi's shape is a candidate for any id; its header decides.
   */
  async function sessionFilesUnder(threadId: string): Promise<{ under: SessionFileHeader[]; files: string[] }> {
    const groups = await sessionFileGroups()
    const headers = await Promise.all(
      groups.map(async (group) => {
        const candidates = group.filter((file) => {
          const nameThreadId = threadIdOfFileName(basename(file))
          return nameThreadId === undefined || nameThreadId === threadId
        })
        const read = await Promise.all(candidates.map((file) => sessionFiles.header(file)))
        return read.filter((header): header is SessionFileHeader => header?.id === threadId)
      }),
    )
    const own = firstPerId(headers)
    const owned = new Set(own)
    const others = headers.flat().filter((header) => !owned.has(header))
    return { under: [...own, ...others], files: groups.flat() }
  }

  /** The thread's session file, served or not — `createSession` must tell "none" from "not yours". */
  async function locate(threadId: string): Promise<LocatedThread | undefined> {
    const { under, files } = await sessionFilesUnder(threadId)
    const [header] = under
    if (header === undefined) return undefined
    const parentThreadId =
      header.parentSessionPath === undefined ? undefined : await parentThreadIdOf(header.parentSessionPath, files)
    return {
      id: header.id,
      path: header.path,
      cwd: header.cwd,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    }
  }

  async function storedSession(threadId: string): Promise<LocatedThread | undefined> {
    const located = await locate(threadId)
    return located !== undefined && servesDirectory(located.cwd) ? located : undefined
  }

  async function storedSessionPath(threadId: string): Promise<string | undefined> {
    return (await storedSession(threadId))?.path
  }

  /** A stored thread's log, open in memory — nothing built (#86); undefined for no file. */
  async function storedLog(threadId: string): Promise<ThreadLog | undefined> {
    const path = await storedSessionPath(threadId)
    return path === undefined ? undefined : openLog(path)
  }

  async function readStoredThread(threadId: string): Promise<StoredThreadRead | undefined> {
    const located = await storedSession(threadId)
    if (located === undefined) return undefined
    // Open in memory; nothing is written until an append.
    const stored = openLog(located.path)
    return {
      cwd: located.cwd,
      transcript: stored.transcript(),
      usage: stored.usage(),
      recordedModel: stored.recordedModel(),
      name: stored.name(),
    }
  }

  async function readStoredThreadStats(threadId: string): Promise<StoredThreadStats | undefined> {
    const stored = await storedLog(threadId)
    return stored === undefined ? undefined : { usage: stored.usage(), branch: stored.stats() }
  }

  async function readStoredThreadContext(threadId: string): Promise<StoredThreadContext | undefined> {
    const stored = await storedLog(threadId)
    return stored === undefined ? undefined : { usage: stored.usage(), context: stored.context() }
  }

  async function readStoredRequestDetail(
    threadId: string,
    request: number | 'next',
  ): Promise<BranchRequestDetail | undefined> {
    return (await storedLog(threadId))?.requestDetail(request)
  }

  async function readStoredForkPoint(threadId: string): Promise<EnsoForkPoint | undefined> {
    const located = await storedSession(threadId)
    if (located === undefined) return undefined
    return openLog(located.path).forkPoint({
      threadId,
      cwd: located.cwd,
      parentThreadId: located.parentThreadId,
    })
  }

  async function readStoredThreadEval(threadId: string): Promise<BranchEval | undefined> {
    return (await storedLog(threadId))?.eval()
  }

  async function readStoredIncidentHistory(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchIncidentHistory | undefined> {
    return (await storedLog(threadId))?.incidentHistory(thresholds)
  }

  /**
   * What a judge case is built from in `cwd` (#469): the guard's default fragments and the user's
   * secret values (`ENSO_HOME`, as the quarantine above reads it), read per call so a key added
   * since is still scrubbed.
   */
  function judgeCaseInputs(cwd: string, thresholds: EnsoRiskThresholds): JudgeCaseInputs {
    return {
      thresholds,
      cwd,
      secretPathFragments: DEFAULT_GUARD_POLICY.secretPathFragments,
      secretValues: knownSecretValues(ensoHome(environment), environment),
    }
  }

  async function readStoredJudgeCases(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchJudgeCases | undefined> {
    const stored = await storedSession(threadId)
    if (stored === undefined) return undefined
    return openLog(stored.path).judgeCases(judgeCaseInputs(stored.cwd, thresholds))
  }

  /** Every session file under `threadId`: the project folders' and pi's own — a legacy copy beside a migrated one too. */
  async function sessionFilesOf(threadId: string): Promise<string[]> {
    return (await sessionFilesUnder(threadId)).under.map((header) => header.path)
  }

  return {
    listSessions,
    locate,
    storedSession,
    readStoredThread,
    readStoredThreadStats,
    readStoredThreadContext,
    readStoredRequestDetail,
    readStoredForkPoint,
    readStoredThreadEval,
    readStoredIncidentHistory,
    judgeCaseInputs,
    readStoredJudgeCases,
    sessionFilesOf,
  }
}
