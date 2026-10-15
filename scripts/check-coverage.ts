#!/usr/bin/env bun
/**
 * The TOTAL coverage floor — the gate that bunfig.toml cannot express.
 *
 * ⚠ WHY THIS SCRIPT EXISTS. bun 1.4.0's `coverageThreshold` is enforced PER FILE, not on
 * the total (measured 2026-09-04: with the worst file at 23.65% lines and the total at
 * 86%, a 0.23 floor passed and a 0.24 floor failed; bun's docs say total). A per-file
 * floor at the level we want for the total would demand every file individually clear it.
 * So `bun test` (coverage always on, bunfig `[test]`) writes `coverage/lcov.info`, and
 * this script — the gate AFTER the test gate — computes the totals and enforces the floor.
 *
 * The floor is over the FULL denominator: test/coverage-manifest.test.ts imports every
 * library source file, so an untested module counts as 0% here instead of vanishing from
 * the report (bun measures only imported files). Bun reports functions and lines only —
 * no branch coverage; that gap is bun's reporter, stated rather than hidden.
 *
 * ⚠ The floors are against LCOV's accounting, which is stricter than bun's text table
 * (measured 2026-09-04 over the same 29 files: lcov 73.38% lines / 84.52% functions, text
 * table 86.58% / 85.57% — the table flatters line counts). Floored a margin under the lcov
 * measurement. The main line-coverage debt is chat-screen.tsx (the UI components have live
 * receipts, no unit renders). Ratchet UP as coverage grows; never down without its own PR.
 *
 * Ratchet 2026-09-05 (#49 first pass, 56 files): lcov 86.33% lines / 87.47% functions after
 * the dialog components gained static renders (chat-screen.tsx 14.89% → 40.89% lines).
 * Same margin as the original: ~2.5 points under the measurement, rounded down.
 * ⓘ Functions DIPPED from 88.00% on main while lines rose: bun counts a function only once
 * the code that declares it has run, so rendering the components materialised their
 * inline onClick handlers (chat-screen FNF 9 → 16, FNH 0 → 4) without any click hitting
 * them. The function metric is soft on this repo for exactly that reason; lines carry the
 * gate.
 *
 * Ratchet 2026-09-09 (#118, 75 files): lcov 94.27% lines / 91.91% functions after the pane
 * mounted under a DOM over the scripted server (chat-screen.tsx 69.6% → 97.7% lines, 54% →
 * 87.5% functions — the handlers the static renders materialised now actually run). Same
 * margin: ~2.5 points under, rounded down.
 *
 * ⚠ THE REPORT MUST BE THE WHOLE SUITE'S (#234). `coverage = true` is global and `coverageDir`
 * is fixed, so ANY targeted run — `bun test test/docs-gate.test.ts`, one package's file —
 * overwrites `coverage/lcov.info`, and this script would then pass a repository verdict over
 * whatever was left behind. Measured 2026-09-18 on this tree: the two-file report three scoped
 * gate files leave behind read 100.00% lines / 100.00% functions and PASSED; the first 20
 * records of the full report read 99.65% / 96.04% and passed. Both are green over a fraction of
 * the code, printing the same sentence they print for the whole suite. So size is a gate too —
 * see `MINIMUM_REPORTED_FILES`.
 *
 * ⚠ TEST FILES ARE IN THE REPORT, NOT IN THE FLOOR (#838). bunfig's `coverageSkipTestFiles = false`
 * makes Bun measure every `*.test.ts(x)` too, so fallow scores the CRAP of test code from
 * measured coverage rather than its estimate. A test file runs almost whole whenever it runs,
 * so counting it would raise both rates and the record count without one more line of product
 * code covered. `summarizeLcov` skips exactly the records Bun's default skipped
 * (`isTestFilePath`); the floor's denominator is the one it was before test files were measured.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../packages/core/src/paths.ts'

export const TOTAL_LINE_COVERAGE_FLOOR = 0.91
export const TOTAL_FUNCTION_COVERAGE_FLOOR = 0.89

/**
 * The fewest file records a whole-suite report can hold. Measured 2026-09-18: the full suite
 * writes 99 — the 84 owned library sources, every one of them, because
 * `test/coverage-manifest.test.ts` imports the lot, plus the test doubles and scripts that ran.
 * Floored ~10% under those 84 on the same convention as the rate floors above: deleting a
 * module is not a red, while both partial reports measured in #234 (2 and 20 records) are.
 * `test/coverage-manifest.test.ts` pins this between the denominator it walks and 80% of it, so
 * it can neither overshoot into a spurious red nor rot into vacuity as the tree grows.
 *
 * Re-measured 2026-09-22 (#144 slices 2–3, 95 owned sources after the debug page's seven
 * modules): the manifest's 80% bound asked for 76, so the same ~10%-under convention gives 85.
 *
 * Re-measured 2026-09-23 (#45: session usage, branch stats, the thread stats route, the drawer
 * and the stats table it shares with the day's page — about 110 owned sources): the 80% bound
 * asks for 88, and ~10% under gives 99.
 *
 * Re-measured 2026-09-24 (#361: the Context view's host walk, its elements, its routes, its
 * browser — 125 owned sources): the 80% bound asks for 100, and ~10% under gives 112.
 *
 * Re-measured 2026-09-25 (#395: the project registry, the listing store the rail's two lists
 * share, the project list — 143 owned sources): the 80% bound asks for 114, and ~10% under gives 128.
 *
 * Re-measured 2026-09-29 (#441: the session eval in core, its host walk, its route and the shared
 * log-day reader — 163 owned sources): the 80% bound asks for 130, and ~10% under gives 146.
 *
 * Re-measured 2026-09-29 again (#443's prompt library, #446's permission rules, #348's re-read
 * after a compaction — 184 owned sources): the 80% bound asks for 147, and ~10% under gives 165.
 *
 * Re-measured 2026-09-30 (#552's project folders, #557's one envelope decoder, #551's snapshot
 * store and thread trees — 209 owned sources): the 80% bound asks for 167, and ~10% under gives 188.
 *
 * Re-measured 2026-10-09 (#739's session-file index, transcript selection and window, day-file
 * fold — 239 owned sources): the 80% bound asks for 191, and ~10% under gives 215.
 *
 * Re-measured for #810 (the server's route groups, on top of #801's host modules — 272 owned
 * sources): the 80% bound asks for 217, and ~10% under gives 245.
 *
 * Re-measured 2026-10-15 (#553's prompt runs and Diff Viewer merged with #970's permission rules
 * and #976's tool views — 312 owned sources): the 80% bound asks for 249, and ~10% under gives 281.
 *
 * Re-measured 2026-10-15 again (#919's health checks, fault banner and draft-keeping reload merged
 * onto that — 318 owned sources): the 80% bound asks for 254, so 281 still holds.
 *
 * Re-measured 2026-10-15 for #904 (providers, roles and the models routes, merged with #977's
 * config approvals, #934's projects settings and the live-page stack #980–#998 — 342 owned
 * sources): the 80% bound asks for 273, and ~10% under gives 308.
 */
