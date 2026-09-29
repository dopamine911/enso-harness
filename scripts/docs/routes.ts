import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { assertExactKeys, runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/routes.md`: the HTTP surface dispatched by the web server.
 * Route discovery is deliberately narrow; behavior is explicit metadata whose keys are
 * checked against every discovered regex constant and literal dispatcher branch.
 */

const ROOT = findRepoRoot(import.meta.url)
const SERVER_PATH = 'packages/web/src/server/index.ts'
const FOLLOW_PATH = 'packages/web/src/server/follow.ts'
const BUNDLE_PATH = 'packages/web/src/server/bundle-route.ts'
const LOGS_PATH = 'packages/web/src/server/logs-route.ts'
const LOGS_TAIL_PATH = 'packages/web/src/server/logs-tail-route.ts'
const LOGS_STATS_PATH = 'packages/web/src/server/logs-stats-route.ts'

interface RouteMetadata {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly handler: string
  readonly input: string
  readonly success: string
  readonly errors: string
  readonly routeClass: 'control' | 'observation' | 'browser-log-ingest' | 'static'
  readonly builds: 'yes' | 'no'
  readonly logs: 'yes' | 'no'
  /**
   * The follow-module factory the handler calls, and what that factory reaches: the thread's
   * runtime (the default), or the storage seam (`AgentHost`) without a runtime — the fork route.
   */
  readonly factory?: { readonly path: string; readonly declaration: string; readonly reaches?: 'storage' }
}

/**
 * A regex route's facts. `path` is stated only where discovery cannot derive it: a
 * `threadRoute('<action>')` constant is `/api/threads/:threadId/<action>` by construction.
 */
type RegexRouteMetadata = Omit<RouteMetadata, 'path'> & { readonly path?: string }

/** What a thread read that finds no session answers — most of the read rows' errors. */
const NO_SESSION_ERRORS = '400 malformed thread id; 403 untrusted origin; 404 no session; 500 handler failure'
/** A git read's errors: a thread held nowhere, or one whose project is no longer served. */
const GIT_READ_ERRORS =
  '400 malformed thread id; 403 untrusted origin; 404 no session, or its project is no longer served; 500 handler failure'
/** What a live-only read answers. */
const NO_LIVE_SESSION_ERRORS = '400 malformed thread id; 403 untrusted origin; 404 no live session'

/**
 * A GET that reads one thread and builds nothing — every such row shares its method, input, class
 * and acquisition, so a row states its handler, what it answers, and anything beyond those.
 */
function threadRead(
  handler: string,
  success: string,
  errors: string = NO_SESSION_ERRORS,
  extra: Partial<Pick<RouteMetadata, 'input' | 'factory' | 'path'>> = {},
): RegexRouteMetadata {
  return {
    method: 'GET',
    input: 'path: `threadId`',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    handler,
    success,
    errors,
    ...extra,
  }
}

/**
 * A control route on one thread: a POST that logs its own outcome. A row states its handler, its
 * input, what it answers and refuses, whether it builds the session, and the follow factory it
 * calls; a route off the thread paths says its method and path.
 */
function threadControl(
  handler: string,
  input: string,
  [success, errors]: readonly [success: string, errors: string],
  facts: Pick<RouteMetadata, 'builds'> & Partial<Pick<RouteMetadata, 'factory' | 'path' | 'method'>>,
): RegexRouteMetadata {
  return { method: 'POST', handler, input, success, errors, routeClass: 'control', logs: 'yes', ...facts }
}

/** A factory in `follow.ts` that reaches the thread's runtime. */
const follows = (declaration: string): NonNullable<RouteMetadata['factory']> => ({ path: FOLLOW_PATH, declaration })

/** A literal GET that takes no input, reads, and builds nothing — the listing and inspection rows. */
function literalRead(
  facts: Pick<RouteMetadata, 'handler' | 'success'> & Partial<Pick<RouteMetadata, 'errors' | 'factory' | 'input'>>,
): Omit<RouteMetadata, 'method' | 'path'> {
  return {
    input: 'none',
    errors: '403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    ...facts,
  }
}

const BODY_ERRORS = '400 malformed id/body; 403 untrusted origin'

const REGEX_ROUTE_METADATA: Record<string, RegexRouteMetadata> = {
  THREAD_ROUTE: threadRead('respondWithThread', '200 JSON', NO_LIVE_SESSION_ERRORS, { path: '/api/threads/:threadId' }),
  THREAD_EVENTS_ROUTE: threadRead('respondWithThreadEvents', '200 `EnsoThreadEvents` JSON', NO_LIVE_SESSION_ERRORS),
  THREAD_COMMANDS_ROUTE: threadRead(
    'respondWithThreadCommands',
    '200 `EnsoThreadCommands` JSON — `source` says live, remembered or none',
    '400 malformed thread id; 403 untrusted origin',
  ),
  THREAD_STATS_ROUTE: threadRead(
    'respondWithThreadStats',
    "200 `EnsoThreadStats` JSON — pi's session for the numbers, the log's day files for the times",
  ),
  THREAD_CONTEXT_ROUTE: threadRead(
    'respondWithThreadContext',
    "200 `EnsoThreadContext` JSON — pi's branch, request by request, and its context meter",
  ),
  THREAD_CONTEXT_REQUEST_ROUTE: threadRead(
    'respondWithContextRequest',
    "200 `EnsoContextRequestDetail` JSON — one request's context, element by element",
    '400 malformed thread id; 403 untrusted origin; 404 no session or no such turn; 500 handler failure',
    {
      path: '/api/threads/:threadId/context/:request',
      input: 'path: `threadId`, `request` (a turn number or `next`)',
    },
  ),
  THREAD_MANIFEST_ROUTE: threadRead(
    'respondWithThreadManifest',
    "200 `EnsoForkPoint` JSON — identity, then run conditions, off pi's branch",
  ),
  THREAD_EVAL_ROUTE: threadRead(
    'respondWithThreadEval',
    "200 `EnsoSessionEval` JSON — the mechanical timeline and scorecard (#441): the branch's events off pi's entries, the queued prompts and interrupts off the day files the branch spans",
  ),
  THREAD_GIT_ROUTE: threadRead(
    'respondWithThreadGit',
    "200 `EnsoThreadGit` JSON — the thread's cwd and git's state there (#453): repository, branch, upstream, the last-push baseline and the rule that chose it, ahead/behind, and changed files by where they sit; `not-a-repository` or `unavailable` with git's reason otherwise. Read-only, no fetch",
    GIT_READ_ERRORS,
  ),
  THREAD_CHANGES_ROUTE: threadRead(
    'respondWithThreadChanges',
    "200 `EnsoThreadChanges` JSON — git's state in the thread's cwd and every file that differs from its last-push baseline (#452): unpushed commits, staged and unstaged edits, deletions, renames and untracked files, each with its unified diff unless binary or too large; `truncated` past 500 files. A diff git cannot produce reads as `unavailable`. Read-only, no fetch",
    GIT_READ_ERRORS,
  ),
  THREAD_HISTORY_ROUTE: threadRead('respondWithThreadHistory', '200 `EnsoThreadHistory` JSON'),
  THREAD_FOLLOW_ROUTE: threadRead(
    'followThread',
    '200 SSE stream',
    '400 malformed thread id; 403 untrusted origin; 500 handler failure',
    { factory: follows('export async function followThread') },
  ),
  THREAD_PROMPT_ROUTE: threadControl(
    'respondToPrompt → promptThread',
    'path: `threadId`; body: `EnsoPromptBody`',
    [
      '202 `EnsoPromptReceipt` JSON',
      '400 malformed id/body or unavailable command; 403 untrusted origin; 409 the thread was taken and released again while the prompt waited on its build (rare; #444); 413 body too large; 500 handler failure',
    ],
    { builds: 'yes', factory: follows('export async function promptThread') },
  ),
  THREAD_DIALOG_ROUTE: threadControl(
    'respondToDialog → answerThreadDialog',
    'path: `threadId`; body: `DialogAnswer`',
    ['204 empty', `${BODY_ERRORS}; 404 no live question; 413 body too large; 422 answer refused; 500 handler failure`],
    { builds: 'no', factory: follows('export function answerThreadDialog') },
  ),
  THREAD_ABORT_ROUTE: threadControl(
    'respondToAbort → abortThread',
    'path: `threadId`; no body',
    [
      '200 `EnsoAbortReceipt` JSON',
      '400 malformed thread id; 403 untrusted origin; 404 no live session; 409 nothing running',
    ],
    { builds: 'no', factory: follows('export function abortThread') },
  ),
  THREAD_COMMAND_ROUTE: threadControl(
    'respondToHostCommand → runHostCommand',
    "path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing; a `view` row (`context`, `fork`) is the page's to do, never run",
    [
      '204 empty for a setting (the change arrives on the follow as `model`); 202 empty for a flow or action (`login`, `logout`, `compact`) — started, its questions and progress arrive on the follow as dialogs and `notify` lines',
      `${BODY_ERRORS}; 409 thread busy; 413 body too large; 422 unknown command, model or level, a provider without credentials, or a \`view\` (\`/context\`, \`/fork\`) the page does itself; 500 handler failure`,
    ],
    { builds: 'yes' },
  ),
  THREAD_CONFIGURE_ROUTE: threadControl(
    'respondToConfigure → configureThread',
    'path: `threadId`; body: `EnsoSessionConfiguration` — optional `model` (`provider/id`), `thinking` (a level that model supports) and `mode`; applied in that order under one lease, a value equal to the current one left alone',
    [
      '204 empty — every step applied (the changes arrive on the follow as `model` and `permission-mode`)',
      `${BODY_ERRORS}; 409 thread busy; 413 body too large; 422 JSON \`EnsoConfigurationRefusal\` — the step that refused (\`model\`, \`thinking\`, \`mode\`) and the reason, the steps before it applied; 500 handler failure`,
    ],
    { builds: 'yes' },
  ),
  THREAD_FORK_ROUTE: threadControl(
    'respondToFork → forkThreadAt → AgentHost.forkThread',
    "path: `threadId`; body: `EnsoForkRequest` — `entryId`, the pi entry id of one of the thread's user messages; the fork is pi's `/fork` at position `before`, taken from the session file",
    [
      "200 `EnsoForkReceipt` JSON — the new thread id (its session file names the source as `parentSession`) and the forked message's text, for the new composer",
      '400 malformed id/body, or an entry that is no user message; 403 untrusted origin; 404 no session file in a served project, or no such entry; 409 thread busy; 413 body too large; 500 handler failure',
    ],
    {
      builds: 'no',
      factory: { path: FOLLOW_PATH, declaration: 'export async function forkThreadAt', reaches: 'storage' },
    },
  ),
  THREAD_CONTINUE_ROUTE: threadControl(
    'respondToContinue → continueThread → ThreadRuntime.continueRun',
    'path: `threadId`; no body',
    [
      '202 empty — the torn tail is continued from the stored state with no new user message; the run arrives on the follow and its `settled` releases the thread',
      '400 malformed thread id; 403 untrusted origin; 404 no thread under that id, live or stored; 409 thread busy; 422 nothing to continue — the thread does not end on an unanswered prompt, an unfinished tool call, or tool results with no reply, or this pi build has no run lifecycle to continue in; 500 handler failure',
    ],
    { builds: 'yes', factory: follows('export async function continueThread') },
  ),
  PROJECT_ROUTE: threadControl(
    'respondToProjectRemoval → ProjectRegistry.remove',
    'path: `projectId` (sixteen hex digits)',
    [
      '204 empty — the registration is forgotten; its sessions stay on disk and are served again if the directory is registered again',
      '403 untrusted origin; 404 no registered project with that id; 409 the launch project, or a thread in the project is running',
    ],
    { builds: 'no', path: '/api/projects/:projectId', method: 'DELETE' },
  ),
  THREAD_MODE_ROUTE: threadControl(
    'respondToModeChange → changeThreadMode',
    'path: `threadId`; body: `EnsoPermissionModeChange`',
    [
      '204 empty; the change arrives on the follow as `permission-mode`',
      `${BODY_ERRORS}; 409 thread busy; 413 body too large; 422 mode not offered; 500 handler failure`,
    ],
    { builds: 'yes', factory: follows('export async function changeThreadMode') },
  ),
}

