import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  base64DecodedBytes,
  DEFAULT_RISK_THRESHOLDS,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_LOG_EVENTS,
  ENSO_PROJECT_HEADER,
  ENSO_PROMPT_BODY_MAX_BYTES,
  ENSO_PROMPT_MAX_IMAGES,
  EnsoPermissionCheckRequest,
  type EnsoPermissionPolicyRead,
  type EnsoPermissionPolicyReset,
  EnsoPermissionPolicyWrite,
  EnsoProjectRegistration,
  type EnsoProjectsConfig,
  type EnsoRiskThresholds,
  type EnsoStoredThread,
  type EnsoSystemPromptChoice,
  type EnsoThreadCommands,
  type EnsoThreadEvents,
  type EnsoThreadHistory,
  type EnsoThreadSummary,
  ensoLogger,
  isEnsoThreadId,
  LIBRARY_PROMPT_ID_SOURCE,
  withEnsoLogContext,
} from '@enso/core'
import { readGitChanges, readGitState, runGit } from '@enso/core/git'
import { missingVendorPaths } from '@enso/core/pi-manifest'
import { AGENT_RUNTIME_VERSION, type AgentHost, createAgentHost, SessionDirectoryRefused } from '../host/agent-host.ts'
import { withoutHostValues } from '../host/host-commands.ts'
import { readPermissionPolicy, resetPermissionPolicy, writePermissionPolicy } from '../host/permission-policy-file.ts'
import { createAboutRoute, createBundleRoute } from './bundle-route.ts'
import {
  abortThread,
  answerThreadDialog,
  changeThreadMode,
  configureThread,
  continueThread,
  type FollowRouteDeps,
  followThread,
  forkThreadAt,
  promptThread,
  readClosedBody,
  readConfigureBody,
  readDialogBody,
  readForkBody,
  readHostCommandBody,
  readIncidentResolutionBody,
  readModeChangeBody,
  readPromptBody,
  resolveThreadIncident,
  runHostCommand,
} from './follow.ts'
import { MAX_LOG_BODY_BYTES, receiveBrowserLogs } from './logs-route.ts'
import { createLogStatsRoute } from './logs-stats-route.ts'
import { followLogTail, type LogTailRouteDeps } from './logs-tail-route.ts'
import { createProjectRegistry, ProjectUnavailable } from './projects.ts'
import {
  createPromptLibrary,
  NO_PROMPT_LIBRARY,
  type LibraryRead,
  draftChoice,
  type PromptLibrary,
  readPromptWriteBody,
  readSystemPromptDraftBody,
  type SystemPromptPick,
  type WriteCondition,
} from './prompt-library.ts'
import { SSE_KEEPALIVE_MS } from './sse.ts'
import { createContextRequestRoute, createThreadContextRoute } from './thread-context-route.ts'
import { createThreadEvalRoute } from './thread-eval-route.ts'
import { createThreadChangesRoute, createThreadGitRoute } from './thread-git-route.ts'
import { createThreadSecurityReads, replayThresholdsOf } from './thread-incidents-route.ts'
import { createThreadManifestRoute } from './thread-manifest-route.ts'
import { readThreadMount, type ThreadReadDeps } from './thread-read.ts'
import { createThreadRegistry, inspectThread, type ThreadView } from './thread-registry.ts'
import { createThreadStatsRoute } from './thread-stats-route.ts'

/**
 * `/api/threads/<threadId>/<action>`: the id is one path segment, percent-encoded by the caller,
 * and the route's first capture; the action names what is asked of the thread.
 */
function threadRoute(action: string): RegExp {
  return new RegExp(`^/api/threads/([^/?#]+)/${action}$`)
}

