/**
 * Playwright config for the MANUAL web smoke (#71).
 *
 * This is not part of `bun test` or the gate. It drives the real dev surface — the bun
 * fullstack server on 5178 proxying `/api` to the enso server on 5179 — and writes
 * screenshots a PR author drags into the PR. Run it with `bun run e2e` from the repo root;
 * see README.md in this directory for the two tiers (model-free by default, `@model` opt-in).
 *
 * ⚠ `*.e2e.ts`, NOT `*.test.ts` / `*.spec.ts`: bun's test runner matches both of those
 * globs everywhere in the tree, and it would try to execute a Playwright spec as a unit
 * test. The coverage manifest (`test/coverage-manifest.test.ts`) sweeps `packages/web/src`
 * only, so this directory never joins the coverage denominator either.
 *
 * ⚠ `webServer.reuseExistingServer: true` is deliberate. The usual pattern gates this on
 * `process.env.CI`; there is no CI run of this suite (named non-scope on #71), and a dev
 * who already has `bun run dev` up should not have the harness fight it for the port.
 *
 * ⚠ `workers: 1`. Every test shares ONE enso server, and the server hosts ONE pi session per
 * request with one cwd — parallel browsers would interleave their runs' stderr and, for
 * the `@model` tier, race for the same provider identity.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepoRoot } from '@enso/core/paths'
import { defineConfig } from '@playwright/test'

const e2eDirectory = dirname(fileURLToPath(import.meta.url))
// `bun run dev` must run from the repo root: scripts/dev.ts resolves the web package
// directory from there. Same helper every other launcher uses, so the answer cannot drift.
const repoRoot = findRepoRoot(import.meta.url)

/** The web surface's origin — matches WEB_PORT in src/server/dev-web.ts. */
export const WEB_ORIGIN = 'http://127.0.0.1:5178'

/** Where screenshots and traces land. Gitignored; the run prints the paths. */
export const OUTPUT_DIRECTORY = join(e2eDirectory, 'output')

/**
 * Generous because a cold `createAgentSessionServices` is ~700 ms and a real model turn
 * can take tens of seconds; the point is to finish, not to be fast.
 */
const TEST_TIMEOUT_MS = 120_000
const WEB_SERVER_STARTUP_TIMEOUT_MS = 60_000

export default defineConfig({
  testDir: e2eDirectory,
  testMatch: '**/*.e2e.ts',
  outputDir: join(OUTPUT_DIRECTORY, 'test-results'),
  timeout: TEST_TIMEOUT_MS,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: WEB_ORIGIN,
    // Trace and video are for a failed run's post-mortem; the deliverable screenshots are
    // taken explicitly in the spec so their names mean something in a PR.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'bun run dev',
    cwd: repoRoot,
    url: WEB_ORIGIN,
    reuseExistingServer: true,
    timeout: WEB_SERVER_STARTUP_TIMEOUT_MS,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
