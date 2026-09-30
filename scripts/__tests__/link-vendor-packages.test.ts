import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkVendorPackages, requiredPackageNames } from '../link-vendor-packages.ts'

/**
 * The postinstall linker (docs/flows/boot-and-launchers.md, stated gap: no test of its own).
 * Against a repo root and a package root of the test's making: which packages it requires,
 * and verify-or-fix — a present package is verified, an absent one is linked from the hoisted
 * copy, a broken link is replaced, a package at neither is an error naming it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'enso-link-vendor-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const MANIFEST = {
  dependencies: { '@enso/core': 'workspace:*', 'cc-safety-net': '2.3.3' },
  pi: {
    extensions: ['./extensions/guards/index.ts', 'node_modules/@ladbabynpm/picc-permission-modes/index.ts'],
    themes: 'node_modules/@mammothb/pi-tokyonight-storm/theme.json',
  },
}

// ⚠ BOTH SOURCES. `@enso/core` appears in no manifest path — only in `dependencies` — and a
// manifest-only sweep once left it unlinked, failing the extension at load (header).
test('required packages are every dependency plus every node_modules/… manifest path, scopes intact, once each', () => {
  expect(requiredPackageNames(MANIFEST).sort()).toEqual(
    ['@ladbabynpm/picc-permission-modes', '@mammothb/pi-tokyonight-storm', '@enso/core', 'cc-safety-net'].sort(),
  )
  expect(requiredPackageNames({})).toEqual([])
  expect(requiredPackageNames({ pi: { extensions: ['./local/only.ts'] } })).toEqual([])
})

function scratchRepo(name: string): { repoRoot: string; packageRoot: string } {
  const repoRoot = join(scratch, name)
  const packageRoot = join(repoRoot, 'packages', 'harness')
  mkdirSync(packageRoot, { recursive: true })
  return { repoRoot, packageRoot }
}

function hoist(repoRoot: string, packageName: string): void {
  const directory = join(repoRoot, 'node_modules', packageName)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `{"name":"${packageName}"}`)
}

// @pins boot-and-launchers/vendor-refusal
test('verify-or-fix: a present package is verified, an absent one is linked from the hoisted copy, and the link resolves', () => {
  const { repoRoot, packageRoot } = scratchRepo('link')
  for (const name of requiredPackageNames(MANIFEST)) hoist(repoRoot, name)
  // one is already in place inside the package — a real directory, not a link
  mkdirSync(join(packageRoot, 'node_modules', 'cc-safety-net'), { recursive: true })
  const outcome = linkVendorPackages(repoRoot, packageRoot, MANIFEST)
  expect(outcome.verified).toEqual(['cc-safety-net'])
  expect(outcome.linked.sort()).toEqual(
    ['@ladbabynpm/picc-permission-modes', '@mammothb/pi-tokyonight-storm', '@enso/core'].sort(),
  )
  const linked = join(packageRoot, 'node_modules', '@enso', 'core')
  expect(lstatSync(linked).isSymbolicLink()).toBe(true)
  // relative, so a moved checkout heals; and it resolves to the hoisted copy
  expect(readlinkSync(linked).startsWith('..')).toBe(true)
  expect(existsSync(join(linked, 'package.json'))).toBe(true)
  // a second run verifies everything and links nothing
  expect(linkVendorPackages(repoRoot, packageRoot, MANIFEST)).toEqual({
    verified: expect.arrayContaining(['cc-safety-net', '@enso/core']),
    linked: [],
  })
})

// ⚠ `existsSync` follows links, so a BROKEN link reads as absent — and must be replaced, not
// left for pi to skip in silence.
test('a broken link is replaced with a working one', () => {
  const { repoRoot, packageRoot } = scratchRepo('broken')
  for (const name of requiredPackageNames(MANIFEST)) hoist(repoRoot, name)
  const target = join(packageRoot, 'node_modules', 'cc-safety-net')
  mkdirSync(join(packageRoot, 'node_modules'), { recursive: true })
  symlinkSync('../../../nowhere/cc-safety-net', target, 'dir')
  expect(existsSync(target)).toBe(false)
  const outcome = linkVendorPackages(repoRoot, packageRoot, MANIFEST)
  expect(outcome.linked).toContain('cc-safety-net')
  expect(existsSync(join(target, 'package.json'))).toBe(true)
})

test('a package at neither the package root nor the repo root is an error that names it', () => {
  const { repoRoot, packageRoot } = scratchRepo('missing')
  hoist(repoRoot, '@enso/core')
  expect(() => linkVendorPackages(repoRoot, packageRoot, MANIFEST)).toThrow(/cc-safety-net|picc|tokyonight/)
})