const LITERAL_ROUTE_METADATA: Record<string, Omit<RouteMetadata, 'method' | 'path'>> = {
  'GET /api/mode': {
    handler: 'respondWithFreshThreadMode',
    input: 'none',
    success: '200 permission-mode JSON',
    errors: '403 untrusted origin',
    routeClass: 'static',
    builds: 'no',
    logs: 'no',
  },
  'GET /api/threads': literalRead({ handler: 'respondWithThreads', success: '200 `EnsoThreadSummary[]` JSON' }),
  'GET /api/stored-threads': literalRead({
    handler: 'respondWithStoredThreads',
    success: '200 `EnsoStoredThread[]` JSON',
    errors: '403 untrusted origin; 500 handler failure',
  }),
  'GET /api/projects': literalRead({
    handler: 'respondWithProjects',
    success: '200 `EnsoProject[]` JSON — the launch project first, then the registered ones',
  }),
  'GET /api/projects/browse*': literalRead({
    handler: 'respondWithBrowse → ProjectRegistry.browse',
    input: 'query: optional `path` — a directory inside a declared root; absent, the roots themselves',
    success:
      '200 `EnsoDirectoryListing` JSON — the directories under it that are inside a root and not hidden (symlinks resolved), which already are projects, and whether this one may be added',
    errors:
      '403 untrusted origin; 422 refused, with the reason — not absolute, missing, not a directory, outside every root, or inside a hidden directory',
  }),
  'POST /api/projects': {
    handler: 'respondToProjectRegistration → ProjectRegistry.register',
    input:
      'body: `EnsoProjectRegistration` — an absolute `path` strictly under a root the ENSO_HOME config declares (`projects.roots`), optional `title`',
    success: '201 `EnsoProject` JSON when registered; 200 when the directory already is a project',
    errors:
      '400 malformed body; 403 untrusted origin; 413 body too large; 422 refused, with the reason — not absolute, missing, not a directory, a root itself, outside every root (resolved through symlinks), or inside a hidden directory; 500 handler failure',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
  },
  'GET /api/about': literalRead({
    handler: 'createAboutRoute → about',
    success: '200 `EnsoBundleAbout` JSON',
    factory: { path: BUNDLE_PATH, declaration: 'export function createAboutRoute' },
  }),
  'GET /api/logs/bundle*': {
    handler: 'createBundleRoute → bundle',
    input: 'query: optional `thread` id/prefix',
    success: '200 Markdown attachment',
    errors: '400 malformed thread filter; 403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: BUNDLE_PATH, declaration: 'export function createBundleRoute' },
  },
  'GET /api/logs/tail*': {
    handler: 'followLogTail',
    input:
      'query: optional `level`, `thread` id/prefix, `process`, `since` duration, `from` byte offset with the `day` it belongs to',
    success: '200 SSE stream of `EnsoLogTailFrame`; a read the server cannot do ends it with an `error` event',
    errors: '400 unknown level, malformed thread filter, malformed since or from; 403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: LOGS_TAIL_PATH, declaration: 'export function followLogTail' },
  },
  'GET /api/logs/stats': literalRead({
    handler: 'createLogStatsRoute → stats',
    success: '200 `EnsoDayStats` JSON',
    factory: { path: LOGS_STATS_PATH, declaration: 'export function createLogStatsRoute' },
  }),
  'POST /api/logs': {
    handler: 'respondToBrowserLogs → receiveBrowserLogs',
    input: 'body: `EnsoBrowserLogBatch`',
    success: '204 empty',
    errors: '400 malformed batch; 403 untrusted origin; 413 body too large; 500 body-read failure',
    routeClass: 'browser-log-ingest',
    builds: 'no',
    logs: 'no',
    factory: { path: LOGS_PATH, declaration: 'export function receiveBrowserLogs' },
  },
}

