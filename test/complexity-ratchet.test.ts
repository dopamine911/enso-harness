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

/**
 * The gate's own run, as JSON: `package.json` → `complexity:check` read and re-run with
 * `--format json`, so this measures with exactly the thresholds the gate enforces.
 */
function measuredOverrides(): readonly ThresholdOverride[] {
  const scripts: Readonly<Record<string, string>> = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ).scripts
  const script = scripts['complexity:check'] ?? ''
  // The script is split on single spaces — no shell runs here — which is right for a plain flag
  // list and wrong the day an argument is quoted. That day is refused rather than misparsed: a
  // quote would land inside an argv entry and fallow would measure with different thresholds
  // than the gate (PR #398 review).
  if (/["'\\]/.test(script)) throw new Error(`complexity ratchet: cannot split a quoted script: ${script}`)
  const [tool, ...gateArguments] = script.split(' ')
  if (tool !== 'fallow') throw new Error('complexity ratchet: `complexity:check` no longer runs fallow')
  const measured = Bun.spawnSync(
    [join(REPOSITORY_ROOT, 'node_modules', '.bin', 'fallow'), ...gateArguments, '--format', 'json'],
    { cwd: REPOSITORY_ROOT },
  )
  const report: HealthReport = JSON.parse(measured.stdout.toString())
  // ⚠ A report without the block is not "no pins": it is a fallow whose output moved, and every
  // assertion below would pass over an empty list. Refused rather than read as clean.
  if (report.threshold_overrides === undefined || report.threshold_overrides.length === 0) {
    throw new Error(`complexity ratchet: fallow reported no threshold_overrides:\n${measured.stdout.toString()}`)
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
