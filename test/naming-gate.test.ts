import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The naming gate's exemption for externally-fixed KEYS (#82, PR #83 review).
 *
 * ⚠ `is_external_contract_key` in `.biome/naming.grit` replaced two per-line suppressions,
 * so it is now load-bearing in a way the old comments were not: it is the only thing keeping
 * `v` (TanStack's interruptBinding stamp) and `dir` (Bun.serve's static-route option bag)
 * spellable. The failure mode to defend against is someone "simplifying" it into
 * `is_allowlisted`, which exempts EVERY tier — `const dir = …` would silently become legal
 * across the codebase and nothing would say so. The repo has no grit harness, so the gate's
 * behaviour is asserted by running Biome itself.
 */

const repositoryRoot = join(import.meta.dir, '..')
const biomeBinary = join(repositoryRoot, 'node_modules', '.bin', 'biome')

/**
 * Lints one fixture through the REPO's config and returns the 1-based line numbers at which
 * the NAMING PLUGIN reported — not any other rule.
 *
 * ⚠ The fixture lives outside the repo tree on purpose. A temp file written under
 * `packages/` would be visible to the other source-walking tests (the coverage manifest, the
 * duplicate-shape gate) while it existed, and bun runs test files concurrently — that is a
 * flake waiting to happen. `--config-path` gives an out-of-tree file the repo's rules, and
 * the plugin override's `**` include still matches it.
 *
 * Positions, not message text (PR #83 review): the diagnostic wording is ours, in
 * `naming.grit`, and a `not.toContain` on a reworded message would go silently green rather
 * than red. Scoping to the `plugin` category also ignores unrelated rules (`useExplicitType`
 * and the like) that may legitimately land on the same lines.
 */
function namingGateLines(source: string): number[] {
  const directory = mkdtempSync(join(tmpdir(), 'zen-naming-gate-'))
  try {
    const fixture = join(directory, 'fixture.ts')
    writeFileSync(fixture, source)
    const linted = Bun.spawnSync([biomeBinary, 'check', `--config-path=${repositoryRoot}`, fixture])
    const report = `${linted.stdout.toString()}${linted.stderr.toString()}`
    // Biome heads each diagnostic with `<path>:<line>:<column> <category>`.
    const flagged = new Set<number>()
    for (const match of report.matchAll(/fixture\.ts:(\d+):\d+ plugin\b/g)) flagged.add(Number(match[1]))
    return [...flagged].sort((left, right) => left - right)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('⚠ the externally-fixed names are exempt as KEYS but still refused as BINDINGS', () => {
  const flagged = namingGateLines(
    ['export const stamp = { v: 1, dir: "static" };', 'export const v = 1;', 'export const dir = "static";', ''].join(
      '\n',
    ),
  )
  // Line 1 holds the two exempted keys — the wire/API shapes we owe their spelling to — and
  // must be clean. Lines 2 and 3 hold the SAME words as our own bindings and must both be
  // flagged: that is the split, and it is what breaks if the predicate is ever folded into
  // `is_allowlisted`.
  expect(flagged).toEqual([2, 3])
})

// ── the exemption's blast radius, pinned ──────────────────────────────────────
// The suppressions this replaced were scoped to one line each; a predicate keyed on the NAME
// is broader, so the call sites are pinned here instead. A third `{ dir: … }` in first-party
// code is a design question — whether we really owe that spelling to something external —
// and it should surface as a failing gate, not pass silently.
//
// Only property keys can slip through: `v` and `dir` as BINDINGS are still refused by the
// tiers asserted above, so they cannot legally exist as identifiers to be mistaken for keys.

// Alphabetical, because the comparison below sorts what it finds: what is asserted is
// MEMBERSHIP, not order — `readdirSync` order is filesystem-defined and not stable across
// runners (PR #83 review).
const EXEMPTED_KEY_SITES = [
  // Bun.serve's static directory-route option bag.
  'packages/web/src/server/dev-web.ts',
  // (TanStack's `tanstack:interruptBinding` stamp was the second site until #112 retired
  // the run path; the wire carries no interrupts.)
] as const
const SCANNED_ROOTS = ['packages', 'scripts'] as const
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-types', 'coverage'])
const SOURCE_EXTENSION = /\.(?:tsx?|mjs|cjs)$/
/** `v:` / `dir:` as a property key — not preceded by a word character or a dot. */
const EXEMPTED_KEY = /(?:^|[^A-Za-z0-9_$.])(?:v|dir)\s*:/

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(dirent.name)) continue
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) found.push(...sourceFiles(path))
    else if (SOURCE_EXTENSION.test(dirent.name)) found.push(path)
  }
  return found
}

test('⚠ only the documented site relies on the key exemption', () => {
  const relyingFiles = new Set<string>()
  for (const root of SCANNED_ROOTS) {
    for (const path of sourceFiles(join(repositoryRoot, root))) {
      const repositoryRelative = path.slice(repositoryRoot.length + 1)
      // Tests are excluded from the plugin entirely, so their fixtures rely on nothing.
      if (repositoryRelative.includes('.test.')) continue
      if (EXEMPTED_KEY.test(readFileSync(path, 'utf8'))) relyingFiles.add(repositoryRelative)
    }
  }
  // Named, not counted, so a failure says which file to open. Compared as a sorted SET of
  // files: the receipt is per file (a second wire key in an already-receipted file is the
  // same contract, not a new site), and `readdirSync` order is not something to assert on.
  expect([...relyingFiles].sort()).toEqual([...EXEMPTED_KEY_SITES])
})