export const MINIMUM_REPORTED_FILES = 308

const LCOV_PATH = join(findRepoRoot(import.meta.url), 'coverage', 'lcov.info')

/**
 * A test file as Bun's runner names one (`*.test.ts`, `*_test.tsx`, `*.spec.js`, …): the files
 * `coverageSkipTestFiles` leaves out by default, so the records the floor never counted (#838).
 * Helpers beside the tests (`packages/test-support/src/log-recorder.ts`, `test/gate-support.ts`) are not test
 * files by this rule and stay counted, as they always were.
 */
export function isTestFilePath(path: string): boolean {
  return /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

export interface CoverageTotals {
  lineRate: number
  functionRate: number
  fileCount: number
}

/**
 * Sum an lcov report's LF/LH (lines found/hit) and FNF/FNH (functions found/hit) records over its
 * non-test files (`isTestFilePath`). Throws on an empty report — zero files means the tests did not
 * run or wrote elsewhere, and "no data" must never read as "no problem".
 */
export function summarizeLcov(lcovText: string): CoverageTotals {
  let linesFound = 0
  let linesHit = 0
  let functionsFound = 0
  let functionsHit = 0
  let fileCount = 0
  let counted = false
  for (const line of lcovText.split('\n')) {
    if (line.startsWith('SF:')) {
      counted = !isTestFilePath(line.slice(3))
      if (counted) fileCount += 1
    } else if (!counted) continue
    else if (line.startsWith('LF:')) linesFound += Number(line.slice(3))
    else if (line.startsWith('LH:')) linesHit += Number(line.slice(3))
    else if (line.startsWith('FNF:')) functionsFound += Number(line.slice(4))
    else if (line.startsWith('FNH:')) functionsHit += Number(line.slice(4))
  }
  if (fileCount === 0 || linesFound === 0) {
    throw new Error('check-coverage: the lcov report is empty — did `bun test` run with coverage on?')
  }
  return {
    lineRate: linesHit / linesFound,
    // A report with no functions at all would divide by zero; treat it as fully covered
    // rather than crashing — lines are the load-bearing metric in that degenerate case.
    functionRate: functionsFound === 0 ? 1 : functionsHit / functionsFound,
    fileCount,
  }
}

/**
 * Why this report cannot be the whole suite's, or `undefined` when its size says it can be.
 * Separate from the rates on purpose: a partial report's arithmetic is fine and says nothing
 * about the repository, which is exactly how a two-file 100% report reads as green.
 */
export function partialReportComplaint(fileCount: number): string | undefined {
  if (fileCount >= MINIMUM_REPORTED_FILES) return undefined
  return (
    `check-coverage: ${fileCount} file records, fewer than the ${MINIMUM_REPORTED_FILES} a whole-suite ` +
    `report holds — this is NOT the whole suite's report, so the floors above mean nothing. A targeted ` +
    `\`bun test <file>\` overwrites coverage/lcov.info with a partial one; run \`bun test\` (\`bun run check\` ` +
    `does) and measure again.\n`
  )
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`
}

// Gate body — runs only when executed directly, so tests can import summarizeLcov alone.
if (import.meta.main) {
  if (!existsSync(LCOV_PATH)) {
    process.stderr.write(`check-coverage: ${LCOV_PATH} is missing — run \`bun test\` first (the gate does).\n`)
    process.exit(1)
  }
  const totals = summarizeLcov(await Bun.file(LCOV_PATH).text())
  process.stderr.write(
    `check-coverage: ${totals.fileCount} files — lines ${formatPercent(totals.lineRate)} ` +
      `(floor ${formatPercent(TOTAL_LINE_COVERAGE_FLOOR)}), functions ${formatPercent(totals.functionRate)} ` +
      `(floor ${formatPercent(TOTAL_FUNCTION_COVERAGE_FLOOR)})\n`,
  )
  // Size before rates: a verdict over a fraction of the suite is not a verdict.
  const complaint = partialReportComplaint(totals.fileCount)
  if (complaint !== undefined) {
    process.stderr.write(complaint)
    process.exit(1)
  }
  if (!(totals.lineRate >= TOTAL_LINE_COVERAGE_FLOOR && totals.functionRate >= TOTAL_FUNCTION_COVERAGE_FLOOR)) {
    process.stderr.write(
      'check-coverage: BELOW the floor. Add tests, or lower the floor in its own PR with the reason.\n',
    )
    process.exit(1)
  }
}
