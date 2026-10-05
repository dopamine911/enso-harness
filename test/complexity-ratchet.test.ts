import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * Re-measures the cognitive-complexity pins, per FUNCTION (#264).
 *
 * The complexity gate (`complexity:check`) is fallow `health` at a cognitive ceiling of 25, and
 * its exceptions are `.fallowrc.jsonc` → `health.thresholdOverrides`, each naming ONE function.
 * That granularity is the point: under Biome an exception could only pin a FILE, so a file
 * pinned at 68 for one function admitted every other function in it up to 68 — measured at
 * #264, 683 points of unclaimed slack across three files, with `literalShellWord` (50) free to
 * grow to 68 inside the repo's most security-load-bearing tokenizer.
 *
 * fallow already FAILS a pin that is too low (`insufficient`, a finding, exit 1). What it does
 * not fail is the other three ways a pin rots, and those are what this test refuses:
 *
 *   • slack — a pin ABOVE its function's score. A number may go down, never up; a pin that
 *     outgrew its function's shrinking is room for the function to grow back unnoticed.
 *   • `stale` — the function now scores under the ceiling. The ceiling is the rule there; a
 *     second, looser rule for the same function is slack by another name.
 *   • `no_match` — the pinned function no longer exists (renamed, moved, deleted). An exception
 *     nobody relies on is a hole nobody is watching.
 *
 * To retire an entry: reduce the function, then lower (or delete) its `maxCognitive`.
 */

interface ThresholdOverride {
  readonly status: string
  readonly path?: string
  readonly function?: string
  readonly configured_thresholds: { readonly max_cognitive?: number }
  readonly metrics?: { readonly cognitive: number }
}

interface HealthReport {
  readonly threshold_overrides?: readonly ThresholdOverride[]
}

/** `package.json` → `name`, split into fallow's arguments — refused if quoted or not fallow. */
function gateArguments(name: string): string[] {
  const scripts: Readonly<Record<string, string>> = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ).scripts
  const script = scripts[name] ?? ''
  // The script is split on single spaces — no shell runs here — which is right for a plain flag
  // list and wrong the day an argument is quoted. That day is refused rather than misparsed: a
  // quote would land inside an argv entry and fallow would measure with different thresholds
  // than the gate (PR #398 review).
  if (/["'\\]/.test(script)) throw new Error(`complexity ratchet: cannot split a quoted script: ${script}`)
  const [tool, ...rest] = script.split(' ')
  if (tool !== 'fallow') throw new Error(`complexity ratchet: \`${name}\` no longer runs fallow`)
  return rest
}

/** fallow with `fallowArguments` and `--format json`, parsed. */
function fallowJson<Report>(fallowArguments: readonly string[]): { report: Report; stdout: string } {
  const measured = Bun.spawnSync(
    [join(REPOSITORY_ROOT, 'node_modules', '.bin', 'fallow'), ...fallowArguments, '--format', 'json'],
    { cwd: REPOSITORY_ROOT },
  )
  const stdout = measured.stdout.toString()
  return { report: JSON.parse(stdout), stdout }
}

/**
 * The gate's own run, as JSON: `package.json` → `complexity:check` read and re-run with
 * `--format json`, so this measures with exactly the thresholds the gate enforces.
 */
function measuredOverrides(): readonly ThresholdOverride[] {
  const { report, stdout } = fallowJson<HealthReport>(gateArguments('complexity:check'))
  // ⚠ A report without the block is not "no pins": it is a fallow whose output moved, and every
  // assertion below would pass over an empty list. Refused rather than read as clean.
  if (report.threshold_overrides === undefined || report.threshold_overrides.length === 0) {
    throw new Error(`complexity ratchet: fallow reported no threshold_overrides:\n${stdout}`)
  }
  return report.threshold_overrides
}

test('⚠ every complexity pin names a live function above the ceiling, at exactly the score it measures', () => {
  const rotted: string[] = []
  for (const pin of measuredOverrides()) {
    const where = `${pin.path ?? '?'}:${pin.function ?? '?'}`
    const pinned = pin.configured_thresholds.max_cognitive
    const score = pin.metrics?.cognitive
    if (pin.status !== 'active') rotted.push(`${where} is ${pin.status}`)
    else if (pinned !== score) rotted.push(`${where} is pinned at ${pinned}, measures ${score}`)
  }
  // Named, not counted, so a failure says which entry to lower or delete.
  expect(rotted).toEqual([])
})

interface ComplexityFinding {
  readonly path: string
  readonly name: string
}

interface NewCodeBaseline {
  readonly identity_finding_counts: Readonly<Record<string, Readonly<Record<string, { readonly count: number }>>>>
}

/**
 * The new-code gate (`complexity:new`, #594) lists the functions already over its number in an
 * identity baseline, keyed `<path>\0<function>`. fallow's own `--fail-on-stale-baseline` judges an
 * entry stale only when its whole FILE has no finding left — measured on #594, an invented entry
 * for a function in a file with other findings passed — so a function brought under the number
 * would keep its entry, free to grow back past it unnoticed. This refuses that per FUNCTION, from
 * the same gate run without its baseline: every entry must still name that many findings.
 */
test('⚠ every new-code baseline entry still names a function over the new-code number', () => {
  const withBaseline = gateArguments('complexity:new')
  const baselineAt = withBaseline.indexOf('--baseline')
  const baselinePath = withBaseline[baselineAt + 1]
  if (baselineAt === -1 || baselinePath === undefined)
    throw new Error('complexity ratchet: `complexity:new` has no --baseline')
  const unbaselined = withBaseline.filter(
    (argument, at) =>
      at !== baselineAt &&
      at !== baselineAt + 1 &&
      argument !== '--fail-on-stale-baseline' &&
      argument !== '--baseline-mode' &&
      withBaseline[at - 1] !== '--baseline-mode',
  )
  const { report, stdout } = fallowJson<{ readonly findings?: readonly ComplexityFinding[] }>(unbaselined)
  if (report.findings === undefined || report.findings.length === 0) {
    throw new Error(`complexity ratchet: fallow reported no findings over the new-code number:\n${stdout}`)
  }
  const measured = new Map<string, number>()
  for (const finding of report.findings) {
    const key = `${finding.path}\0${finding.name}`
    measured.set(key, (measured.get(key) ?? 0) + 1)
  }
  const baseline: NewCodeBaseline = JSON.parse(readFileSync(join(REPOSITORY_ROOT, baselinePath), 'utf8'))
  const stale: string[] = []
  for (const [key, categories] of Object.entries(baseline.identity_finding_counts)) {
    const listed = Object.values(categories).reduce((total, category) => total + category.count, 0)
    const found = measured.get(key) ?? 0
    if (found < listed) stale.push(`${key.replace('\0', ':')} lists ${listed}, measures ${found}`)
  }
  // Named, so a failure says which function to take out (`bun run complexity:baseline`).
  expect(stale).toEqual([])
})
