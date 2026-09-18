import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  base64DecodedBytes,
  type DialogAnswer,
  isZenThreadId,
  withZenLogContext,
  ZEN_IMAGE_MAX_BYTES,
  ZEN_PROMPT_BODY_MAX_BYTES,
  ZEN_PROMPT_MAX_IMAGES,
  type ZenPermissionModeChange,
  type ZenStoredThread,
  type ZenThreadEvents,
  type ZenThreadHistory,
  type ZenThreadSummary,
  zenLogger,
} from '@zen/core'
import { missingVendorPaths } from '@zen/core/pi-manifest'
import { AGENT_RUNTIME_VERSION, type AgentHost, createAgentHost } from '../host/agent-host.ts'
import { createAboutRoute, createBundleRoute } from './bundle-route.ts'
import {
  abortThread,
  answerThreadDialog,
  changeThreadMode,
  type FollowRouteDeps,
  followThread,
  type PromptBody,
  promptThread,
  readDialogBody,
  readModeChangeBody,
  readPromptBody,
} from './follow.ts'
import { MAX_LOG_BODY_BYTES, receiveBrowserLogs } from './logs-route.ts'
import { noteRunAdmitted } from './run-timing.ts'
import { SSE_KEEPALIVE_MS } from './sse.ts'
import { createThreadRegistry, inspectThread, type ThreadView } from './thread-registry.ts'
import { interruptedTail, transcriptToMessages } from './transcript-to-messages.ts'