interface DetectedRoute {
  readonly key: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly line: number
  readonly kind: 'regex' | 'literal'
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function declarationLine(source: string, declaration: string, path: string): number {
  const offset = source.indexOf(declaration)
  if (offset < 0) throw new Error(`routes: ${path} no longer declares ${declaration}`)
  return lineAt(source, offset)
}

/** A discovered route with its metadata and the lines that prove both ends of it. */
export interface ResolvedRoute extends RouteMetadata {
  readonly dispatch: { readonly path: string; readonly line: number }
  readonly factoryLine?: number
}

/**
 * Every route the server dispatches, with its checked metadata — the page's rows, and the
 * control-plane diagram's nodes (#188), from ONE discovery.
 *
 * Exported because a second reader of the same dispatcher would be a second answer to
 * "what routes exist": `flow-diagrams.ts` draws these, it does not re-find them.
 */
export function discoverRoutes(): ResolvedRoute[] {
  const server = readFileSync(join(ROOT, SERVER_PATH), 'utf8')
  const supportingSources: Record<string, string> = {
    [FOLLOW_PATH]: readFileSync(join(ROOT, FOLLOW_PATH), 'utf8'),
    [BUNDLE_PATH]: readFileSync(join(ROOT, BUNDLE_PATH), 'utf8'),
    [LOGS_PATH]: readFileSync(join(ROOT, LOGS_PATH), 'utf8'),
    [LOGS_TAIL_PATH]: readFileSync(join(ROOT, LOGS_TAIL_PATH), 'utf8'),
    [LOGS_STATS_PATH]: readFileSync(join(ROOT, LOGS_STATS_PATH), 'utf8'),
  }

  // A route constant is a regex literal, or `threadRoute('<action>')` — the server's builder for
  // `/api/threads/<threadId>/<action>`, whose path is derived here rather than restated.
  const regexRoutes: DetectedRoute[] = [
    ...server.matchAll(/^const ([A-Z][A-Z_]*_ROUTE) = (?:\/.*\/|threadRoute\('([a-z-]+)'\))$/gm),
  ].map((match) => {
    const key = match[1] ?? ''
    const metadata = REGEX_ROUTE_METADATA[key]
    const action = match[2]
    return {
      key,
      method: metadata?.method ?? 'GET',
      path: metadata?.path ?? (action === undefined ? 'UNCLASSIFIED' : `/api/threads/:threadId/${action}`),
      line: lineAt(server, match.index),
      kind: 'regex',
    }
  })
  for (const route of regexRoutes) {
    const references = [...server.matchAll(new RegExp(`\\b${route.key}\\b`, 'g'))]
    if (references.length < 2) throw new Error(`routes: ${route.key} is declared but not dispatched`)
  }
  assertExactKeys(
    'regex route',
    regexRoutes.map((route) => route.key),
    Object.keys(REGEX_ROUTE_METADATA),
  )

  const literalRoutes: DetectedRoute[] = []
  for (const match of server.matchAll(/request\.method === '(GET|POST)' && url === '([^']+)'/g)) {
    const method = match[1] as 'GET' | 'POST'
    const path = match[2] ?? ''
    literalRoutes.push({ key: `${method} ${path}`, method, path, line: lineAt(server, match.index), kind: 'literal' })
  }
  for (const match of server.matchAll(/request\.method === '(GET|POST)' && url\.startsWith\('([^']+)'\)/g)) {
    const method = match[1] as 'GET' | 'POST'
    const path = `${match[2] ?? ''}*`
    literalRoutes.push({ key: `${method} ${path}`, method, path, line: lineAt(server, match.index), kind: 'literal' })
  }
  assertExactKeys(
    'literal route',
    literalRoutes.map((route) => route.key),
    Object.keys(LITERAL_ROUTE_METADATA),
  )