/** `GET /api/threads/<threadId>` — the id is one path segment, percent-encoded by the caller. */
const THREAD_ROUTE = /^\/api\/threads\/([^/?#]+)$/
/** `GET /api/threads/<threadId>/events` — the thread's two event tails (#97). */
const THREAD_EVENTS_ROUTE = threadRoute('events')
/** `GET /api/threads/<threadId>/history` — the branch as messages, live or stored (#95). */
const THREAD_HISTORY_ROUTE = threadRoute('history')
/** `GET /api/threads/<threadId>/commands` — the slash commands the thread can run, for the palette (#338). */
const THREAD_COMMANDS_ROUTE = threadRoute('commands')
/** `GET /api/threads/<threadId>/stats` — the thread analysed: per prompt, turn and tool (#45). */
const THREAD_STATS_ROUTE = threadRoute('stats')
/** `GET /api/threads/<threadId>/context` — the thread's context, request by request (#361). */
const THREAD_CONTEXT_ROUTE = threadRoute('context')
/** `GET /api/threads/<threadId>/context/<turn|next>` — one request's context, element by element (#361). */
const THREAD_CONTEXT_REQUEST_ROUTE = /^\/api\/threads\/([^/?#]+)\/context\/([1-9]\d*|next)$/
/** `GET /api/threads/<threadId>/manifest` — the thread's fork point: identity, then run conditions (#435). */
const THREAD_MANIFEST_ROUTE = threadRoute('manifest')
/** `GET /api/threads/<threadId>/eval` — the thread's session eval: mechanical timeline and scorecard (#441). */
const THREAD_EVAL_ROUTE = threadRoute('eval')
/** `GET /api/threads/<threadId>/git` — git in the thread's cwd: branch, last-push baseline, unpushed work (#453). */
const THREAD_GIT_ROUTE = threadRoute('git')
/** `GET /api/threads/<threadId>/changes` — every file that differs from the last-push baseline, with its patch (#452). */
const THREAD_CHANGES_ROUTE = threadRoute('changes')
/** `GET /api/threads/<threadId>/judge-cases` — the calls the command judge would be asked about, redacted (#469). */
const THREAD_JUDGE_CASES_ROUTE = threadRoute('judge-cases')
/** The wire (#112): `POST …/prompt`, `GET …/follow`, `POST …/dialog`, `POST …/abort` (#116). See `follow.ts`. */
const THREAD_FOLLOW_ROUTE = threadRoute('follow')
const THREAD_PROMPT_ROUTE = threadRoute('prompt')
const THREAD_DIALOG_ROUTE = threadRoute('dialog')
const THREAD_ABORT_ROUTE = threadRoute('abort')
/** `POST …/mode` (#162 workstream 4, L3 step C): switch the mode as a control route, not a prompt. */
const THREAD_MODE_ROUTE = threadRoute('mode')
/** `POST …/command` (#338 slice 2): run a `host` command — `/model`, `/thinking` — as a control route, not a prompt. */
const THREAD_COMMAND_ROUTE = threadRoute('command')
/** `POST …/configure` (#391): a new session's model, effort and mode, applied together — the Start-a-session dialog. */
const THREAD_CONFIGURE_ROUTE = threadRoute('configure')
/**
 * `POST …/permissions/check` (#474): the permission engine's verdict for `{ surface, value }` in the
 * thread's mode now — Settings' "Try a command". Builds the thread on ask, as a preview does.
 */
const THREAD_PERMISSION_CHECK_ROUTE = threadRoute('permissions/check')
/**
 * `GET …/system-prompt[?prompt=<id>]` (#443): the system prompt the thread's next request would carry
 * with a library prompt — pi's default without one — section by section. Builds the thread on ask.
 * The one query parameter is part of the pattern on purpose: its id is the library's own shape
 * (`LIBRARY_PROMPT_ID_SOURCE`), so a malformed id or any other parameter is a 404, never a file lookup.
 */
const THREAD_SYSTEM_PROMPT_ROUTE = new RegExp(
  `^/api/threads/([^/?#]+)/system-prompt(?:\\?prompt=(${LIBRARY_PROMPT_ID_SOURCE}))?$`,
)
/** `POST …/system-prompt` (#443): the same preview for an unsaved prompt's text — the editor's breakdown. */
const THREAD_SYSTEM_PROMPT_DRAFT_ROUTE = threadRoute('system-prompt')
/** `POST …/fork` (#433): fork the thread at one of its user messages — a new thread naming this one as its parent. */
const THREAD_FORK_ROUTE = threadRoute('fork')
/** `POST …/continue` (#436): continue a torn thread from its stored state — no new prompt. */
const THREAD_CONTINUE_ROUTE = threadRoute('continue')
/**
 * `POST …/incidents/<incidentId>/resolve` (#466): a human's resolution of the thread's incident — the
 * one way a suspension is lifted. The incident id is the shape both writers mint (a UUID), so it
 * needs no decoding; any other is no route.
 */
const THREAD_INCIDENT_RESOLVE_ROUTE = /^\/api\/threads\/([^/?#]+)\/incidents\/([0-9A-Za-z-]+)\/resolve$/
/**
 * `GET …/incidents` (#468): the thread's incident history and its replay — under the server's
 * thresholds, or the ones the query names (`?incidentAtSignals=4`). The one thread read that takes a query.
 */
const THREAD_INCIDENTS_ROUTE = /^\/api\/threads\/([^/?#]+)\/incidents(?:\?([^#]*))?$/
/**
 * `/api/prompts/<id>` (#443): a library prompt. The id is its file name in the library's own shape
 * (`LIBRARY_PROMPT_ID_SOURCE`), so it needs no decoding and can never leave the directory.
 */
function promptRoute(): RegExp {
  return new RegExp(`^/api/prompts/(${LIBRARY_PROMPT_ID_SOURCE})$`)
}
/** One constant per method, as the routes reference reads them: `GET` reads it, `PUT` writes it whole, `DELETE` removes it. */
const PROMPT_READ_ROUTE = promptRoute()
const PROMPT_WRITE_ROUTE = promptRoute()
const PROMPT_DELETE_ROUTE = promptRoute()
/** `DELETE /api/projects/<projectId>` (#395) — the id is sixteen hex digits, so it needs no decoding. */
const PROJECT_ROUTE = /^\/api\/projects\/([0-9a-f]{16})$/

/**
 * The dev backend: the thread routes the browser's `FollowConnection` talks to (#112), and
 * the inspection routes beside them.
 *
 * ⚠ DEV ONLY, AND THE REASON IS NOT POLISH.
 * There is no sandbox (#24), `bash` is unconfined (#9), and a session's directory is the tree
 * pi reads and writes — so the directories this process accepts ARE the blast radius. It
 * therefore binds loopback only, and no request chooses a directory the install did not
 * allow: the launch directory comes from ITS OWN launch arguments, and a page may register a
 * project only strictly under a root the user's config declares (#395, `projects.ts`). After
 * that the page names projects by id; a path never reaches a session from a request.
 */
const DEFAULT_PORT = 5179
const LOOPBACK_ONLY = '127.0.0.1'
/** A dialog answer is an id and a short value — kilobytes, not megabytes. */
const MAX_DIALOG_BODY_BYTES = 64 * 1024
/** A permission policy is a hand-sized JSON file; a megabyte is far past any real one (#474). */
const MAX_POLICY_BODY_BYTES = 1024 * 1024
/** A library prompt is a system prompt at most — a few hundred kilobytes is already most of a context window. */
const MAX_PROMPT_BODY_BYTES = 512 * 1024

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

/** A strong entity tag as the library quotes one: a file's sha256, hex. */
const PROMPT_ETAG = /^"[0-9a-f]{64}"$/

/** What a conditional write names in its refusals: a library prompt (#443), or the permission policy (#474). */
type WriteSubject = 'prompt' | 'permission policy'

/** Why a write or delete does not say what it expects: the one line `refuseWith` sends. */
function missingPrecondition(what: 'write' | 'delete', subject: WriteSubject): string {
  return what === 'write'
    ? `a ${subject} write states what it expects on disk: \`If-None-Match: *\` to create, \`If-Match: <ETag>\` to replace the version it read, \`If-Match: *\` to replace whatever is there`
    : `a ${subject} delete states the version it removes: \`If-Match: <ETag>\`, or \`If-Match: *\` for whatever is there`
}

/**
 * The precondition a library write or delete states (#443) — and a permission-policy save (#474):
 * `If-None-Match: *` (create — no file there), `If-Match: "<etag>"` (the version a read answered),
 * `If-Match: *` (whatever is there). ⚠ NONE IS A 428, never an unconditional write: without it a
 * stale page or a script overwrites a file it never read, a refused one included. Both headers, a
 * list, or a weak tag are a 400.
 */
function writeConditionOf(
  request: IncomingMessage,
  what: 'write' | 'delete',
  subject: WriteSubject,
): WriteCondition | { readonly status: 400 | 428; readonly reason: string } {
  const none = request.headers['if-none-match']?.trim()
  const match = request.headers['if-match']?.trim()
  if (none !== undefined && match !== undefined) {
    return { status: 400, reason: `a ${subject} request takes \`If-None-Match\` or \`If-Match\`, not both` }
  }
  if (none !== undefined) {
    return none === '*' ? { kind: 'absent' } : { status: 400, reason: '`If-None-Match` takes only `*`: create' }
  }
  if (match === undefined) return { status: 428, reason: missingPrecondition(what, subject) }
  if (match === '*') return { kind: 'present' }
  return PROMPT_ETAG.test(match)
    ? { kind: 'matches', etag: match }
    : { status: 400, reason: `\`If-Match\` takes \`*\` or the one ETag a read of this ${subject} answered` }
}

/** A body that carries a prompt's text — a library write or a draft — under the prompt cap. */
function readPromptSizedBody<T>(
  request: IncomingMessage,
  response: ServerResponse,
  parse: (text: string) => T,
): Promise<T | undefined> {
  return readJsonBody(request, response, {
    maxBytes: MAX_PROMPT_BODY_BYTES,
    capText: `a prompt is at most ${MAX_PROMPT_BODY_BYTES} bytes`,
    parse,
  })
}

/** A 200 with `body` as JSON. */
function answerJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
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
   * The launch directory: the first project (#395), where a thread nobody named a project for
   * runs. With no sandbox (#24) a session's directory IS its blast radius, so this comes from the
   * launcher's own arguments, never from a request — and every other project must sit under one
   * of `projectRoots`, which also come from the user's config (`ENSO_HOME/config.json`), not the page.
   */
  cwd: string
  /** `projects.roots` from the user's config: where a page may register projects. None means the launch directory only. */
  projectRoots?: Readonly<EnsoProjectsConfig['roots']>
  /** The config file `projectRoots` came from, named when a refusal says to declare a root. */
  projectsConfigPath?: string
  /** Where registrations are kept (`.enso/projects.json`); absent, they last as long as the process (tests). */
  projectsStatePath?: string
  /** The prompt library's directory (`ENSO_HOME/prompts`, #443); absent, the server has none and says so. */
  promptsDir?: string
  /**
   * The risk fold's thresholds, from the user's config (`security.incidents`, #466) — user-only, like
   * `projectRoots`. Absent, the defaults: what the guard measures with when the config sets none.
   */
  riskThresholds?: EnsoRiskThresholds
  /**
   * The Enso pi package directory, loaded as the ONLY extension source.
   *
   * ⚠ Required, not optional. An optional value here would make "no guards" the default
   * for anyone who forgot it, which is exactly the state the first live run was in.
   */
  harnessPackageDir: string
  /** Scratch config dir for pi, so the operator's own packages stay invisible. */
  agentDir: string
  /**
   * The permission policy file pi runs under (`ENSO_HOME/permissions.json`, #446, #496). Required,
   * like `harnessPackageDir`: forgetting it would run the engine on whatever its own config path held.
   */
  permissionRulesPath: string
  /** Where this process's log file is — the launcher configured logging there; the bundle route reads it (#132). */
  logsDir: string
  port?: number
  /**
   * The pi host to use instead of building one from `agentDir` / `harnessPackageDir`, made from
   * the server's own `servesDirectory` rule (its projects, #395) so a fake applies what the real
   * host would. ⓘ Exists for `__tests__/server-handler.test.ts` (#76): a fake host whose sessions
   * record abort/dispose is the only way to observe the handler's stop/release sequencing
   * without a model. Production launchers never pass it.
   */
  host?: (servesDirectory: (directory: string) => boolean) => AgentHost
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
  const projects = createProjectRegistry({
    launchDirectory: options.cwd,
    roots: options.projectRoots ?? [],
    ...(options.projectsConfigPath === undefined ? {} : { configPath: options.projectsConfigPath }),
    ...(options.projectsStatePath === undefined ? {} : { statePath: options.projectsStatePath }),
  })
  const servesDirectory = (directory: string): boolean => projects.byDirectory(directory) !== undefined
  const host: AgentHost =
    options.host?.(servesDirectory) ??
    createAgentHost({
      servesDirectory,
      agentDir: options.agentDir,
      harnessPackageDir: options.harnessPackageDir,
      permissionRulesPath: options.permissionRulesPath,
    })
  const threads = createThreadRegistry({
    // A thread with a session on disk is opened where pi recorded it; a new one where its project
    // is — asked for only when there is no session, so a claim naming a project that has since
    // gone cannot block a resume. The claim has done its work once the session exists (PR #399 review).
    createSession: async (threadId: string) => {
      const hosted = await host.createSession(threadId, () => projects.directoryForNewThread(threadId))
      projects.dropClaim(threadId)
      return hosted
    },
  })
  const prompts: PromptLibrary | undefined =
    options.promptsDir === undefined ? undefined : createPromptLibrary(options.promptsDir)
  /** A library prompt as a session's system prompt, or why not — the configure route's first step (#443). */
  function pickSystemPrompt(id: string): SystemPromptPick {
    return prompts === undefined ? { kind: 'refused', reason: NO_PROMPT_LIBRARY } : prompts.pickSystemPrompt(id)
  }
  /** The one live-or-cold read (#214), shared with the follow route's snapshot. */
  const threadRead: ThreadReadDeps = {
    threads,
    host,
    projects,
    riskThresholds: options.riskThresholds ?? DEFAULT_RISK_THRESHOLDS,
  }

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
   * and an idle thread the server still holds is resumable, since held is not busy (PR #104 review).
   */
  async function respondWithStoredThreads(response: ServerResponse): Promise<void> {
    const stored = await host.listSessions()
    const payload: EnsoStoredThread[] = stored.flatMap((session) => {
      // The host lists only sessions in a project; the lookup is what names which one.
      const project = projects.byDirectory(session.cwd)
      if (project === undefined) return []
      return [
        {
          threadId: session.id,
          projectId: project.projectId,
          ...(session.firstMessage.trim().length === 0 ? {} : { title: session.firstMessage.trim() }),
          lastActivityAt: session.modified.toISOString(),
          messageCount: session.messageCount,
          busy: threads.peek(session.id)?.busy === true,
          ...(session.parentThreadId === undefined ? {} : { parentThreadId: session.parentThreadId }),
        },
      ]
    })
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
  async function respondWithThreadHistory(threadId: string, response: ServerResponse): Promise<void> {
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
    if (!mount.present || mount.projectId === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`no session for thread ${threadId}`)
      return
    }

    const payload: EnsoThreadHistory = {
      threadId,
      projectId: mount.projectId,
      messages: mount.messages,
      permissionMode: mount.permissionMode,
      sessionRisk: mount.sessionRisk,
      incidents: mount.incidents,
      ...(mount.interrupted === undefined ? {} : { interrupted: mount.interrupted }),
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  /**
   * ⚠ The dispatcher is synchronous and a throw in the request listener has nothing above
   * it (PR #87). Every handler that awaits (the thread routes, the listing, the browser log) runs
   * through here: a rejection is reported and answered as a 500 whose text names no route (it
   * answers every one of them; PR #393 review), and the server stays up.
   *
   * The one exception is a refusal the SERVER decided while building a thread (#395): the thread's
   * project is gone, its directory deleted, or its session is in a directory not served. Any route
   * that builds can meet one, so it is answered here, once — 409 with the reason, not a fault
   * (PR #399 review: a refusal is not a fault, and must not read as one).
   */
  function answerOrFail(work: Promise<void>, response: ServerResponse): void {
    work.catch((error: unknown) => {
      if (error instanceof ProjectUnavailable || error instanceof SessionDirectoryRefused) {
        log.warn('a thread could not be built where it belongs: {reason}', { reason: error.message })
        if (response.headersSent) response.end()
        else refuseWith(response, { status: 409, reason: error.message })
        return
      }
      log.error('a handler failed: {error}', { error })
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('the request failed — see the server log')
    })
  }

  /**
   * The slash commands a thread can run (#338), from ITS session — built here if it is not live
   * (#390). This route is asked only on a person's explicit act (the `/` palette opening, the model
   * picker, a typed bare command), so it is not the look #86 forbids to build: inspection keeps
   * `peek`. Before #390 it answered an unbuilt thread with the last build's list, or nothing after a
   * restart, and `/login` could not run until something had been prompted. A build that fails
   * answers as before — the last build's list, host rows without their `value` (#338 slice 2), or
   * none — said as `source`, so the palette never shows a stale list as live. No record: a reader
   * opening a menu is not an event.
   */
  async function respondWithThreadCommands(threadId: string, response: ServerResponse): Promise<void> {
    // Only the BUILD is caught (#392 review): a live session whose listing throws is a fault, and
    // rejects to `answerOrFail` (500, an error record) — not a failed build answered from memory.
    let thread: Awaited<ReturnType<typeof threads.ensure>> | undefined
    try {
      thread = await threads.ensure(threadId)
    } catch (error) {
      log.warn('the session for {threadId} could not be built for its commands: {error}', { threadId, error })
    }
    const remembered = threads.rememberedCommands()
    let payload: EnsoThreadCommands = { threadId, commands: [], source: 'none' }
    if (thread !== undefined) payload = { threadId, commands: thread.hosted.runtime.listCommands(), source: 'live' }
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

  /**
   * The system-prompt preview (#443): the candidate from the library (`?prompt=`), or pi's default;
   * the thread built on ask, as the commands route builds it — this is a person opening the prompt
   * manager, not a look (#86). Nothing about the thread changes. A library prompt that cannot be one
   * is the pick's refusal (422); a thread in a run is 409, since pi's rendering is then the run's.
   */
  async function respondWithSystemPromptPreview(
    threadId: string,
    _request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const promptId = match[2]
    const pick = promptId === undefined ? undefined : pickSystemPrompt(promptId)
    if (pick?.kind === 'refused') {
      refuseWith(response, { status: prompts === undefined ? 404 : 422, reason: pick.reason })
      return
    }
    await answerPreview(threadId, pick?.choice ?? null, response)
  }

  /**
   * `POST …/system-prompt` (#443): an unsaved prompt's text, previewed as the editor types it. The
   * draft is a choice like a saved one's — its hash taken here — that nothing records.
   */
  async function respondWithDraftPreview(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const draft = await readPromptSizedBody(request, response, readSystemPromptDraftBody)
    if (draft === undefined) return
    await answerPreview(threadId, draftChoice(draft), response)
  }

  /**
   * A preview of `candidate` on the thread, built on ask; 409 while it runs. A rendering that does
   * not split is a 500: the host matches the candidate's own text whole (preamble and addendum,
   * `system-prompt-preview.ts`), so whatever it holds cannot be the cause — pi rendered something the
   * splitter does not know.
   */
  async function answerPreview(
    threadId: string,
    candidate: EnsoSystemPromptChoice | null,
    response: ServerResponse,
  ): Promise<void> {
    const thread = await threads.ensure(threadId)
    const outcome = thread.busy ? { kind: 'busy' as const } : thread.hosted.previewSystemPrompt(candidate)
    if (outcome.kind === 'preview') {
      answerJson(response, outcome.preview)
      return
    }
    if (outcome.kind === 'busy') {
      refuseWith(response, {
        status: 409,
        reason: `thread ${threadId} is running; preview its system prompt when it settles`,
      })
      return
    }
    log.error('pi rendered a system prompt that does not split back', { threadId, id: candidate?.id ?? null })
    refuseWith(response, {
      status: 500,
      reason: "pi's rendering of this system prompt does not split back into its sections",
    })
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
  // One thread's context (#361): pi's branch, request by request; no log is read.
  const threadContext = createThreadContextRoute({ threads, host })
  const contextRequest = createContextRequestRoute({ threads, host })
  // One thread's fork point (#435): identity and run conditions off pi's branch.
  const threadManifest = createThreadManifestRoute({ threads, host })
  // One thread's session eval (#441): the branch's events and the log's, scored mechanically.
  const threadEval = createThreadEvalRoute({ threads, host, logsDir: options.logsDir })
  // One thread's security reads (#468, #469): the incident history and replay, and the judge's cases
  // — what `bun run judge` shows before it sends anything.
  const securityReads = createThreadSecurityReads({ threads, host, riskThresholds: threadRead.riskThresholds })
  // One thread's git state (#453): read in its cwd when asked, only in a directory this server serves.
  const gitDeps = { threads, host, servesDirectory, readGit: (cwd: string) => readGitState(runGit, cwd) }
  const threadGit = createThreadGitRoute(gitDeps)
  // What changed since the last push (#452): the same state, with every file and its patch.
  const threadChanges = createThreadChangesRoute({
    ...gitDeps,
    readChanges: (repository) => readGitChanges(runGit, repository),
  })

  /**
   * A thread analysis — stats (#45), context (#361), manifest (#435), git (#453), changes (#452) — or 404 for a thread the
   * server holds neither live nor on disk. The payload is built before the head, as
   * `respondWithStats` builds it: a day file that fails to read is the 500 `answerOrFail`
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
  const followDeps: FollowRouteDeps = { ...threadRead, sseKeepaliveMs }

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
    /** The row's own match: its first capture is the id, any further ones the route's to read. */
    match: RegExpExecArray,
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
  /** The GET rows that read only the id — most of the table, so it says them as route and handler. */
  const idOnlyReads: ReadonlyArray<
    readonly [RegExp, (threadId: string, response: ServerResponse) => void | Promise<void>]
  > = [
    [THREAD_EVENTS_ROUTE, respondWithThreadEvents],
    [THREAD_HISTORY_ROUTE, respondWithThreadHistory],
    [THREAD_COMMANDS_ROUTE, respondWithThreadCommands],
    [THREAD_STATS_ROUTE, respondWithThreadStats],
    [THREAD_CONTEXT_ROUTE, respondWithThreadContext],
    [THREAD_MANIFEST_ROUTE, respondWithThreadManifest],
    [THREAD_EVAL_ROUTE, respondWithThreadEval],
    [THREAD_GIT_ROUTE, respondWithThreadGit],
    [THREAD_CHANGES_ROUTE, respondWithThreadChanges],
    [THREAD_JUDGE_CASES_ROUTE, respondWithThreadJudgeCases],
  ]
  const THREAD_ROUTES: readonly ThreadRoute[] = [
    ...idOnlyReads.map(([route, respond]): ThreadRoute => ({ method: 'GET', route, respond: idOnly(respond) })),
    { method: 'GET', route: THREAD_CONTEXT_REQUEST_ROUTE, respond: respondWithContextRequest },
    { method: 'GET', route: THREAD_SYSTEM_PROMPT_ROUTE, respond: respondWithSystemPromptPreview },
    { method: 'GET', route: THREAD_INCIDENTS_ROUTE, respond: respondWithThreadIncidents },
    { method: 'GET', route: THREAD_ROUTE, respond: idOnly(respondWithThread) },
    {
      method: 'GET',
      route: THREAD_FOLLOW_ROUTE,
      respond: idOnly((threadId: string, response: ServerResponse) => followThread(followDeps, threadId, response)),
    },
    { method: 'POST', route: THREAD_PROMPT_ROUTE, respond: respondToPrompt },
    { method: 'POST', route: THREAD_DIALOG_ROUTE, respond: respondToDialog },
    { method: 'POST', route: THREAD_MODE_ROUTE, respond: respondToModeChange },
    { method: 'POST', route: THREAD_COMMAND_ROUTE, respond: respondToHostCommand },
    { method: 'POST', route: THREAD_CONFIGURE_ROUTE, respond: respondToConfigure },
    { method: 'POST', route: THREAD_SYSTEM_PROMPT_DRAFT_ROUTE, respond: respondWithDraftPreview },
    { method: 'POST', route: THREAD_PERMISSION_CHECK_ROUTE, respond: respondToPermissionCheck },
    { method: 'POST', route: THREAD_FORK_ROUTE, respond: respondToFork },
    { method: 'POST', route: THREAD_CONTINUE_ROUTE, respond: idOnly(respondToContinue) },
    { method: 'POST', route: THREAD_ABORT_ROUTE, respond: idOnly(respondToAbort) },
    { method: 'POST', route: THREAD_INCIDENT_RESOLVE_ROUTE, respond: respondToIncidentResolution },
  ]

  /**
   * A page names a NEW thread's project on its requests (`X-Enso-Project`, #395). An id that is no
   * registered project is refused here (400), before any route runs — the page would otherwise have
   * its thread built somewhere else without a word — and so is a name that contradicts the one the
   * thread already has (409). The body is never read, so the connection closes.
   */
  function admitProjectClaim(threadId: string, request: IncomingMessage, response: ServerResponse): boolean {
    const header = request.headers[ENSO_PROJECT_HEADER]
    const refusal = projects.claim(threadId, typeof header === 'string' ? header : undefined)
    if (refusal === undefined) return true
    log.warn('thread request refused: {reason}', { threadId, reason: refusal.reason })
    endAndClose(request, response, refusal.status, refusal.reason)
    return false
  }

  /** True when the request was a thread route — answered, or refused (`decodeThreadId`, `admitProjectClaim`). */
  function dispatchThreadRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    for (const { method, route, respond } of THREAD_ROUTES) {
      if (request.method !== method) continue
      const match = route.exec(url)
      const segment = match?.[1]
      if (match === null || segment === undefined) continue
      const threadId = decodeThreadId(segment, response)
      if (threadId !== undefined && admitProjectClaim(threadId, request, response)) {
        withEnsoLogContext({ threadId }, () => {
          const work = respond(threadId, request, response, match)
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
    if (outcome.status !== 202) {
      log.warn('prompt refused: {reason}', { threadId, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    const { messageId, generation, queued } = outcome.receipt
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

  /** No body: the thread id is the whole request (#436). The run arrives on the follow. */
  async function respondToContinue(threadId: string, response: ServerResponse): Promise<void> {
    const outcome = await continueThread(followDeps, threadId)
    if (outcome.status !== 202) {
      log.warn('continue refused ({status}): {reason}', { threadId, status: outcome.status, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    log.info('continue accepted', { threadId })
    response.writeHead(202)
    response.end()
  }

  /** A control route's refusal: the status and the reason it answers with. */
  type ControlRefusal = { readonly status: number; readonly reason: string }
  /** The refusals among a route's outcomes: the ones carrying a reason. */
  const isRefusal = <Outcome extends { readonly status: number }>(
    outcome: Outcome,
  ): outcome is Extract<Outcome, ControlRefusal> => 'reason' in outcome

  /**
   * A control route whose body is a small JSON value (#265): read under the dialog cap, run, and
   * answered — a refusal as its status and reason, logged in the route's own words with the object
   * it refused (`subject`), an acceptance logged and answered as the route says (by default its
   * status, empty). Every route states its messages: the log is searched by them.
   */
  async function answerControl<Body, Outcome extends { readonly status: number }>(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
    route: {
      /** The body as its cap names it: `a dialog answer is at most … bytes`. */
      readonly body: string
      readonly parse: (text: string) => Body
      readonly run: (body: Body) => Outcome | Promise<Outcome>
      /** What the records name: the dialog id, the mode, the command. */
      readonly subject: (body: Body) => Record<string, unknown>
      readonly refused: string
      readonly accepted: (
        outcome: Exclude<Outcome, ControlRefusal>,
        body: Body,
      ) => { readonly message: string; readonly facts?: object }
      readonly answer?: (outcome: Exclude<Outcome, ControlRefusal>) => void
    },
  ): Promise<void> {
    const body = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `${route.body} is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: route.parse,
    })
    if (body === undefined) return
    const outcome = await route.run(body)
    if (isRefusal(outcome)) {
      log.warn(route.refused, { threadId, ...route.subject(body), status: outcome.status, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    // The guard's false branch: TypeScript does not narrow a generic union by exclusion.
    const accepted = outcome as Exclude<Outcome, ControlRefusal>
    const { message, facts = {} } = route.accepted(accepted, body)
    log.info(message, { threadId, ...route.subject(body), ...facts })
    if (route.answer !== undefined) route.answer(accepted)
    else {
      response.writeHead(outcome.status)
      response.end()
    }
  }

  // A dialog answer is an id and a short value; nothing legitimate approaches the cap.
  function respondToDialog(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a dialog answer',
      parse: readDialogBody,
      run: (answer) => answerThreadDialog(followDeps, threadId, answer),
      subject: (answer) => ({ dialogId: answer.id }),
      refused: 'dialog {dialogId} answer refused ({status}): {reason}',
      accepted: () => ({ message: 'dialog {dialogId} answered' }),
    })
  }

  // A mode name; nothing legitimate approaches the dialog cap either.
  function respondToModeChange(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a mode change',
      parse: readModeChangeBody,
      run: (change) => changeThreadMode(followDeps, threadId, change),
      subject: (change) => ({ mode: change.mode }),
      refused: 'mode change to {mode} refused ({status}): {reason}',
      accepted: () => ({ message: 'mode change to {mode} told' }),
    })
  }

  // A classification, an outcome and at most three families; the dialog cap is generous for it.
  function respondToIncidentResolution(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    // The pattern has the capture; a match without it is no match.
    const incidentId = match[2] ?? ''
    return answerControl(threadId, request, response, {
      body: 'an incident resolution',
      parse: readIncidentResolutionBody,
      run: (resolution) => resolveThreadIncident(followDeps, threadId, incidentId, resolution),
      subject: (resolution) => ({ incidentId, classification: resolution.classification, outcome: resolution.outcome }),
      refused: 'incident {incidentId} resolution refused ({status}): {reason}',
      accepted: () => ({ message: 'incident {incidentId} resolution recorded: {classification}, {outcome}' }),
    })
  }

  // A command name and one option id; the dialog cap is generous for it. A setting answers 204, a
  // flow or action 202 — started, its questions arrive on the follow.
  function respondToHostCommand(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a host command',
      parse: readHostCommandBody,
      run: (run) => runHostCommand(followDeps, threadId, run),
      subject: (run) => ({ name: run.name }),
      refused: 'host command {name} refused ({status}): {reason}',
      accepted: (outcome, run) => ({
        message: outcome.status === 202 ? 'host flow {name} started' : 'host command {name} applied',
        facts: run.value === undefined ? {} : { value: run.value },
      }),
    })
  }

  /**
   * `POST …/configure` (#391): a new session's model, effort and mode, applied together — the
   * Start-a-session dialog's Start. A refused step answers 422 with its JSON refusal (the step and
   * the reason), so the dialog can say which; a run in flight is the usual 409 text.
   */
  async function respondToConfigure(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const configuration = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a session configuration is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: readConfigureBody,
    })
    if (configuration === undefined) return
    const outcome = await configureThread(followDeps, threadId, configuration, pickSystemPrompt)
    if (outcome.status === 409) {
      log.warn('configure refused (409): {reason}', { threadId, reason: outcome.reason })
      refuseWith(response, outcome)
      return
    }
    if (outcome.status === 422) {
      log.warn('configure refused at {step}: {reason}', { threadId, ...outcome.refusal })
      response.writeHead(422, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(outcome.refusal))
      return
    }
    log.info('session configured', { threadId, ...configuration })
    response.writeHead(204)
    response.end()
  }

  /**
   * `POST …/fork` (#433): the new thread's id and the text to prefill its composer with. An unknown
   * thread or entry is a 404, a non-user entry a 400, a thread a run holds the usual 409 — each with
   * its reason as text, as the other control routes answer.
   */
  function respondToFork(threadId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    return answerControl(threadId, request, response, {
      body: 'a fork request',
      parse: readForkBody,
      run: (fork) => forkThreadAt(threadRead, threadId, fork),
      subject: (fork) => fork,
      refused: 'fork at {entryId} refused ({status}): {reason}',
      accepted: (outcome) => ({
        message: 'forked at {entryId} as {forkThreadId}',
        facts: { forkThreadId: outcome.receipt.threadId },
      }),
      answer: (outcome) => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(outcome.receipt))
      },
    })
  }

  // ── Projects (#395): the directories threads run in — listed, registered under a declared
  // root, forgotten. Registration is the one request that carries a path; `projects.ts` decides it.
  function respondWithProjects(response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(projects.list()))
  }

  async function respondToProjectRegistration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const registration = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a project registration is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: (raw: string) =>
        readClosedBody(
          raw,
          EnsoProjectRegistration,
          'project',
          'a project registration takes an absolute `path` and an optional `title`',
        ),
    })
    if (registration === undefined) return
    const outcome = projects.register(registration)
    if (outcome.kind === 'refused') {
      log.warn('project registration refused: {reason}', { path: registration.path, reason: outcome.reason })
      refuseWith(response, { status: 422, reason: outcome.reason })
      return
    }
    response.writeHead(outcome.kind === 'registered' ? 201 : 200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.project))
  }

  /**
   * Forget a registration. Its sessions stay on disk. Refused while one of its threads is RUNNING
   * here — a run would go on in a directory the rail no longer shows, with nothing to stop it from.
   * Its live threads that are NOT running are retired with it (PR #399 review): a live thread is
   * taken again without a build, so a page still showing one could otherwise go on prompting it in
   * the removed directory for as long as it kept it from idling out.
   */
  function respondToProjectRemoval(projectId: string, response: ServerResponse): void {
    // The launch project first: it is never removable, running or not, so it is not told to wait.
    if (projects.get(projectId)?.launch === true) {
      refuseWith(response, { status: 409, reason: 'the launch directory is always a project' })
      return
    }
    // `inspect()` decodes a branch (#285); removal is a rare, explicit act, and live threads are few.
    const live = threads
      .list()
      .filter((thread) => projects.byDirectory(thread.hosted.inspect().cwd)?.projectId === projectId)
    if (live.some((thread) => thread.busy)) {
      refuseWith(response, { status: 409, reason: 'a thread in this project is running; remove it when that settles' })
      return
    }
    const outcome = projects.remove(projectId)
    if (outcome === 'launch') {
      refuseWith(response, { status: 409, reason: 'the launch directory is always a project' })
      return
    }
    if (outcome === 'unknown') {
      refuseWith(response, { status: 404, reason: `no registered project has the id ${projectId}` })
      return
    }
    for (const thread of live) threads.retire(thread.threadId, 'its project was removed')
    response.writeHead(204)
    response.end()
  }

  /**
   * What a page may browse while adding a project: the declared roots, or `?path=` inside them. Read
   * only; the rules are the registration's (`projects.ts#browse`), so nothing listed is refused later.
   * It reads the disk under a root, so it answers through `answerOrFail` (PR #401 review): whatever the
   * disk throws that `browse` did not foresee is a 500, never a throw with nothing above it.
   */
  async function respondWithBrowse(url: string, response: ServerResponse): Promise<void> {
    const path = new URL(url, 'http://loopback').searchParams.get('path') ?? undefined
    const outcome = projects.browse(path)
    if (outcome.kind === 'refused') {
      refuseWith(response, { status: 422, reason: outcome.reason })
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(outcome.listing))
  }

  /** True when the request was a project route. */
  function dispatchProjectRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/projects') {
      respondWithProjects(response)
      return true
    }
    if (request.method === 'POST' && url === '/api/projects') {
      answerOrFail(respondToProjectRegistration(request, response), response)
      return true
    }
    if (request.method === 'GET' && url.startsWith('/api/projects/browse')) {
      answerOrFail(respondWithBrowse(url, response), response)
      return true
    }
    const projectId = PROJECT_ROUTE.exec(url)?.[1]
    if (projectId === undefined || request.method !== 'DELETE') return false
    respondToProjectRemoval(projectId, response)
    return true
  }

  /**
   * `PUT /api/prompts/:id` (#443): write a library prompt whole under the precondition its headers
   * state; the answer is the file as read back, with its `ETag`, so a page never shows fields the
   * file does not hold. A precondition the disk does not meet is a 412 naming the file.
   */
  async function respondToPromptWrite(
    library: PromptLibrary,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const condition = writeConditionOf(request, 'write', 'prompt')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    const fields = await readPromptSizedBody(request, response, readPromptWriteBody)
    if (fields === undefined) return
    const written = library.write(id, fields, condition)
    if (written.kind === 'conflict') {
      log.warn('prompt {id} not written: {reason}', { id, reason: written.reason })
      refuseWith(response, { status: 412, reason: written.reason })
      return
    }
    if (written.kind !== 'prompt')
      log.error('prompt {id} did not read back after its write: {read}', { id, read: written })
    answerLibraryRead(response, written, 500)
  }

  /**
   * A library read, answered: the prompt as JSON with its `ETag`, a missing file 404, a refused one
   * with its reason at `refusedStatus` — 422 for a read, 500 for a write that does not read back.
   */
  function answerLibraryRead(response: ServerResponse, read: LibraryRead, refusedStatus: 422 | 500): void {
    if (read.kind === 'prompt') {
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: read.etag })
      response.end(JSON.stringify(read.prompt))
      return
    }
    refuseWith(response, { status: read.kind === 'missing' ? 404 : refusedStatus, reason: read.reason })
  }

  /** `GET /api/prompts/:id`: the prompt, 404 when there is no such file, 422 naming why a file is refused. */
  function respondWithPrompt(library: PromptLibrary, id: string, response: ServerResponse): void {
    answerLibraryRead(response, library.read(id), 422)
  }

  /** `GET /api/prompts`: the library's prompts, and every file it refused, by name. */
  function respondWithPrompts(library: PromptLibrary, response: ServerResponse): void {
    answerJson(response, library.list())
  }

  /**
   * `DELETE /api/prompts/:id` under its `If-Match`: 204, 404 when there was no such file, 412 when it
   * is not the version the caller read. A thread that ran it keeps its own copy.
   */
  function respondToPromptRemoval(
    library: PromptLibrary,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const condition = writeConditionOf(request, 'delete', 'prompt')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    if (condition.kind === 'absent') {
      endAndClose(request, response, 400, 'a delete takes `If-Match`, not `If-None-Match`')
      return
    }
    const removed = library.remove(id, condition)
    if (removed === 'missing') {
      refuseWith(response, { status: 404, reason: `no prompt ${id} in ${library.directory}` })
      return
    }
    if (removed !== 'removed') {
      log.warn('prompt {id} not deleted: {reason}', { id, reason: removed.reason })
      refuseWith(response, { status: 412, reason: removed.reason })
      return
    }
    response.writeHead(204)
    response.end()
  }

  /** A library route's work, answered or failed: a disk that throws is a 500, never a throw with nothing above it. */
  function withLibrary(
    request: IncomingMessage,
    response: ServerResponse,
    work: (library: PromptLibrary) => void | Promise<void>,
  ): true {
    if (prompts === undefined) {
      endAndClose(request, response, 404, NO_PROMPT_LIBRARY)
      return true
    }
    answerOrFail(
      Promise.resolve().then(() => work(prompts)),
      response,
    )
    return true
  }

  /**
   * `POST /api/threads/:id/permissions/check` (#474): what the thread's permission engine decides
   * for a value on a surface, in the thread's mode now. Asked of the REAL engine the session runs
   * (`HostedThread.checkPermission`), never a second matcher in the page. 409 when the engine has
   * published no service for the session.
   */
  async function respondToPermissionCheck(
    threadId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const check = await readJsonBody(request, response, {
      maxBytes: MAX_DIALOG_BODY_BYTES,
      capText: `a permission check is at most ${MAX_DIALOG_BODY_BYTES} bytes`,
      parse: (raw: string) =>
        readClosedBody(raw, EnsoPermissionCheckRequest, 'permission check', 'a check needs a `surface` and a `value`'),
    })
    if (check === undefined) return
    const thread = await threads.ensure(threadId)
    const verdict = thread.hosted.checkPermission(check)
    if (verdict === undefined) {
      refuseWith(response, {
        status: 409,
        reason: `thread ${threadId} has no permission engine loaded: nothing there decides a call`,
      })
      return
    }
    answerJson(response, verdict)
  }

  /** A policy read answered with its `ETag` when there is a file to name one. */
  function answerPolicy(response: ServerResponse, read: EnsoPermissionPolicyRead): void {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      ...(read.etag === undefined ? {} : { ETag: read.etag }),
    })
    response.end(JSON.stringify(read))
  }

  /**
   * `PUT /api/permissions` (#474): the whole file a page sent, under its `If-Match`; normalised,
   * validated against the engine's schema and written atomically (`host/permission-policy-file.ts`). 412 when
   * the file changed since the page read it; 422 with each problem when the engine would not run it.
   */
  async function respondToPolicyWrite(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const condition = writeConditionOf(request, 'write', 'permission policy')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    const body = await readJsonBody(request, response, {
      maxBytes: MAX_POLICY_BODY_BYTES,
      capText: `a permission policy is at most ${MAX_POLICY_BODY_BYTES} bytes`,
      parse: (raw: string) =>
        readClosedBody(
          raw,
          EnsoPermissionPolicyWrite,
          'permission policy',
          'a save carries `{ file }`, the whole file',
        ),
    })
    if (body === undefined) return
    const written = writePermissionPolicy(options.permissionRulesPath, options.agentDir, body.file, condition)
    if (written.kind === 'conflict') {
      log.warn('permission policy not saved: {reason}', { reason: written.reason })
      refuseWith(response, { status: 412, reason: written.reason })
      return
    }
    if (written.kind === 'refused') {
      log.warn('permission policy not saved: {reason}', { reason: written.refusal.reason })
      response.writeHead(422, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(written.refusal))
      return
    }
    log.info('permission policy saved to {path}', { path: options.permissionRulesPath })
    answerPolicy(response, written.read)
  }

  /** `POST /api/permissions/reset` (#474): Enso's default in force, the file it replaced kept beside it. */
  function respondToPolicyReset(request: IncomingMessage, response: ServerResponse): void {
    const condition = writeConditionOf(request, 'write', 'permission policy')
    if ('status' in condition) {
      endAndClose(request, response, condition.status, condition.reason)
      return
    }
    const reset = resetPermissionPolicy(options.permissionRulesPath, options.agentDir, condition)
    if (reset.kind === 'conflict') {
      refuseWith(response, { status: 412, reason: reset.reason })
      return
    }
    log.info('permission policy reset to Enso’s; the previous file is {backup}', { backup: reset.backup ?? 'none' })
    const answer: EnsoPermissionPolicyReset = {
      ...(reset.backup === undefined ? {} : { backup: reset.backup }),
      policy: reset.read,
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      ...(reset.read.etag === undefined ? {} : { ETag: reset.read.etag }),
    })
    response.end(JSON.stringify(answer))
  }

  /** True when the request was a permission-policy route (#474). */
  function dispatchPermissionRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/permissions') {
      answerOrFail(
        Promise.resolve().then(() =>
          answerPolicy(response, readPermissionPolicy(options.permissionRulesPath, options.agentDir)),
        ),
        response,
      )
      return true
    }
    if (request.method === 'PUT' && url === '/api/permissions') {
      answerOrFail(respondToPolicyWrite(request, response), response)
      return true
    }
    if (request.method === 'POST' && url === '/api/permissions/reset') {
      answerOrFail(
        Promise.resolve().then(() => respondToPolicyReset(request, response)),
        response,
      )
      return true
    }
    return false
  }

  /** True when the request was a prompt-library route (#443). */
  function dispatchPromptRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/prompts') {
      return withLibrary(request, response, (library) => respondWithPrompts(library, response))
    }
    const read = request.method === 'GET' ? PROMPT_READ_ROUTE.exec(url)?.[1] : undefined
    if (read !== undefined)
      return withLibrary(request, response, (library) => respondWithPrompt(library, read, response))
    const written = request.method === 'PUT' ? PROMPT_WRITE_ROUTE.exec(url)?.[1] : undefined
    if (written !== undefined) {
      return withLibrary(request, response, (library) => respondToPromptWrite(library, written, request, response))
    }
    const removed = request.method === 'DELETE' ? PROMPT_DELETE_ROUTE.exec(url)?.[1] : undefined
    if (removed !== undefined) {
      return withLibrary(request, response, (library) => respondToPromptRemoval(library, removed, request, response))
    }
    return false
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
    if (dispatchProjectRoute(request, response)) return
    if (dispatchPromptRoute(request, response)) return
    if (dispatchPermissionRoute(request, response)) return
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