/** `GET /api/threads/<threadId>` — the id is one path segment, percent-encoded by the caller. */
const THREAD_ROUTE = /^\/api\/threads\/([^/?#]+)$/
/** `GET /api/threads/<threadId>/events` — the thread's two event tails (#97). */
const THREAD_EVENTS_ROUTE = /^\/api\/threads\/([^/?#]+)\/events$/
/** `GET /api/threads/<threadId>/history` — the branch as messages, live or stored (#95). */
const THREAD_HISTORY_ROUTE = /^\/api\/threads\/([^/?#]+)\/history$/
/** The wire (#112): `POST …/prompt`, `GET …/follow`, `POST …/dialog`, `POST …/abort` (#116). See `follow.ts`. */
const THREAD_FOLLOW_ROUTE = /^\/api\/threads\/([^/?#]+)\/follow$/
const THREAD_PROMPT_ROUTE = /^\/api\/threads\/([^/?#]+)\/prompt$/
const THREAD_DIALOG_ROUTE = /^\/api\/threads\/([^/?#]+)\/dialog$/
const THREAD_ABORT_ROUTE = /^\/api\/threads\/([^/?#]+)\/abort$/
/** `POST …/mode` (#162 workstream 4, L3 step C): switch the mode as a control route, not a prompt. */
const THREAD_MODE_ROUTE = /^\/api\/threads\/([^/?#]+)\/mode$/

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

const log = zenLogger('server', 'http')

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

/**
 * ⚠ `decodeURIComponent` THROWS on a malformed escape (`/api/threads/%`), and a throw in the
 * request listener has nothing above it — it took the whole dev server down, every live
 * session with it, from one hand-typed URL (PR #87 review, reproduced). A bad id is the
 * caller's problem: 400 written here, `undefined` returned, and the server stays up.
 *
 * Since #95 the id is also pi's session id, which pi puts in a FILENAME — so a decoded id
 * that is not thread-id shaped (`isZenThreadId`: `../x`, spaces, anything a filesystem could
 * read) is the same 400. Nothing downstream ever sees an id that failed here.
 */
function decodeThreadId(rawSegment: string, response: ServerResponse): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawSegment)
  } catch {
    decoded = ''
  }
  if (isZenThreadId(decoded)) return decoded
  response.writeHead(400, { 'Content-Type': 'text/plain' })
  response.end('malformed thread id')
  return undefined
}

export interface ZenServerOptions {
  /**
   * Where pi runs — the tree it will read and write. With no sandbox (#24) this value IS
   * the blast radius; it comes from the launcher's own arguments, never from a request.
   */
  cwd: string
  /**
   * The zen-harness pi package directory, loaded as the ONLY extension source.
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
export interface ZenServerHandle {
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
 * CONFIG — `~/.pi/agent`, all sixteen of their packages, and **not the zen harness**.
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
 * `scripts/zen.mjs` already refuses to launch on the same condition. The server had no
 * equivalent, which is the asymmetry this closes: two launch points, one precondition, and
 * it must be enforced at both or the unenforced one becomes the confusing path. Since #221
 * the precondition is also one IMPLEMENTATION — `@zen/core/pi-manifest` — so "what pi will
 * read as a literal vendor path" is decided in one file rather than at each launch point.
 */
function assertVendorLinks(harnessPackageDir: string): void {
  const manifestPath = join(harnessPackageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`zen-server: no package.json at ${harnessPackageDir}`)
  }
  // The manifest is parsed JSON and stays `unknown` here: the narrowing belongs to the one
  // module that knows what pi reads out of it (#221).
  const missing = missingVendorPaths(JSON.parse(readFileSync(manifestPath, 'utf8')), harnessPackageDir)
  if (missing.length > 0) {
    throw new Error(
      `zen-server: vendor package paths are missing from the harness package:\n` +
        `${missing.map((vendorPath) => `  - ${vendorPath}`).join('\n')}\n` +
        `Run \`bun install\` (its postinstall relinks the vendor packages).`,
    )
  }
}

export function startZenServer(options: ZenServerOptions): ZenServerHandle {
  if (options.cwd.length === 0) {
    // ⚠ Fail at startup rather than on the first request. A bad `cwd` discovered mid-run
    // is a confusing failure; discovered at boot it is a one-line message.
    throw new Error('zen-server: cwd must not be empty')
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
  // human (the debug drawer) or an agent (`scripts/zen-thread.mjs`) to cross-check the
  // derived views against. Read-only. Never creates a session — `threads.peek`, never
  // `acquire`: looking must not be the thing that spins pi up. Loopback-only by the
  // server's bind; the branch is conversation and tool output, which is the point.
  function summarize(thread: ThreadView): ZenThreadSummary {
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
    const payload: ZenThreadEvents = {
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
    const payload: ZenStoredThread[] = stored.map((session) => ({
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
   *   • NOT here: the file, with the mode its branch persists. Neither: 404.
   */
  async function respondWithThreadHistory(threadId: string, response: ServerResponse): Promise<void> {
    const live = threads.peek(threadId)
    const transcript = live === undefined ? await host.readTranscript(threadId) : live.hosted.inspect().entries
    if (transcript === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no session for thread ${threadId}`)
      return
    }
    const messages = transcriptToMessages(transcript)
    const interrupted = interruptedTail(transcript)
    const payload: ZenThreadHistory = {
      threadId,
      messages,
      permissionMode:
        live === undefined ? host.storedPermissionMode(transcript) : live.hosted.runtime.permissionModeState(),
      ...(interrupted === undefined ? {} : { interrupted }),
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
    const outcome = bundle(new URL(url, 'http://zen').searchParams)
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
        withZenLogContext({ threadId }, () => {
          const work = respond(threadId, request, response)
          if (work !== undefined) answerOrFail(work, response)
        })
      }
      return true
    }
    return false
  }

  async function respondToPrompt(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: PromptBody
    try {
      body = readPromptBody(await readBody(request, ZEN_PROMPT_BODY_MAX_BYTES))
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        endAndClose(
          request,
          response,
          413,
          `a prompt body is at most ${ZEN_PROMPT_BODY_MAX_BYTES} bytes (${ZEN_PROMPT_MAX_IMAGES} images of ${ZEN_IMAGE_MAX_BYTES} bytes, base64, plus text)`,
        )
        return
      }
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end((error as Error).message)
      return
    }
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
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end(outcome.reason)
      return
    }
    const { messageId, generation, queued } = outcome.receipt
    // The clock the first-delta record measures from (#144); a queued prompt joins the run
    // already in flight and does not restart it.
    noteRunAdmitted(threadId, generation)
    log.info('prompt {messageId} {admission} on run {generation}', {
      threadId,
      messageId,
      generation,
      admission: queued ? 'queued' : 'opened',
      ...(body.streamingBehavior === undefined ? {} : { streamingBehavior: body.streamingBehavior }),
    })
    response.writeHead(202, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.receipt))
  }

  /** The browser's records (#132 slice 3): into this process's logger, or a 4xx that says why — never logged itself. */
  async function respondToBrowserLogs(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The cap is passed, not left to the schema check downstream: `receiveBrowserLogs` can
    // only refuse a batch it has already buffered whole, which is the thing `readBody`'s
    // `maxBytes` exists to avoid.
    let body: string
    try {
      body = await readBody(request, MAX_LOG_BODY_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        endAndClose(request, response, 413, `a log batch is at most ${MAX_LOG_BODY_BYTES} bytes`)
        return
      }
      throw error
    }
    const outcome = receiveBrowserLogs(body)
    if (outcome.status !== 204) {
      response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
      response.end(outcome.reason)
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
      response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
      response.end(outcome.reason)
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
    let answer: DialogAnswer
    try {
      // A dialog answer is an id and a short value; nothing legitimate approaches this.
      answer = readDialogBody(await readBody(request, MAX_DIALOG_BODY_BYTES))
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        endAndClose(request, response, 413, `a dialog answer is at most ${MAX_DIALOG_BODY_BYTES} bytes`)
        return
      }
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end((error as Error).message)
      return
    }
    const outcome = answerThreadDialog(followDeps, threadId, answer)
    if (outcome.status !== 204) {
      log.warn('dialog {dialogId} answer refused ({status}): {reason}', {
        threadId,
        dialogId: answer.id,
        status: outcome.status,
        reason: outcome.reason,
      })
      response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
      response.end(outcome.reason)
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
    let change: ZenPermissionModeChange
    try {
      // A mode name; nothing legitimate approaches the dialog cap either.
      change = readModeChangeBody(await readBody(request, MAX_DIALOG_BODY_BYTES))
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        endAndClose(request, response, 413, `a mode change is at most ${MAX_DIALOG_BODY_BYTES} bytes`)
        return
      }
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end((error as Error).message)
      return
    }
    const outcome = await changeThreadMode(followDeps, threadId, change)
    if (outcome.status !== 204) {
      log.warn('mode change to {mode} refused ({status}): {reason}', {
        threadId,
        mode: change.mode,
        status: outcome.status,
        reason: outcome.reason,
      })
      response.writeHead(outcome.status, { 'Content-Type': 'text/plain' })
      response.end(outcome.reason)
      return
    }
    log.info('mode change to {mode} told', { threadId, mode: change.mode })
    response.writeHead(204)
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
   * 2. `Origin`, when the caller sends one, must be loopback too. Browsers always send it
   *    on cross-origin POSTs; `curl` and the repo's own CLIs send none, so they are
   *    unaffected. Either dev port satisfies it, and the 5178 proxy forwards both headers
   *    unchanged.
   */
  function fromTrustedOrigin(request: IncomingMessage): boolean {
    const hostHeader = request.headers.host
    if (hostHeader === undefined || !isLoopbackAuthority(hostHeader)) return false
    const origin = request.headers.origin
    if (origin === undefined || origin === 'null') return true
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return false
    }
    return isLoopbackAuthority(originHost)
  }

  // ⚠ Routes dispatch HERE, outside the chat handler, on purpose: that handler's top-to-bottom
  // shape is the #27/#34 teardown ordering (#82). A literal route is one arm that calls its
  // handler; a thread route is a row of THREAD_ROUTES. This file needed its own complexity
  // pin (49) until the thread routes became the table (#174); it now clears the global ceiling.
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    if (!fromTrustedOrigin(request)) {
      log.warn('request refused: {method} {url} from host {host} origin {origin}', {
        method: request.method,
        url,
        host: request.headers.host,
        origin: request.headers.origin,
      })
      response.writeHead(403, { 'Content-Type': 'text/plain' })
      response.end('this server answers the machine it runs on, and only to a loopback origin')
      return
    }
    if (request.method === 'GET' && url === '/api/mode') {
      respondWithFreshThreadMode(response)
      return
    }
    if (request.method === 'GET' && url === '/api/threads') {
      respondWithThreads(response)
      return
    }
    if (request.method === 'GET' && url === '/api/stored-threads') {
      answerOrFail(respondWithStoredThreads(response), response)
      return
    }
    if (request.method === 'GET' && url === '/api/about') {
      // No log line here, by rule (#144): a surface that exists to read the trace must not
      // write to it.
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(about()))
      return
    }
    if (request.method === 'GET' && url.startsWith('/api/logs/bundle')) {
      respondWithBundle(url, response)
      return
    }
    if (request.method === 'POST' && url === '/api/logs') {
      answerOrFail(respondToBrowserLogs(request, response), response)
      return
    }
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
        'port {port} is already in use — another zen server is probably running; stop it, or pass a different port',
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
