import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { landingFeatureGroups } from '../docs/features/landing.ts'
import { SITE_BASE } from '../docs/site-base.ts'
import { project } from '../docs/site-content.ts'

/**
 * `bun scripts/docs/site-content.ts` (#188) over a tree of the test's own (#838): what the site's
 * content directory holds after a projection — every page, titled from its H1; a README as its
 * section's index; a derived index for a section without one; the images and nothing else; the
 * repository README; the landing's feature map — and nothing left from before.
 */

const CONTENT = 'site/src/content/docs'
let root = ''

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function tree(files: Readonly<Record<string, string>>): string {
  root = mkdtempSync(join(tmpdir(), 'site-content-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** Every file under `directory`, relative to it, sorted. */
const filesIn = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .toSorted()

test('the projection: every page titled, a README as its index, a derived index, images only, the README, the map', () => {
  const projected = tree({
    'docs/guide.md': '# The `guide`\n\nSee [the flows](./flows/) and [the code](../packages/a.ts#L3).\n',
    'docs/flows/README.md': '# Flows\n\n- [One](./one.md)\n',
    'docs/flows/one.md': '# One\n',
    'docs/concepts/b-two.md': '# Bee\n',
    'docs/concepts/a-one.md': '# Ay\n',
    'docs/concepts/images/shot.png': 'png',
    'docs/concepts/data/labels.json': '[]',
    'README.md': '# Repo\n\nRead [the guide](docs/guide.md).\n',
    [`${CONTENT}/gone.md`]: '---\ntitle: "Gone"\n---\n',
  })
  expect(project(projected)).toEqual({ written: 5, indexes: 1 })
  const content = join(projected, CONTENT)
  expect(filesIn(content)).toEqual([
    'concepts/a-one.md',
    'concepts/b-two.md',
    'concepts/images/shot.png',
    'concepts/index.md',
    'flows/index.md',
    'flows/one.md',
    'guide.md',
    'readme.md',
  ])
  const read = (path: string): string => readFileSync(join(content, path), 'utf8')
  // The H1 moves into the frontmatter, backticks dropped; links are rewritten for the site.
  expect(read('guide.md')).toBe(
    `---\ntitle: "The guide"\n---\n\nSee [the flows](${SITE_BASE}/flows/) and ` +
      '[the code](https://github.com/dopamine911/zen-harness-foundation/blob/main/packages/a.ts#L3).\n',
  )
  expect(read('flows/index.md')).toBe(`---\ntitle: "Flows"\n---\n\n- [One](${SITE_BASE}/flows/one/)\n`)
  // The section without a README gets one, listing its pages by their own titles, in path order.
  expect(read('concepts/index.md')).toBe(
    `---\ntitle: "Concepts overview"\n---\n\n- [Ay](${SITE_BASE}/concepts/a-one/)\n- [Bee](${SITE_BASE}/concepts/b-two/)\n`,
  )
  // The repository README's links are repo-relative.
  expect(read('readme.md')).toBe(`---\ntitle: "Repo"\n---\n\nRead [the guide](${SITE_BASE}/guide/).\n`)
  const landing = JSON.parse(readFileSync(join(projected, 'site/src/generated/landing-features.json'), 'utf8')) as {
    kicker: string
    features: { id: string; title: string; tagline: string }[]
  }[]
  expect(landing.map((group) => [group.kicker, group.features.map((feature) => feature.id)])).toEqual(
    landingFeatureGroups().map((group) => [group.kicker, group.features.map((spec) => spec.id)]),
  )
})

test('⚠ a page with no H1 is refused by name, never titled from its filename', () => {
  const projected = tree({ 'docs/untitled.md': 'No heading here.\n', 'README.md': '# Repo\n' })
  expect(() => project(projected)).toThrow('site-content: untitled.md has no H1 to take a title from')
  expect(existsSync(join(projected, CONTENT, 'untitled.md'))).toBe(false)
})
