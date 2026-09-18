import { expect, test } from 'bun:test'
import { isPrintRun, piArguments } from '../zen-launch.mjs'

/**
 * The terminal launcher's decisions (docs/flows/boot-and-launchers.md, stated gap: `zen.mjs`
 * had no test of its own). The launcher spawns pi and is not driven here; what it decides
 * before spawning is. The vendor-path precondition moved out with #221 — it is pi's manifest
 * layout, not the launcher's decision, and is pinned at its owner
 * (`packages/core/src/__tests__/pi-manifest.test.ts`).
 */

// ⚠ THE ISOLATION TRIPLE. Two legs are arguments and one is the environment; the arguments
// must be exactly these, in this order, BEFORE whatever the user passed — a flag the user adds
// cannot displace `--no-skills`, which neither of the other two covers (header).
test('pi is launched with --no-extensions, --no-skills and -e <package>, ahead of the user’s arguments', () => {
  expect(piArguments('/pkg', ['-p', 'hello'])).toEqual(['--no-extensions', '--no-skills', '-e', '/pkg', '-p', 'hello'])
  expect(piArguments('/pkg', [])).toEqual(['--no-extensions', '--no-skills', '-e', '/pkg'])
})

test('a print run is -p, --print, or stdin that is not a TTY; an interactive run is none of those', () => {
  expect(isPrintRun(['-p', 'x'], true)).toBe(true)
  expect(isPrintRun(['--print', 'x'], true)).toBe(true)
  expect(isPrintRun([], false)).toBe(true)
  expect(isPrintRun([], true)).toBe(false)
  expect(isPrintRun(['--model', 'x'], true)).toBe(false)
})
