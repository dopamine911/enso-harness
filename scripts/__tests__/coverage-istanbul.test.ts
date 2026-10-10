import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { istanbulFileCoverage, parseLcov } from '../coverage-istanbul.ts'

/**
 * The LCOV → Istanbul mapping fallow scores CRAP from (#826). fallow matches an `(anonymous_N)`
 * entry to its own function by start position and scores the share of hit statements inside the
 * entry's span, so the positions and spans are what this pins.
 */

const SOURCE = [
  'export function doubled(values: number[]): number[] {',
  '  return values.map((value) => value * 2)',
  '}',
  '',
  'class Counter {',
  '  count(): number {',
  '    return 1',
  '  }',
  '}',
  '',
  'const never = (): number => {',
  '  return 0',
  '}',
  '',
  'const unlisted = (): void => {}',
].join('\n')

const LCOV = [
  'TN:',
  'SF:fixture.ts',
  'FNF:0',
  'FNH:0',
  'DA:1,3',
  'DA:2,3',
  'DA:6,0',
  'DA:7,0',
  'DA:11,1',
  'DA:12,0',
  'end_of_record',
  'SF:types.ts',
  'end_of_record',
  '',
].join('\n')

interface Span {
  readonly start: { readonly line: number; readonly column: number }
  readonly end: { readonly line: number; readonly column: number }
}

const at = (startLine: number, startColumn: number, endLine: number, endColumn: number): Span => ({
  start: { line: startLine, column: startColumn },
  end: { line: endLine, column: endColumn },
})

test('parseLcov keeps each record’s DA hits by line, and a record with none', () => {
  const [fixture, types] = parseLcov(LCOV)
  expect(fixture?.path).toBe('fixture.ts')
  expect([...(fixture?.lines ?? [])]).toEqual([
    [1, 3],
    [2, 3],
    [6, 0],
    [7, 0],
    [11, 1],
    [12, 0],
  ])
  expect(types).toEqual({ path: 'types.ts', lines: new Map() })
})

test('one statement per DA line from its first non-blank character; one anonymous function per AST span, counted from its first DA line', () => {
  const lines = parseLcov(LCOV)[0]?.lines ?? new Map<number, number>()
  const coverage = istanbulFileCoverage('/repo/fixture.ts', SOURCE, lines)
  expect(coverage.path).toBe('/repo/fixture.ts')
  expect(coverage.statementMap).toEqual({
    0: at(1, 0, 1, 53),
    1: at(2, 2, 2, 41),
    2: at(6, 2, 6, 19),
    3: at(7, 4, 7, 12),
    4: at(11, 0, 11, 29),
    5: at(12, 2, 12, 10),
  })
  expect(coverage.s).toEqual({ 0: 3, 1: 3, 2: 0, 3: 0, 4: 1, 5: 0 })
  expect(coverage.fnMap).toEqual({
    // The span starts at `export`, so the declaration line's statement lies inside it.
    0: { name: '(anonymous_0)', decl: at(1, 16, 1, 23), loc: at(1, 0, 3, 1), line: 1 },
    // A one-line callback holds no whole statement: fallow scores it from `f`, its line's count.
    1: { name: '(anonymous_1)', decl: at(2, 20, 2, 40), loc: at(2, 20, 2, 40), line: 2 },
    2: { name: '(anonymous_2)', decl: at(6, 2, 6, 7), loc: at(6, 2, 8, 3), line: 6 },
    // `const never =` ran when the module loaded; the body's statement, the one inside the span, did not.
    3: { name: '(anonymous_3)', decl: at(11, 14, 13, 1), loc: at(11, 14, 13, 1), line: 11 },
  })
  // `unlisted` has no DA line, so it has no entry and fallow keeps its estimate.
  expect(coverage.f).toEqual({ 0: 3, 1: 3, 2: 0, 3: 1 })
  expect(coverage.branchMap).toEqual({})
})

/** One CRAP finding as fallow 3.33's health JSON reports it; only the fields this test reads. */
interface CrapFinding {
  readonly name: string
  readonly cyclomatic: number
  readonly crap: number
  readonly coverageSource: unknown
}

/** One element of fallow's `findings`, read checked: undefined when it lacks the fields. */
function crapFindingOf(value: unknown): CrapFinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('name' in value) || !('cyclomatic' in value) || !('crap' in value)) return undefined
  const { name, cyclomatic, crap } = value
  if (typeof name !== 'string' || typeof cyclomatic !== 'number' || typeof crap !== 'number') return undefined
  return { name, cyclomatic, crap, coverageSource: 'coverage_source' in value ? value.coverage_source : undefined }
}

/** Every readable CRAP finding in fallow's health JSON. */
function crapFindingsOf(output: unknown): CrapFinding[] {
  if (typeof output !== 'object' || output === null || !('findings' in output)) return []
  return Array.isArray(output.findings) ? output.findings.flatMap((value) => crapFindingOf(value) ?? []) : []
}

const SIGN_SOURCE = [
  'export function sign(value: number): number {',
  '  if (value > 0) return 1',
  '  if (value < 0) return -1',
  '  return 0',
  '}',
  '',
  'export function parity(value: number): string {',
  '  if (value % 2 === 0) return "even"',
  '  return "odd"',
  '}',
].join('\n')

test('⚠ the installed fallow scores CRAP from the map: an unrun function as uncovered, a fully run one at its cyclomatic (#826)', () => {
  // ⚠ The contract with fallow itself: it matches `(anonymous_N)` entries by position and marks
  // what it scored from the map `coverage_source: "istanbul"`. If a fallow upgrade changes either,
  // `health:full` would silently report nothing measured; this fails instead.
  const project = mkdtempSync(join(tmpdir(), 'coverage-istanbul-fallow-'))
  try {
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
    const sourcePath = join(project, 'src', 'sign.ts')
    writeFileSync(sourcePath, SIGN_SOURCE)
    // `sign` never ran (every line 0); `parity` ran every line.
    const lines = new Map([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [7, 4],
      [8, 4],
      [9, 2],
    ])
    const map = join(project, 'coverage-final.json')
    writeFileSync(map, JSON.stringify({ [sourcePath]: istanbulFileCoverage(sourcePath, SIGN_SOURCE, lines) }))
    const fallow = join(findRepoRoot(import.meta.url), 'node_modules', '.bin', 'fallow')
    const run = Bun.spawnSync([fallow, 'health', '--coverage', map, '--max-crap', '1', '--format', 'json', '--quiet'], {
      cwd: project,
    })
    // fallow exits 1 when it reports findings, which this test needs; 2 is fallow itself failing.
    if (run.exitCode === 2) throw new Error(`fallow failed: ${run.stderr.toString()}${run.stdout.toString()}`)
    const findings = crapFindingsOf(JSON.parse(run.stdout.toString()))
    const sign = findings.find((finding) => finding.name === 'sign')
    const parity = findings.find((finding) => finding.name === 'parity')
    expect(sign?.coverageSource).toBe('istanbul')
    expect(sign?.crap).toBe((sign?.cyclomatic ?? 0) ** 2 + (sign?.cyclomatic ?? 0))
    expect(parity?.coverageSource).toBe('istanbul')
    expect(parity?.crap).toBe(parity?.cyclomatic)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
