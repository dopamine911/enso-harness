import {
  type EnsoInterruptedTail,
  type EnsoLoginInProgress,
  type EnsoModelState,
  type EnsoOpenDialog,
  type EnsoPermissionModeState,
  type EnsoProviderRefusal,
  type EnsoQueuedPrompts,
  type EnsoRecordedModel,
  type EnsoRiskThresholds,
  type EnsoSessionIncidents,
  type EnsoSessionRiskChange,
  type EnsoSessionUsage,
  type EnsoStoppedAfter,
  type EnsoThreadHistory,
  type EnsoThreadModelRole,
  type EnsoThreadSystemPrompt,
  type EnsoTranscriptEntry,
  sessionIncidentsOf,
  sessionRiskOfTranscript,
  threadModelRole,
  threadSystemPrompt,
} from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import type { StoredThreadRead } from '../host/stored-threads.ts'
import { treeRecordOf } from '../host/thread-trees.ts'
import type { ProjectRegistry } from './projects.ts'
import type { ThreadRegistry, ThreadView } from './thread-registry.ts'
import { interruptedTail, stoppedAfter, transcriptToMessages } from './transcript-to-messages.ts'

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
  /**
   * The risk fold's thresholds from the user's config (#466, `security.incidents`) — the ones the
   * live guard measures with, so the replayed level is the level the guard reached.
   */
  readonly riskThresholds: EnsoRiskThresholds
}

/** One thread as of this read: what a pane mounts with, and what the follow's snapshot says. */
export interface ThreadMount {
  /**
   * Does the server hold this id at all — a live thread or a file? `false` is `/history`'s 404,
   * unless a page named the thread for a project: then a draft of that project (#897).
   */
  readonly present: boolean
  /**
   * The directory of this id's session file when that directory is no project here (#378):
   * `present` is `false` for it, like an id never seen, but the file is there — so `/history`
   * refuses it by name (403) rather than as unknown (404), and a page does not start it afresh.
   */
  readonly storedOutside: string | undefined
  /**
   * The branch's entries: pi's memory when live, the file when cold. `/history` maps a PAGE of it
   * to messages (`historyPage`, #739); the follow's snapshot sends only the two facts below.
   */
  readonly transcript: readonly EnsoTranscriptEntry[]
  /** How many messages the branch holds — one per `message` entry, as `transcriptToMessages` maps them. */
  readonly messageCount: number
  /**
   * The thread was never started (#479): live here with no message and no session file — a control
   * route or a refused Start built it, and nothing was prompted. `/history` says it as `draft`. A
   * fork is written by its route, and a stored thread has a file, so neither is one.
   */
  readonly draft: boolean
  /** The refusal the branch's last assistant message is (#381); `undefined` when it is none. */
  readonly trailingRefusal: EnsoProviderRefusal | undefined
  /** Set only when the branch ends inside a turn (#109). */
  readonly interrupted: EnsoInterruptedTail | undefined
  /** Where the branch's runs were stopped (#766), oldest first — empty when none was. Live or cold, the same entries. */
  readonly stoppedAfter: EnsoStoppedAfter
  /** The name a person gave the thread (#670): the live session's, else the file's; `undefined` when none. */
  readonly name: string | undefined
  readonly live: boolean
  readonly busy: boolean
  readonly generation: number
  /** The live session's own mode, or the one this branch persists. */
  readonly permissionMode: EnsoPermissionModeState
  /**
   * The session's risk (#464): the branch replayed through the fold the live guard runs — the
   * same answer live or cold, since both read the same branch.
   */
  readonly sessionRisk: EnsoSessionRiskChange
  /**
   * The session's incidents (#466): the branch's opening and resolution records, folded as the
   * guard folds them — live or cold, the same records.
   */
  readonly incidents: EnsoSessionIncidents
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
  /**
   * The system prompt the session runs with (#878): the branch's last record (#443) — the live
   * session's entries or the file's, the same record either way. `null` is pi's default.
   */
  readonly systemPrompt: EnsoThreadSystemPrompt
  /** The role the branch runs under (#904): its last `enso-model-role` record, live or cold; `null` for none. */
  readonly modelRole: EnsoThreadModelRole | null
  /** Every question pi is blocked on, oldest first (#114); empty when the thread is not live. */
  readonly openDialogs: EnsoOpenDialog[]
  /** What pi holds behind the run (#917), interrupting first; both empty when nothing waits or not live. */
  readonly queue: EnsoQueuedPrompts
  /** The login waiting on its provider (#348), which Stop can end; undefined when none is, or not live. */
  readonly login: EnsoLoginInProgress | undefined
  /**
   * The tree pi runs this thread in (#44): the live session's own, the stored session's (pi fixed
   * it at creation), or — for a thread with neither — its project's, where it will be built (#395).
   */
  readonly cwd: string
  /** The project that directory is (#395); `undefined` when it is no registered project — the thread is not served. */
  readonly projectId: string | undefined
  /** Whether the thread runs on a tree of its own (#551) — `EnsoFollowSnapshot.tree`. */
  readonly tree: boolean
  /** What the session has spent and how full its context is (#45): pi's live totals, or the file's with no context. */
  readonly usage: EnsoSessionUsage
}