  return [...regexRoutes, ...literalRoutes]
    .map((detected): ResolvedRoute => {
      // `assertExactKeys` above already proved every detected key has metadata; these throws are
      // the type system asking for the same proof, and they name the key if it ever stops holding.
      const metadata = ((): RouteMetadata => {
        if (detected.kind === 'regex') {
          const regex = REGEX_ROUTE_METADATA[detected.key]
          if (regex === undefined) throw new Error(`routes: metadata disappeared for ${detected.key}`)
          return { ...regex, path: detected.path }
        }
        const literal = LITERAL_ROUTE_METADATA[detected.key]
        if (literal === undefined) throw new Error(`routes: metadata disappeared for ${detected.key}`)
        return { method: detected.method, path: detected.path, ...literal }
      })()
      const dispatch = { path: SERVER_PATH, line: detected.line }
      if (metadata.factory === undefined) return { ...metadata, dispatch }
      const source = supportingSources[metadata.factory.path]
      if (source === undefined) throw new Error(`routes: source was not loaded for ${metadata.factory.path}`)
      return {
        ...metadata,
        dispatch,
        factoryLine: declarationLine(source, metadata.factory.declaration, metadata.factory.path),
      }
    })
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      if (left.method === right.method) return 0
      return left.method < right.method ? -1 : 1
    })
}

