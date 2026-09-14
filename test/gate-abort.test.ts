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
 * Builds a throwaway package whose `lint` gate runs `body`, then runs the real
 * `scripts/gate.ts` against it.
 */
function runGateOver(body: string): { status: number | null; stdout: string; stderr: string; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'zen-gate-abort-'))
  writeFileSync(join(scratch, 'crash.sh'), `#!/bin/sh\n${body}`, { mode: 0o755 })
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'gate-abort-fixture',
      private: true,
      packageManager: 'bun@1.4.0',
      scripts: {
        lint: './crash.sh',
        typecheck: 'true',
        'deadcode:check': 'true',
        test: 'true',
        'coverage:check': 'true',
      },
    }),
  )

  const run = spawnSync('bun', [join(import.meta.dir, '..', 'scripts', 'gate.ts')], {
    cwd: scratch,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, output: `${run.stdout}${run.stderr}` }
}

/**
 * End to end, because the unit above cannot prove the wiring: a gate script that prints the
 * banner and exits 0 must take the whole gate down.
 */
test('⚠ end to end: a gate script that prints the banner and exits 0 still fails the run', () => {
  // Exits 0 on purpose — that is the whole point.
  const run = runGateOver(
    'echo "thread \'biome::workspace_worker_0\' has overflowed its stack" >&2\necho "fatal runtime error: stack overflow, aborting" >&2\nexit 0\n',
  )
  expect(run.status).toBe(1)
  expect(run.output).toContain('ABORTED')
  // …and it stops there rather than running the gates behind it on a broken tree.
  expect(run.output).not.toContain('All gates passed')
})

/**
 * A tool that says a lot before it dies is still a tool that died. stderr is streamed and
 * scanned as it passes, never accumulated, so there is no size at which the gate stops
 * reading — a buffered read would have hit its 1 MB ceiling here and reported the crash as
 * something else entirely.
 */
test('⚠ megabytes of stderr before the banner does not hide the abort', () => {
  const run = runGateOver(
    "head -c 2000000 /dev/zero | tr '\\0' 'x' >&2\necho >&2\necho 'fatal runtime error: stack overflow, aborting' >&2\nexit 0\n",
  )
  expect(run.status).toBe(1)
  expect(run.output).toContain('ABORTED')
  expect(run.output).not.toContain('failed to spawn')
})

/**
 * Both streams are piped, so the gate is now the only writer to the terminal. Every line the
 * tool wrote must arrive whole and on the stream it was written to — an earlier revision
 * inherited stdout while piping stderr, and Biome's diagnostics and its summary spliced into
 * each other mid-line. (Ordering ACROSS the two streams is grouped in chunks, not exact;
 * that is the price of reading either of them.)
 */
test('⚠ a tool writing both streams has every line arrive whole, on the stream it came from', () => {
  const run = runGateOver('i=0\nwhile [ $i -lt 300 ]; do\n  echo "out $i"\n  echo "err $i" >&2\n  i=$((i+1))\ndone\n')
  expect(run.status).toBe(0)
  const lines = (stream: string, tag: string): string[] => stream.split('\n').filter((line) => line.startsWith(tag))
  expect(lines(run.stdout, 'out ')).toEqual(Array.from({ length: 300 }, (_, index) => `out ${index}`))
  expect(lines(run.stderr, 'err ')).toEqual(Array.from({ length: 300 }, (_, index) => `err ${index}`))
})

/**
 * stdout is forwarded but never scanned. A linter quoting source — this very file names every
 * banner, and Biome prints the offending lines — must not read as its own death.
 */
test('⚠ a banner quoted on stdout is a tool reporting, not a tool dying', () => {
  const run = runGateOver('echo "fatal runtime error: stack overflow, aborting"\necho "  > 42 | Segmentation fault"\n')
  expect(run.status).toBe(0)
  expect(run.output).toContain('All gates passed')
  expect(run.output).not.toContain('ABORTED')
})
