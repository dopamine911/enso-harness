/**
 * Gate step `crap` (#844): no function at CRAP ≥ 30 outside its pin.
 *
 *   bun run crap:check      → after `bun test`: converts its LCOV, then judges
 *
 * CRAP is cyclomatic² × (1 − coverage)³ + cyclomatic, scored by fallow from MEASURED coverage:
 * `coverage/coverage-final.json`, which `scripts/coverage-istanbul.ts` writes from the LCOV `test`
 * left. The exceptions are `crap-pins.json`, one function each (file + name) at the exact score
 * fallow reports, with the reason it stays over 30. A number may go down, never up. This fails when
 *   • a function at ≥ 30 has no pin;
 *   • a pinned function scores above its pin: it got worse;
 *   • a pin is above its function's score: slack, room to grow back unnoticed — lower it;
 *   • a pin matches no function at ≥ 30: it fell under 30, or was renamed, moved or deleted —
 *     delete it.
 *
 * ⚠ Not `thresholdOverrides` in `.fallowrc.jsonc` (#844): CRAP is off there (`maxCrap: 0`, #826),
 * so both complexity steps would list every CRAP pin as `no_match` on every run; and fallow fails
 * neither a slack nor a stale pin. Only a step after `test` has the coverage to judge them.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../packages/core/src/paths.ts'
import { ISTANBUL_PATH } from './coverage-istanbul.ts'

const ROOT = findRepoRoot(import.meta.url)
const PINS_PATH = join(ROOT, 'crap-pins.json')
/** The ceiling: fallow reports a function whose CRAP meets or exceeds it. */
const CRAP_CEILING = 30

/** One function at or over the ceiling, as fallow's health JSON reports it. */
export interface CrapFinding {
  readonly path: string
  readonly name: string
  readonly line: number
  readonly crap: number
  /** False when fallow fell back to its estimate: no test loads the file. */
  readonly measured: boolean
}

/** One entry of `crap-pins.json`. */
export interface CrapPin {
  readonly path: string
  readonly function: string
  readonly crap: number
  readonly reason: string
}

function crapFindingOf(value: unknown): CrapFinding | undefined {
  if (typeof value !== 'object' || value === null || !('crap' in value)) return undefined
  if (!('path' in value) || !('name' in value) || !('line' in value)) {
    throw new Error(`crap: a fallow finding without path, name or line: ${JSON.stringify(value)}`)
  }
  const { path, name, line, crap } = value
  if (typeof path !== 'string' || typeof name !== 'string' || typeof line !== 'number' || typeof crap !== 'number') {
    throw new Error(`crap: a fallow finding of the wrong shape: ${JSON.stringify(value)}`)
  }
  if (crap < CRAP_CEILING) return undefined
  const measured = 'coverage_source' in value && value.coverage_source === 'istanbul'
  return { path, name, line, crap, measured }
}

/**
 * The functions at or over the ceiling in fallow's health JSON. ⚠ Throws rather than reading
 * clean when the `findings` list is missing or a finding changed shape: either is a fallow whose
 * output moved, and an empty list would pass the gate.
 */
export function crapFindingsOf(report: unknown): CrapFinding[] {
  if (typeof report !== 'object' || report === null || !('findings' in report) || !Array.isArray(report.findings)) {
    throw new Error("crap: fallow's health JSON has no `findings` list")
  }
  return report.findings.flatMap((reported: unknown) => crapFindingOf(reported) ?? [])
}

function crapPinOf(value: unknown): CrapPin {
  const shape = 'a pin needs a path, a function, a numeric crap and a reason'
  if (typeof value !== 'object' || value === null) throw new Error(`crap: ${shape}: ${JSON.stringify(value)}`)
  if (!('path' in value) || !('function' in value) || !('crap' in value) || !('reason' in value)) {
    throw new Error(`crap: ${shape}: ${JSON.stringify(value)}`)
  }
  const { path, function: name, crap, reason } = value
  if (typeof path !== 'string' || typeof name !== 'string' || typeof crap !== 'number' || typeof reason !== 'string') {
    throw new Error(`crap: ${shape}: ${JSON.stringify(value)}`)
  }
  if (reason.trim() === '') throw new Error(`crap: the pin for ${path} ${name} gives no reason`)
  return { path, function: name, crap, reason }
}

