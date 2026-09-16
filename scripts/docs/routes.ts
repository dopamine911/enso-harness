import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/index.ts'
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

const REGEX_ROUTE_METADATA: Record<string, RouteMetadata> = {
  THREAD_ROUTE: {
    method: 'GET',
    path: '/api/threads/:threadId',
    handler: 'respondWithThread',
    input: 'path: `threadId`',
    success: '200 JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no live session',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  THREAD_EVENTS_ROUTE: {
    method: 'GET',
    path: '/api/threads/:threadId/events',
    handler: 'respondWithThreadEvents',
    input: 'path: `threadId`',
    success: '200 `ZenThreadEvents` JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no live session',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  THREAD_HISTORY_ROUTE: {
    method: 'GET',
    path: '/api/threads/:threadId/history',
    handler: 'respondWithThreadHistory',
    input: 'path: `threadId`',
    success: '200 `ZenThreadHistory` JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no session; 500 handler failure',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  THREAD_FOLLOW_ROUTE: {
    method: 'GET',
    path: '/api/threads/:threadId/follow',
    handler: 'followThread',
    input: 'path: `threadId`',
    success: '200 SSE stream',
    errors: '400 malformed thread id; 403 untrusted origin; 500 handler failure',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
    factory: { path: FOLLOW_PATH, declaration: 'export async function followThread' },
  },
  THREAD_PROMPT_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/prompt',
    handler: 'respondToPrompt → promptThread',
    input: 'path: `threadId`; body: `ZenPromptBody`',
    success: '202 `ZenPromptReceipt` JSON',
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
    success: '200 `ZenAbortReceipt` JSON',
    errors: '400 malformed thread id; 403 untrusted origin; 404 no live session; 409 nothing running',
    routeClass: 'control',
    builds: 'no',
    logs: 'yes',
    factory: { path: FOLLOW_PATH, declaration: 'export function abortThread' },
  },
  THREAD_MODE_ROUTE: {
    method: 'POST',
    path: '/api/threads/:threadId/mode',
    handler: 'respondToModeChange → changeThreadMode',
    input: 'path: `threadId`; body: `ZenPermissionModeChange`',
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
    success: '200 `ZenThreadSummary[]` JSON',
    errors: '403 untrusted origin',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  'GET /api/stored-threads': {
    handler: 'respondWithStoredThreads',
    input: 'none',
    success: '200 `ZenStoredThread[]` JSON',
    errors: '403 untrusted origin; 500 handler failure',
    routeClass: 'observation',
    builds: 'no',
    logs: 'no',
  },
  'GET /api/about': {
    handler: 'createAboutRoute → about',
    input: 'none',
    success: '200 `ZenBundleAbout` JSON',
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
  'POST /api/logs': {
    handler: 'respondToBrowserLogs → receiveBrowserLogs',
    input: 'body: `ZenBrowserLogBatch`',
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

function generate(): string {
  const server = readFileSync(join(ROOT, SERVER_PATH), 'utf8')
  const supportingSources: Record<string, string> = {
    [FOLLOW_PATH]: readFileSync(join(ROOT, FOLLOW_PATH), 'utf8'),
    [BUNDLE_PATH]: readFileSync(join(ROOT, BUNDLE_PATH), 'utf8'),
    [LOGS_PATH]: readFileSync(join(ROOT, LOGS_PATH), 'utf8'),
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

  const routes = [...regexRoutes, ...literalRoutes]
    .map((detected) => {
      const metadata =
        detected.kind === 'regex'
          ? REGEX_ROUTE_METADATA[detected.key]
          : { method: detected.method, path: detected.path, ...LITERAL_ROUTE_METADATA[detected.key] }
      if (metadata === undefined) throw new Error(`routes: metadata disappeared for ${detected.key}`)
      const sources = [`[\`${SERVER_PATH}:${detected.line}\`](../../${SERVER_PATH}#L${detected.line})`]
      if (metadata.factory !== undefined) {
        const source = supportingSources[metadata.factory.path]
        if (source === undefined) throw new Error(`routes: source was not loaded for ${metadata.factory.path}`)
        const line = declarationLine(source, metadata.factory.declaration, metadata.factory.path)
        sources.push(`[\`${metadata.factory.path}:${line}\`](../../${metadata.factory.path}#L${line})`)
      }
      return { ...metadata, sources: sources.join('<br>') }
    })
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      if (left.method === right.method) return 0
      return left.method < right.method ? -1 : 1
    })

  const rows = routes.map(
    (route) =>
      `| ${route.method} | \`${route.path}\` | \`${route.handler}\` | ${route.input} | ${route.success} | ${route.errors} | ${route.routeClass} | ${route.builds} | ${route.logs} | ${route.sources} |`,
  )

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
    `Detected ${regexRoutes.length} regex route constants and ${literalRoutes.length} literal dispatcher routes; metadata is exhaustive for both sets.`,
    '',
  ].join('\n')
}

runGenerator('routes', generate)
