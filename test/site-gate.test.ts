import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentPath, documentationPages, pageTitle, rewriteLinks } from '../scripts/docs/site-content.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * THE SITE IS A PROJECTION OF `docs/`, AND THE PROJECTION IS TOTAL (#188).
 *
 * Starlight's `docsLoader()` takes no path argument and reads `src/content/docs/` only
 * (@astrojs/starlight 0.42.2), so the repository's docs are projected into the site rather than
 * moved into it. That projection is the whole risk: a page that fails to project is simply
 * absent from the site, and an absent page looks exactly like a page nobody linked.
 *
 * ⚠ THE SITE BUILD CANNOT REPORT THIS, AND NEITHER CAN THE LINK CRAWL. `astro build` succeeds
 * over content it was never given, and `scripts/docs/site-links.ts` only walks links that were
 * built — a page missing from BOTH the projection and every other page's prose is invisible to
 * both. That is the shape `seams-table.ts` was carrying in #213: a silent omission in the thing
 * whose job is completeness.
 *
 * WHAT IT HOLDS:
 *   • every page under `docs/` has a projected path, and every one carries an H1 to be titled
 *     by — the projection refuses a title guessed from a filename, so a page without one has to
 *     fail here rather than at build time in a stack trace;
 *   • every `slug:` the sidebar names exists as a page — a renamed page silently leaves
 *     navigation otherwise, and the crawl cannot see a link the sidebar never rendered;
 *   • the link rewrites, class by class, because they are what makes a GitHub-correct page a
 *     site-correct one.
 *
 * WHAT IT DOES NOT HOLD: that the built HTML is correct or that its links resolve. That is the
 * `site` gate step, which builds and crawls; this file is about what goes IN.
 */

const CONFIG = 'site/astro.config.mjs'

/** Every `{ slug: '…' }` the sidebar names, in config order. */
function sidebarSlugs(): string[] {
  const config = readFileSync(join(REPOSITORY_ROOT, CONFIG), 'utf8')
  return [...config.matchAll(/\{\s*slug:\s*'([^']+)'\s*\}/g)].map((match) => match[1] ?? '')
}

test('⚠ every page under docs/ projects, and every one can be titled (#188)', () => {
  const pages = documentationPages()
  // A floor: an empty walk would satisfy every "for all" below it.
  expect(pages.length).toBeGreaterThan(30)
  const untitled = pages.filter((page) => {
    try {
      pageTitle(readFileSync(join(REPOSITORY_ROOT, 'docs', page), 'utf8'), page)
      return false
    } catch {
      return true
    }
  })
  // Named, not counted: the output IS the list of pages to give an H1.
  expect(untitled).toEqual([])
})

test('⚠ every page the sidebar names exists, and a README becomes its section index (#188)', () => {
  const missing = sidebarSlugs().filter((slug) => !existsSync(join(REPOSITORY_ROOT, 'docs', `${slug}.md`)))
  expect(missing).toEqual([])
  // The sidebar's explicit entries are the generated reference pages plus two prose pages; the
  // rest of the tree is `autogenerate`, so a floor is all that can be asserted about the count.
  expect(sidebarSlugs().length).toBeGreaterThan(7)
  // A directory index has to BE a page: `](./flows/)` in the prose resolves to it.
  expect(contentPath('flows/README.md')).toBe('flows/index.md')
  expect(contentPath('reference/routes.md')).toBe('reference/routes.md')
})

test('the projection rewrites every link class a route cannot serve (#188)', () => {
  const page = 'reference/flows.md'
  // A sibling page: `.md` is a 404 as a route, and `/README` is the section index, not a page.
  expect(rewriteLinks('[routes](./routes.md)', page)).toBe('[routes](/zen-harness/reference/routes/)')
  expect(rewriteLinks('[seams](../seams/README.md)', page)).toBe('[seams](/zen-harness/seams/)')
  // A directory, which resolves to that directory's index.
  expect(rewriteLinks('[flows](../flows/)', page)).toBe('[flows](/zen-harness/flows/)')
  // Out of `docs/` into the source tree: there is no source tree under a site.
  expect(rewriteLinks('[src](../../packages/web/src/server/index.ts#L47)', page)).toBe(
    '[src](https://github.com/dopamine911/zen-harness-foundation/blob/main/packages/web/src/server/index.ts#L47)',
  )
  // A file `docs/` carries but a site does not serve.
  expect(rewriteLinks('[data](./data/labels.json)', 'concepts/page.md')).toBe(
    '[data](https://github.com/dopamine911/zen-harness-foundation/blob/main/docs/concepts/data/labels.json)',
  )
  // ⚠ The repository README is the site's root and its links are REPO-relative, not
  // docs-relative — the one page where `docs/architecture.md` and `./architecture.md` mean the
  // same thing. Anchored wrongly, every link on the site's front page points into the blob.
  expect(rewriteLinks('[arch](docs/architecture.md)', 'README.md', 'repository')).toBe(
    '[arch](/zen-harness/architecture/)',
  )
  expect(rewriteLinks('[lint](biome.jsonc)', 'README.md', 'repository')).toBe(
    '[lint](https://github.com/dopamine911/zen-harness-foundation/blob/main/biome.jsonc)',
  )
  // An external link is left exactly as it is: a site does not rewrite the web.
  expect(rewriteLinks('[pi](https://example.invalid/pi)', page)).toBe('[pi](https://example.invalid/pi)')
})
