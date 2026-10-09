import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { SITE_BASE as BASE, SITE_URL } from './site-base.ts'

/**
 * Every internal link in the BUILT site resolves to something the site serves (#188).
 *
 * ⚠ THE DOCS GATE CANNOT SEE THIS CLASS OF BREAK, AND THE SITE BUILD IS SILENT ABOUT IT. A page
 * under `docs/` links a sibling as `./routes.md` and the source tree as
 * `../../packages/web/src/server/index.ts#L47`; both are correct on GitHub, and both are dead the
 * moment the same markdown is served as HTML from a route — the first because Starlight serves
 * that page at `/reference/routes/`, the second because a site has no source tree. Measured on
 * the first build: 3 dead page links and 14 dead source links on ONE page, with `astro build`
 * reporting success. `site-content.ts` rewrites both classes; this is what holds the rewrite.
 *
 * WHAT IT CHECKS: every `href` and `src` in every built page that is internal — site-absolute or
 * relative.
 * A path is served when the file exists, or its directory carries an `index.html`.
 *
 * WHAT IT DOES NOT CHECK: external links (a network check is not a build's job, and a dead
 * third-party URL is not this repository's regression), `mailto:`, and pure `#fragment` hrefs —
 * an anchor's target is markdown's business, and Starlight generates the ids.
 */

const ROOT = findRepoRoot(import.meta.url)
const DIST = 'site/dist'

/** Every built HTML page, repo-relative. */
function builtPages(): string[] {
  const pages: string[] = []
  const walk = (directory: string): void => {
    for (const childName of readdirSync(directory)) {
      const path = join(directory, childName)
      if (statSync(path).isDirectory()) walk(path)
      else if (childName.endsWith('.html')) pages.push(relative(ROOT, path))
    }
  }
  walk(join(ROOT, DIST))
  return pages.toSorted()
}

/**
 * The hrefs a page carries, and the `src` of everything it loads, minus the ones no build can
 * answer for.
 *
 * ⚠ `src` too (#437): a Features page's screenshot is an `<img>`, not a link, and an image that
 * failed to reach the build is a broken picture on a page the crawl otherwise calls healthy.
 *
 * ⚠ And the page's `og:image` when it is on the site's own origin: a link preview needs an
 * ABSOLUTE URL, which the filter below passes over as external, and a card missing from the build
 * is a broken preview no one sees from the site itself.
 */
export function internalHrefs(html: string, origin: string = SITE_URL): string[] {
  const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((href) => href !== '' && !/^(?:https?:|mailto:|#|data:)/.test(href))
  const cards = [...html.matchAll(/<meta property="og:image" content="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((url) => url.startsWith(`${origin}/`))
    .map((url) => url.slice(origin.length))
  return [...links, ...cards]
}

/**
 * Where `href` lands on disk, given the page that carries it.
 *
 * The three branches produce paths in two different frames, which is why the last line strips
 * rather than always prefixing: a site-absolute href (`/enso/x/`, or `/x/`) names a path
 * INSIDE the built site and has to be joined onto `site/dist/`, while a relative href resolved
 * against the page — which already lives under `site/dist/` — comes back carrying that prefix
 * from `relative(ROOT, …)`. Stripping first makes both frames one.
 */
export function resolveHref(href: string, page: string): string {
  const withoutFragment = (href.split('#')[0] ?? '').split('?')[0] ?? ''
  if (withoutFragment === '') return page
  const fromBase = ((): string => {
    if (withoutFragment.startsWith(`${BASE}/`)) return withoutFragment.slice(BASE.length + 1)
    if (withoutFragment.startsWith('/')) return withoutFragment.slice(1)
    return relative(ROOT, resolve(ROOT, page, '..', withoutFragment))
  })()
  const insideDist = fromBase.startsWith(`${DIST}/`) ? fromBase.slice(DIST.length + 1) : fromBase
  // ⚠ Without the trim the two frames disagree on a trailing slash — `join` keeps the one a
  // site-absolute href carries, `relative` has already dropped it from a page-relative one.
  // `isServed` tolerates either, so the difference is invisible until something compares the strings.
  return join(DIST, insideDist).replace(/\/$/, '')
}

/** A path the built site serves: the file itself, or the directory's `index.html`. */
function isServed(path: string): boolean {
  const absolute = join(ROOT, path)
  if (existsSync(absolute) && statSync(absolute).isFile()) return true
  return existsSync(join(absolute, 'index.html'))
}

export function deadLinks(): string[] {
  const dead: string[] = []
  for (const page of builtPages()) {
    for (const href of internalHrefs(readFileSync(join(ROOT, page), 'utf8'))) {
      if (!isServed(resolveHref(href, page))) dead.push(`${page}: ${href}`)
    }
  }
  return dead
}

/** Whether `directory` holds a built page anywhere beneath it. */
function holdsAPage(directory: string): boolean {
  for (const childName of readdirSync(directory)) {
    const path = join(directory, childName)
    if (statSync(path).isDirectory() ? holdsAPage(path) : childName.endsWith('.html')) return true
  }
  return false
}

/**
 * A SECTION with no page of its own — `/api/` when the API reference exists only at
 * `/api/core/src/` and friends.
 *
 * ⚠ The crawl above cannot see this, and did not: it follows links, and nothing in the site
 * LINKS a bare section path. The sidebar presents `API reference` as a group of pages, so
 * `/api/` was never an href — it was only a URL a reader reaches by trimming one, or by
 * following a link written somewhere this repository does not build. It 404ed on the published
 * site while every gate was green.
 *
 * ⚠ A SECTION IS A DIRECTORY THAT HOLDS PAGES, never a name on a list. The
 * build also writes asset directories — `_astro/`, `pagefind/` today, whatever the next plugin
 * adds tomorrow — and excluding those BY NAME makes the gate false-fail the day one appears.
 * Measured: both hold exactly zero `.html` files among their 107 and 75, so "holds a page" tells
 * a section from an asset dump without knowing either one's name.
 *
 * Depth one only: `/api/core/` is a namespace segment of an entry point's path, not a section
 * anybody navigates to, and demanding a page there would mean generating pages nobody reads.
 */
export function unservedSections(distRoot: string = join(ROOT, DIST)): string[] {
  return readdirSync(distRoot)
    .filter((childName) => statSync(join(distRoot, childName)).isDirectory())
    .filter((childName) => holdsAPage(join(distRoot, childName)))
    .filter((childName) => !existsSync(join(distRoot, childName, 'index.html')))
    .map((childName) => `/${childName}/`)
}

if (import.meta.main) {
  if (!existsSync(join(ROOT, DIST))) {
    process.stderr.write(`site-links: ${DIST} does not exist — run \`bun run docs:site\` first\n`)
    process.exit(1)
  }
  const unserved = unservedSections()
  if (unserved.length > 0) {
    process.stderr.write(`site-links: ${unserved.length} section(s) with no page\n${unserved.join('\n')}\n`)
    process.exit(1)
  }
  const dead = deadLinks()
  if (dead.length > 0) {
    // Named, never counted: the output IS the list of links to fix.
    process.stderr.write(`site-links: ${dead.length} dead internal link(s)\n${dead.join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `site-links: every internal link in ${builtPages().length} built pages resolves, every section is served\n`,
  )
}
