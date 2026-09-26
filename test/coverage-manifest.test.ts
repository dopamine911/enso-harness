import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { MINIMUM_REPORTED_FILES } from '../scripts/check-coverage.ts'
import { filesUnder } from '../scripts/source-tree.ts'

/**
 * THE COVERAGE DENOMINATOR (#slop-factory port). Bun measures coverage only over files a
 * test IMPORTED — there is no `coverage.include` — so an untested module is ABSENT from
 * the table rather than counted at 0%, and the floor in bunfig.toml passes over a shrinking
 * denominator. Measured in slop-factory on bun 1.3.14: an orphan module left the total at
 * 100%. This test closes that gap by importing EVERY library source file, which puts each
 * one in the denominator; a new file joins automatically via readdir, so nothing rots.
 *
 * ⚠ The cost, stated: importing a module runs its top-level code. Every library module
 * here is import-clean (chat-screen.tsx guards its one `window` read for exactly this
 * reason). The files that are NOT import-clean are the named ENTRY_POINTS below — modules
 * whose body IS the program — and the VENDORED components, which share the linter's
 * exclusion boundary (oxlint.config.ts): upstream's code, kept diffable, not held to our coverage.
 *
 * ⚠ Each entry-point exception is asserted to EXIST, so a renamed entry fails here instead
 * of silently widening the exclusion into a dead pattern.
 */

const REPOSITORY_ROOT = resolve(import.meta.dir, '..')

/** Library roots whose every source file must enter the coverage denominator. */
const LIBRARY_SOURCE_ROOTS = [
  'packages/core/src',
  'packages/harness/core',
  'packages/harness/extensions',
  'packages/web/src',
] as const

/**
 * Modules whose top-level code IS the program — mounting the DOM app, starting the dev
 * servers. Their logic is exercised by live receipts, not unit coverage, and each is kept
 * THIN so the exclusion stays small (main.tsx's header carries that contract).
 */
const ENTRY_POINT_EXCEPTIONS = [
  'packages/web/src/main.tsx',
  'packages/web/src/debug.tsx',
  'packages/web/src/server/dev.ts',
  'packages/web/src/server/dev-web.ts',
] as const

/** Vendored code — the linter's exclusion boundary (oxlint.config.ts), applied to coverage for the same reason. */
const VENDORED_DIRECTORIES = ['packages/web/src/components'] as const
/**
 * The same list as bunfig must spell it. ONE source of truth, the way `test/fallow-config.test.ts`
 * holds the fallow entry list equal to the harness manifest.
 */
const VENDORED_IGNORE_PATTERNS = VENDORED_DIRECTORIES.map((directory) => `**/${directory}/**`)

/**
 * The denominator: every production module under the library roots — no tests, no vendored
 * components, no named entry point — over the one walker (`scripts/source-tree.ts`, #174).
 */
function collectLibrarySources(rootDirectory: string): string[] {
  return filesUnder(rootDirectory, {
    skipDirectories: ['__tests__'],
    keep: (fileName: string, absolutePath: string): boolean => {
      if (/\.test\.tsx?$/.test(fileName)) return false
      const repositoryRelative = relative(REPOSITORY_ROOT, absolutePath)
      if (VENDORED_DIRECTORIES.some((vendored) => repositoryRelative.startsWith(vendored))) return false
      return !ENTRY_POINT_EXCEPTIONS.some((entry) => repositoryRelative === entry)
    },
  })
}

test('every named entry-point exception still exists — a rename must not widen the exclusion', () => {
  for (const entryPoint of ENTRY_POINT_EXCEPTIONS) {
    expect(existsSync(join(REPOSITORY_ROOT, entryPoint))).toBe(true)
  }
})

test('every library source file is importable and enters the coverage denominator', async () => {
  const sources = LIBRARY_SOURCE_ROOTS.flatMap((root) => collectLibrarySources(join(REPOSITORY_ROOT, root)))
  // A denominator of zero would mean the roots are wrong, not that coverage is perfect.
  expect(sources.length).toBeGreaterThan(20)
  for (const sourcePath of sources) {
    // Import failures name the file — an import-unclean module must either become
    // clean or be promoted to a named entry-point exception with its reason.
    await import(sourcePath)
  }
})

