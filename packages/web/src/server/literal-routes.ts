import type { IncomingMessage, ServerResponse } from 'node:http'
import { ensoLogger, type EnsoStoredThread, type EnsoThreadSummary } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import { AGENT_RUNTIME_VERSION } from '../host/hosted-thread.ts'
import { createAboutRoute, createBundleRoute } from './bundle-route.ts'
import { MAX_LOG_BODY_BYTES, receiveBrowserLogs } from './logs-route.ts'
import { createLogStatsRoute } from './logs-stats-route.ts'
import { followLogTail, type LogTailRouteDeps } from './logs-tail-route.ts'
import type { ProjectRegistry } from './projects.ts'
import { answerJson, answerOrFail, readCappedBody, refuseWith } from './request-plumbing.ts'
import type { ThreadRegistry, ThreadView } from './thread-registry.ts'

/**
 * The literal routes (#810): the ones whose path is a constant rather than a thread's id — the
 * fresh thread's mode, the live and stored thread listings, the trees, the about card, and the log
 * routes (#144). ⚠ `scripts/docs/routes.ts` reads these routes off the `request.method === … && url …`
 * conditions below (#174): keep that spelling.
 */

const log = ensoLogger('server', 'http')

/** What the literal routes read from the server (#810): the host, the registries, the log directory, the tail's keepalive. */
export interface LiteralRoutesState {
  readonly host: AgentHost
  readonly threads: ThreadRegistry
  readonly projects: ProjectRegistry
  readonly logsDir: string
  readonly sseKeepaliveMs: number
}

/** The literal routes' one dispatcher (#810). */
export interface LiteralRoutes {
  /** True when the request was a literal route. */
  readonly dispatchLiteralRoute: (request: IncomingMessage, response: ServerResponse) => boolean
}

