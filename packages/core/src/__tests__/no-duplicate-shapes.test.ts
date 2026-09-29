import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../index.ts'

/**
 * Anchors for the reason this package exists: one place for every shape, reachable by one
 * search.
 *
 * ⚠ These are not unit tests of a schema — they are the enforcement of "one place". The half
 * that walks the REPOSITORY for a second declaration site is `test/duplicate-shapes-gate.test.ts`
 * (moved there by #255, when it grew to `packages`/`scripts`/`test` over the shared walker,
 * which a test inside this package's `rootDir` cannot import). What stays here is the half
 * about this package: every module reachable from the barrel or a declared subpath, and the
 * schemas the rest of the repo depends on actually exported.
 */

test('every module is reachable: from the barrel, or from a subpath package.json declares', () => {
  // If a module is added to src/ and not to index.ts, a consumer would have to reach past
  // the barrel — and "is this shape already declared?" stops being one search. The
  // exceptions are declared in package.json (checked here so an exception cannot be an
  // undeclared file either), and every one is a module the BROWSER MUST NEVER SEE:
  //
  //   `git.ts`          `node:child_process` — the one git runner, and the repository reader (#453)
  //   `log-process.ts`  `@logtape/file` builds its sinks on `node:fs` at import
  //   `paths.ts`        `node:fs`/`node:url` — the repo-root walker and the harness's paths (#211)
  //   `permission-rules.ts` `node:fs` — the permission rules file, seeded before pi loads (#446)
  //   `pi-manifest.ts`  `node:fs` — is a declared pi resource path actually there (#221)
  //   `secrets.ts`      `node:fs` — the secrets file's reader (#211)
  //
  // ⚠ Tree-shaking does not save a bundle from a bare `node:*` specifier: it is resolved at
  // link time, before anything is shaken, so a node-only module ON the barrel breaks a
  // browser build outright — measured on #211, and `test/browser-bundle-gate.test.ts` is
  // the sensor. Three more are test-only: the recording sink (#178) is
  // `@enso/core/log-recorder`, the flow trace recorder (#482) is `@enso/core/flow-trace` and
  // the observation-kinds oracle (#173) is `@enso/core/observation-kinds`, all from under
  // `__tests__`, where the logging gate's three-file LogTape inventory does not look.
  const modules = readdirSync(join(import.meta.dir, '..'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'index.ts')
    .map((entry) => entry.name)
  const barrel = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string>
  }
  const subpathModules = Object.entries(manifest.exports)
    .filter(([subpath]) => subpath !== '.')
    .map(([, target]) => target.replace(/^\.\/src\//, ''))
  expect(subpathModules).toEqual([
    'git.ts',
    'log-process.ts',
    'paths.ts',
    'permission-rules.ts',
    'pi-manifest.ts',
    'secrets.ts',
    '__tests__/flow-trace.ts',
    '__tests__/log-recorder.ts',
    '__tests__/observation-kinds.ts',
  ])
  // ⚠ The barrel's RE-EXPORTS, not its text: `barrel.includes(module)` read a filename in a
  // comment as an export, so this assertion passed on prose (#211 — the new header names the
  // node-only modules to say they are NOT here, and that turned the check red).
  const reExported = new Set([...barrel.matchAll(/ from '\.\/([^']+)'$/gm)].map((match) => match[1] ?? ''))
  const inBarrel = modules.filter((module) => reExported.has(module))
  const expectedInBarrel = modules.filter((module) => !subpathModules.includes(module))
  expect(inBarrel.sort()).toEqual(expectedInBarrel.sort())
})

test('the schemas the rest of the repo depends on are actually exported', () => {
  // A spot check that the barrel resolves, rather than an inventory that rots.
  for (const name of [
    'GuardPolicy',
    'DEFAULT_GUARD_POLICY',
    'EnsoToolResultDescriptor',
    'EnsoObservation',
    'ThreadRuntime',
    'RuntimeCommand',
    'PromptImageContent',
    'EnsoPromptAdmission',
  ]) {
    expect(core).toHaveProperty(name)
  }
})
