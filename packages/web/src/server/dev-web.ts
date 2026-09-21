/**
 * Dev entry point for the web surface — Bun's fullstack dev server, replacing vite (#36).
 *
 * `index.html` is imported as an `HTMLBundle`: bun scans its <script>/<link> tags, bundles
 * the TSX and CSS on the fly (Tailwind v4 runs via `bun-plugin-tailwind`, wired in this
 * package's bunfig.toml — bunfig is read from the process CWD, which is packages/web for
 * every launcher of this file), and serves the result with HMR. The `@` alias needs no
 * config at all: bun's bundler reads tsconfig `paths` directly, so the alias has exactly
 * one source of truth — under vite it had two (vite.config + tsconfig) that could drift.
 *
 * ⚠ SECURITY PAIRING, migrated from vite.config.ts when that file was deleted:
 * `/api` is proxied to the zen server rather than the browser calling it directly, so the
 * page and the API share an origin and no CORS surface is opened. The server binds loopback
 * only (see `src/server/index.ts`), and this server does too: with no sandbox and `bash`
 * unconfined (#9), neither surface may be reachable from another host.
 */
import { join } from 'node:path'
import { zenLogger } from '@zen/core'
import { configureProcessLogging, installLoggingShutdown, logsDirFrom, parseZenLogLevels } from '@zen/core/log-process'
import { findRepoRoot, webPackageDir } from '@zen/core/paths'
import { knownSecretValues } from '@zen/core/secrets'
import homepage from '../../index.html'

const WEB_PORT = 5178
const API_UPSTREAM_ORIGIN = 'http://127.0.0.1:5179'

const repoRoot = findRepoRoot(import.meta.url)
const publicDir = join(webPackageDir(repoRoot), 'public')

// Its own process, the same day's file (#132) — nothing of substance happens here, but a
// proxy that cannot reach the zen server is exactly the line a bundle needs.
const disposeLogging: () => Promise<void> = await configureProcessLogging({
  logsDir: logsDirFrom(process.env, repoRoot),
  process: 'web',
  levels: parseZenLogLevels(process.env, { console: 'info' }),
  // The value pass (#139): what a token quoted in a message or a trace payload is scrubbed against.
  secretValues: knownSecretValues(repoRoot),
})
const log = zenLogger('server', 'web')
installLoggingShutdown(disposeLogging)

/**
 * Forward an `/api/*` request to the zen server, streaming both directions.
 *
 * ⚠ `signal: request.signal` is LOAD-BEARING, not hygiene. The zen server tears pi down
 * from its response 'close' (#34), which fires only if a browser abort propagates through
 * this hop as an upstream disconnect — vite's http-proxy did this implicitly; a bare
 * `fetch` would hold the upstream open and starve the teardown of its trigger. Receipt:
 * a timeout-curl through 5178 reaps pi within 3s (#38).
 */
function proxyToApiServer(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, API_UPSTREAM_ORIGIN)
  return fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    // The zen server never redirects; surfacing one un-followed would be a bug report.
    redirect: 'manual',
  }).catch((error: unknown) => {
    // A browser's own abort is not a failure; the zen server being down is.
    if (!request.signal.aborted)
      log.error('proxy to {upstream} failed: {error}', { upstream: API_UPSTREAM_ORIGIN, error })
    throw error
  })
}

try {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: WEB_PORT,
    // ⚠ Bun's default is 10 s of inactivity, and a proxied SSE run that carried no byte for
    // 10 s — a tool call, whose progress has no AG-UI event — was closed HERE, which the
    // browser saw as "Stream response body read failed" and the zen server as a client
    // disconnect (#98/#99). The zen server now sends an SSE keepalive every 5 s
    // (`SSE_KEEPALIVE_MS`), so a healthy stream never goes idle; this is the backstop for
    // a dead one, set well above the keepalive so a missed tick cannot cut a live run.
    idleTimeout: 60,
    // hmr defaults on outside production; explicit so the intent survives an env change.
    // `console: true` mirrors browser console lines into this terminal, which the dev
    // wrapper prefixes — a page error is visible without opening devtools.
    development: { hmr: true, console: true },
    routes: {
      '/': homepage,
      '/api/*': proxyToApiServer,
      // Everything else falls through to the public assets (favicon, logos). Bun's
      // directory route rejects non-canonical paths and clamps symlink escapes, and a
      // miss is a 404 — this app has no client-side routing to fall back for.
      '/*': { dir: publicDir },
    },
  })
  log.info('serving {url} (bun {bun}, hmr on) · /api -> {upstream}', {
    url: String(server.url),
    bun: Bun.version,
    upstream: API_UPSTREAM_ORIGIN,
  })
} catch (error) {
  // The same courtesy the zen server extends on its port: a clash is a one-line
  // diagnosis, not a stack trace.
  if (error instanceof Error && error.message.includes('in use')) {
    log.error('port {port} is already in use — another web dev server is probably running; stop it first', {
      port: WEB_PORT,
    })
    await disposeLogging()
    process.exit(1)
  }
  throw error
}
