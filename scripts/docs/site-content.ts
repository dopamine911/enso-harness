import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { landingFeatureGroups } from './features/landing.ts'
import { SITE_BASE } from './site-base.ts'
import { linkCitations } from './source-citations.ts'

/**
 * Projects `docs/` into the Starlight site's content collection (#188).
 *
 * ⚠ STARLIGHT CANNOT READ `docs/` WHERE IT LIVES, AND THAT IS A HARD LIMIT, NOT A PREFERENCE.
 * `docsLoader()` takes no arguments and hardcodes `src/content/docs/` (@astrojs/starlight
 * 0.42.2, https://starlight.astro.build/manual-setup/), so the choice is: move the docs into
 * the site — away from the code they describe and the generators that own them — or project
 * them in. This projects them in.
 *
 * WHAT MAKES THAT SAFE RATHER THAN A SECOND COPY:
 *   • the output is GITIGNORED and rebuilt from `docs/` on every site build, so nothing can be
 *     edited there and survive;
 *   • the projection is total — every page under `docs/` is projected or NAMED as excluded, so
 *     a page cannot go missing quietly (the failure `seams-table.ts` had in #213);
 *   • it adds exactly one thing, the `title` frontmatter Starlight requires, taken from the
 *     page's own H1. It rewrites nothing else.
 *
 * ⚠ A page with no H1 is REFUSED, never titled from its filename. A filename-derived title is a
 * guess that reads like a fact, and the repository would carry it in navigation forever.
 */

const ROOT = findRepoRoot(import.meta.url)
const DOCS = 'docs'
const CONTENT = 'site/src/content/docs'
/** Data the site's pages read, written here and gitignored (the landing's feature map, #504). */
const GENERATED = 'site/src/generated'
/**
 * The slug the repository's README is projected to. It is the one sidebar page that is not under
 * `docs/` (`site/astro.config.ts` names it; `test/site-gate.test.ts` checks it is there).
 */
export const README_SLUG = 'readme'

/**
 * Where a page lands in the site. A `README.md` becomes its directory's INDEX rather than being
 * dropped.
 *
 * ⚠ Dropping them was the first thing tried, on the reasoning that the sidebar is the site's
 * index. Measured on the built site: every `](./flows/)`-shaped link in the prose — 7 of them —
 * 404ed, because a directory with no index page is not a page. The READMEs ARE those pages.
 */
export function contentPath(page: string): string {
  return page.replace(/(^|\/)README\.md$/, '$1index.md')
}

/**
 * Every file under `root`'s `docs/` whose name `keep` accepts, relative to `docs/`, in a stable
 * order. `root` is the repository's; a test passes a tree of its own (#838).
 */
function documentationFiles(root: string, keep: (fileName: string) => boolean): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const childName of readdirSync(directory).toSorted()) {
      const path = join(directory, childName)
      if (statSync(path).isDirectory()) walk(path)
      else if (keep(childName)) files.push(relative(join(root, DOCS), path))
    }
  }
  walk(join(root, DOCS))
  return files
}

/** Every markdown page under `docs/`, repo-relative, in a stable order. */
export function documentationPages(root: string = ROOT): string[] {
  return documentationFiles(root, (fileName) => fileName.endsWith('.md'))
}

/**
 * The image files a page may embed. Only these are carried into the site: everything else
 * `docs/` holds (`concepts/data/*.json`) is linked to on GitHub, never served (`rewriteLinks`).
 */
const ASSET = /\.(?:png|jpe?g|webp|gif|svg)$/i

function isAsset(path: string): boolean {
  return ASSET.test(path)
}

/** Every image file under `docs/`, repo-relative to `docs/`, in a stable order. */
export function documentationAssets(root: string = ROOT): string[] {
  return documentationFiles(root, isAsset)
}

/**
 * Copies every image under `docs/` to the same place under `target`, and returns what it copied.
 *
 * Beside the pages that embed them (#437): a relative `![…](./images/x.png)` is resolved by Astro
 * against the projected page, so the file has to be where the link says.
 */
export function projectAssets(target: string, root: string = ROOT): string[] {
  const assets = documentationAssets(root)
  for (const asset of assets) {
    const destination = join(target, asset)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(root, DOCS, asset), destination)
  }
  return assets
}

