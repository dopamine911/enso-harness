import { expect, test } from 'bun:test'
import {
  isTestFilePath,
  MINIMUM_REPORTED_FILES,
  partialReportComplaint,
  summarizeLcov,
  TOTAL_FUNCTION_COVERAGE_FLOOR,
  TOTAL_LINE_COVERAGE_FLOOR,
} from '../scripts/check-coverage.ts'

/**
 * The coverage GATE's own arithmetic (#53 S2). Before this file the gate's parser had no
 * test: swapping `linesHit` and `linesFound` produced a rate above 1 and the floor check
 * still passed. The fixtures below use unequal, asymmetric numbers so every swap or
 * misread field lands on a different value.
 */

const TWO_FILE_REPORT = [
  'SF:/repo/a.ts',
  'FNF:4',
  'FNH:3',
  'LF:100',
  'LH:60',
  'end_of_record',
  'SF:/repo/b.ts',
  'FNF:6',
  'FNH:2',
  'LF:50',
  'LH:30',
  'end_of_record',
  '',
].join('\n')

/**
 * #234's receipt, in the shape it was measured: `bun test test/vendor-gate.test.ts
 * test/no-lint-suppressions.test.ts test/code-offenders.test.ts` left exactly these two
 * records behind in `coverage/lcov.info`, every line hit.
 */
const SCOPED_RUN_REPORT = [
  'SF:scripts/source-tree.ts',
  'FNF:2',
  'FNH:2',
  'LF:20',
  'LH:20',
  'end_of_record',
  'SF:test/gate-support.ts',
  'FNF:3',
  'FNH:3',
  'LF:30',
  'LH:30',
  'end_of_record',
  '',
].join('\n')

test('sums LF/LH and FNF/FNH across files — exact rates, not just ≤ 1', () => {
  const totals = summarizeLcov(TWO_FILE_REPORT)
  expect(totals.fileCount).toBe(2)
  // (60 + 30) / (100 + 50); swapping hit/found would give 1.6667.
  expect(totals.lineRate).toBeCloseTo(0.6, 10)
  // (3 + 2) / (4 + 6); reading FNF as FNH would give 1.
  expect(totals.functionRate).toBeCloseTo(0.5, 10)
})

// ⚠ TEST FILES (#838): bun measures them now, and each runs almost whole. Placed BETWEEN the two
// counted records, so a parser that stops counting after one or never resumes lands elsewhere.
test('a test file record is skipped whole: the totals and the count are the other records alone', () => {
  const [first = '', second = ''] = TWO_FILE_REPORT.split('end_of_record\n')
  const withTestFile =
    `${first}end_of_record\n` +
    'SF:packages/core/src/__tests__/paths.test.ts\nFNF:40\nFNH:40\nLF:900\nLH:900\nend_of_record\n' +
    `${second}end_of_record\n`
  expect(summarizeLcov(withTestFile)).toEqual(summarizeLcov(TWO_FILE_REPORT))
})

test("a test file is what bun's runner names one; a helper beside the tests stays counted", () => {
  for (const path of [
    'test/check-coverage.test.ts',
    'packages/web/src/__tests__/app.test.tsx',
    'a/b_test.js',
    'x.spec.mts',
  ]) {
    expect(isTestFilePath(path)).toBe(true)
  }
  for (const path of [
    'packages/core/src/__tests__/log-recorder.ts',
    'test/gate-support.ts',
    'packages/core/src/test-results.ts',
    'packages/core/src/latest.ts',
  ]) {
    expect(isTestFilePath(path)).toBe(false)
  }
})

test('an empty report throws — no data must never read as no problem', () => {
  expect(() => summarizeLcov('')).toThrow(/empty/)
  // Files listed but no line records is equally "did not run".
  expect(() => summarizeLcov('SF:/repo/a.ts\nend_of_record\n')).toThrow(/empty/)
})

// ⚠ THE PARTIAL REPORT (#234). `coverage = true` is global, so any targeted run overwrites the
// report the gate reads, and a report over two well-covered files clears the floors and reads as
// repository green. The refusal is on SIZE, so it has to fire on exactly the report the rates
// would have waved through — that pairing is the whole finding.
test('⚠ a report too small to be the whole suite is refused however good its rates', () => {
  const totals = summarizeLcov(SCOPED_RUN_REPORT)
  expect(totals.lineRate).toBeGreaterThanOrEqual(TOTAL_LINE_COVERAGE_FLOOR)
  expect(totals.functionRate).toBeGreaterThanOrEqual(TOTAL_FUNCTION_COVERAGE_FLOOR)
  expect(partialReportComplaint(totals.fileCount)).toContain('NOT the whole suite')
  // The boundary, both sides — one record short is refused, the minimum itself is accepted.
  expect(partialReportComplaint(MINIMUM_REPORTED_FILES - 1)).toContain('NOT the whole suite')
  expect(partialReportComplaint(MINIMUM_REPORTED_FILES)).toBeUndefined()
})

test('a report with lines but no functions counts functions as fully covered, not as a division by zero', () => {
  const totals = summarizeLcov('SF:/repo/only-constants.ts\nLF:10\nLH:7\nend_of_record\n')
  expect(totals.functionRate).toBe(1)
  expect(totals.lineRate).toBeCloseTo(0.7, 10)
})
