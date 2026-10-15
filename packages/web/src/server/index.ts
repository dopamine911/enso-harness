import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { DEFAULT_RISK_THRESHOLDS, type EnsoProjectsConfig, type EnsoRiskThresholds, ensoLogger } from '@enso/core'
import { missingVendorPaths } from '@enso/core/pi-manifest'
import { type AgentHost, createAgentHost } from '../host/agent-host.ts'
import type { ProjectThreadSettingsSource } from '../host/tree-setup.ts'
import type { FollowRouteDeps } from './follow.ts'
import { createLiteralRoutes } from './literal-routes.ts'
import { isLoopbackAuthority, LOOPBACK_ONLY } from './loopback.ts'
import { createPermissionRoutes } from './permission-routes.ts'
import { createProjectRoutes } from './project-routes.ts'
import { createProjectRegistry } from './projects.ts'
import { createPromptLibrary, type PromptLibrary } from './prompt-library.ts'
import { createPromptRoutes } from './prompt-routes.ts'
import { createSecurityRoutes } from './security-routes.ts'
import { SSE_KEEPALIVE_MS } from './sse.ts'
import { createThreadControlRoutes } from './thread-control-routes.ts'
import { createThreadReadRoutes } from './thread-read-routes.ts'
import type { ThreadReadDeps } from './thread-read.ts'
import { createThreadRegistry } from './thread-registry.ts'
import { createThreadRoutes } from './thread-routes.ts'
import { createWebToolsRoutes, type HostCheckNetwork } from './web-tools-routes.ts'

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

/**
 * Whether a browser says this request came from Enso's own page (#717): `Sec-Fetch-Site` is
 * `same-origin`, or `none` — a navigation the person made (a typed URL, a bookmark). Absent, the
 * caller is no browser that sends Fetch Metadata (`curl`, the repo's CLIs, an old browser), and the
 * `Origin` rule alone judges it. A page on another loopback port says `same-site`; another host,
 * `cross-site`.
 */