export function createLiteralRoutes(state: LiteralRoutesState): LiteralRoutes {
  const { host, threads, projects, logsDir, sseKeepaliveMs } = state

  // The permission mode a FRESH thread starts in (#84). The browser asks once on mount,
  // before any run exists, so the header can read the starting mode instead of `unknown`
  // from the first paint. The host answers — it is the one place that knows what its mode
  // extension starts in and registers (L3, #162 workstream 4). A thread's LIVE state —
  // after a change — rides on the run-start receipt, never here.
  function respondWithFreshThreadMode(response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(host.freshPermissionMode()))
  }

  // ── Session inspection (#86): what a live thread's session ACTUALLY contains, for a
  // human (the debug drawer) or an agent (`scripts/enso-thread.ts`) to cross-check the
  // derived views against. Read-only. Never creates a session — `threads.peek`, never
  // `acquire`: looking must not be the thing that spins pi up. Loopback-only by the
  // server's bind; the branch is conversation and tool output, which is the point.
  function summarize(thread: ThreadView): EnsoThreadSummary {
    const inspection = thread.hosted.inspect()
    return {
      threadId: thread.threadId,
      sessionId: inspection.sessionId,
      sessionDir: inspection.sessionDir,
      sessionFile: inspection.sessionFile,
      mode: thread.hosted.runtime.permissionModeState().mode,
      busy: thread.busy,
      generation: thread.generation,
      lastActivityAt: new Date(thread.lastActivityAt).toISOString(),
    }
  }

  function respondWithThreads(response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(threads.list().map(summarize)))
  }

  /**
   * pi's session files for this workspace (#95) — what the rail can come back to.
   *
   * @flow resume Resume: a stored thread, from the rail to live
   * A stored thread is one whose log the runtime has flushed: nothing reaches disk before the first
   * assistant message, so a thread that has only run slash commands has nothing to come back to.
   * Resume is not a code identifier (glossary, Thread states): the rail's listing, the URL naming
   * the thread, `GET …/history` read cold from the file, adoption in the browser under the SAME id,
   * then the first prompt building the runtime over that file. The thread id IS the runtime's
   * session id (#95): no mapping, no index file, across a restart. The pane's messages come from
   * `/history` (`adoptThread`); the snapshot carries the same `messages`, and
   * `custom-event-router.ts` reads one fact off them: whether the last assistant message is a
   * refused attempt (#381). The host's name for the listing is `listSessions`; there is no
   * `listThreads`.
   * @contract packages/core/src/transcript.ts#EnsoTranscriptEntry
   * @see docs/seams/storage.md the seam: the listing, the cold read, the open-or-create
   * @see docs/seams/permission-mode.md the mode walk
   * @see docs/glossary.md the words: stored thread, resume, live / cold, session reserved for the log (Thread)
   *
   * @invariant resume/rail-listing The rail is the listing, newest first, titled by the first user message.
   * The host's own listing, one header parse per file, newest first; a blank first message is no
   * title. `busy` marks a thread a run on THIS server holds: the row is shown, not locked (#114),
   * and an idle thread the server still holds is resumable, since held is not busy. `waiting`
   * marks one whose runtime holds a question open for the person (#876), so the rail says it
   * without the page having opened the thread.
   */
  async function respondWithStoredThreads(response: ServerResponse): Promise<void> {
    const stored = await host.listSessions()
    const payload: EnsoStoredThread[] = stored.flatMap((session) => {
      // The host lists only sessions in a project; the lookup is what names which one.
      const project = projects.byDirectory(session.cwd)
      if (project === undefined) return []
      const live = threads.peek(session.id)
      return [
        {
          threadId: session.id,
          projectId: project.projectId,
          ...(session.firstMessage.trim().length === 0 ? {} : { title: session.firstMessage.trim() }),
          lastActivityAt: session.modified.toISOString(),
          messageCount: session.messageCount,
          busy: live?.busy === true,
          waiting: live !== undefined && live.hosted.runtime.openDialogs().length > 0,
          ...(session.parentThreadId === undefined ? {} : { parentThreadId: session.parentThreadId }),
          ...(session.name === undefined ? {} : { name: session.name }),
          ...(session.model === undefined ? {} : { model: session.model }),
        },
      ]
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  /** `GET /api/trees` (#578): what the served threads' trees and object stores cost on disk. Reads only. */
  async function respondWithTrees(response: ServerResponse): Promise<void> {
    answerJson(response, await host.listTrees())
  }

  // The bundle (#132): today's records + the live threads + the versions, one file.
  const bundle = createBundleRoute({ threads, logsDir, runtimeVersion: AGENT_RUNTIME_VERSION })

  function respondWithBundle(url: string, response: ServerResponse): void {
    const outcome = bundle(new URL(url, 'http://enso').searchParams)
    if (outcome.status !== 200) {
      response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
      response.end(outcome.reason)
      return
    }
    response.writeHead(outcome.status, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${outcome.filename}"`,
    })
    response.end(outcome.body)
  }
  const about = createAboutRoute({ runtimeVersion: AGENT_RUNTIME_VERSION })
  // The tail (#144 slice 2): the same day's file, filtered server-side and streamed, for the
  // debug page. Like the bundle it only reads; unlike the bundle it stays open.
  const logTailDeps: LogTailRouteDeps = { logsDir, sseKeepaliveMs }
  // The day, derived (#144 slice 4): the whole file folded per request, never the tail's cap.
  const stats = createLogStatsRoute({ logsDir })

  /**
   * The payload before the head: the fold reads the file synchronously and
   * can throw — EACCES on the directory, the file removed mid-read — and a `writeHead(200)`
   * already committed would have made that throw an uncaught exception in the request
   * listener with no way to say 500. A failed read IS a record's business, the one kind this
   * surface does write: the failure, never the reader's presence.
   */
  function respondWithStats(response: ServerResponse): void {
    let payload: string
    try {
      payload = JSON.stringify(stats())
    } catch (error) {
      log.error('the day could not be folded: {error}', { error })
      response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('the day could not be read — see the server log')
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(payload)
  }

  /** The browser's records (#132 slice 3): into this process's logger, or a 4xx that says why — never logged itself. */
  async function respondToBrowserLogs(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The cap is passed, not left to the schema check downstream: `receiveBrowserLogs` can
    // only refuse a batch it has already buffered whole, which is the thing `readBody`'s
    // `maxBytes` exists to avoid. The CAP helper and not `readJsonBody`: this route parses
    // its batch downstream, so a read that fails for any other reason is deliberately left
    // to `answerOrFail`'s 500 rather than answered as a 400 the other three routes give.
    const body = await readCappedBody(request, response, {
      maxBytes: MAX_LOG_BODY_BYTES,
      capText: `a log batch is at most ${MAX_LOG_BODY_BYTES} bytes`,
    })
    if (body === undefined) return
    const outcome = receiveBrowserLogs(body)
    if (outcome.status !== 204) {
      refuseWith(response, outcome)
      return
    }
    response.writeHead(204)
    response.end()
  }

  /** The thread listings and the host's own state: the literal routes before the log routes. */
  function dispatchStateRoute(request: IncomingMessage, url: string, response: ServerResponse): boolean {
    if (request.method === 'GET' && url === '/api/mode') {
      respondWithFreshThreadMode(response)
      return true
    }
    if (request.method === 'GET' && url === '/api/threads') {
      respondWithThreads(response)
      return true
    }
    if (request.method === 'GET' && url === '/api/stored-threads') {
      answerOrFail(respondWithStoredThreads(response), response)
      return true
    }
    if (request.method === 'GET' && url === '/api/trees') {
      answerOrFail(respondWithTrees(response), response)
      return true
    }
    if (request.method === 'GET' && url === '/api/about') {
      // No log line here, by rule (#144): a surface that exists to read the trace must not
      // write to it.
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(about()))
      return true
    }
    return false
  }

  /** The log routes (#144): the bundle, the tail, the day's stats, and the browser's own records. */
  function dispatchLogRoute(request: IncomingMessage, url: string, response: ServerResponse): boolean {
    if (request.method === 'GET' && url.startsWith('/api/logs/bundle')) {
      respondWithBundle(url, response)
      return true
    }
    if (request.method === 'GET' && url.startsWith('/api/logs/tail')) {
      // No log line here either, by the same rule (#144): the tail must not appear in the tail.
      followLogTail(logTailDeps, url, response)
      return true
    }
    if (request.method === 'GET' && url === '/api/logs/stats') {
      // No log line for the read itself (#144): a record per refresh would be the reader's
      // own presence in the day it is summing. A read that FAILS is recorded.
      respondWithStats(response)
      return true
    }
    if (request.method === 'POST' && url === '/api/logs') {
      answerOrFail(respondToBrowserLogs(request, response), response)
      return true
    }
    return false
  }

  /**
   * The literal routes — the ones whose path is a constant rather than a thread's id — in
   * precedence order. True when the request was one of them.
   *
   * ⚠ Its own function, apart from `dispatchThreadRoute` (`thread-routes.ts`), for the reason #174 gave when the thread
   * routes became a table: the request callback is where every arm's cost lands. The ladder
   * stays a ladder rather than becoming a second table because each of these answers
   * differently — a JSON body, a stream, a 204, an answered-or-failed promise — and a table of
   * six shapes is a `switch` wearing a hat. ⚠ `scripts/docs/routes.ts` reads the routes off
   * these `request.method === … && url …` conditions: keep that spelling. It is split in two
   * ladders (#816) that run in order, so precedence is unchanged.
   */
  function dispatchLiteralRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    return dispatchStateRoute(request, url, response) || dispatchLogRoute(request, url, response)
  }

  return { dispatchLiteralRoute }
}
