import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { makeRunTmp, sweepAbandonedRunTmps } from '../launch.ts'
import { isRunning, processTreeOf, stopProcessTree } from '../process-tree.ts'

/**
 * A run's launch and cleanup (#742): stopping its stack takes the whole tree, and what a killed run
 * left in the temporary directory is swept by the next start, while a live run's is not touched.
 * The scope itself (systemd) is proven by a live run.
 */

let stack: Subprocess | undefined
let survivors: number[] = []
afterEach(() => {
  stack?.kill('SIGKILL')
  stack = undefined
  for (const pid of survivors) spawnSync('kill', ['-KILL', String(pid)])
  survivors = []
})

/** The tree once the shell has forked: a real process has no event to await, so this polls `ps` until it shows. */
async function treeOfAtLeast(root: number, size: number): Promise<number[]> {
  const deadline = Date.now() + 5000
  let tree = processTreeOf(root)
  while (tree.length < size && Date.now() < deadline) {
    await Bun.sleep(20)
    tree = processTreeOf(root)
  }
  return tree
}

test('⚠ stopping a stack takes the child that outlives its root: SIGTERM ignored, then SIGKILL', async () => {
  // The root dies on SIGTERM; its child ignores SIGTERM and would outlive it, as a dev server slower
  // than `scripts/dev.ts`'s 500 ms did, re-parented and still holding its port.
  stack = Bun.spawn(['sh', '-c', '(trap "" TERM; exec sleep 30) & exec sleep 30'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const tree = await treeOfAtLeast(stack.pid, 2)
  survivors = tree.slice(1)
  expect(tree).toHaveLength(2)

  const left = await stopProcessTree(stack.pid, 200)

  expect(left).toEqual([])
  for (const pid of tree) expect(isRunning(pid)).toBe(false)
})

test('a stack whose root takes its children down needs no more than the SIGTERM', async () => {
  stack = Bun.spawn(['sh', '-c', 'sleep 30 & child=$!; trap "kill $child; exit 0" TERM; wait'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const tree = await treeOfAtLeast(stack.pid, 2)
  survivors = tree.slice(1)
  const started = Date.now()

  expect(await stopProcessTree(stack.pid, 2000)).toEqual([])
  // Gone within the first grace: no second SIGTERM, no SIGKILL needed.
  expect(Date.now() - started).toBeLessThan(2000)
  for (const pid of tree) expect(isRunning(pid)).toBe(false)
})

test('⚠ the sweep removes only the temporary directories whose run is gone', () => {
  const base = mkdtempSync(join(tmpdir(), 'arena-launch-'))
  const gone = spawnSync('true').pid
  const abandoned = makeRunTmp({ pid: gone }, base)
  const scopeGone = makeRunTmp({ pid: gone, unit: 'arena-no-such-run.scope' }, base)
  const live = makeRunTmp({ pid: process.pid }, base)
  // Not a run's: no owner to read, or not named like one.
  const unowned = join(base, 'enso-arena-unowned')
  mkdirSync(unowned)
  const stranger = join(base, 'something-else')
  mkdirSync(stranger)

  expect(sweepAbandonedRunTmps(base).toSorted()).toEqual([abandoned, scopeGone].toSorted())

  expect(existsSync(abandoned)).toBe(false)
  expect(existsSync(scopeGone)).toBe(false)
  expect(existsSync(live)).toBe(true)
  expect(existsSync(unowned)).toBe(true)
  expect(existsSync(stranger)).toBe(true)
  rmSync(base, { recursive: true, force: true })
})
