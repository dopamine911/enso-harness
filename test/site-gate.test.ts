import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { builtDocPages } from '../scripts/docs/build-docs.ts'
import {
  contentPath,
  documentationAssets,
  documentationPages,
  pageTitle,
  projectAssets,
  rewriteLinks,
  sectionTitle,
} from '../scripts/docs/site-content.ts'
import { internalHrefs, resolveHref, unservedSections } from '../scripts/docs/site-links.ts'
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

const CONFIG = 'site/astro.config.ts'

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
  // A built page (#482) is gitignored: it exists once `docs:build` runs, which the site build does first.
  const built = new Set(builtDocPages())
  const missing = sidebarSlugs().filter(
    (slug) => !(existsSync(join(REPOSITORY_ROOT, 'docs', `${slug}.md`)) || built.has(`docs/${slug}.md`)),
  )
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
  expect(rewriteLinks('[routes](./routes.md)', page)).toBe('[routes](/enso/reference/routes/)')
  expect(rewriteLinks('[seams](../seams/README.md)', page)).toBe('[seams](/enso/seams/)')
  // A directory, which resolves to that directory's index.
  expect(rewriteLinks('[flows](../flows/)', page)).toBe('[flows](/enso/flows/)')
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
  expect(rewriteLinks('[arch](docs/architecture.md)', 'README.md', 'repository')).toBe('[arch](/enso/architecture/)')
  expect(rewriteLinks('[lint](oxlint.config.ts)', 'README.md', 'repository')).toBe(
    '[lint](https://github.com/dopamine911/zen-harness-foundation/blob/main/oxlint.config.ts)',
  )
  // An external link is left exactly as it is: a site does not rewrite the web.
  expect(rewriteLinks('[pi](https://example.invalid/pi)', page)).toBe('[pi](https://example.invalid/pi)')
})

test('⚠ an image embedded from docs/ stays relative, and the projection carries it (#437)', () => {
  const page = 'features/chat.md'
  // Astro bundles a relative image; rewritten to the blob, the `<img>` would point at an HTML page.
  expect(rewriteLinks('![the chat](./images/chat-thread.png)', page)).toBe('![the chat](./images/chat-thread.png)')
  // …but a LINK to an image is a link, and a site serves no file at that path: the blob.
  expect(rewriteLinks('[the chat](./images/chat-thread.png)', page)).toBe(
    '[the chat](https://github.com/dopamine911/zen-harness-foundation/blob/main/docs/features/images/chat-thread.png)',
  )
  // An embed of something that is not an image, or from outside `docs/`, keeps its alt text.
  expect(rewriteLinks('![data](./data/labels.json)', page)).toBe(
    '![data](https://github.com/dopamine911/zen-harness-foundation/blob/main/docs/features/data/labels.json)',
  )
  // Every image the pages embed is one the projection copies — to where the embed looks for it.
  const target = mkdtempSync(join(tmpdir(), 'enso-site-assets-'))
  const assets = projectAssets(target)
  expect(assets).toEqual(documentationAssets())
  for (const asset of assets) expect(existsSync(join(target, asset))).toBe(true)
  for (const page of documentationPages()) {
    const text = readFileSync(join(REPOSITORY_ROOT, 'docs', page), 'utf8')
    for (const match of text.matchAll(/!\[[^\]]*\]\((\.\/[^)]+)\)/g)) {
      expect(assets).toContain(join(dirname(page), match[1] ?? '').replace(/\\/g, '/'))
    }
  }
})

/**
 * THE PUBLISHED SITE'S BASE PATH IS DERIVED, AND THE ORDER OF ITS TWO BUILDS IS NOT OPTIONAL.
 *
 * A GitHub project site is served from `/<repository>`, which is not this repository's short
 * name. Built with the wrong `base`, Astro emits perfectly valid HTML whose every internal link
 * 404s — and nothing fails: the build succeeds, the upload succeeds, the deployment succeeds,
 * and the site is broken in a way that reads as broken documentation. So the workflow takes the
 * base from the repository rather than repeating a literal that rots on a rename or a fork.
 *
 * ⚠ The local build's default is the OTHER value (`/enso`), which is exactly why this is
 * checked here: the two are supposed to differ, so neither one being wrong is visible by
 * comparing them. What is checkable is that the published one is derived at all.
 */
const PUBLISH_WORKFLOW = '.github/workflows/docs-site.yml'