function generate(): string {
  const routes = discoverRoutes()
  const regexCount = Object.keys(REGEX_ROUTE_METADATA).length
  const literalCount = Object.keys(LITERAL_ROUTE_METADATA).length

  const sourceLink = (path: string, line: number): string => `[\`${path}:${line}\`](../../${path}#L${line})`
  const rows = routes.map((route) => {
    const sources = [sourceLink(route.dispatch.path, route.dispatch.line)]
    if (route.factory !== undefined && route.factoryLine !== undefined) {
      sources.push(sourceLink(route.factory.path, route.factoryLine))
    }
    return `| ${route.method} | \`${route.path}\` | \`${route.handler}\` | ${route.input} | ${route.success} | ${route.errors} | ${route.routeClass} | ${route.builds} | ${route.logs} | ${sources.join('<br>')} |`
  })

  return [
    '<!-- generated: scripts/docs/routes.ts -->',
    '# HTTP routes',
    '',
    'Generated from the route constants and dispatcher in `packages/web/src/server/index.ts`, with handler contracts from `server/follow.ts`, `server/bundle-route.ts`, and `server/logs-route.ts`.',
    '',
    "Every `/api/threads/:threadId…` route also reads the `X-Enso-Project` header (#395): a page names a new thread's project with it, and an id that is no registered project is a 400 before the route runs.",
    '',
    '> Parser limitation: discovery recognizes top-level `const *_ROUTE = /…/` and `const *_ROUTE = threadRoute(…)` declarations plus direct `request.method` branches using `url === …` or `url.startsWith(…)`. Statuses, input shapes, classes, acquisition, and self-logging are intentionally explicit checked metadata rather than inferred behavior.',
    '',
    '| Method | Rendered path | Handler / factory | Input shape | Success | Named error statuses | Class | Builds / acquires? | Logs itself? | Source |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Detected ${regexCount} regex route constants and ${literalCount} literal dispatcher routes; metadata is exhaustive for both sets.`,
    '',
  ].join('\n')
}

// Importable: `flow-diagrams.ts` reuses `discoverRoutes`, and importing must not print a page.
if (import.meta.main) runGenerator('routes', generate)
