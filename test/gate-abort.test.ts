import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reportsWorkerAbort } from '../scripts/gate.ts'

/**
 * The gate's blind spot, closed (#157): a tool that dies mid-run and still exits 0.
 *
 * Measured 2026-09-10 — Biome 2.5.13 with any GritQL plugin loaded overflows a worker's
 * stack, prints `fatal runtime error: stack overflow, aborting`, and exits **0**. The files
 * that worker held go unchecked and `bun run check` says green. Every other gate failure
 * announces itself in the exit code; this one does not, so it is the one worth a test.
 */

test('⚠ a tool that aborts a worker is a failure whatever it exited with', () => {
  // The verbatim banner Biome 2.5.13 printed, and the other runtimes' equivalents.
  expect(reportsWorkerAbort("thread 'biome::workspace_worker_4' (3220082) has overflowed its stack")).toBe(true)
  expect(reportsWorkerAbort('fatal runtime error: stack overflow, aborting')).toBe(true)
  expect(reportsWorkerAbort("thread 'main' panicked at src/lib.rs:42:9:")).toBe(true)
  expect(reportsWorkerAbort('Segmentation fault (core dumped)')).toBe(true)
})

test('ordinary stderr is not an abort — diagnostics, warnings and an empty stream all pass', () => {
  expect(reportsWorkerAbort('')).toBe(false)
  expect(reportsWorkerAbort('Found 214 warnings.\nChecked 185 files in 1301ms.')).toBe(false)
  expect(reportsWorkerAbort('error: script "lint" exited with code 1')).toBe(false)
  // A test NAMING the banner (this file does) is prose in someone's output, not an abort of
  // the tool that printed it — the scan reads the running tool's stderr, nothing else.
  expect(reportsWorkerAbort('the message says stack overflow when it aborts')).toBe(false)
})

/**
 * End to end, because the unit above cannot prove the wiring: a gate script that prints the
 * banner and exits 0 must take the whole gate down. Runs the real `scripts/gate.ts` against a
 * throwaway package.json whose one gate does exactly that.
 */
test('⚠ end to end: a gate script that prints the banner and exits 0 still fails the run', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'zen-gate-abort-'))
  // Exits 0 on purpose — that is the whole point.
  writeFileSync(
    join(scratch, 'crash.sh'),
    '#!/bin/sh\necho "thread \'biome::workspace_worker_0\' has overflowed its stack" >&2\necho "fatal runtime error: stack overflow, aborting" >&2\nexit 0\n',
    { mode: 0o755 },
  )
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'gate-abort-fixture',
      private: true,
      packageManager: 'bun@1.4.0',
      scripts: { lint: './crash.sh', typecheck: 'true', test: 'true', 'coverage:check': 'true' },
    }),
  )

  const run = spawnSync('bun', [join(import.meta.dir, '..', 'scripts', 'gate.ts')], {
    cwd: scratch,
    encoding: 'utf8',
  })
  expect(run.status).toBe(1)
  expect(`${run.stdout}${run.stderr}`).toContain('ABORTED')
  // …and it stops there rather than running the gates behind it on a broken tree.
  expect(run.stdout).not.toContain('All gates passed')
})