// ⚠ The floor itself is code that nothing else references at build time: assert it is
// present, wired into the gate, and at least the intended level — so weakening or
// unplugging it is a red test rather than a quiet edit. (It lives in a SCRIPT rather than
// bunfig's coverageThreshold because bun 1.4 enforces that key PER FILE — measured
// 2026-09-04, docs disagree — see scripts/check-coverage.ts.)
const INTENDED_LINE_FLOOR = 0.91
const INTENDED_FUNCTION_FLOOR = 0.89

test('the total coverage floor is wired into the gate at the intended level', async () => {
  const { TOTAL_LINE_COVERAGE_FLOOR, TOTAL_FUNCTION_COVERAGE_FLOOR } = await import(
    join(REPOSITORY_ROOT, 'scripts', 'check-coverage.ts')
  )
  expect(TOTAL_LINE_COVERAGE_FLOOR).toBeGreaterThanOrEqual(INTENDED_LINE_FLOOR)
  expect(TOTAL_FUNCTION_COVERAGE_FLOOR).toBeGreaterThanOrEqual(INTENDED_FUNCTION_FLOOR)
  // The script only bites while the gate runs it — assert the wiring, not just the value.
  // ⚠ Quote-agnostic: the wiring is the gate naming that script, not which quote character the
  // formatter happens to use. A `toContain('script: "coverage:check"')` here failed the whole
  // suite the day the formatter switched to single quotes — a test pinning style, not behaviour.
  const gate = await Bun.file(join(REPOSITORY_ROOT, 'scripts', 'gate.ts')).text()
  expect(gate).toMatch(/script:\s*['"]coverage:check['"]/)
  const bunfig = await Bun.file(join(REPOSITORY_ROOT, 'bunfig.toml')).text()
  expect(bunfig).toMatch(/^coverage = true$/m)
})

// ⚠ ONE OF TWO OTHER HALVES OF THE DENOMINATOR (#252). Three things decide which files the
// floor is measured over: which files a test imports (the manifest above),
// `coveragePathIgnorePatterns`, which drops an imported file from the report anyway, and the
// report's own size (#234, below). The gate pinned only that coverage was ON, so one extra
// glob in that key lowered the floor's real bar with every gate still green and no test
// naming the change — measured 2026-09-18, adding `**/chat-screen.tsx` (the repo's largest
// single line-coverage debt) took `check-coverage` from 99 files at 93.61%/92.96% to 98 files
// at 93.74%/93.47% (lines/functions), and the whole suite stayed green. That is the back door
// on the one ratchet this repo calls unfalsifiable-by-construction, and
// `scripts/check-coverage.ts` says the floor moves in its own PR with the reason. So the
// exclusion is pinned to its EXACT value, derived from the vendored list above: widening it is
// a red test with a named diff. The key is unbounded — nothing else in the repo reads it.
test('⚠ the coverage exclusion is exactly the vendored directories — nothing else leaves the denominator', async () => {
  const bunfig = await Bun.file(join(REPOSITORY_ROOT, 'bunfig.toml')).text()
  const declared = /^coveragePathIgnorePatterns = \[([^\]]*)\]$/m.exec(bunfig)
  if (declared === null) throw new Error('bunfig.toml: coveragePathIgnorePatterns is not a single-line array')
  const patterns = [...(declared[1] ?? '').matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '')
  expect(patterns).toEqual([...VENDORED_IGNORE_PATTERNS])
})

/**
 * ⚠ THE REPORT'S SIZE is the third, and the one #234 closed: the gate refuses a report
 * holding fewer records than a whole-suite run produces, because `coverage = true` is global and
 * any targeted `bun test <file>` overwrites the report with a partial one that reads as green.
 * That minimum is a hand-set number in a script — this test is what keeps it honest against the
 * denominator this file actually walks: never above it (a full report would go red for nothing),
 * never far under it (a two-file report would sail through).
 */
const MINIMUM_REPORT_SHARE_OF_DENOMINATOR = 0.8

test("⚠ the gate's minimum report size stays under the walked denominator, and not far under", () => {
  const sources = LIBRARY_SOURCE_ROOTS.flatMap((root) => collectLibrarySources(join(REPOSITORY_ROOT, root)))
  expect(MINIMUM_REPORTED_FILES).toBeLessThanOrEqual(sources.length)
  expect(MINIMUM_REPORTED_FILES).toBeGreaterThanOrEqual(
    Math.floor(sources.length * MINIMUM_REPORT_SHARE_OF_DENOMINATOR),
  )
})