/** `crap-pins.json`, read checked: every pin whole, each function pinned once. */
export function crapPinsOf(json: unknown): CrapPin[] {
  if (!Array.isArray(json)) throw new Error('crap: crap-pins.json is not a list')
  const pins = json.map((pinned: unknown) => crapPinOf(pinned))
  const keys = new Set<string>()
  for (const pin of pins) {
    const key = `${pin.path}\0${pin.function}`
    if (keys.has(key)) throw new Error(`crap: ${pin.path} ${pin.function} is pinned twice`)
    keys.add(key)
  }
  return pins
}

/**
 * What fails the step, one line each; empty when it passes. A pin matches by file and function
 * name, so two same-named functions in one file both answer to it.
 */
export function crapFailures(findings: readonly CrapFinding[], pins: readonly CrapPin[]): string[] {
  const pinned = new Map(pins.map((pin) => [`${pin.path}\0${pin.function}`, pin]))
  const matched = new Set<string>()
  const failures: string[] = []
  for (const finding of findings) {
    const key = `${finding.path}\0${finding.name}`
    const pin = pinned.get(key)
    const where = `${finding.path}:${finding.line} ${finding.name}`
    const score = `CRAP ${finding.crap}${finding.measured ? '' : " (fallow's estimate: no test loads the file)"}`
    matched.add(key)
    if (pin === undefined) {
      failures.push(`${where}: ${score}, with no pin; test it under ${CRAP_CEILING}, or pin it with its reason`)
    } else if (finding.crap > pin.crap) {
      failures.push(`${where}: ${score}, over its pin of ${pin.crap}`)
    } else if (finding.crap < pin.crap) {
      failures.push(`${where}: ${score}, under its pin of ${pin.crap}; lower the pin to ${finding.crap}`)
    }
  }
  for (const pin of pins) {
    if (!matched.has(`${pin.path}\0${pin.function}`)) {
      failures.push(
        `${pin.path} ${pin.function}: pinned at ${pin.crap}, but no function of that name there scores ${CRAP_CEILING} or more; delete the pin`,
      )
    }
  }
  return failures
}

function main(): number {
  if (!existsSync(ISTANBUL_PATH)) {
    process.stderr.write('crap: no coverage/coverage-final.json; run `bun test`, then `bun run crap:check`\n')
    return 1
  }
  const fallow = join(ROOT, 'node_modules', '.bin', 'fallow')
  const thresholds = ['--max-cognitive', '1000', '--max-cyclomatic', '1000', '--max-crap', String(CRAP_CEILING)]
  const run = Bun.spawnSync(
    [fallow, 'health', '--complexity', ...thresholds, '--coverage', ISTANBUL_PATH, '--format', 'json', '--quiet'],
    { cwd: ROOT },
  )
  // fallow exits 1 when it reports findings, which is this step's input; 2 is fallow itself failing.
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    process.stderr.write(`crap: fallow failed (exit ${run.exitCode}): ${run.stderr.toString()}\n`)
    return 1
  }
  const findings = crapFindingsOf(JSON.parse(run.stdout.toString()))
  const pins = crapPinsOf(JSON.parse(readFileSync(PINS_PATH, 'utf8')))
  const failures = crapFailures(findings, pins)
  if (failures.length > 0) {
    process.stderr.write(`crap: ${failures.map((failure) => `\n  ${failure}`).join('')}\n`)
    return 1
  }
  process.stdout.write(
    `crap: no function at CRAP ≥ ${CRAP_CEILING} outside crap-pins.json; ${pins.length} pinned, each at its score\n`,
  )
  return 0
}

if (import.meta.main) process.exitCode = main()