test('⚠ the docs-site workflow derives its base and builds the API first (#188)', () => {
  const workflow = readFileSync(join(REPOSITORY_ROOT, PUBLISH_WORKFLOW), 'utf8')
  // Manual only: the gate already builds and crawls the site on every PR, so a push trigger
  // would re-prove it on someone else's minutes.
  expect(workflow).toContain('workflow_dispatch:')
  expect(workflow).not.toMatch(/^\s{2}(?:push|pull_request):/m)
  // Derived from the repository, never a literal — the failure this test exists for.
  expect(workflow).toContain('ENSO_SITE_BASE: /${{ github.event.repository.name }}')
  // ⚠ Anything that is not the expression, rather than a lowercase literal (PR #330 review): a
  // repository whose name starts with a capital — `Zen-Harness` is a valid GitHub name — would
  // have walked straight past a `/[a-z]/` check, hardcoded and undetected.
  expect(workflow).not.toMatch(/ENSO_SITE_BASE:\s*\/(?!\$\{\{)/)
  // ⚠ `docs:api` no longer PRODUCES anything the site needs — it validates with `--emit none`,
  // and the site generates its own API pages from the same `typedoc.json`. It still runs first,
  // because a contract that fails to document should fail before a full static build, not after.
  const apiAt = workflow.indexOf('bun run docs:api')
  const siteAt = workflow.indexOf('bun run docs:site')
  expect(apiAt).toBeGreaterThan(-1)
  expect(siteAt).toBeGreaterThan(apiAt)
  // What is uploaded is what was crawled.
  expect(workflow).toContain('path: site/dist')
})

/**
 * The crawl's own readers, against a synthetic tree (PR #332 review).
 *
 * ⚠ Before this, `unservedSections`, `internalHrefs` and `resolveHref` were exercised only
 * end-to-end by gate step 7 against the real built site — which means the `/api/` fix was
 * "mutation-checked" by hand (delete `api/index.html`, watch the gate fail) and nothing would
 * have pinned it through a refactor. A gate whose reader is only ever run on one input has no
 * way to show that it reads anything.
 */
test('a section is a directory that holds pages, not a name on a list (#188)', () => {
  const dist = mkdtempSync(join(tmpdir(), 'enso-site-dist-'))
  // A section with its own page, and one without: only the second is a 404 a reader can reach.
  mkdirSync(join(dist, 'seams'), { recursive: true })
  writeFileSync(join(dist, 'seams', 'index.html'), '<html lang="en"></html>')
  mkdirSync(join(dist, 'api', 'core'), { recursive: true })
  writeFileSync(join(dist, 'api', 'core', 'index.html'), '<html lang="en"></html>')
  // An asset directory: no page anywhere beneath it, and no name this code knows.
  mkdirSync(join(dist, '_astro'), { recursive: true })
  writeFileSync(join(dist, '_astro', 'app.css'), 'body{}')
  mkdirSync(join(dist, 'whatever-the-next-plugin-writes'), { recursive: true })
  writeFileSync(join(dist, 'whatever-the-next-plugin-writes', 'index.pf_meta'), 'x')

  expect(unservedSections(dist)).toEqual(['/api/'])
})

test('the crawl reads the hrefs a site serves, and skips the ones it cannot answer for (#188)', () => {
  const html = [
    '<a href="/enso/reference/routes/">a</a>',
    '<a href="../seams/guards/">b</a>',
    '<a href="https://example.invalid/x">external</a>',
    '<a href="mailto:nobody@example.invalid">mail</a>',
    '<a href="#anchor">fragment</a>',
    '<img src="/enso/_astro/chat-thread.Bx1.webp" alt="a screenshot">',
    '<img src="data:image/png;base64,AAAA" alt="inline">',
  ].join('\n')
  // External, mail and pure-fragment hrefs are not this build's to answer for; an image is (#437).
  expect(internalHrefs(html)).toEqual([
    '/enso/reference/routes/',
    '../seams/guards/',
    '/enso/_astro/chat-thread.Bx1.webp',
  ])
  // Site-absolute (with and without the base) and page-relative land in one frame: under `dist`.
  expect(resolveHref('/enso/reference/routes/', 'site/dist/index.html')).toBe('site/dist/reference/routes')
  expect(resolveHref('../seams/guards/', 'site/dist/flows/resume/index.html')).toBe('site/dist/flows/seams/guards')
  expect(resolveHref('#anchor', 'site/dist/index.html')).toBe('site/dist/index.html')
})

test('a derived section index is titled, and every word of it (#188)', () => {
  // The two this repository has today: reported from the published site as `concepts` and
  // `concepts/archive`, lowercase paths sitting beside pages with real titles.
  expect(sectionTitle('concepts')).toBe('Concepts overview')
  expect(sectionTitle('concepts/archive')).toBe('Archive overview')
  // ⚠ The first hyphenated section would have arrived as `Getting-started overview` (PR #333
  // review). No directory here is hyphenated yet, which is exactly why nothing would have caught
  // it — and why the case is pinned before one exists.
  expect(sectionTitle('docs/getting-started')).toBe('Getting Started overview')
})
