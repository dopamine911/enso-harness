import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type EnsoThreadCommands,
  type EnsoThreadEvents,
  type EnsoThreadHistory,
  type EnsoThreadPages,
} from '@enso/core'
import { readGitChanges, readGitState, runGit } from '@enso/core/git'
import { answerJson, refuseWith, type ThreadResponder, type ThreadRouteHandler } from './request-plumbing.ts'
import { createContextRequestRoute, createThreadContextRoute } from './thread-context-route.ts'
import { createThreadEvalRoute } from './thread-eval-route.ts'
import { createThreadChangesRoute, createThreadGitRoute } from './thread-git-route.ts'
import { createThreadSecurityReads, replayThresholdsOf } from './thread-incidents-route.ts'
import { createThreadManifestRoute } from './thread-manifest-route.ts'
import {
  createPreviewOrigins,
  createPreviewRoute,
  createThreadPagesRoute,
  type PreviewOrigins,
} from './thread-preview-route.ts'
import { historyPage, readThreadMount, type ThreadReadDeps } from './thread-read.ts'
import { inspectThread } from './thread-registry.ts'
import { createThreadStatsRoute } from './thread-stats-route.ts'

/**
 * The thread reads (#810): a thread's events, history, commands, inspection and delete preview,
 * and its analyses — stats, context, manifest, eval, git, changes, incidents, judge cases, pages.
 * Each is a row of the thread route table (`thread-routes.ts`); none builds a session it reads (#86).
 */

/** What the thread reads take from the server (#810): the live-or-cold read, the log directory, the served directories. */
export interface ThreadReadRoutesState {
  readonly threadRead: ThreadReadDeps
  readonly logsDir: string
  readonly servesDirectory: (directory: string) => boolean
}

/**
 * The thread reads' handlers — the ones that read only the id, and the ones that read their match's
 * query or second capture — and the preview origins the server closes with it (#713).
 */
export type ThreadReadRoutes = Readonly<
  Record<
    | 'respondWithThreadEvents'
    | 'respondWithDeletePreview'
    | 'respondWithThreadCommands'
    | 'respondWithThread'
    | 'respondWithThreadStats'
    | 'respondWithThreadContext'
    | 'respondWithThreadManifest'
    | 'respondWithThreadEval'
    | 'respondWithThreadGit'
    | 'respondWithThreadChanges'
    | 'respondWithThreadJudgeCases'
    | 'respondWithThreadPages',
    ThreadResponder
  > &
    Record<
      'respondWithThreadHistory' | 'respondWithThreadIncidents' | 'respondWithContextRequest',
      ThreadRouteHandler
    > & {
      previews: PreviewOrigins
    }
>