/** A thread with neither a session nor a file has spent nothing and has no window to fill. */
const NO_USAGE: EnsoSessionUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null }

/** A live thread's mount reads no file. */
const NOT_READ = { stored: undefined, storedOutside: undefined } as const

/**
 * The file, read only for a thread that is not live here — nothing is built to answer (#86).
 * `readStoredThread` answers nothing both for "never stored" and for "stored in a directory that is
 * no project here"; only the second has a file, and it must not read as a new thread.
 */
async function readCold(
  host: AgentHost,
  threadId: string,
): Promise<{ readonly stored: StoredThreadRead | undefined; readonly storedOutside: string | undefined }> {
  const stored = await host.readStoredThread(threadId)
  if (stored !== undefined) return { stored, storedOutside: undefined }
  return { stored, storedOutside: await host.storedThreadDirectory(threadId) }
}

export async function readThreadMount(deps: ThreadReadDeps, threadId: string): Promise<ThreadMount> {
  const { threads, host, projects } = deps
  const live = threads.peek(threadId)
  const read = live === undefined ? await readCold(host, threadId) : NOT_READ
  const { stored } = read
  const nowLive = threads.peek(threadId)
  const inspection = nowLive?.hosted.inspect()
  const transcript = inspection === undefined ? (stored?.transcript ?? []) : inspection.entries
  // A thread that went live during the read is served, wherever its file is.
  const storedOutside = nowLive === undefined ? read.storedOutside : undefined
  const risk = sessionRiskOfTranscript(transcript, deps.riskThresholds)
  const place = placeOf(projects, threadId, inspection?.cwd ?? stored?.cwd, storedOutside)
  const messageEntries = transcript.filter((transcriptEntry) => transcriptEntry.kind === 'message')
  return {
    present: nowLive !== undefined || stored !== undefined,
    storedOutside,
    name: inspection === undefined ? stored?.name : inspection.name,
    transcript,
    messageCount: messageEntries.length,
    // Live with no file: never flushed, which pi does at the first reply — so, with no message, never prompted.
    draft: inspection?.sessionFile === null && messageEntries.length === 0,
    trailingRefusal: messageEntries.findLast((message) => message.role === 'assistant')?.refusal,
    stoppedAfter: stoppedAfter(transcript),
    sessionRisk: { level: risk.level, signals: risk.signals.length },
    systemPrompt: threadSystemPrompt(transcript),
    modelRole: threadModelRole(transcript),
    incidents: sessionIncidentsOf(
      transcript.flatMap((transcriptEntry) => (transcriptEntry.kind === 'custom' ? [transcriptEntry] : [])),
    ),
    ...(nowLive === undefined ? coldReading(host, transcript, stored) : liveReading(nowLive, transcript)),
    ...place,
    // Our record (#555 rule 5), else — no file yet, live or not: a new thread, which the host moves
    // onto a tree at its first run (#551) — whether the host gives its project's threads one.
    tree:
      treeRecordOf(transcript) !== undefined ||
      (stored === undefined &&
        (inspection === undefined || inspection.sessionFile === null) &&
        place.cwd !== '' &&
        host.mintsTreesIn(place.cwd)),
  }
}

