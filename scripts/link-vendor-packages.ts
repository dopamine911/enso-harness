#!/usr/bin/env bun
/**
 * Ensure the vendor pi packages exist inside the harness package's own node_modules.
 *
 * WHY THIS EXISTS
 * pi requires a package to reference bundled pi packages through `node_modules/` paths
 * relative to its own root (docs/packages.md § Dependencies), and a published tarball
 * built from `bundledDependencies` has exactly that layout.
 *
 * ⚠ WHAT THE INSTALLER PROVIDES CHANGED WITH #30, so this script is verify-or-fix:
 *
 *   bun (current)  bun's isolated linker puts a symlink for every workspace dependency in
 *                  the workspace's OWN node_modules (→ the `.bun` store), so the layout pi
 *                  needs exists NATIVELY after `bun install` and the loop below verifies
 *                  it and links nothing.
 *   npm (history)  npm hoisted workspace dependencies to the repo root and left
 *                  `packages/harness/node_modules` empty — the fallback branch below (link
 *                  the hoisted copy into place) was the script's whole job then, and it is
 *                  KEPT because a bunfig `linker = "hoisted"` (or a future bun default
 *                  flip) reproduces the npm shape. npm's `install-strategy=nested` did NOT
 *                  avoid the need — tested 2026-09-03; hoisting ignored the strategy.
 *
 * It runs from the root `postinstall` (wired for real with #30 — the claim predated the
 * wiring), so a clean clone plus `bun install` is enough — nothing here is manual. The
 * server's own `assertVendorLinks` re-checks the effective layout at startup either way.
 *
 * Symlinks, not copies: `pi update` and `bun install` stay authoritative over the real
 * package, and there is no second copy to go stale.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { findRepoRoot, harnessPackageDir } from '../packages/core/src/paths.ts'
import { vendorPackageNames } from '../packages/core/src/pi-manifest.ts'

/** A package manifest, as much of one as this script reads. */
interface PackageManifest {
  readonly dependencies?: Record<string, string>
  readonly pi?: Record<string, unknown>
}

/**
 * Every package that must exist inside the harness package's own node_modules.
 *
 * Two sources, and both are needed:
 *
 *  1. the packages the manifest's `node_modules/…` resource paths reach into — pi reads
 *     those as literal paths relative to the package root, so a missing one is a silently
 *     skipped resource. That reading is `@zen/core/pi-manifest`'s since #221, prefix and
 *     scope-splitting included; this script no longer spells either.
 *  2. EVERY entry in `dependencies` — because pi loads packages with separate module roots,
 *     so a bare `import "@zen/core"` from an extension is not guaranteed to resolve by
 *     walking up to the repo root the way plain Node would. ⚠ This is the case that made
 *     the list insufficient: `@zen/core` appears nowhere in the manifest paths, only as an
 *     import in the source, so a manifest-only sweep left it unlinked and the extension
 *     failed at load rather than at typecheck.
 */
export function requiredPackageNames(manifest: PackageManifest): string[] {
  return [...new Set([...Object.keys(manifest.dependencies ?? {}), ...vendorPackageNames(manifest)])]
}

/**
 * Point `linkPath` at `targetPath` as a RELATIVE directory symlink, replacing whatever is
 * there (#267). Two scripts enforce the boot invariants that rest on this idiom — this one
 * (invariant 5, the vendor layout pi resolves through) and `print-harness.ts` (invariant 4,
 * the variant package's mirror) — and both had it written out, so a correction reached one.
 *
 * ⚠ `lstat`, not `exists`: a BROKEN symlink must be replaced, and `existsSync` follows links,
 * so it reports a dangling one as absent and the `symlinkSync` below then fails EEXIST.
 * Relative, so the link survives a move of the tree that holds both ends.
 */
export function relinkDirectory(linkPath: string, targetPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    lstatSync(linkPath)
    rmSync(linkPath, { recursive: true, force: true })
  } catch {
    // nothing there yet
  }
  symlinkSync(relative(dirname(linkPath), targetPath), linkPath, 'dir')
}

/**
 * Verify-or-fix: every required package is reachable at `<packageRoot>/node_modules/<name>`,
 * linked from the repo root's hoisted copy when it is not. A package at neither is an
 * error naming it — the caller decides whether that ends the process.
 */
export function linkVendorPackages(
  repoRoot: string,
  packageRoot: string,
  manifest: PackageManifest,
): { verified: string[]; linked: string[] } {
  const verified: string[] = []
  const linked: string[] = []
  for (const packageName of requiredPackageNames(manifest)) {
    const target = join(packageRoot, 'node_modules', packageName)
    // existsSync FOLLOWS symlinks, so a bun-made link into the `.bun` store passes here
    // while a broken link falls through to the fix branch below.
    if (existsSync(target)) {
      verified.push(packageName)
      continue
    }
    const hoisted = join(repoRoot, 'node_modules', packageName)
    if (!existsSync(hoisted)) {
      throw new Error(
        `link-vendor-packages: ${packageName} is at neither ${target} nor the repo root — run bun install`,
      )
    }
    relinkDirectory(target, hoisted)
    linked.push(packageName)
  }
  return { verified, linked }
}

if (import.meta.main) {
  const repoRoot = findRepoRoot(import.meta.url)
  const packageRoot = harnessPackageDir(repoRoot)
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  let outcome: { verified: string[]; linked: string[] }
  try {
    outcome = linkVendorPackages(repoRoot, packageRoot, manifest)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
  process.stderr.write(
    `link-vendor-packages: ${outcome.verified.length} already in place (${outcome.verified.join(', ') || 'none'}); ` +
      `linked ${outcome.linked.length} (${outcome.linked.join(', ') || 'none'})\n`,
  )
}
