import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { SITE_BASE as BASE } from './site-base.ts'

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
 * WHAT IT CHECKS: every `href` in every built page that is internal — site-absolute or relative.
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
  return pages.sort()
}

/** The hrefs a page carries, minus the ones no build can answer for. */
export function internalHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((href) => href !== '' && !/^(?:https?:|mailto:|#|data:)/.test(href))
}

/**
 * Where `href` lands on disk, given the page that carries it.
 *
 * The three branches produce paths in two different frames, which is why the last line strips
 * rather than always prefixing: a site-absolute href (`/zen-harness/x/`, or `/x/`) names a path
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
  return join(DIST, insideDist)
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
 * Depth one only: `/api/core/` is a namespace segment of an entry point's path, not a section
 * anybody navigates to, and demanding a page there would mean generating pages nobody reads.
 */
export function unservedSections(): string[] {
  const root = join(ROOT, DIST)
  return readdirSync(root)
    .filter((name) => !['_astro', 'pagefind'].includes(name))
    .filter((name) => statSync(join(root, name)).isDirectory())
    .filter((name) => !existsSync(join(root, name, 'index.html')))
    .map((name) => `/${name}/`)
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
