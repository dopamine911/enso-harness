import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The browser zone must bundle for the browser (#211). `@enso/core`'s barrel used to re-export
 * `paths.ts` and `secrets.ts`, whose bare `node:fs` / `node:url` specifiers are resolved at
 * link time — before anything is tree-shaken — so a production build of the web surface
 * failed outright (`Browser polyfill for module "node:url" doesn't have a matching export
 * named "fileURLToPath"`), and the HMR dev server was the only thing that ran it. Those
 * modules are subpaths now (`@enso/core/paths`, `@enso/core/secrets`, beside `log-process`).
 *
 * ⚠ Enforcement, not a unit test — the shape of the other gates: this is the sensor the
 * zone table lacked. It builds the real entry for the real target and fails by the bundler's
 * own error if a `node:` module is ever reachable from the browser graph again, whether
 * through the barrel, a new subpath, or a browser file importing the wrong thing.
 */

const WEB_ENTRY = join(REPOSITORY_ROOT, 'packages/web/src/main.tsx')

test('⚠ the web surface bundles for the browser target: no node:-only module is reachable from the browser zone (#211)', async () => {
  const result = await Bun.build({
    entrypoints: [WEB_ENTRY],
    target: 'browser',
    // No `outdir`: the build is the check, and its artifacts stay in memory.
    // The dev server's Tailwind plugin owns `.css`; here a stylesheet is text the build may ignore.
    loader: { '.css': 'text' },
  })
  const messages = result.logs.filter((log) => log.level === 'error').map((log) => log.message)
  expect(messages).toEqual([])
  expect(result.success).toBe(true)
  // Something was bundled — a wrong entry path would "succeed" with nothing.
  expect(result.outputs.length).toBeGreaterThan(0)
})
