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
 * ⚠ A child given an explicit `env` WITHOUT `TMPDIR` writes to the real `/tmp`. Every such child
 * today (PR #549 review): the fixed-environment git helpers in `secret-scan-gate.test.ts` and
 * `guards.test.ts` make no temporary files; `guards.test.ts`'s nested `bun test` is handed this
 * run's `TMPDIR`; and `cc-safety-net-contract.test.ts`'s probe (`checkCommand`, read in the
 * vendored source of cc-safety-net 2.4.6) reads `TMPDIR` only to classify paths in the commands
 * it judges, and its only writes are its policy files under `$HOME`, which the probe points at
 * a directory of its own — nothing under `tmpdir()`. It is left WITHOUT `TMPDIR` on purpose, so
 * the pinned verdicts are the policy's view under the default tmp, not this run's scratch.
 * Playwright's e2e home (`packages/web/e2e/e2e-home.ts`) runs outside `bun test` and is not
 * covered here.
 *
 * ⚠ `ENSO_HOME` is pinned the same way, for the same reason, since #551: see below.
 *
 * ⚠ The teardown is an `afterAll` in THIS preload, which bun runs once at the end of the whole
 * run — not a `process.on('exit')`: measured on bun 1.4.0, `bun test` ends without firing exit
 * or beforeExit listeners at all, so a cleanup registered there never ran (the first draft).
 */
const scratch = mkdtempSync(join(tmpdir(), 'enso-test-run-'))
process.env['TMPDIR'] = scratch
// And the run's own ENSO_HOME (#551): the harness extensions run IN-PROCESS under a hosted thread
// and read `ensoHome(process.env)` — the guards for the user's security config, the run-context
// recorder for where a thread's snapshot store is minted. Unpinned, a host test would mint bare
// repositories under the operator's `~/.enso/projects/`, one per test thread (the way an unpinned
// `PI_CODING_AGENT_DIR` once filed fixtures under `~/.pi`, PR #554). A test that means the real
// home passes its own environment; none does.
process.env['ENSO_HOME'] = join(scratch, 'enso-home')
/**
 * ⚠ The teardown's cost grows with the whole suite, so it is not held to bun's 5 s hook default
 * (PR #562): with #578's two large fixtures left here it deleted ~58,000 entries, past 5 s on a CI
 * runner, and the gate failed on an `(unnamed)` hook after whichever file ran last. Those fixtures
 * now remove themselves; this limit is what keeps the next growth from failing the gate again.
 */
const TEARDOWN_TIMEOUT_MS = 60_000
afterAll(
  () => {
    rmSync(scratch, { recursive: true, force: true })
  },
  { timeout: TEARDOWN_TIMEOUT_MS },
)
