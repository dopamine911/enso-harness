import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fallowConfig from '../.fallowrc.jsonc'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * fallow's entry list cannot drift from the harness manifest (#163).
 *
 * fallow builds its module graph from package.json entries and imports; the runtime loads
 * the harness's extensions from `packages/harness/package.json` → `pi.extensions`, which
 * fallow does not read. Without an `entry` for each, every extension and everything under
 * `harness/core/` is "unused" (measured: 24 of 28 unused-file findings before #163), and
 * `fallow fix` would remove the guards. `.fallowrc.jsonc` lists them by hand; this holds the
 * hand-written list equal to the manifest, both directions, so a new extension added to one
 * and not the other fails here rather than in a silent false positive.
 *
 * Only the manifest's repository-local extensions (`./extensions/…`) are compared: the
 * vendored ones under `node_modules/` are dependencies, ignored by name in the config.
 */

const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'packages/harness/package.json'), 'utf8')) as {
  pi: { extensions: string[] }
}

// @pins boot-and-launchers/manifest-order
test('⚠ every repository extension in the harness manifest is a fallow entry, and only those (#163)', () => {
  const declared = manifest.pi.extensions
    .filter((path) => path.startsWith('./'))
    .map((path) => `packages/harness/${path.slice(2)}`)
    .toSorted()
  const listed = (fallowConfig as { entry: string[] }).entry
    .filter((path) => path.startsWith('packages/harness/extensions/'))
    .toSorted()
  expect(listed).toEqual(declared)
})

/**
 * The page's fonts are served as files, never imported (#407), so fallow cannot see them used and
 * they are ignored by name. The names are the web package's `@fontsource` dependencies, both
 * directions: a font dropped from the package leaves no stale ignore, and one added without an
 * ignore fails the dead-code gate rather than passing here.
 */
test('⚠ the ignored font packages are exactly the web package’s @fontsource dependencies (#407)', () => {
  const webPackage = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'packages/web/package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const isFont = (name: string): boolean => name.startsWith('@fontsource')
  const ignored = (fallowConfig as { ignoreDependencies: string[] }).ignoreDependencies.filter(isFont).toSorted()
  expect(ignored).toEqual(Object.keys(webPackage.dependencies).filter(isFont).toSorted())
})

/**
 * The zone table in `docs/architecture.md` → *Ownership boundary* is prose restating
 * `.fallowrc.jsonc` → `boundaries` (#173) — which #167's rule forbids unless it is checked. This
 * checks it: one row per zone, its directories, and the zones it may import, in config order.
 * The config is the source; the page is read back into the same shape.
 */

interface BoundaryConfig {
  zones: { name: string; patterns: string[] }[]
  rules: { from: string; allow: string[] }[]
}

const boundaries: BoundaryConfig = (fallowConfig as { boundaries: BoundaryConfig }).boundaries
const architecture = readFileSync(join(REPOSITORY_ROOT, 'docs/architecture.md'), 'utf8')

const ZONE_ROW = /^\| `([\w-]+)` \| (.+?) \| (.+?) \|$/gm

test('⚠ the architecture page’s zone table equals the boundaries config (#173)', () => {
  const fromConfig = boundaries.zones.map((zone) => {
    const rule = boundaries.rules.find((candidate) => candidate.from === zone.name)
    const directories = zone.patterns.map((pattern) => pattern.replace(/\*\*$/, ''))
    const allow = rule?.allow ?? []
    return { name: zone.name, directories, allow }
  })
  const everyZone = boundaries.zones.map((zone) => zone.name)
  const fromPage = [...architecture.matchAll(ZONE_ROW)].map((match) => {
    const [, name = '', directoryCell = '', allowCell = ''] = match
    const directories = [...directoryCell.matchAll(/`([^`]+)`/g)].map((code) => code[1] ?? '')
    let allow: string[]
    if (allowCell === 'nothing') allow = []
    else if (allowCell === 'anything') allow = everyZone.filter((zoneName) => zoneName !== name)
    else allow = [...allowCell.matchAll(/`([^`]+)`/g)].map((code) => code[1] ?? '')
    return { name, directories, allow }
  })
  expect(fromPage).toEqual(fromConfig)
})
