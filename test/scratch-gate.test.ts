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

/** A real `bun test` of `args` from the repository root, under a `TMPDIR` of its own. */
async function runUnder(
  tmp: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  mkdirSync(tmp)
  const run = Bun.spawn(['bun', 'test', ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...Bun.env, TMPDIR: tmp },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, code }
}

test('⚠ a test run leaves no temporary directory behind, even one the suite forgot (#546)', async () => {
  const tmp = join(outer, 'tmp')
  const suite = join(outer, 'suite')
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
  const { stdout, code } = await runUnder(tmp, [join(suite, 'leaky.test.ts')])
  expect(code).toBe(0)
  const made = /^made (.+)$/m.exec(stdout)?.[1]
  // Routed: under THIS run's TMPDIR, inside the preload's per-run directory — never the real /tmp.
  expect(made).toMatch(new RegExp(`^${tmp}/enso-test-run-[^/]+/enso-leak-`))
  // And gone with it: the suite never removed its directory, the preload removed the run's.
  expect(readdirSync(tmp)).toEqual([])
})

/**
 * ⚠ #790: a write AFTER the teardown re-creates the run's directory, and nothing removes it again.
 * Every run of the host suite left one: pi's model runtime refreshes the catalog, unawaited, on each
 * provider registration, and the refresh still in flight when the last test ended re-created its
 * agent dir with `auth.json` and `auth.json.lock`. The suite now waits for those refreshes
 * (`settleModelRefreshes` in `agent-host.test.ts`). Held with the suite's last test alone, as the
 * gate runs it: before the fix, 5 runs of 5 left the directory.
 */
test('⚠ a host test run leaves nothing behind: pi refreshing models after the last test is waited for (#790)', async () => {
  const tmp = join(outer, 'tmp-host')
  const { stderr, code } = await runUnder(tmp, [
    'packages/web/src/host/__tests__/agent-host.test.ts',
    '--test-name-pattern',
    'Stop cancels a login waiting on its provider',
  ])
  expect({ code, ran: /^ 1 pass$/m.test(stderr) }).toEqual({ code: 0, ran: true })
  expect(readdirSync(tmp, { recursive: true })).toEqual([])
})
