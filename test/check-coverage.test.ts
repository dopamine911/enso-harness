import { expect, test } from "bun:test";
import { summarizeLcov } from "../scripts/check-coverage.ts";

/**
 * The coverage GATE's own arithmetic (#53 S2). Before this file the gate's parser had no
 * test: swapping `linesHit` and `linesFound` produced a rate above 1 and the floor check
 * still passed. The fixtures below use unequal, asymmetric numbers so every swap or
 * misread field lands on a different value.
 */

const TWO_FILE_REPORT = [
	"SF:/repo/a.ts",
	"FNF:4",
	"FNH:3",
	"LF:100",
	"LH:60",
	"end_of_record",
	"SF:/repo/b.ts",
	"FNF:6",
	"FNH:2",
	"LF:50",
	"LH:30",
	"end_of_record",
	"",
].join("\n");

test("sums LF/LH and FNF/FNH across files — exact rates, not just ≤ 1", () => {
	const totals = summarizeLcov(TWO_FILE_REPORT);
	expect(totals.fileCount).toBe(2);
	// (60 + 30) / (100 + 50); swapping hit/found would give 1.6667.
	expect(totals.lineRate).toBeCloseTo(0.6, 10);
	// (3 + 2) / (4 + 6); reading FNF as FNH would give 1.
	expect(totals.functionRate).toBeCloseTo(0.5, 10);
});

test("an empty report throws — no data must never read as no problem", () => {
	expect(() => summarizeLcov("")).toThrow(/empty/);
	// Files listed but no line records is equally "did not run".
	expect(() => summarizeLcov("SF:/repo/a.ts\nend_of_record\n")).toThrow(/empty/);
});

test("a report with lines but no functions counts functions as fully covered, not as a division by zero", () => {
	const totals = summarizeLcov("SF:/repo/only-constants.ts\nLF:10\nLH:7\nend_of_record\n");
	expect(totals.functionRate).toBe(1);
	expect(totals.lineRate).toBeCloseTo(0.7, 10);
});
