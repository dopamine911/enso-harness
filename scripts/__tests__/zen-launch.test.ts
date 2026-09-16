import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredResources, isPrintRun, missingVendorPaths, piArguments } from '../zen-launch.mjs'

/**
 * The terminal launcher's decisions (docs/flows/boot-and-launchers.md, stated gap: `zen.mjs`
 * had no test of its own). The launcher spawns pi and is not driven here; the three things it
 * decides before spawning are, against a manifest and a package root of the test's making.
 */

const scratch = mkdtempSync(join(tmpdir(), 'zen-launch-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const MANIFEST = {
  pi: {
    extensions: [
      './extensions/logging/index.ts',
      './extensions/guards/index.ts',
      'node_modules/@ladbabynpm/picc-permission-modes/index.ts',
      'node_modules/pi-multi-account/index.ts',
    ],
    themes: 'node_modules/@mammothb/pi-tokyonight-storm/theme.json',
  },
}

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

test('declared resources are every pi.* path, arrays and singles alike; a non-string entry is not one', () => {
  expect(declaredResources(MANIFEST)).toEqual([
    './extensions/logging/index.ts',
    './extensions/guards/index.ts',
    'node_modules/@ladbabynpm/picc-permission-modes/index.ts',
    'node_modules/pi-multi-account/index.ts',
    'node_modules/@mammothb/pi-tokyonight-storm/theme.json',
  ])
  expect(declaredResources({ pi: { extensions: [42, './x.ts'] } })).toEqual(['./x.ts'])
  expect(declaredResources({})).toEqual([])
})

// ⚠ pi skips a missing manifest resource SILENTLY; the launcher must refuse instead. Only the
// vendor (`node_modules/…`) paths are checked — the repo-local ones are the package's own.
test('the vendor paths a manifest declares that are not under the package root are named, and only those', () => {
  const packageRoot = join(scratch, 'harness')
  const put = (relativePath: string): void => {
    mkdirSync(join(packageRoot, relativePath, '..'), { recursive: true })
    writeFileSync(join(packageRoot, relativePath), '')
  }
  put('node_modules/pi-multi-account/index.ts')
  expect(missingVendorPaths(MANIFEST, packageRoot)).toEqual([
    'node_modules/@ladbabynpm/picc-permission-modes/index.ts',
    'node_modules/@mammothb/pi-tokyonight-storm/theme.json',
  ])
  // a directory alone is not the resource: the path names a file, and the file must be there
  mkdirSync(join(packageRoot, 'node_modules', '@mammothb', 'pi-tokyonight-storm'), { recursive: true })
  expect(missingVendorPaths(MANIFEST, packageRoot)).toHaveLength(2)
  put('node_modules/@mammothb/pi-tokyonight-storm/theme.json')
  put('node_modules/@ladbabynpm/picc-permission-modes/index.ts')
  expect(missingVendorPaths(MANIFEST, packageRoot)).toEqual([])
})
