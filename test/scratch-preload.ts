import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One scratch directory per test run, removed when the run ends (#546).
 *
 * The suites make temporary directories at 178 sites across 41 files (`mkdtempSync(join(tmpdir(),
 * 'enso-…'))`), and 25 of them remove what they made. A full gate run left ~1,000 `enso-*`
 * directories under `/tmp`; a machine that ran the gate a few hundred times filled the tmpfs's
 * inodes, and 235 tests across unrelated suites failed with no error naming the cause.
 *
 * `os.tmpdir()` reads `TMPDIR` at every call, so this preload points it at a directory of this
 * run's own before any test file loads; every `mkdtempSync(join(tmpdir(), …))` lands inside it,
 * and so does every child a test spawns, since a child inherits the environment. When the run
 * ends, the one directory goes, whatever the suites forgot. No site changes; a new site is
 * covered by construction. `test/scratch-gate.test.ts` holds it: a run under a fresh `TMPDIR`
 * leaves it empty.
 *
 * ⚠ A child given an explicit `env` WITHOUT `TMPDIR` writes to the real `/tmp`; none does today
 * (the fixed-environment git helper in `secret-scan-gate.test.ts` makes no temporary files).
 * Playwright's e2e home (`packages/web/e2e/e2e-home.ts`) runs outside `bun test` and is not
 * covered here.
 *
 * ⚠ The teardown is an `afterAll` in THIS preload, which bun runs once at the end of the whole
 * run — not a `process.on('exit')`: measured on bun 1.4.0, `bun test` ends without firing exit
 * or beforeExit listeners at all, so a cleanup registered there never ran (the first draft).
 */
const scratch = mkdtempSync(join(tmpdir(), 'enso-test-run-'))
process.env['TMPDIR'] = scratch
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})
