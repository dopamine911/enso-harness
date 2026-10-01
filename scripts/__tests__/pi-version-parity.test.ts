import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { piVersionSupported, piVersionText, SUPPORTED_PI_VERSIONS } from '../enso-launch.ts'

/**
 * THE TWO PI RESOLUTIONS, HELD TOGETHER (#217). The guard REPLICATES pi's path normaliser —
 * `resolveToCwd` is not on pi's export map — and the replica is kept honest by a corpus that
 * reaches the real implementation through the WORKSPACE tree:
 *
 *   corpus    `packages/harness/core/__tests__/paths.test.ts` → `import.meta.resolve(…)`
 *             → `node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js`
 *   terminal  `scripts/enso.ts` → `Bun.spawn(['pi', …])` → the first `pi` on `PATH`
 *
 * Those are different resolutions, and until #217 nothing related them: measured 2026-09-18, a
 * shim printing `0.85.0` earlier on `PATH` launched with the whole suite green, so the guard
 * could resolve a path differently from the tool it gates and compute a deny against the wrong
 * target. `enso.ts` now refuses a `pi` outside `SUPPORTED_PI_VERSIONS`; this file is the other
 * half — that the range still covers the pi the corpus actually pinned.
 *
 * ⚠ A red line here means the two ends have drifted apart. If the WORKSPACE pi moved (a
 * devDependency bump), the corpus is now pinning a pi the launcher refuses: run the corpus
 * against it, then move `SUPPORTED_PI_VERSIONS` in `scripts/enso-launch.ts` — in that order,
 * because the range means "the corpus has been run against this".
 *
 * ⚠ WHAT THIS DOES NOT COVER, stated: the version of the pi BINARY, not the versions of the
 * libraries inside its own tree. `packages/web/src/host/__tests__/agent-loop-contract.test.ts`
 * pins `@earendil-works/pi-agent-core`'s `dist/agent-loop.js` from the workspace, and the pi on
 * `PATH` resolves its own copy of that package; a pi that still reports a supported version with
 * a different `pi-agent-core` beneath it is out of reach from here. The in-process surface has
 * no such gap — it imports the workspace copy it is pinned against (#69).
 */

const VENDOR_PACKAGE = '@earendil-works/pi-coding-agent'

/** The `version` of the pi package `import.meta.resolve` reaches — the one the corpus pins against. */
function workspacePiVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.resolve(VENDOR_PACKAGE)))
  for (;;) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === VENDOR_PACKAGE) return manifest.version ?? ''
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`no ${VENDOR_PACKAGE} manifest above its resolved entry point`)
    directory = parent
  }
}

// @pins boot-and-launchers/pi-version-gate
test('⚠ the pi the guard corpus pins against is a pi the terminal launcher will run (#217)', () => {
  const pinned = workspacePiVersion()
  // The receipt that the resolution worked at all, so an empty string cannot pass the range check.
  expect(pinned).toMatch(/^\d+\.\d+\.\d+/)
  expect(piVersionSupported(pinned)).toBe(true)
})

// The range is also a PUBLISHED contract: a consumer installing the harness reads
// `peerDependencies`, not the launcher. `>=0.84.0` said the corpus covers versions it has never
// been run against; the two must state the same bound, and `^0.99.2` is that bound for a 0.x
// package — the boundary tests in `enso-launch.test.ts`, beside this file, pin the equivalence.
test('the harness declares the peer range the launcher enforces', () => {
  const manifestPath = join(import.meta.dir, '..', '..', 'packages', 'harness', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    peerDependencies?: Record<string, string>
  }
  expect(manifest.peerDependencies?.[VENDOR_PACKAGE]).toBe(`^${piVersionText(SUPPORTED_PI_VERSIONS.minimum)}`)
})
