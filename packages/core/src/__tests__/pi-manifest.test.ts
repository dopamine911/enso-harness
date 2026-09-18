import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredResources, missingVendorPaths } from '../pi-manifest.ts'

/**
 * pi's manifest-resource layout, now owned in one place (#221 — it was implemented three
 * times: the terminal launcher, the postinstall linker, and the server's `assertVendorLinks`).
 * Against a manifest and a package root of the test's making, which is what both launch
 * points do. The package-name reading is pinned where its one consumer needs it
 * (`scripts/__tests__/link-vendor-packages.test.ts`).
 */

const scratch = mkdtempSync(join(tmpdir(), 'zen-pi-manifest-'))
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

test('declared resources are every pi.* path, arrays and singles alike, in declaration order', () => {
  expect(declaredResources(MANIFEST)).toEqual([
    './extensions/logging/index.ts',
    './extensions/guards/index.ts',
    'node_modules/@ladbabynpm/picc-permission-modes/index.ts',
    'node_modules/pi-multi-account/index.ts',
    'node_modules/@mammothb/pi-tokyonight-storm/theme.json',
  ])
})

// The input is `unknown` on purpose — a manifest is a parsed JSON file, and three callers
// must not each cast the same unverified shape.
test('a manifest with no pi table declares no resources — a package may declare none', () => {
  for (const withoutPi of [undefined, null, 'package.json', 42, [], {}, { pi: undefined }]) {
    expect(declaredResources(withoutPi)).toEqual([])
  }
})

// ⚠ MALFORMED IS NOT EMPTY (#226). A `pi` spelled as a bare string is the case that matters:
// `Object.values` walks a string character by character, no character starts `node_modules/`,
// and the vendor-path check would come back empty — the server booting with its precondition
// silently unenforced, which is the failure the check exists to prevent.
test('a pi that is present and is not an object is refused by name, not walked character by character', () => {
  for (const notATable of [null, 'node_modules/pi-multi-account/index.ts', 7, ['node_modules/x/index.ts']]) {
    expect(() => declaredResources({ pi: notATable })).toThrow(/`pi` that is not an object/)
  }
})

// …while a value INSIDE the table that is not a resource path is a kind we do not model
// yet: skipped, never fatal. On main this threw `startsWith is not a function` out of the
// server's boot path.
test('a non-string value inside the pi table is skipped, not fatal', () => {
  expect(declaredResources({ pi: { extensions: ['./x.ts'], hooks: { onStart: './y.ts' } } })).toEqual(['./x.ts'])
  expect(missingVendorPaths({ pi: { themes: 42 } }, scratch)).toEqual([])
})

// ⚠ pi skips a missing manifest resource SILENTLY; both launch points must refuse instead.
// Only the vendor (`node_modules/…`) paths are checked — the repo-local ones are the
// package's own.
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
