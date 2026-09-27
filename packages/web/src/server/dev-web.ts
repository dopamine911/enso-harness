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
 * `/api` is proxied to the enso server rather than the browser calling it directly, so the
 * page and the API share an origin and no CORS surface is opened. The server binds loopback
 * only (see `src/server/index.ts`), and this server does too: with no sandbox and `bash`
 * unconfined (#9), neither surface may be reachable from another host.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startLauncher } from '@enso/core/log-process'
import { findRepoRoot, webPackageDir } from '@enso/core/paths'
// A SECOND entry, not a route inside the first (#144 slice 2): the observation surface — a
// read-only view of the day's log — is its own page, so the page that controls pi and the
// page that only watches it cannot drift into one bundle.
import debugPage from '../../debug.html'
import homepage from '../../index.html'
import { createApiProxy } from './dev-proxy.ts'
import { createFontFileRoute } from './font-files.ts'

const WEB_PORT = 5178
const API_UPSTREAM_ORIGIN = 'http://127.0.0.1:5179'

const repoRoot = findRepoRoot(import.meta.url)
const publicDir = join(webPackageDir(repoRoot), 'public')
// The page's fonts, from the installed `@fontsource` packages, unbundled (`font-files.ts`, #407).
const webPackage: { dependencies?: Record<string, string> } = JSON.parse(
  readFileSync(join(webPackageDir(repoRoot), 'package.json'), 'utf8'),
)
const fontFiles = createFontFileRoute(webPackageDir(repoRoot), Object.keys(webPackage.dependencies ?? {}))

// Its own process, the same day's file (#132) — nothing of substance happens here, but a
// proxy that cannot reach the enso server is exactly the line a bundle needs. `bun run dev` starts
// this beside the server: either may migrate the checkout's old `.enso/` first (#421).
const { log, dispose: disposeLogging } = await startLauncher({
  repoRoot,
  environment: process.env,
  process: 'web',
  logger: ['server', 'web'],
})

const proxyToApiServer = createApiProxy(API_UPSTREAM_ORIGIN)

try {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: WEB_PORT,
    // ⚠ Bun's default is 10 s of inactivity, and a proxied SSE run that carried no byte for
    // 10 s — a tool call, whose progress has no AG-UI event — was closed HERE, which the
    // browser saw as "Stream response body read failed" and the enso server as a client
    // disconnect (#98/#99). The enso server now sends an SSE keepalive every 5 s
    // (`SSE_KEEPALIVE_MS`), so a healthy stream never goes idle; this is the backstop for
    // a dead one, set well above the keepalive so a missed tick cannot cut a live run.
    idleTimeout: 60,
    // hmr defaults on outside production; explicit so the intent survives an env change.
    // `console: true` mirrors browser console lines into this terminal, which the dev
    // wrapper prefixes — a page error is visible without opening devtools.
    development: { hmr: true, console: true },
    routes: {
      '/': homepage,
      '/debug': debugPage,
      '/api/*': proxyToApiServer,
      '/fonts/*': fontFiles,
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
  // The same courtesy the enso server extends on its port: a clash is a one-line
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
