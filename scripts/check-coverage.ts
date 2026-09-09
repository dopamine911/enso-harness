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
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../packages/core/src/index.ts";

export const TOTAL_LINE_COVERAGE_FLOOR = 0.91;
export const TOTAL_FUNCTION_COVERAGE_FLOOR = 0.89;

const LCOV_PATH = join(findRepoRoot(import.meta.url), "coverage", "lcov.info");

export interface CoverageTotals {
	lineRate: number;
	functionRate: number;
	fileCount: number;
}

/**
 * Sum an lcov report's LF/LH (lines found/hit) and FNF/FNH (functions found/hit) records.
 * Throws on an empty report — zero files means the tests did not run or wrote elsewhere,
 * and "no data" must never read as "no problem".
 */
export function summarizeLcov(lcovText: string): CoverageTotals {
	let linesFound = 0;
	let linesHit = 0;
	let functionsFound = 0;
	let functionsHit = 0;
	let fileCount = 0;
	for (const line of lcovText.split("\n")) {
		if (line.startsWith("SF:")) fileCount += 1;
		else if (line.startsWith("LF:")) linesFound += Number(line.slice(3));
		else if (line.startsWith("LH:")) linesHit += Number(line.slice(3));
		else if (line.startsWith("FNF:")) functionsFound += Number(line.slice(4));
		else if (line.startsWith("FNH:")) functionsHit += Number(line.slice(4));
	}
	if (fileCount === 0 || linesFound === 0) {
		throw new Error("check-coverage: the lcov report is empty — did `bun test` run with coverage on?");
	}
	return {
		lineRate: linesHit / linesFound,
		// A report with no functions at all would divide by zero; treat it as fully covered
		// rather than crashing — lines are the load-bearing metric in that degenerate case.
		functionRate: functionsFound === 0 ? 1 : functionsHit / functionsFound,
		fileCount,
	};
}

function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(2)}%`;
}

// Gate body — runs only when executed directly, so tests can import summarizeLcov alone.
if (import.meta.main) {
	if (!existsSync(LCOV_PATH)) {
		console.error(`check-coverage: ${LCOV_PATH} is missing — run \`bun test\` first (the gate does).`);
		process.exit(1);
	}
	const totals = summarizeLcov(await Bun.file(LCOV_PATH).text());
	const lineOk = totals.lineRate >= TOTAL_LINE_COVERAGE_FLOOR;
	const functionOk = totals.functionRate >= TOTAL_FUNCTION_COVERAGE_FLOOR;
	console.error(
		`check-coverage: ${totals.fileCount} files — lines ${formatPercent(totals.lineRate)} ` +
			`(floor ${formatPercent(TOTAL_LINE_COVERAGE_FLOOR)}), functions ${formatPercent(totals.functionRate)} ` +
			`(floor ${formatPercent(TOTAL_FUNCTION_COVERAGE_FLOOR)})`,
	);
	if (!(lineOk && functionOk)) {
		console.error("check-coverage: BELOW the floor. Add tests, or lower the floor in its own PR with the reason.");
		process.exit(1);
	}
}
