import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  base64DecodedBytes,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_LOG_EVENTS,
  ENSO_PROMPT_BODY_MAX_BYTES,
  ENSO_PROMPT_MAX_IMAGES,
  type EnsoStoredThread,
  type EnsoThreadCommands,
  type EnsoThreadEvents,
  type EnsoThreadHistory,
  type EnsoThreadSummary,
  ensoLogger,
  isEnsoThreadId,
  withEnsoLogContext,
} from '@enso/core'
import { missingVendorPaths } from '@enso/core/pi-manifest'
import { AGENT_RUNTIME_VERSION, type AgentHost, createAgentHost } from '../host/agent-host.ts'
import { withoutHostValues } from '../host/host-commands.ts'
import { createAboutRoute, createBundleRoute } from './bundle-route.ts'
import {
  abortThread,
  answerThreadDialog,
  changeThreadMode,
  type FollowRouteDeps,
  followThread,
  promptThread,
  readDialogBody,
  readHostCommandBody,
  readModeChangeBody,
  readPromptBody,
  runHostCommand,
} from './follow.ts'
import { MAX_LOG_BODY_BYTES, receiveBrowserLogs } from './logs-route.ts'
import { createLogStatsRoute } from './logs-stats-route.ts'
import { followLogTail, type LogTailRouteDeps } from './logs-tail-route.ts'
import { noteRunAdmitted } from './run-timing.ts'
import { SSE_KEEPALIVE_MS } from './sse.ts'
import { readThreadMount, type ThreadReadDeps } from './thread-read.ts'
import { createThreadRegistry, inspectThread, type ThreadView } from './thread-registry.ts'
import { createThreadStatsRoute } from './thread-stats-route.ts'

