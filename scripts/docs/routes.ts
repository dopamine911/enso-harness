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
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly handler: string
  readonly input: string
  readonly success: string
  readonly errors: string
  readonly routeClass: 'control' | 'observation' | 'browser-log-ingest' | 'static'
  readonly builds: 'yes' | 'no'
  readonly logs: 'yes' | 'no'
  readonly factory?: { readonly path: string; readonly declaration: string }
}

/**
 * A GET that reads one thread and builds nothing — six rows share everything but these four
 * facts (and the follow's factory), so they are stated once (#45 phase 2 added the sixth).
 */
function threadRead(facts: Pick<RouteMetadata, 'path' | 'handler' | 'success' | 'errors' | 'factory'>): RouteMetadata {
  return { method: 'GET', input: 'path: `threadId`', routeClass: 'observation', builds: 'no', logs: 'no', ...facts }
}

const REGEX_ROUTE_METADATA: Record<string, RouteMetadata> = {
  THREAD_ROUTE: threadRead({
    path: '/api/threads/:threadId',
    handler: 'respondWithThread',
    success: '200 JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no live session',
  }),
  THREAD_EVENTS_ROUTE: threadRead({
    path: '/api/threads/:threadId/events',
    handler: 'respondWithThreadEvents',
    success: '200 `EnsoThreadEvents` JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no live session',
  }),
  THREAD_COMMANDS_ROUTE: threadRead({
    path: '/api/threads/:threadId/commands',
    handler: 'respondWithThreadCommands',
    success: '200 `EnsoThreadCommands` JSON — `source` says live, remembered or none',
    errors: '400 malformed thread id; 403 untrusted origin',
  }),
  THREAD_STATS_ROUTE: threadRead({
    path: '/api/threads/:threadId/stats',
    handler: 'respondWithThreadStats',
    success: "200 `EnsoThreadStats` JSON — pi's session for the numbers, the log's day files for the times",
    errors: '400 malformed thread id; 403 untrusted origin; 404 no session; 500 handler failure',
  }),
  THREAD_HISTORY_ROUTE: threadRead({
    path: '/api/threads/:threadId/history',
    handler: 'respondWithThreadHistory',
    success: '200 `EnsoThreadHistory` JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no session; 500 handler failure',
  }),
  THREAD_FOLLOW_ROUTE: threadRead({
    path: '/api/threads/:threadId/follow',
    handler: 'followThread',
    success: '200 SSE stream',
    errors: '400 malformed thread id; 403 untrusted origin; 500 handler failure',
    factory: { path: FOLLOW_PATH, declaration: 'export async function followThread' },
  }),
  THREAD_PROMPT_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/prompt',
    handler: 'respondToPrompt → promptThread',
    input: 'path: `threadId`; body: `EnsoPromptBody`',
    success: '202 `EnsoPromptReceipt` JSON',
    errors:
      '400 malformed id/body or unavailable command; 403 untrusted origin; 413 body too large; 500 handler failure',
    routeClass: 'control',
    builds: 'yes',
    logs: 'yes',
    factory: { path: FOLLOW_PATH, declaration: 'export async function promptThread' },
  },
  THREAD_DIALOG_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/dialog',
    handler: 'respondToDialog → answerThreadDialog',
    input: 'path: `threadId`; body: `DialogAnswer`',
    success: '204 empty',
    errors:
      '400 malformed id/body; 403 untrusted origin; 404 no live question; 413 body too large; 422 answer refused; 500 handler failure',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
    factory: { path: FOLLOW_PATH, declaration: 'export function answerThreadDialog' },
  },
  THREAD_ABORT_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/abort',
    handler: 'respondToAbort → abortThread',
    input: 'path: `threadId`; no body',
    success: '200 `EnsoAbortReceipt` JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no live session; 409 nothing running',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
    factory: { path: FOLLOW_PATH, declaration: 'export function abortThread' },
  },
  THREAD_COMMAND_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/command',
    handler: 'respondToHostCommand → runHostCommand',
    input:
      'path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing',
    success:
      '204 empty for a setting (the change arrives on the follow as `model`); 202 empty for a flow or action (`login`, `logout`, `compact`) — started, its questions and progress arrive on the follow as dialogs and `notify` lines',
    errors:
      '400 malformed id/body; 403 untrusted origin; 409 thread busy; 413 body too large; 422 unknown command, model or level, or a provider without credentials; 500 handler failure',
    routeClass: 'control',
    builds: 'yes',
    logs: 'yes',
  },
  THREAD_MODE_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/mode',
    handler: 'respondToModeChange → changeThreadMode',
    input: 'path: `threadId`; body: `EnsoPermissionModeChange`',
    success: '204 empty; the change arrives on the follow as `permission-mode`',
    errors:
      '400 malformed id/body; 403 untrusted origin; 409 thread busy; 413 body too large; 422 mode not offered; 500 handler failure',
    routeClass: 'control',
    builds: 'yes',
    logs: 'yes',
    factory: { path: FOLLOW_PATH, declaration: 'export async function changeThreadMode' },
  },
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
  'GET /api/threads': {
    handler: 'respondWithThreads',
    input: 'none',
    success: '200 `EnsoThreadSummary[]` JSON',
    errors: '403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  'GET /api/stored-threads': {
    handler: 'respondWithStoredThreads',
    input: 'none',
    success: '200 `EnsoStoredThread[]` JSON',
    errors: '403 untrusted origin; 500 handler failure',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  'GET /api/about': {
    handler: 'createAboutRoute → about',
    input: 'none',
    success: '200 `EnsoBundleAbout` JSON',
    errors: '403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: BUNDLE_PATH, declaration: 'export function createAboutRoute' },
  },
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
  'GET /api/logs/stats': {
    handler: 'createLogStatsRoute → stats',
    input: 'none',
    success: '200 `EnsoDayStats` JSON',
    errors: '403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: LOGS_STATS_PATH, declaration: 'export function createLogStatsRoute' },
  },
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
  readonly method: 'GET' | 'POST'
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

  const regexRoutes: DetectedRoute[] = [...server.matchAll(/^const ([A-Z][A-Z_]*_ROUTE) = \/.*\/$/gm)].map((match) => ({
    key: match[1] ?? '',
    method: REGEX_ROUTE_METADATA[match[1] ?? '']?.method ?? 'GET',
    path: REGEX_ROUTE_METADATA[match[1] ?? '']?.path ?? 'UNCLASSIFIED',
    line: lineAt(server, match.index),
    kind: 'regex',
  }))
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
          return regex
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
    '> Parser limitation: discovery recognizes top-level `const *_ROUTE = /…/` declarations plus direct `request.method` branches using `url === …` or `url.startsWith(…)`. Statuses, input shapes, classes, acquisition, and self-logging are intentionally explicit checked metadata rather than inferred behavior.',
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
