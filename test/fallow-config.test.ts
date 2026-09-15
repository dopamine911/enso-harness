import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const config = readFileSync(join(REPOSITORY_ROOT, '.fallowrc.jsonc'), 'utf8')
const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'packages/harness/package.json'), 'utf8')) as {
  pi: { extensions: string[] }
}

test('⚠ every repository extension in the harness manifest is a fallow entry, and only those (#163)', () => {
  const declared = manifest.pi.extensions
    .filter((path) => path.startsWith('./'))
    .map((path) => `packages/harness/${path.slice(2)}`)
    .sort()
  const listed = [...config.matchAll(/"(packages\/harness\/extensions\/[^"]+)"/g)].map((match) => match[1] ?? '').sort()
  expect(listed).toEqual(declared)
})