export function createThreadReadRoutes(state: ThreadReadRoutesState): ThreadReadRoutes {
  const { threadRead, logsDir, servesDirectory } = state
  const { threads, host } = threadRead

  function respondWithThreadEvents(threadId: string, response: ServerResponse): void {
    const thread = threads.peek(threadId)
    if (thread === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no live session for thread ${threadId}`)
      return
    }
    const payload: EnsoThreadEvents = {
      threadId,
      emitted: thread.hosted.emittedEvents(),
      sent: thread.sent.recent(),
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  /**
   * The thread's branch as the messages a chat mounts with (#95), plus its permission mode.
   * Read-only — looking must not build (#86). ONE PAGE of it (#739, `thread-read.ts#historyPage`):
   * the last, or with `?before=<messageId>` the one before that message — and a 409 when the
   * branch holds no such message any more (a compaction rewrote it), which the page re-reads.
   *
   * Decided by what the server holds, not by whether it holds anything:
   *   • HERE (a run in flight, a dialog open, or idle within the eviction window): pi's
   *     memory and the session's own mode — fresher than the file, and RESUMABLE. A page
   *     that reloaded after a run must be able to come back before the 30-minute eviction
   *     (PR #104 review); a page that reloaded UNDER pi's open question must be able to
   *     come back to the card (#114). Busy is not a refusal any more: under the follow
   *     transport (#112) a resumed pane follows the run in flight, and a prompt to a busy
   *     thread queues through pi (#75) — the 409 that guarded the old per-response run
   *     path guarded nothing here and locked the operator out of their own question.
   *   • NOT here: the file, with the mode its branch persists. Neither: 404 — the one thing
   *     this route decides that the follow decides differently (`present`). A page reads a 404
   *     for its URL's thread as an id nobody has used yet, and starts it (#378).
   *   • A file in a directory that is no project here: 403, naming the directory — it exists,
   *     so it is not a 404 a page would start afresh (#378).
   *
   * The read itself is `thread-read.ts#readThreadMount` (#214), shared with the follow's
   * snapshot: HERE is settled AFTER the file read, so a thread built during it is served
   * pi's memory rather than the file both routes were racing.
   *
   * @invariant resume/looking-builds-nothing Looking must not build (#86).
   * `readStoredThread` opens the file into memory and writes nothing until an append; this route
   * `peek`s the registry, and a thread neither live nor stored is a 404, while the follow's cold
   * read is an EMPTY snapshot, so observation may precede the first prompt
   * (`follow-snapshot-frames/cold-empty`). A session file in a directory that is no project here is
   * a 403 naming the directory, not that 404 (#378). The page reads the three by where the id came
   * from (`stored-threads.ts#createResumeRequests`): a 404 for the URL's own thread (written before
   * its first prompt, then lost to a restart) starts it under that id, said nowhere; a 404 for a
   * rail row is a stale listing; either failure is said on the rail's "could not open the thread"
   * line, never as the listing failing.
   */
  async function respondWithThreadHistory(
    threadId: string,
    _request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const before = new URLSearchParams(match[2] ?? '').get('before') ?? undefined
    const mount = await readThreadMount(threadRead, threadId)
    // #378: stored, but in a directory that is no project here — refused by name, so a page does
    // not take it for an id nobody has used and start it afresh (a 404 means exactly that).
    if (mount.storedOutside !== undefined) {
      response.writeHead(403, { 'Content-Type': 'text/plain' })
      // The directory FIRST and no thread id (the URL has it): a page bounds a failure to 120
      // characters (`boundedFailureDetail`), and the directory is the part that must survive. The
      // rest is 57 characters, so the advice survives too up to a 63-character directory (#478 review).
      response.end(`stored in ${mount.storedOutside} — not a project here; add it as one to open it`)
      return
    }
    // A deleted id (#571) is GONE, not unknown (PR #572 review): a 404 for the URL's own thread
    // starts a new thread under it (#378), and the page must take this one as a failure instead.
    if (!mount.present && host.threadDeleted(threadId)) {
      response.writeHead(410, { 'Content-Type': 'text/plain' })
      response.end(`thread ${threadId} was deleted`)
      return
    }
    if (!mount.present || mount.projectId === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no session for thread ${threadId}`)
      return
    }
    const page = historyPage(mount.transcript, before)
    if (page === undefined) {
      refuseWith(response, { status: 409, reason: `the thread's branch no longer holds message ${before}` })
      return
    }
    const payload: EnsoThreadHistory = {
      threadId,
      projectId: mount.projectId,
      ...page,
      permissionMode: mount.permissionMode,
      sessionRisk: mount.sessionRisk,
      incidents: mount.incidents,
      ...(mount.interrupted === undefined ? {} : { interrupted: mount.interrupted }),
      ...(mount.stoppedAfter.length === 0 ? {} : { stoppedAfter: mount.stoppedAfter }),
      ...(mount.name === undefined ? {} : { name: mount.name }),
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  /**
   * `GET …/delete-preview` (#571): the delete dialog's text, read before it asks — 200
   * `EnsoThreadDeletePreview`; 410 a deleted thread, as `…/history` answers it; 404 no session.
   * Reads only: the tree's inventory, as the delete itself takes it.
   */
  async function respondWithDeletePreview(threadId: string, response: ServerResponse): Promise<void> {
    const outcome = await host.previewThreadDelete(threadId)
    if (outcome.kind === 'preview') {
      answerJson(response, outcome.preview)
      return
    }
    refuseWith(response, { status: host.threadDeleted(threadId) ? 410 : 404, reason: outcome.reason })
  }

  /**
   * The slash commands a thread can run (#338): from ITS session when it is live, else the host's
   * catalogue (#484) — and NOTHING IS BUILT. Before #484 this route built the session for a thread
   * that had none (#390: after a restart `/login` could not run until something had been
   * prompted), and the Start dialog read its models here, so every page visit built one. Now the
   * Start dialog is served from the catalogue, a run or a control route is what builds, and the
   * palette shows a `catalogue` list as none. No record: a reader opening a menu is not an event.
   */
  async function respondWithThreadCommands(threadId: string, response: ServerResponse): Promise<void> {
    const thread = threads.peek(threadId)
    const payload: EnsoThreadCommands =
      thread === undefined
        ? { threadId, commands: await host.catalogue(), source: 'catalogue' }
        : { threadId, commands: thread.hosted.runtime.listCommands(), source: 'live' }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  function respondWithThread(threadId: string, response: ServerResponse): void {
    const thread = threads.peek(threadId)
    if (thread === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no live session for thread ${threadId}`)
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(inspectThread(thread)))
  }

  // One thread, analysed (#45 phase 2): pi's session for the numbers, the day files for the times.
  const threadStats = createThreadStatsRoute({ threads, host, logsDir })
  // One thread's context (#361): pi's branch, request by request; no log is read.
  const threadContext = createThreadContextRoute({ threads, host })
  const contextRequest = createContextRequestRoute({ threads, host })
  // One thread's fork point (#435): identity and run conditions off pi's branch.
  const threadManifest = createThreadManifestRoute({ threads, host })
  // One thread's session eval (#441): the branch's events and the log's, scored mechanically.
  const threadEval = createThreadEvalRoute({ threads, host, logsDir })
  // One thread's security reads (#468, #469): the incident history and replay, and the judge's cases
  // — what `bun run judge` shows before it sends anything.
  const securityReads = createThreadSecurityReads({ threads, host, riskThresholds: threadRead.riskThresholds })
  // One thread's git state (#453): read in its cwd when asked, only in a directory this server serves.
  const gitDeps = { threads, host, servesDirectory, readGit: (cwd: string) => readGitState(runGit, cwd) }
  const threadGit = createThreadGitRoute(gitDeps)
  // What changed since the last push (#452): the same state, with every file and its patch — or,
  // for a thread whose tree is a copy, what changed since the copy was made, from its store (#650).
  const threadChanges = createThreadChangesRoute({
    ...gitDeps,
    readChanges: (repository) => readGitChanges(runGit, repository),
    threadTree: (threadId) => host.threadTree(threadId),
    readCopyChanges: (copy) => host.readCopyChanges(copy),
  })
  // What the thread built (#619): where it works and its pages — and, once it holds one, the origin
  // its preview is served from, a listener of its own (#713, `thread-preview-route.ts`).
  const pagesOf = createThreadPagesRoute(gitDeps)
  const previews = createPreviewOrigins(createPreviewRoute(gitDeps))
  // The thread's tree prepared (#754): what its setup did, from its branch, with its pages.
  const threadPages = async (threadId: string): Promise<EnsoThreadPages | undefined> => {
    const listed = await pagesOf(threadId)
    if (listed === undefined) return undefined
    const setup = (await host.threadTree(threadId))?.setup
    const withSetup = setup === undefined ? listed : { ...listed, setup }
    if (listed.pages.length === 0) return withSetup
    return { ...withSetup, previewOrigin: await previews.originOf(threadId) }
  }

  /**
   * A thread analysis — stats (#45), context (#361), manifest (#435), git (#453), changes (#452) — or 404 for a thread the
   * server holds neither live nor on disk. The payload is built before the head, as
   * `respondWithStats` (`literal-routes.ts`) builds it: a day file that fails to read is the 500 `answerOrFail`
   * writes, never a throw after a committed 200.
   */
  function analysisResponder(
    read: (threadId: string) => Promise<object | undefined>,
    absent: (threadId: string) => string = (threadId: string): string => `no session for thread ${threadId}`,
  ): (threadId: string, response: ServerResponse) => Promise<void> {
    return async (threadId: string, response: ServerResponse): Promise<void> => {
      const payload = await read(threadId)
      if (payload === undefined) {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end(absent(threadId))
        return
      }
      const body = JSON.stringify(payload)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(body)
    }
  }
  const respondWithThreadStats = analysisResponder(threadStats)
  const respondWithThreadContext = analysisResponder(threadContext)
  const respondWithThreadManifest = analysisResponder(threadManifest)
  const respondWithThreadEval = analysisResponder(threadEval)
  const respondWithThreadGit = analysisResponder(threadGit)
  const respondWithThreadChanges = analysisResponder(threadChanges)
  const respondWithThreadJudgeCases = analysisResponder((threadId: string) => securityReads.judgeCases(threadId))
  const respondWithThreadPages = analysisResponder(threadPages)
  /** The incident history under the query's thresholds; a query that names no threshold well is the 400 that says why. */
  function respondWithThreadIncidents(
    threadId: string,
    _request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const thresholds = replayThresholdsOf(match[2] ?? '', threadRead.riskThresholds)
    if (typeof thresholds === 'string') {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end(thresholds)
      return Promise.resolve()
    }
    return analysisResponder((id: string) => securityReads.incidents(id, thresholds))(threadId, response)
  }
  /**
   * One request's context; the request is the route's second capture, a turn or `next` — the
   * dispatcher's own match, so the url is read once. A turn the thread lacks, or a thread held
   * nowhere, is the 404 that names the request.
   */
  function respondWithContextRequest(
    threadId: string,
    _request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const segment = match[2]
    const which: number | 'next' = segment === 'next' ? 'next' : Number(segment)
    return analysisResponder(
      (id: string) => contextRequest(id, which),
      (id: string) => `no request ${segment} on thread ${id}`,
    )(threadId, response)
  }

  return {
    respondWithThreadEvents,
    respondWithThreadHistory,
    respondWithDeletePreview,
    respondWithThreadCommands,
    respondWithThread,
    respondWithThreadStats,
    respondWithThreadContext,
    respondWithThreadManifest,
    respondWithThreadEval,
    respondWithThreadGit,
    respondWithThreadChanges,
    respondWithThreadJudgeCases,
    respondWithThreadPages,
    respondWithThreadIncidents,
    respondWithContextRequest,
    previews,
  }
}
