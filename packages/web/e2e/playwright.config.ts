/**
 * Playwright config for the browser suite (#71, #486).
 *
 * Not part of `bun test`: it drives the real dev surface — the bun fullstack server on 5178
 * proxying `/api` to the enso server on 5179 — in Chromium. `bun run e2e` runs the model-free
 * tier, in CI on every pull request (`.github/workflows/ci.yml`, job `e2e`); `bun run e2e:model`
 * adds one real model turn, by hand. See README.md in this directory.
 *
 * ⚠ `*.e2e.ts`, NOT `*.test.ts` / `*.spec.ts`: bun's test runner matches both of those
 * globs everywhere in the tree, and it would try to execute a Playwright spec as a unit
 * test. The coverage manifest (`test/coverage-manifest.test.ts`) sweeps `packages/web/src`
 * only, so this directory never joins the coverage denominator either.
 *
 * ⚠ THE MODEL-FREE TIER RUNS OVER ITS OWN HOME (`e2e-home.ts`): a throwaway `ENSO_HOME` with
 * stored threads seeded in it, handed to the stack it starts. So `reuseExistingServer` is off for
 * it: a dev stack already on 5178 serves the operator's home, where the seeded threads are not,
 * and a run over it would pass or fail on whatever that home holds. A port in use is Playwright's
 * plain error instead. The `@model` tier needs the operator's own login, so it keeps their home
 * and may reuse their stack, as before.
 *
 * ⚠ `workers: 1`. Every test shares ONE enso server, and the server hosts ONE pi session per
 * request with one cwd — parallel browsers would interleave their runs' stderr and, for
 * the `@model` tier, race for the same provider identity.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepoRoot } from '@enso/core/paths'
import { defineConfig } from '@playwright/test'
import { e2eStack } from './e2e-home.ts'

const e2eDirectory = dirname(fileURLToPath(import.meta.url))
// `bun run dev` must run from the repo root: scripts/dev.ts resolves the web package
// directory from there. Same helper every other launcher uses, so the answer cannot drift.
const repoRoot = findRepoRoot(import.meta.url)

/** Over the seeded home, or the operator's for the `@model` tier (`e2e-home.ts#e2eStack`). */
const stack = e2eStack()

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
    reuseExistingServer: stack.reuseRunningStack,
    env: stack.environment,
    timeout: WEB_SERVER_STARTUP_TIMEOUT_MS,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