/**
 * The most messages one `/history` answer carries (#739). Sized for the page a person reads first:
 * the last 200 of the 40-minute arena session are 0.48 MB as JSON, where its whole branch grown to
 * 5,040 turns is 15 MB. Big enough that a thread of a few hours opens whole, so "Load earlier" is
 * for the long ones. ⓘ The server's choice alone: a page asks for messages before an id, never a count.
 */
export const HISTORY_PAGE_MESSAGES = 200

/** One `/history` page: its messages, and what of the branch is before them — `EnsoThreadHistory`'s halves. */
type HistoryPage = Pick<EnsoThreadHistory, 'messages' | 'earlier'>

/**
 * The page of the branch's messages that ends before `before`, or its last page when `undefined`
 * (#739). `undefined` when the branch holds no message `before`: a compaction or a `/tree` move
 * rewrote it under the page, and the page is to re-read the thread rather than splice a stranger in.
 *
 * ⓘ Paged AFTER mapping, so a tool result `transcriptToMessages` stamps onto its call's message
 * never lands on another page than its call.
 */
export function historyPage(
  transcript: readonly EnsoTranscriptEntry[],
  before: string | undefined,
): HistoryPage | undefined {
  const messages = transcriptToMessages(transcript)
  const end = before === undefined ? messages.length : messages.findIndex((message) => message.id === before)
  if (end === -1) return undefined
  const start = Math.max(0, end - HISTORY_PAGE_MESSAGES)
  const page = messages.slice(start, end)
  if (start === 0) return { messages: page }
  const earlierPrompts = messages.slice(0, start).filter((message) => message.role === 'user')
  const firstPrompt = earlierPrompts[0]
  return {
    messages: page,
    earlier: {
      messages: start,
      prompts: earlierPrompts.length,
      // Text only: an image prompt's bytes are no part of a title, and could outweigh the page.
      ...(firstPrompt === undefined
        ? {}
        : { firstPrompt: { ...firstPrompt, parts: firstPrompt.parts.filter((part) => part.type === 'text') } }),
    },
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
  | 'queue'
  | 'usage'
  | 'login'
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
    queue: runtime.queued(),
    usage: runtime.sessionUsage(),
    login: runtime.loginInProgress(),
  }
}

/**
 * A thread not live here: what its file says, or nothing at all for one never stored.
 *
 * @invariant resume/opening-mode The opening mode is the branch's last `modes` custom entry, or the fresh state.
 * A cold thread's mode is `storedPermissionModeState`'s walk of the transcript from the end over
 * `custom` entries, which builds nothing and offers the full registered set (#86: looking must not
 * build); a live thread answers from the runtime (`liveReading`), fresher than the file.
 */
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
    queue: { interrupting: [], enqueued: [] },
    usage: stored?.usage ?? NO_USAGE,
    login: undefined,
  }
}

/**
 * Where a thread runs and which project that is: its session's directory, or a new thread's
 * project's. `cwd: ''` when there is nowhere it will run — a new thread whose project was removed
 * (its first prompt is refused, 409, saying so), or a stored one whose directory is no project here
 * (resuming it is refused the same way). Falling back to the launch directory would name a place
 * it will never run.
 */
function placeOf(
  projects: ProjectRegistry,
  threadId: string,
  sessionDirectory: string | undefined,
  storedOutside: string | undefined,
): Pick<ThreadMount, 'cwd' | 'projectId'> {
  if (sessionDirectory !== undefined) {
    return { cwd: sessionDirectory, projectId: projects.byDirectory(sessionDirectory)?.projectId }
  }
  if (storedOutside !== undefined) return { cwd: '', projectId: undefined }
  const project = projects.projectOfNewThread(threadId)
  return { cwd: project?.path ?? '', projectId: project?.projectId }
}