function fromEnsosOwnPage(headers: IncomingMessage['headers']): boolean {
  const site = headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

const log = ensoLogger('server', 'http')

export interface EnsoServerOptions {
  /**
   * The launch directory: the first project (#395), where a thread nobody named a project for
   * runs. With no sandbox (#24) a session's directory IS its blast radius, so this comes from the
   * launcher's own arguments, never from a request. Every other project is one the person added
   * from Enso's own page, after a confirmation that says what an agent there can reach (#866).
   */
  cwd: string
  /** `projects.roots` from the user's config: an optional fence a page's projects must sit under (#866). None means any folder the standing refusals allow. */
  projectRoots?: Readonly<EnsoProjectsConfig['roots']>
  /** The config file `projectRoots` came from, named when a refusal points at a root. */
  projectsConfigPath?: string
  /** Enso's own home (`ENSO_HOME`, #421): never a project, nor anything under it (#866); absent (tests), no such refusal. */
  ensoHome?: string
  /** Where registrations are kept (`.enso/projects.json`); absent, they last as long as the process (tests). */
  projectsStatePath?: string
  /** The prompt library's directory (`ENSO_HOME/prompts`, #443); absent, the server has none and says so. */
  promptsDir?: string
  /** The project folders (`ENSO_HOME/projects`, #552): where a thread's session is filed, under its project's id; absent, pi's default. */
  projectsDir?: string
  /**
   * Each new thread's own tree and its preparation, per project, by tier (#551, #754,
   * `AgentHostOptions.threadSettings`), and the project page's settings; absent, threads run in the
   * checkout and the project settings routes refuse.
   */
  threadSettings?: ProjectThreadSettingsSource
  /** The user's config file (`ENSO_HOME/config.json`), which Settings › Web tools edits (#924); absent, those routes refuse. */
  userConfigPath?: string
  /** The Web tools host check's lookup and request (#924). ⓘ Injectable for `server-handler.test.ts`; absent, DNS and `fetch`. */
  hostCheck?: HostCheckNetwork
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
    ...(options.projectsDir === undefined ? {} : { projectsDir: options.projectsDir }),
    ...(options.ensoHome === undefined ? {} : { ensoHome: options.ensoHome }),
  })
  const servesDirectory = (directory: string): boolean => projects.byDirectory(directory) !== undefined
  const host: AgentHost =
    options.host?.(servesDirectory) ??
    createAgentHost({
      servesDirectory,
      agentDir: options.agentDir,
      harnessPackageDir: options.harnessPackageDir,
      permissionRulesPath: options.permissionRulesPath,
      ...(options.projectsDir === undefined ? {} : { projectsDir: options.projectsDir }),
      ...(options.threadSettings === undefined ? {} : { threadSettings: options.threadSettings }),
    })
  const threads = createThreadRegistry({
    // A thread with a session on disk is opened where pi recorded it; a new one where its project
    // is — asked for only when there is no session, so a claim naming a project that has since
    // gone cannot block a resume. The claim has done its work once the session exists.
    createSession: async (threadId: string) => {
      const hosted = await host.createSession(threadId, () => projects.directoryForNewThread(threadId))
      projects.dropClaim(threadId)
      return hosted
    },
  })
  const prompts: PromptLibrary | undefined =
    options.promptsDir === undefined ? undefined : createPromptLibrary(options.promptsDir)
  /** The one live-or-cold read (#214), shared with the follow route's snapshot. */
  const threadRead: ThreadReadDeps = {
    threads,
    host,
    projects,
    riskThresholds: options.riskThresholds ?? DEFAULT_RISK_THRESHOLDS,
  }

  // ── The wire (#112): prompt / follow / dialog ────────────────────────────────────
  const followDeps: FollowRouteDeps = { ...threadRead, sseKeepaliveMs }

  // The route groups (#810): each a factory over the state it reads, wired here.
  const { dispatchLiteralRoute } = createLiteralRoutes({
    host,
    threads,
    projects,
    logsDir: options.logsDir,
    sseKeepaliveMs,
  })
  const reads = createThreadReadRoutes({ threadRead, logsDir: options.logsDir, servesDirectory })
  const promptRoutes = createPromptRoutes({ prompts, threads, host, projects })
  const controls = createThreadControlRoutes({
    followDeps,
    threadRead,
    pickSystemPrompt: promptRoutes.pickSystemPrompt,
  })
  const permissions = createPermissionRoutes({
    threads,
    permissionRulesPath: options.permissionRulesPath,
    agentDir: options.agentDir,
  })
  const { dispatchProjectRoute } = createProjectRoutes({
    projects,
    threads,
    threadSettings: options.threadSettings,
    agentDir: options.agentDir,
  })
  const { dispatchWebToolsRoute } = createWebToolsRoutes({
    userConfigPath: options.userConfigPath,
    projects,
    threads,
    agentDir: options.agentDir,
    ...options.hostCheck,
  })
  const { dispatchThreadRoute } = createThreadRoutes({
    reads,
    controls,
    prompts: promptRoutes,
    permissions,
    projects,
    followDeps,
  })
  const { dispatchPromptRoute } = promptRoutes
  const { dispatchPermissionRoute } = permissions
  const { dispatchSecurityRoute } = createSecurityRoutes({ ensoHome: options.ensoHome })
  const { previews } = reads

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
   * full agent run. Three independent checks, all here so every route inherits them:
   *
   * 1. `Host` must name loopback. Node does not validate it, and a DNS name that resolves
   *    to 127.0.0.1 (rebinding) makes the READ side — `/api/threads/:id`, the verbatim
   *    branch, and the log bundle — same-origin readable. A rebound name is not loopback.
   * 2. ⚠ A browser's `Sec-Fetch-Site` must say `same-origin` (or `none`, a navigation the
   *    person made), when the header is present (#717). `Origin` names a HOST, and loopback
   *    on any port passed check 3: measured, a page on `localhost:5173` — a dev server
   *    running agent-written code — switched a thread to `bypassPermissions` (204). Enso's
   *    own page calls its API same-origin (through the 5178 proxy, which forwards the header,
   *    or served by this server); a page on another port is `same-site` or `cross-site`.
   *    Fetch Metadata needs no list of Enso's own origins, which the server does not know.
   *    The header is absent from `curl`, the repo's CLIs and browsers too old to send it,
   *    and those are judged by check 3 alone.
   * 3. `Origin`, when the header is PRESENT, must parse and name loopback. Browsers always
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
    if (!fromEnsosOwnPage(request.headers)) return false
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

  // ⚠ Routes dispatch HERE, outside the chat handler, on purpose: that handler's top-to-bottom
  // shape is the #27/#34 teardown ordering (#82). What is left in the callback is the one check
  // every request is admitted by, then one dispatcher per route family, in order, and the miss.
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
    if (dispatchWebToolsRoute(request, response)) return
    if (dispatchSecurityRoute(request, response)) return
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
    // The previews close with it (#713): their listeners are this server's.
    close: async (): Promise<void> => {
      await previews.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
