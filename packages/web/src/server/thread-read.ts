import type {
  EnsoInterruptedTail,
  EnsoModelState,
  EnsoOpenDialog,
  EnsoPermissionModeState,
  EnsoRecordedModel,
  EnsoSessionUsage,
  EnsoTranscriptEntry,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import type { AgentHost, StoredThreadRead } from '../host/agent-host.ts'
import type { ProjectRegistry } from './projects.ts'
import type { ThreadRegistry, ThreadView } from './thread-registry.ts'
import { interruptedTail, transcriptToMessages } from './transcript-to-messages.ts'

/**
 * THE LIVE-OR-COLD READ, ONCE (#214).
 *
 * What the server holds for one thread, as a pane mounts it: the branch as messages, whether it
 * is live, and the mode it opens in. `GET …/follow`'s snapshot and `GET …/history`'s payload
 * are the same question asked by two routes; they were implemented twice and had drifted apart
 * in two visible ways. The follow re-peeked the registry after the awaited cold read and the
 * history route did not, so a thread built DURING the read was served the FILE's messages and
 * the FILE's permission mode by `/history`, while the follow opened a tick later reported the
 * same thread live with pi's own branch and the session's own mode. That is the shape invariant
 * 5 refuses — a surface presenting one state while the server holds another — with no MISMATCH
 * to name it, because each side is internally consistent. It is on the boot path: boot adopts a
 * named thread from `/history` before showing a pane, so another tab or `enso-thread` prompting
 * the same id during that fetch is enough.
 *
 * ⚠ THE RE-PEEK IS THE POINT, and it is why the cold read is awaited BEFORE anything is
 * decided: a thread that went live during the read is then read from pi's memory, which is
 * fresher than the file and resumable. Deciding any field from the PRE-await peek is the
 * bug this file exists to have exactly one copy of.
 *
 * The two routes differ in one thing, and it is a contract rather than drift: for an id the
 * server holds neither live nor on disk, `/history` is a 404 while a follow is an EMPTY
 * snapshot — observation may precede the first prompt, and must, or the prompt's opening
 * events have no follower. `present` is that difference, and the only branch a caller takes.
 *
 * The cost, stated: `/history` asks for `busy`, `generation` and `openDialogs` it does not
 * send. One read of a live runtime's open questions is cheaper than two shapes of this
 * answer — two shapes is what drifted.
 *
 * Named for what it produces rather than #214's suggested `readThreadView`: `ThreadView` is
 * already the registry's word for a live entry, and this is the answer a pane mounts with,
 * live or cold.
 */

export interface ThreadReadDeps {
  readonly threads: ThreadRegistry
  readonly host: AgentHost
  readonly projects: ProjectRegistry
}

/** One thread as of this read: what a pane mounts with, and what the follow's snapshot says. */
export interface ThreadMount {
  /** Does the server hold this id at all — a live thread or a file? `false` is `/history`'s 404. */
  readonly present: boolean
  /** The branch as the messages a chat mounts with: pi's memory when live, the file when cold. */
  readonly messages: UIMessage[]
  /** Set only when the branch ends inside a turn (#109). */
  readonly interrupted: EnsoInterruptedTail | undefined
  readonly live: boolean
  readonly busy: boolean
  readonly generation: number
  /** The live session's own mode, or the one this branch persists. */
  readonly permissionMode: EnsoPermissionModeState
  /**
   * The live session's model and thinking level (#338 slice 2); `null` when not live — nothing is
   * built to say what pi would run, or which levels it would offer (#86).
   */
  readonly model: EnsoModelState | null
  /**
   * What a NOT-live thread's branch records it last ran on (#434): the last `model_change` and
   * `thinking_level_change` on the path — what pi restores on open. The page shows it labelled
   * recorded; never set on a live thread, whose `model` is the truth. `undefined` when the branch
   * records neither.
   */
  readonly recordedModel: EnsoRecordedModel | undefined
  /** Every question pi is blocked on, oldest first (#114); empty when the thread is not live. */
  readonly openDialogs: EnsoOpenDialog[]
  /**
   * The tree pi runs this thread in (#44): the live session's own, the stored session's (pi fixed
   * it at creation), or — for a thread with neither — its project's, where it will be built (#395).
   */
  readonly cwd: string
  /** The project that directory is (#395); `undefined` when it is no registered project — the thread is not served. */
  readonly projectId: string | undefined
  /** What the session has spent and how full its context is (#45): pi's live totals, or the file's with no context. */
  readonly usage: EnsoSessionUsage
}

/** A thread with neither a session nor a file has spent nothing and has no window to fill. */
const NO_USAGE: EnsoSessionUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null }

