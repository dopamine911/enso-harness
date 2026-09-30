import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrintManifest, materializePrintHarness, PrintHarnessShapeError } from '../print-harness.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const harnessPackageRoot = join(repoRoot, 'packages', 'harness')

const exampleManifest = {
  name: 'enso',
  pi: {
    extensions: [
      './extensions/guards/index.ts',
      'node_modules/@gotgenes/pi-permission-system/src/index.ts',
      './extensions/permission-modes/index.ts',
      'node_modules/pi-multi-account/index.ts',
    ],
    skills: ['./skills'],
    prompts: ['./prompts'],
    themes: ['./themes'],
  },
}

test('buildPrintManifest removes exactly the permission engine and keeps everything else, the mode commands too', () => {
  const printManifest = buildPrintManifest(exampleManifest)
  expect(printManifest.pi.extensions).toEqual([
    './extensions/guards/index.ts',
    './extensions/permission-modes/index.ts',
    'node_modules/pi-multi-account/index.ts',
  ])
  expect(printManifest.pi.skills).toEqual(['./skills'])
  expect(printManifest.pi.prompts).toEqual(['./prompts'])
  expect(printManifest.pi.themes).toEqual(['./themes'])
  expect(printManifest.name).toBe('enso-print')
  // The input is not mutated — interactive launches read the same object.
  expect(exampleManifest.pi.extensions).toHaveLength(4)
})

// ⚠ The contract test: run the filter against the REAL harness manifest, so renaming or
// removing the permission engine there turns THIS test red instead of turning a print launch into a loud
// runtime refusal (or worse, a silent no-op filter).
// @pins boot-and-launchers/print-mirror
test('the real harness manifest matches the shape the print filter expects', () => {
  const realManifest = JSON.parse(readFileSync(join(harnessPackageRoot, 'package.json'), 'utf8'))
  const printManifest = buildPrintManifest(realManifest)
  expect(printManifest.pi.extensions.join('\n')).not.toContain('pi-permission-system')
  expect(printManifest.pi.extensions.join('\n')).toContain('guards')
  expect(printManifest.pi.extensions.join('\n')).toContain('pi-multi-account')
})

test('a manifest with no permission-engine entry is a stale filter, not a quiet pass', () => {
  const withoutEngine = {
    name: 'x',
    pi: { extensions: ['./extensions/guards/index.ts'] },
  }
  expect(() => buildPrintManifest(withoutEngine)).toThrow(PrintHarnessShapeError)
})

test('a manifest where the permission engine is the only extension refuses rather than launching empty', () => {
  const onlyEngine = {
    name: 'x',
    pi: { extensions: ['node_modules/@gotgenes/pi-permission-system/src/index.ts'] },
  }
  expect(() => buildPrintManifest(onlyEngine)).toThrow(PrintHarnessShapeError)
})

// @pins boot-and-launchers/print-mirror
test('materializePrintHarness writes the filtered manifest and symlinks into the real package', () => {
  const printDir = mkdtempSync(join(tmpdir(), 'enso-print-harness-test-'))
  try {
    const returned = materializePrintHarness(printDir, harnessPackageRoot, buildPrintManifest(exampleManifest))
    expect(returned).toBe(printDir)
    const written = JSON.parse(readFileSync(join(printDir, 'package.json'), 'utf8'))
    expect(JSON.stringify(written)).not.toContain('pi-permission-system')
    // Every package-root sibling is mirrored — `core` is what extensions actually import.
    for (const entry of ['extensions', 'core', 'skills', 'prompts', 'themes', 'node_modules']) {
      const target = readlinkSync(join(printDir, entry))
      expect(resolve(printDir, target)).toBe(join(harnessPackageRoot, entry))
    }
    // Idempotent: a second materialize over existing links must not throw.
    materializePrintHarness(printDir, harnessPackageRoot, buildPrintManifest(exampleManifest))
    // Self-healing the other way: an entry the harness no longer has is removed, so pi
    // cannot silently skip a dead link.
    symlinkSync('/nowhere-real', join(printDir, 'renamed-away'), 'dir')
    materializePrintHarness(printDir, harnessPackageRoot, buildPrintManifest(exampleManifest))
    expect(existsSync(join(printDir, 'renamed-away'))).toBe(false)
    expect(() => readlinkSync(join(printDir, 'renamed-away'))).toThrow()
  } finally {
    rmSync(printDir, { recursive: true, force: true })
  }
})