/** `GET /api/threads/<threadId>` — the id is one path segment, percent-encoded by the caller. */
const THREAD_ROUTE = /^\/api\/threads\/([^/?#]+)$/
/** `GET /api/threads/<threadId>/events` — the thread's two event tails (#97). */
const THREAD_EVENTS_ROUTE = /^\/api\/threads\/([^/?#]+)\/events$/
/** `GET /api/threads/<threadId>/history` — the branch as messages, live or stored (#95). */
const THREAD_HISTORY_ROUTE = /^\/api\/threads\/([^/?#]+)\/history$/
/** `GET /api/threads/<threadId>/commands` — the slash commands the thread can run, for the palette (#338). */
const THREAD_COMMANDS_ROUTE = /^\/api\/threads\/([^/?#]+)\/commands$/
/** `GET /api/threads/<threadId>/stats` — the thread analysed: per prompt, turn and tool (#45). */
const THREAD_STATS_ROUTE = /^\/api\/threads\/([^/?#]+)\/stats$/
/** The wire (#112): `POST …/prompt`, `GET …/follow`, `POST …/dialog`, `POST …/abort` (#116). See `follow.ts`. */
const THREAD_FOLLOW_ROUTE = /^\/api\/threads\/([^/?#]+)\/follow$/
const THREAD_PROMPT_ROUTE = /^\/api\/threads\/([^/?#]+)\/prompt$/
const THREAD_DIALOG_ROUTE = /^\/api\/threads\/([^/?#]+)\/dialog$/
const THREAD_ABORT_ROUTE = /^\/api\/threads\/([^/?#]+)\/abort$/
/** `POST …/mode` (#162 workstream 4, L3 step C): switch the mode as a control route, not a prompt. */
const THREAD_MODE_ROUTE = /^\/api\/threads\/([^/?#]+)\/mode$/
/** `POST …/command` (#338 slice 2): run a `host` command — `/model`, `/thinking` — as a control route, not a prompt. */
const THREAD_COMMAND_ROUTE = /^\/api\/threads\/([^/?#]+)\/command$/

/**
 * The dev backend: the thread routes the browser's `FollowConnection` talks to (#112), and
 * the inspection routes beside them.
 *
 * ⚠ DEV ONLY, AND THE REASON IS NOT POLISH.
 * There is no sandbox (#24), `bash` is unconfined (#9), and `cwd` is the tree pi reads and
 * writes — so whatever this process accepts as `cwd` IS the blast radius. It therefore
 * binds loopback only and takes `cwd` from ITS OWN launch arguments, never from the request
 * body. Accepting a browser-supplied working directory is a deliberate, later decision that
 * should not happen by default, and doing it before #9 closes would mean a page could point
 * an unconfined agent at any path on the machine.
 */
const DEFAULT_PORT = 5179
const LOOPBACK_ONLY = '127.0.0.1'
/** A dialog answer is an id and a short value — kilobytes, not megabytes. */
const MAX_DIALOG_BODY_BYTES = 64 * 1024

/**
 * Is this `Host`/`Origin` authority the machine itself? Port is irrelevant (either dev
 * surface may ask); the NAME is the whole point, because a hostname that merely resolves
 * to 127.0.0.1 today is a rebinding attack, not localhost.
 */
function isLoopbackAuthority(authority: string): boolean {
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
  return host === LOOPBACK_ONLY || host === 'localhost' || host === '[::1]'
}

const log = ensoLogger('server', 'http')

/** A body that outgrew its route's cap: the read stopped, nothing was buffered past it. */
class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the request body is larger than ${maxBytes} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * A request's body as text. With `maxBytes`, the read STOPS at the cap — the listener comes
 * off, the stream is paused, what was buffered is dropped, the promise rejects — rather than
 * buffering an arbitrary body first and refusing it after (#68: a prompt may carry images,
 * and the cap is many megabytes). ⚠ The socket is NOT destroyed here: the response shares
 * it, and destroying first is how a 413 never reaches the client. The caller answers, then
 * tears the connection down (`endAndClose`). Counted in bytes as they arrive.
 */
function readBody(request: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const chunks: Buffer[] = []
  let received = 0
  const onEnd = (): void => resolve(Buffer.concat(chunks).toString('utf8'))
  const onData = (chunk: Buffer): void => {
    received += chunk.length
    if (received > maxBytes) {
      request.off('data', onData).off('end', onEnd).off('error', reject)
      request.pause()
      chunks.length = 0
      reject(new BodyTooLargeError(maxBytes))
      return
    }
    chunks.push(chunk)
  }
  request.on('data', onData).on('end', onEnd).on('error', reject)
  return promise
}

/**
 * Answer, then drop the connection: the request body was never read to its end, so this
 * socket cannot carry another request. The header says so; the destroy makes it so, once
 * the answer has been flushed.
 */
function endAndClose(request: IncomingMessage, response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' })
  response.end(text, () => request.destroy())
}

/** A route's read cap and the sentence a body over it is refused with. */
interface BodyCap {
  readonly maxBytes: number
  readonly capText: string
}

/**
 * The read-cap rule, once (#265): the body up to `maxBytes`, or `undefined` once the 413 has
 * been written. A body over the cap is the one case that MUST tear the connection down —
 * `readBody` stopped mid-stream, so the socket cannot carry another request — and `capText`
 * is the sentence that says which cap was hit. Anything else the read throws is the caller's
 * to answer: the three JSON routes go through `readJsonBody` below, which turns it into a
 * 400; the browser-logs route calls THIS function directly and lets a read failure reach
 * `answerOrFail`'s 500, because that route parses downstream and has no body to quote.
 */
async function readCappedBody(
  request: IncomingMessage,
  response: ServerResponse,
  cap: BodyCap,
): Promise<string | undefined> {
  try {
    return await readBody(request, cap.maxBytes)
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error
    endAndClose(request, response, 413, cap.capText)
    return undefined
  }
}

/**
 * A capped body through its reader, or `undefined` once the refusal has been written: the
 * cap's 413 from `readCappedBody`, and a 400 carrying the message for everything else — a
 * socket that failed mid-read and a body the reader rejects are both "the caller's body is
 * not usable", answered with the reason rather than a 500 that says nothing.
 */
async function readJsonBody<T>(
  request: IncomingMessage,
  response: ServerResponse,
  cap: BodyCap & { readonly parse: (text: string) => T },
): Promise<T | undefined> {
  try {
    const text = await readCappedBody(request, response, cap)
    return text === undefined ? undefined : cap.parse(text)
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain' })
    response.end((error as Error).message)
    return undefined
  }
}

/**
 * A refused outcome, answered (#265): the status the decision carries and its reason AS the
 * body, in `text/plain` — five routes wrote this pair by hand. The route logs first, in its
 * own words: the record names the object that was refused (a prompt, a dialog id, a mode),
 * which is what makes the log searchable, and the browser-logs route deliberately writes no
 * record at all.
 */
function refuseWith(response: ServerResponse, outcome: { readonly status: number; readonly reason: string }): void {
  response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
  response.end(outcome.reason)
}

/**
 * ⚠ `decodeURIComponent` THROWS on a malformed escape (`/api/threads/%`), and a throw in the
 * request listener has nothing above it — it took the whole dev server down, every live
 * session with it, from one hand-typed URL (PR #87 review, reproduced). A bad id is the
 * caller's problem: 400 written here, `undefined` returned, and the server stays up.
 *
 * Since #95 the id is also pi's session id, which pi puts in a FILENAME — so a decoded id
 * that is not thread-id shaped (`isEnsoThreadId`: `../x`, spaces, anything a filesystem could
 * read) is the same 400. Nothing downstream ever sees an id that failed here.
 */
function decodeThreadId(rawSegment: string, response: ServerResponse): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawSegment)
  } catch {
    decoded = ''
  }
  if (isEnsoThreadId(decoded)) return decoded
  response.writeHead(400, { 'Content-Type': 'text/plain' })
  response.end('malformed thread id')
  return undefined
}

export interface EnsoServerOptions {
  /**
   * Where pi runs — the tree it will read and write. With no sandbox (#24) this value IS
   * the blast radius; it comes from the launcher's own arguments, never from a request.
   */
  cwd: string
  /**
   * The Enso pi package directory, loaded as the ONLY extension source.
   *
   * ⚠ Required, not optional. An optional value here would make "no guards" the default
   * for anyone who forgot it, which is exactly the state the first live run was in.
   */
  harnessPackageDir: string
  /** Scratch config dir for pi, so the operator's own packages stay invisible. */
  agentDir: string
  /** Where this process's log file is — the launcher configured logging there; the bundle route reads it (#132). */
  logsDir: string
  port?: number
  /**
   * The pi host to use instead of building one from `cwd` / `agentDir` /
   * `harnessPackageDir`. ⓘ Exists for `__tests__/server-handler.test.ts` (#76): a fake host
   * whose sessions record abort/dispose is the only way to observe the handler's
   * stop/release sequencing without a model. Production launchers never pass it.
   */
  host?: AgentHost
  /** SSE keepalive interval; defaults to `SSE_KEEPALIVE_MS`. ⓘ Injectable for `server-handler.test.ts`. */
  sseKeepaliveMs?: number
}

/** What a started server hands back — the node server plus the lifecycle the launchers drive. */
export interface EnsoServerHandle {
  readonly server: Server
  readonly url: string
  /** Resolves with the bound origin once listening; rejects if the bind failed. */
  readonly listening: Promise<string>
  readonly close: () => Promise<void>
}

/*
 * ⚠⚠ THE FIRST LIVE RUN EXPOSED THIS, AND IT WAS A SECURITY DEFECT — kept as history because
 * the in-process host inherits the same obligation.
 *
 * The spawned `pi --mode rpc` inherited the environment, so pi loaded the OPERATOR'S GLOBAL
 * CONFIG — `~/.pi/agent`, all sixteen of their packages, and **not the enso harness**.
 * Observed directly in the first SSE stream: pi-lens status lines, powerline widgets and a
 * pi-multi-account advisor warning, none of which this package installs. The web surface
 * was running with **no Tier 0 guard at all**.
 *
 * The in-process host (`host/agent-host.ts`, #69) applies the same isolation as loader
 * options — `noExtensions`, `noSkills`, the harness dir as the only extension path — and
 * sets `PI_CODING_AGENT_DIR` on this process before the first session, because
 * pi-multi-account reads it at module import (spike receipt: unset, it read the operator's
 * real credentials again).
 */

/**
 * Refuse to start if the harness package's vendor links are missing.
 *
 * ⚠⚠ THIS EXISTS BECAUSE THE ABSENCE WAS SILENT AND THE SYMPTOM WAS UNRELATED.
 * `npm install` rebuilds `node_modules` and destroys the links `npm run link:vendor`
 * creates. When that happened, `pi -e <package>` loaded — pi SKIPS a missing manifest
 * resource path without a word — so `pi-multi-account` was simply absent, and the visible
 * failure was an HTTP 400 from the provider several layers away. Diagnosing that from the
 * 400 took a detour through expiry checks and rpc-mode hypotheses, none of which were the
 * cause.
 *
 * `scripts/enso.ts` already refuses to launch on the same condition. The server had no
 * equivalent, which is the asymmetry this closes: two launch points, one precondition, and
 * it must be enforced at both or the unenforced one becomes the confusing path. Since #221
 * the precondition is also one IMPLEMENTATION — `@enso/core/pi-manifest` — so "what pi will
 * read as a literal vendor path" is decided in one file rather than at each launch point.
 */
function assertVendorLinks(harnessPackageDir: string): void {
  const manifestPath = join(harnessPackageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`enso-server: no package.json at ${harnessPackageDir}`)
  }
  // The manifest is parsed JSON and stays `unknown` here: the narrowing belongs to the one
  // module that knows what pi reads out of it (#221).
  const missing = missingVendorPaths(JSON.parse(readFileSync(manifestPath, 'utf8')), harnessPackageDir)
  if (missing.length > 0) {
    throw new Error(
      `enso-server: vendor package paths are missing from the harness package:\n` +
        `${missing.map((vendorPath) => `  - ${vendorPath}`).join('\n')}\n` +
        `Run \`bun install\` (its postinstall relinks the vendor packages).`,
    )
  }
}

export function startEnsoServer(options: EnsoServerOptions): EnsoServerHandle {
  if (options.cwd.length === 0) {
    // ⚠ Fail at startup rather than on the first request. A bad `cwd` discovered mid-run
    // is a confusing failure; discovered at boot it is a one-line message.
    throw new Error('enso-server: cwd must not be empty')
  }
  assertVendorLinks(options.harnessPackageDir)

  // pi, in this process (#69). Creating the host sets the isolation env and pins the
  // multi-account config; sessions are created per chat THREAD below and live across runs
  // (#43 — a mode chosen on prompt 1 is in force on prompt 2).
  const sseKeepaliveMs = options.sseKeepaliveMs ?? SSE_KEEPALIVE_MS
  const host: AgentHost =
    options.host ??
    createAgentHost({
      cwd: options.cwd,
      agentDir: options.agentDir,
      harnessPackageDir: options.harnessPackageDir,
    })
  const threads = createThreadRegistry({
    createSession: (threadId: string) => host.createSession(threadId),
  })
  /** The one live-or-cold read (#214), shared with the follow route's snapshot. */
  const threadRead: ThreadReadDeps = { threads, host }

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
   * pi's session files for this workspace (#95) — what the rail can come back to. `busy`
   * marks the ones a thread on THIS server is running right now; the rail shows those but
   * does not offer them, and `/history` refuses them below.
   */
  async function respondWithStoredThreads(response: ServerResponse): Promise<void> {
    const stored = await host.listSessions()
    const payload: EnsoStoredThread[] = stored.map((session) => ({
      threadId: session.id,
      ...(session.firstMessage.trim().length === 0 ? {} : { title: session.firstMessage.trim() }),
      lastActivityAt: session.modified.toISOString(),
      messageCount: session.messageCount,
      busy: threads.peek(session.id)?.busy === true,
    }))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  /**
   * The thread's branch as the messages a chat mounts with (#95), plus its permission mode.
   * Read-only — looking must not build (#86).
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
   *     this route decides that the follow decides differently (`present`).
   *
   * The read itself is `thread-read.ts#readThreadMount` (#214), shared with the follow's
   * snapshot: HERE is settled AFTER the file read, so a thread built during it is served
   * pi's memory rather than the file both routes were racing.
   */
  async function respondWithThreadHistory(threadId: string, response: ServerResponse): Promise<void> {
    const mount = await readThreadMount(threadRead, threadId)
    if (!mount.present) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no session for thread ${threadId}`)
      return
    }

    const payload: EnsoThreadHistory = {
      threadId,
      messages: mount.messages,
      permissionMode: mount.permissionMode,
      ...(mount.interrupted === undefined ? {} : { interrupted: mount.interrupted }),
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  /**
   * ⚠ The dispatcher is synchronous and a throw in the request listener has nothing above
   * it (PR #87). The two handlers that await the host run through here: a rejection is
   * reported and answered as a 500, and the server stays up.
   */
  function answerOrFail(work: Promise<void>, response: ServerResponse): void {
    work.catch((error: unknown) => {
      log.error('a handler failed: {error}', { error })
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('the session listing failed — see the server log')
    })
  }

  /**
   * The slash commands a thread can run (#338). Live: its runtime's own list. Not live: the
   * list the last built session registered, or none — said as `source`, because looking must
   * not build (#86) and a palette that quietly showed a stale list would be a palette that lies.
   * A remembered list's host rows lose their `value` (#338 slice 2): this thread has no session
   * and so no current model; the options are every session's. No record: this is the palette
   * OPENING, and a reader opening a menu is not an event.
   */
  function respondWithThreadCommands(threadId: string, response: ServerResponse): void {
    const live = threads.peek(threadId)
    const remembered = threads.rememberedCommands()
    let payload: EnsoThreadCommands = { threadId, commands: [], source: 'none' }
    if (live !== undefined) payload = { threadId, commands: live.hosted.runtime.listCommands(), source: 'live' }
    else if (remembered !== undefined) {
      payload = { threadId, commands: withoutHostValues(remembered), source: 'remembered' }
    }
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

  // The bundle (#132): today's records + the live threads + the versions, one file.
  const bundle = createBundleRoute({ threads, logsDir: options.logsDir, runtimeVersion: AGENT_RUNTIME_VERSION })

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
  const logTailDeps: LogTailRouteDeps = { logsDir: options.logsDir, sseKeepaliveMs }
  // The day, derived (#144 slice 4): the whole file folded per request, never the tail's cap.
  const stats = createLogStatsRoute({ logsDir: options.logsDir })
  // One thread, analysed (#45 phase 2): pi's session for the numbers, the day files for the times.
  const threadStats = createThreadStatsRoute({ threads, host, logsDir: options.logsDir })

  /**
   * The thread's stats, or 404 for a thread the server holds neither live nor on disk. Built
   * before the head, as `respondWithStats` is: a day file that fails to read is the 500
   * `answerOrFail` writes, never a throw after a committed 200.
   */
  async function respondWithThreadStats(threadId: string, response: ServerResponse): Promise<void> {
    const payload = await threadStats(threadId)
    if (payload === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no session for thread ${threadId}`)
      return
    }
    const body = JSON.stringify(payload)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(body)
  }

  /**
   * The payload before the head (PR #336 review): the fold reads the file synchronously and
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

  // ── The wire (#112): prompt / follow / dialog ────────────────────────────────────
  const followDeps: FollowRouteDeps = { threads, host, sseKeepaliveMs }

  /**
   * The thread routes, one row each, in precedence order (#174, workstream 6): method, the
   * path pattern with the id as its one capture, and the handler. The dispatcher below is the
   * table, not a case per row — it was seven copies of match → decode → handler in two
   * ladders. Every row runs under the thread's log context, so a record from any of them
   * names its thread; before the table only the wire's four did. A handler that returns a
   * promise is answered-or-failed (a rejection is a 500, the server stays up); a bad body is
   * a 400 inside the handler, never a throw. A row whose handler reads the body takes
   * `request` as it is (`respondToPrompt`, `respondToDialog`); one that reads only the id is
   * wrapped in `idOnly`, so the table says which is which.
   */
  type ThreadRouteHandler = (
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>
  interface ThreadRoute {
    readonly method: 'GET' | 'POST'
    readonly route: RegExp
    readonly respond: ThreadRouteHandler
  }
  /** A handler that reads no body: the row's arrow names the id and the response. */
  function idOnly(respond: (threadId: string, response: ServerResponse) => void | Promise<void>): ThreadRouteHandler {
    return (threadId: string, _request: IncomingMessage, response: ServerResponse) => respond(threadId, response)
  }
  const THREAD_ROUTES: readonly ThreadRoute[] = [
    {
      method: 'GET',
      route: THREAD_EVENTS_ROUTE,
      respond: idOnly(respondWithThreadEvents),
    },
    {
      method: 'GET',
      route: THREAD_HISTORY_ROUTE,
      respond: idOnly(respondWithThreadHistory),
    },
    {
      method: 'GET',
      route: THREAD_COMMANDS_ROUTE,
      respond: idOnly(respondWithThreadCommands),
    },
    {
      method: 'GET',
      route: THREAD_STATS_ROUTE,
      respond: idOnly(respondWithThreadStats),
    },
    {
      method: 'GET',
      route: THREAD_ROUTE,
      respond: idOnly(respondWithThread),
    },
    {
      method: 'GET',
      route: THREAD_FOLLOW_ROUTE,
      respond: idOnly((threadId: string, response: ServerResponse) => followThread(followDeps, threadId, response)),
    },
    { method: 'POST', route: THREAD_PROMPT_ROUTE, respond: respondToPrompt },
    { method: 'POST', route: THREAD_DIALOG_ROUTE, respond: respondToDialog },
    { method: 'POST', route: THREAD_MODE_ROUTE, respond: respondToModeChange },
    { method: 'POST', route: THREAD_COMMAND_ROUTE, respond: respondToHostCommand },
    {
      method: 'POST',
      route: THREAD_ABORT_ROUTE,
      respond: idOnly(respondToAbort),
    },
  ]

  /** True when the request was a thread route — answered, or refused with the 400 `decodeThreadId` wrote. */
  function dispatchThreadRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    for (const { method, route, respond } of THREAD_ROUTES) {
      if (request.method !== method) continue
      const segment = route.exec(url)?.[1]
      if (segment === undefined) continue
      const threadId = decodeThreadId(segment, response)
      if (threadId !== undefined) {
        withEnsoLogContext({ threadId }, () => {
          const work = respond(threadId, request, response)
          if (work !== undefined) answerOrFail(work, response)
        })
      }
      return true
    }
    return false
  }

  async function respondToPrompt(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request, response, {
      maxBytes: ENSO_PROMPT_BODY_MAX_BYTES,
      capText: `a prompt body is at most ${ENSO_PROMPT_BODY_MAX_BYTES} bytes (${ENSO_PROMPT_MAX_IMAGES} images of ${ENSO_IMAGE_MAX_BYTES} bytes, base64, plus text)`,
      parse: readPromptBody,
    })
    if (body === undefined) return
    if (body.images !== undefined) {
      // The audit line (#68): what crossed, never the bytes. One record per prompt with images.
      log.info('prompt carries {count} image(s): {mimeTypes}, {bytes} bytes', {
        threadId,
        count: body.images.length,
        mimeTypes: body.images.map((image) => image.mimeType),
        bytes: body.images.reduce((total, image) => total + base64DecodedBytes(image.data), 0),
      })
    }
    const outcome = await promptThread(followDeps, threadId, body)
    if (outcome.status === 400) {
      log.warn('prompt refused: {reason}', { threadId, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    const { messageId, generation, queued } = outcome.receipt
    // The clock the first-delta record measures from (#144); a queued prompt joins the run
    // already in flight and does not restart it.
    noteRunAdmitted(threadId, generation)
    // ⚠ TWO DIFFERENT FACTS, TWO NAMES (PR #326 review). `admission` is what the SERVER did —
    // `queued` or `opened`, the record #132 asks for — and `requestedAdmission` is what the
    // CLIENT asked for. #216's rename gave the request the word `admission` too, and an object
    // literal's later key wins: the spread silently overwrote the outcome on every queued
    // prompt the browser sends, which is every prompt typed while a run is in flight. The
    // wire field keeps its name; the record's older one keeps its meaning.
    log.info(ENSO_LOG_EVENTS.promptAdmitted, {
      threadId,
      messageId,
      generation,
      admission: queued ? 'queued' : 'opened',
      ...(body.admission === undefined ? {} : { requestedAdmission: body.admission }),
    })
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.receipt))
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

  /** No body to read: the thread id is the whole request (#116). The answer is the restored queue (#75). */
  function respondToAbort(threadId: string, response: ServerResponse): void {
    const outcome = abortThread(followDeps, threadId)
    if (outcome.status !== 200) {
      log.warn('abort refused ({status}): {reason}', { threadId, status: outcome.status, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    log.info('abort: queue of {restored} restored to the caller', {
      threadId,
      restored: outcome.receipt.restored.length,
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.receipt))
  }

  async function respondToDialog(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A dialog answer is an id and a short value; nothing legitimate approaches this.
    const answer = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a dialog answer is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: readDialogBody,
    })
    if (answer === undefined) return
    const outcome = answerThreadDialog(followDeps, threadId, answer)
    if (outcome.status !== 204) {
      log.warn('dialog {dialogId} answer refused ({status}): {reason}', {
        threadId,
        dialogId: answer.id,
        status: outcome.status,
        reason: outcome.reason,
      })
      refuseWith(response, outcome)
      return
    }
    log.info('dialog {dialogId} answered', { threadId, dialogId: answer.id })
    response.writeHead(204)
    response.end()
  }

  async function respondToModeChange(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // A mode name; nothing legitimate approaches the dialog cap either.
    const change = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a mode change is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: readModeChangeBody,
    })
    if (change === undefined) return
    const outcome = await changeThreadMode(followDeps, threadId, change)
    if (outcome.status !== 204) {
      log.warn('mode change to {mode} refused ({status}): {reason}', {
        threadId,
        mode: change.mode,
        status: outcome.status,
        reason: outcome.reason,
      })
      refuseWith(response, outcome)
      return
    }
    log.info('mode change to {mode} told', { threadId, mode: change.mode })
    response.writeHead(204)
    response.end()
  }

  async function respondToHostCommand(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // A command name and one option id; the dialog cap is generous for it.
    const run = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a host command is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: readHostCommandBody,
    })
    if (run === undefined) return
    const outcome = await runHostCommand(followDeps, threadId, run)
    if (outcome.status !== 204 && outcome.status !== 202) {
      log.warn('host command {name} refused ({status}): {reason}', {
        threadId,
        name: run.name,
        status: outcome.status,
        reason: outcome.reason,
      })
      refuseWith(response, outcome)
      return
    }
    log.info(outcome.status === 202 ? 'host flow {name} started' : 'host command {name} applied', {
      threadId,
      name: run.name,
      ...(run.value === undefined ? {} : { value: run.value }),
    })
    response.writeHead(outcome.status)
    response.end()
  }

  /**
   * The one check that stands between a page the operator happens to visit and an agent
   * with unconfined `bash` in their tree.
   *
   * ⚠ Binding loopback is NOT an authorization boundary against a browser (review of the
   * lint/hardening pass). A page on any origin can POST to `127.0.0.1:5179`, and
   * `/api/threads/<id>/prompt` is a CORS-*simple* request — `JSON.parse` never consults
   * `Content-Type`, so `text/plain` reaches the handler with no preflight — and
   * `threads.acquire` mints a session for any id matching the pattern, so no existing
   * thread need be known. The reply is opaque to the attacker, but the side effect is a
   * full agent run. Two independent checks, both here so every route inherits them:
   *
   * 1. `Host` must name loopback. Node does not validate it, and a DNS name that resolves
   *    to 127.0.0.1 (rebinding) makes the READ side — `/api/threads/:id`, the verbatim
   *    branch, and the log bundle — same-origin readable. A rebound name is not loopback.
   * 2. `Origin`, when the header is PRESENT, must parse and name loopback. Browsers always
   *    send it on cross-origin POSTs; `curl` and the repo's own CLIs send none, so they are
   *    unaffected. Either dev port satisfies it, and the 5178 proxy forwards both headers
   *    unchanged.
   *
   * ⚠ An ABSENT header is trusted; the literal string `null` is NOT (#205, #160 §3). An
   * opaque-origin browsing context — a sandboxed iframe, a `file://` page, a `data:`
   * document — sends `Origin: null`, which is a browser saying "cross-origin, and I will
   * not name who". Trusting it left the whole control plane open to a page the operator
   * merely visits: measured before this fix, `Origin: null` escalated a thread to
   * `bypassPermissions` (204), drove a run on an id nobody owned (202) and approved the
   * permission dialog that run opened (204). `new URL('null')` throws, so the string needs
   * no arm of its own — it fails the parse below. Only the absent header is trusted, and
   * only because no browser can produce it.
   */
  function fromTrustedOrigin(request: IncomingMessage): boolean {
    const hostHeader = request.headers.host
    if (hostHeader === undefined || !isLoopbackAuthority(hostHeader)) return false
    const origin = request.headers.origin
    if (origin === undefined) return true
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return false
    }
    return isLoopbackAuthority(originHost)
  }

  /**
   * The literal routes — the ones whose path is a constant rather than a thread's id — in
   * precedence order. True when the request was one of them.
   *
   * ⚠ Its own function, beside `dispatchThreadRoute`, for the reason #174 gave when the thread
   * routes became a table: the request callback is where every arm's cost lands, and it had
   * reached the complexity ceiling as written (26 against a 25 max, the frame `#144`'s tail
   * route pushed it over). The ladder stays a ladder here rather than becoming a second table
   * because each of these answers differently — a JSON body, a stream, a 204, an
   * answered-or-failed promise — and a table of six shapes is a `switch` wearing a hat.
   */
  function dispatchLiteralRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
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
    if (request.method === 'GET' && url === '/api/about') {
      // No log line here, by rule (#144): a surface that exists to read the trace must not
      // write to it.
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(about()))
      return true
    }
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

  // ⚠ Routes dispatch HERE, outside the chat handler, on purpose: that handler's top-to-bottom
  // shape is the #27/#34 teardown ordering (#82). What is left in the callback is the one check
  // every request is admitted by, then the two dispatchers and the miss.
  const server = createServer((request, response) => {
    if (!fromTrustedOrigin(request)) {
      log.warn('request refused: {method} {url} from host {host} origin {origin}', {
        method: request.method,
        url: request.url ?? '',
        host: request.headers.host,
        origin: request.headers.origin,
      })
      response.writeHead(403, { 'Content-Type': 'text/plain' })
      response.end('this server answers the machine it runs on, and only to a loopback origin')
      return
    }
    if (dispatchLiteralRoute(request, response)) return
    if (dispatchThreadRoute(request, response)) return
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
  })

  // Every thread's session is disposed with the server.
  server.on('close', () => {
    threads.shutdown()
  })

  const port = options.port ?? DEFAULT_PORT

  // ⚠ Without this, a port clash surfaces as an unhandled 'error' event and a Node stack
  // trace — which is what happened, and which reads as "the server is broken" rather than
  // "something else is already listening". Observed while restarting during development,
  // and it cost a minute of reading a trace to learn a one-line fact.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      log.error(
        'port {port} is already in use — another enso server is probably running; stop it, or pass a different port',
        {
          port,
        },
      )
      return
    }
    log.error('server error: {error}', { error })
  })

  // Resolves with the URL of the port the OS actually bound — the same as `url` unless the
  // caller asked for port 0 (tests do), where `url` would name a port that does not exist.
  const listening = new Promise<string>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address !== null ? address.port : port
      resolve(`http://${LOOPBACK_ONLY}:${boundPort}`)
    })
    // A bind failure emits 'error' (handled above), never 'listening'. Under Bun the
    // 'listening' event does not re-fire afterwards, so without this the promise would
    // hang forever and any `await listening` caller (dev.ts) would dangle silently. The
    // 'error' handler already logged the cause; this only settles the wait.
    server.once('error', reject)
  })
  server.listen(port, LOOPBACK_ONLY)
  return {
    server,
    url: `http://${LOOPBACK_ONLY}:${port}`,
    listening,
    close: (): Promise<void> => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
