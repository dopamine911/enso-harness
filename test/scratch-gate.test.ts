import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The temporary directories a test run makes are gone when it ends (#546). Held by running a
 * real `bun test` as a child under a `TMPDIR` of this test's own: the child's suite makes a
 * directory the way every suite does and never removes it, and the preload
 * (`test/scratch-preload.ts`) must still leave `TMPDIR` empty. The child prints where its
 * directory landed, so the routing is held too: inside the run's scratch, not the real `/tmp`.
 */

const outer = mkdtempSync(join(tmpdir(), 'enso-scratch-gate-'))
afterAll(() => rmSync(outer, { recursive: true, force: true }))

test('⚠ a test run leaves no temporary directory behind, even one the suite forgot (#546)', async () => {
  const tmp = join(outer, 'tmp')
  const suite = join(outer, 'suite')
  mkdirSync(tmp)
  mkdirSync(suite)
  writeFileSync(
    join(suite, 'leaky.test.ts'),
    [
      `import { test } from 'bun:test'`,
      `import { mkdtempSync } from 'node:fs'`,
      `import { tmpdir } from 'node:os'`,
      `import { join } from 'node:path'`,
      `test('leaks', () => { process.stdout.write('made ' + mkdtempSync(join(tmpdir(), 'enso-leak-')) + '\\n') })`,
    ].join('\n'),
  )
  const run = Bun.spawn(['bun', 'test', join(suite, 'leaky.test.ts')], {
    cwd: REPOSITORY_ROOT,
    env: { ...Bun.env, TMPDIR: tmp },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
  expect(code).toBe(0)
  const made = /^made (.+)$/m.exec(stdout)?.[1]
  // Routed: under THIS run's TMPDIR, inside the preload's per-run directory — never the real /tmp.
  expect(made).toMatch(new RegExp(`^${tmp}/enso-test-run-[^/]+/enso-leak-`))
  // And gone with it: the suite never removed its directory, the preload removed the run's.
  expect(readdirSync(tmp)).toEqual([])
})