/** A live thread's mount reads no file. */
const NOT_READ = { stored: undefined, storedUnserved: false } as const

/**
 * The file, read only for a thread that is not live here — nothing is built to answer (#86).
 * `readStoredThread` answers nothing both for "never stored" and for "stored in a directory that is
 * no project here"; only the second has a file, and it must not read as a new thread (PR #399 review).
 */
async function readCold(
  host: AgentHost,
  threadId: string,
): Promise<{ readonly stored: StoredThreadRead | undefined; readonly storedUnserved: boolean }> {
  const stored = await host.readStoredThread(threadId)
  if (stored !== undefined) return { stored, storedUnserved: false }
  return { stored, storedUnserved: (await host.storedThreadDirectory(threadId)) !== undefined }
}

export async function readThreadMount(deps: ThreadReadDeps, threadId: string): Promise<ThreadMount> {
  const { threads, host, projects } = deps
  const live = threads.peek(threadId)
  const { stored, storedUnserved } = live === undefined ? await readCold(host, threadId) : NOT_READ
  const nowLive = threads.peek(threadId)
  const inspection = nowLive?.hosted.inspect()
  const transcript = inspection === undefined ? (stored?.transcript ?? []) : inspection.entries
  return {
    present: nowLive !== undefined || stored !== undefined,
    messages: transcriptToMessages(transcript),
    ...(nowLive === undefined ? coldReading(host, transcript, stored) : liveReading(nowLive, transcript)),
    ...placeOf(projects, threadId, inspection?.cwd ?? stored?.cwd, storedUnserved),
  }
}

/** What a mount says about the run, read one way per kind of thread — a live one's session, or a cold one's file. */
type RunReading = Pick<
  ThreadMount,
  | 'interrupted'
  | 'live'
  | 'busy'
  | 'generation'
  | 'permissionMode'
  | 'model'
  | 'recordedModel'
  | 'openDialogs'
  | 'usage'
>

/**
 * A thread live here: its session says it all. `interrupted` reads the ENTRIES, not the mapped
 * messages (#220): a transcript's last entry can be a tool result or a custom entry. And a torn tail
 * is a fact about a run that ENDED (#412): a run still going — parked on an open question, which by
 * construction ends on a call with no result yet — has not torn.
 */
function liveReading(thread: ThreadView, transcript: readonly EnsoTranscriptEntry[]): RunReading {
  const { runtime } = thread.hosted
  return {
    interrupted: thread.busy ? undefined : interruptedTail(transcript),
    live: true,
    busy: thread.busy,
    generation: thread.generation,
    permissionMode: runtime.permissionModeState(),
    model: runtime.modelState(),
    recordedModel: undefined,
    openDialogs: runtime.openDialogs(),
    usage: runtime.sessionUsage(),
  }
}

/** A thread not live here: what its file says, or nothing at all for one never stored. */
function coldReading(
  host: AgentHost,
  transcript: readonly EnsoTranscriptEntry[],
  stored: StoredThreadRead | undefined,
): RunReading {
  return {
    interrupted: interruptedTail(transcript),
    live: false,
    busy: false,
    generation: 0,
    permissionMode: host.storedPermissionMode(transcript),
    model: null,
    recordedModel: stored?.recordedModel,
    openDialogs: [],
    usage: stored?.usage ?? NO_USAGE,
  }
}

/**
 * Where a thread runs and which project that is: its session's directory, or a new thread's
 * project's. `cwd: ''` when there is nowhere it will run — a new thread whose project was removed
 * (its first prompt is refused, 409, saying so), or a stored one whose directory is no project here
 * (resuming it is refused the same way). Falling back to the launch directory would name a place
 * it will never run (PR #399 review).
 */
function placeOf(
  projects: ProjectRegistry,
  threadId: string,
  sessionDirectory: string | undefined,
  storedUnserved: boolean,
): Pick<ThreadMount, 'cwd' | 'projectId'> {
  if (sessionDirectory !== undefined) {
    return { cwd: sessionDirectory, projectId: projects.byDirectory(sessionDirectory)?.projectId }
  }
  if (storedUnserved) return { cwd: '', projectId: undefined }
  const project = projects.projectOfNewThread(threadId)
  return { cwd: project?.path ?? '', projectId: project?.projectId }
}
