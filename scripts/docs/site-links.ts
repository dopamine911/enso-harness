import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'

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
const BASE = '/zen-harness'

/** Every built HTML page, repo-relative. */
function builtPages(): string[] {
  const pages: string[] = []
  const walk = (directory: string): void => {
    for (const childName of readdirSync(directory)) {
      const path = join(directory, childName)
      // `api/` is TypeDoc's own build, checked by the `api-docs` gate and not re-crawled here.
      if (statSync(path).isDirectory()) {
        if (childName !== 'api') walk(path)
      } else if (childName.endsWith('.html')) pages.push(relative(ROOT, path))
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

/** Where `href` lands on disk, given the page that carries it. */
export function resolveHref(href: string, page: string): string {
  const withoutFragment = (href.split('#')[0] ?? '').split('?')[0] ?? ''
  if (withoutFragment === '') return page
  const fromBase = ((): string => {
    if (withoutFragment.startsWith(`${BASE}/`)) return withoutFragment.slice(BASE.length + 1)
    if (withoutFragment.startsWith('/')) return withoutFragment.slice(1)
    return relative(ROOT, resolve(ROOT, page, '..', withoutFragment))
  })()
  return join(DIST, fromBase.replace(new RegExp(`^${DIST.replace('/', '\\/')}\\/`), ''))
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

if (import.meta.main) {
  if (!existsSync(join(ROOT, DIST))) {
    process.stderr.write(`site-links: ${DIST} does not exist — run \`bun run docs:site\` first\n`)
    process.exit(1)
  }
  const dead = deadLinks()
  if (dead.length > 0) {
    // Named, never counted: the output IS the list of links to fix.
    process.stderr.write(`site-links: ${dead.length} dead internal link(s)\n${dead.join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`site-links: every internal link in ${builtPages().length} built pages resolves\n`)
}