/** The page's H1, which Starlight needs as `title` — or a throw naming the page that has none. */
export function pageTitle(source: string, page: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(source)
  if (heading?.[1] === undefined) throw new Error(`site-content: ${page} has no H1 to take a title from`)
  return heading[1].replace(/`/g, '')
}

/** Where a repository-relative source link has to point once the page is served from a site. */
const BLOB = 'https://github.com/dopamine911/zen-harness-foundation/blob/main'

/**
 * The links a projected page needs, which are NOT the links the same page needs on GitHub.
 *
 * Measured on the first build — `astro build` reporting success the whole time — 139 dead
 * internal links in six classes, every one of them correct on GitHub and wrong as a route:
 *   • `](../../packages/web/src/server/index.ts#L47)` — out of `docs/` into the source tree.
 *     There is no source tree under a site, so it becomes the blob on GitHub, line anchor
 *     intact. This is the trail the flow diagrams promise: node → contract → source.
 *   • `](./routes.md)` — a sibling page. Starlight serves it at `/reference/routes/`, so the
 *     `.md` href 404s.
 *   • `](./flows/)` — a directory. It resolves to that directory's index page, which exists
 *     because `README.md` is projected as one (`contentPath`).
 *   • `](../data/magpie-signal-labels.json)` — a file `docs/` carries but a site does not
 *     serve; it becomes the blob too.
 *
 * ⚠ The rewrite happens on the PROJECTION, never on `docs/`. The pages are read on GitHub as
 * well, where the relative links are the correct ones — rewriting in place would fix the site
 * by breaking the source.
 */
export function rewriteLinks(source: string, page: string, anchoredAt: 'docs' | 'repository' = 'docs'): string {
  const directory = dirname(page)
  const pattern = /(!\[[^\]\n]*)?\]\(((?:\.{1,2}\/)?[^)\s#:]+)(#[^)\s]*)?\)/g
  return source.replace(pattern, (whole, embed: string | undefined, target: string, anchor = '') => {
    const resolved = join(directory === '.' ? '' : directory, target).replace(/\\/g, '/')
    // An image EMBEDDED from inside `docs/` stays relative: the projection copies it beside the
    // page (`documentationAssets`), and Astro bundles a relative image into the build. Rewritten
    // to the blob like any other non-page file, it would be an `<img>` pointing at an HTML page.
    if (embed !== undefined && anchoredAt === 'docs' && !resolved.startsWith('..') && isAsset(resolved)) return whole
    // The alt text, when the link is an embed, is part of the match and goes back unchanged.
    const lead = embed ?? ''
    const site = (path: string): string => `${lead}](${SITE_BASE}/${path.replace(/\/?$/, '/')}${anchor})`
    const blob = (path: string): string => `${lead}](${BLOB}/${path}${anchor})`
    // The repository README is projected as the site's `/readme/` page, and its links are repo-relative
    // rather than docs-relative: `docs/architecture.md` from it is the same page `./glossary.md`
    // is from inside `docs/`. One page, one asymmetry, named rather than special-cased silently.
    if (anchoredAt === 'repository') {
      if (!resolved.startsWith(`${DOCS}/`)) return blob(resolved)
      return site(
        resolved
          .slice(DOCS.length + 1)
          .replace(/\.md$/, '')
          .replace(/\/?README$/, ''),
      )
    }
    if (resolved.startsWith('..')) return blob(resolved.replace(/^(?:\.\.\/)+/, ''))
    if (resolved.endsWith('/')) return site(resolved)
    if (!resolved.endsWith('.md')) return blob(`${DOCS}/${resolved}`)
    // ⚠ `.md` first, THEN `/README`: the other order never matched, and every link to a section
    // index came out as `/seams/README/` — 24 dead links in the built site.
    return site(resolved.replace(/\.md$/, '').replace(/\/?README$/, ''))
  })
}

/**
 * The page with Starlight frontmatter in front of it, and its H1 taken INTO that frontmatter.
 *
 * Starlight renders `title` as the page's heading, so a projected page that also kept its own
 * `#` line showed the title twice — verified in the built page before this. The H1 is removed
 * from the projection and nowhere else: `docs/` keeps it, because a markdown file read on GitHub
 * has no frontmatter to render in its place.
 *
 * Every `path#Name` citation becomes a link to that declaration's line on GitHub (#482,
 * `source-citations.ts`): the page names the declaration, the build computes where it is.
 */
export function withFrontmatter(source: string, page: string, anchoredAt: 'docs' | 'repository' = 'docs'): string {
  const title = pageTitle(source, page).replace(/"/g, "'")
  const body = rewriteLinks(linkCitations(source, BLOB), page, anchoredAt).replace(/^#\s+.+?\s*$\n*/m, '')
  return `---\ntitle: "${title}"\n---\n\n${body}`
}

/**
 * The title a DERIVED section index carries in the sidebar.
 *
 * ⚠ Titled, never path-named. `title: "concepts/archive"` put a lowercase path in the navigation
 * beside pages with real titles, where it read as a broken entry — reported from the published
 * site, not caught here.
 *
 * ⚠ Every word, not just the first. `charAt(0).toUpperCase()` is right for every
 * directory this repository has today and wrong for the first hyphenated one: `getting-started`
 * would have arrived as `Getting-started overview`, which is the kind of thing nobody fixes
 * because nobody owns it.
 */
export function sectionTitle(directory: string): string {
  const segment = directory.split('/').at(-1) ?? directory
  const words = segment.split('-').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
  return `${words.join(' ')} overview`
}

/**
 * Projects `root`'s `docs/` and README into its site content and writes the landing's feature map.
 * `root` is the repository's; a test passes a tree of its own (#838).
 */
export function project(root: string = ROOT): { written: number; indexes: number } {
  const target = join(root, CONTENT)
  // Rebuilt wholesale: a page deleted from `docs/` must not survive in the site's content.
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  let written = 0
  const directoriesWithIndex = new Set<string>()
  for (const page of documentationPages(root)) {
    const source = readFileSync(join(root, DOCS, page), 'utf8')
    const destination = join(target, contentPath(page))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, withFrontmatter(source, page))
    if (contentPath(page).endsWith('index.md')) directoriesWithIndex.add(dirname(page))
    written += 1
  }

  projectAssets(target, root)

  // The repository's README, as its own page. It was the site's root until the landing page
  // (`site/src/pages/index.astro`, hello-enso's design) took `/`; the root is a page now, not
  // projected content, so nothing here may write `index.md` at the top.
  writeFileSync(
    join(target, `${README_SLUG}.md`),
    withFrontmatter(readFileSync(join(root, 'README.md'), 'utf8'), 'README.md', 'repository'),
  )

  // The landing page's feature map (#504), as DATA the page reads: the site takes its content as
  // files this script writes, never as an import of `scripts/` (`.fallowrc.jsonc` → the `site`
  // zone). Each feature is its spec's id, title and landing tagline, grouped as
  // `features/landing.ts` groups them.
  const landing = landingFeatureGroups().map((group) => ({
    kicker: group.kicker,
    title: group.title,
    text: group.text,
    features: group.features.map((spec) => ({ id: spec.id, title: spec.title, tagline: spec.landingTagline })),
  }))
  mkdirSync(join(root, GENERATED), { recursive: true })
  writeFileSync(join(root, GENERATED, 'landing-features.json'), `${JSON.stringify(landing, null, 2)}\n`)

  // A section with no `README.md` still needs a page at its path, because the prose links to it.
  // Derived from the directory, never written by hand: the pages it holds, by their own titles.
  let indexes = 0
  for (const directory of documentationDirectories(root)) {
    if (directoriesWithIndex.has(directory)) continue
    const pages = documentationPages(root).filter((page) => dirname(page) === directory)
    const entries = pages.map((page) => {
      const title = pageTitle(readFileSync(join(root, DOCS, page), 'utf8'), page)
      return `- [${title}](${SITE_BASE}/${page.replace(/\.md$/, '')}/)`
    })
    mkdirSync(join(target, directory), { recursive: true })
    writeFileSync(
      join(target, directory, 'index.md'),
      `---\ntitle: "${sectionTitle(directory)}"\n---\n\n${entries.join('\n')}\n`,
    )
    indexes += 1
  }

  return { written, indexes }
}

/** Every directory under `docs/` that holds at least one page. */
function documentationDirectories(root: string): string[] {
  return [...new Set(documentationPages(root).map((page) => dirname(page)))].filter((directory) => directory !== '.')
}

if (import.meta.main) {
  const { written, indexes } = project()
  process.stdout.write(
    `site-content: projected ${written} pages and ${documentationAssets().length} images into ${CONTENT}, plus the README and ${indexes} derived section indexes\n`,
  )
}
