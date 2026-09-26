import { dirname, join } from 'node:path'

/**
 * The page's fonts, served as files rather than bundled (#407 item 6).
 *
 * WHY NOT THE BUNDLE. Bun's CSS bundler inlines every `url()` asset under a hard-coded 128 KB as a
 * `data:` URL (Bun issue 28307, closed as a duplicate of 24599 — not configurable; a `loader` and
 * an `onLoad` plugin both leave it unchanged, measured). With the `@fontsource` stylesheets
 * imported, every face of every family — every Unicode subset — rode inside the render-blocking
 * stylesheet: 1.74 MB against 174 KB without. Nor can the stylesheet name the files by absolute
 * URL: the bundler resolves `url("/fonts/…")` and fails the build.
 *
 * So the packages' OWN stylesheets and files are served here, unbundled, from the installed
 * package — no copy in the repo to keep in step with the dependency. Their stylesheets name the
 * files as `./files/…`, which resolves back under this route. The page links the stylesheets at
 * boot (`fonts.ts`); a browser downloads a declared face only when text is set in it, so what a
 * page never shows costs nothing but a few lines of `@font-face`.
 *
 * ⚠ A closed surface, like the public directory beside it: only a `@fontsource` package the web
 * package DEPENDS on, and only its top-level stylesheets and `files/*.woff2|woff` — no path the
 * two patterns do not spell, so no `..`, no other file of the package, no other package.
 */

/** Where the route is mounted — the page's stylesheet links start with it. */
export const FONT_ROUTE_PREFIX = '/fonts/'

const FONT_PACKAGE = /^@fontsource(?:-variable)?\/[a-z0-9-]+$/
const FONT_FILE = /^(?:[a-z0-9-]+\.css|files\/[a-z0-9-]+\.woff2?)$/

/**
 * A font's bytes never change for a given package version; a day keeps reloads free without
 * pinning a stale upgrade for long.
 */
const CACHE_CONTROL = 'public, max-age=86400'

const notFound = (): Response => new Response('not found', { status: 404 })

/**
 * The `/fonts/*` handler for the `@fontsource` packages among `dependencies`, each resolved from
 * `webPackageDir` once, at creation.
 */
export function createFontFileRoute(
  webPackageDir: string,
  dependencies: readonly string[],
): (request: Request) => Promise<Response> {
  const packageDirs = new Map<string, string>()
  for (const dependency of dependencies) {
    if (FONT_PACKAGE.test(dependency))
      packageDirs.set(dependency, dirname(Bun.resolveSync(`${dependency}/package.json`, webPackageDir)))
  }
  return async (request: Request): Promise<Response> => {
    const [scope, name, ...rest] = new URL(request.url).pathname.slice(FONT_ROUTE_PREFIX.length).split('/')
    const packageDir = packageDirs.get(`${scope}/${name}`)
    const file = rest.join('/')
    if (packageDir === undefined || !FONT_FILE.test(file)) return notFound()
    const served = Bun.file(join(packageDir, file))
    if (!(await served.exists())) return notFound()
    return new Response(served, { headers: { 'cache-control': CACHE_CONTROL } })
  }
}
