import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * Re-measures the cognitive-complexity pins, per FUNCTION (#264).
 *
 * `biome.jsonc`'s exception entries pin a FILE, because that is the only granularity a Biome
 * `overrides` entry has — so a file pinned at 68 for one function admits every other function
 * in it up to 68 as well. Measured when this was written: 683 points of unclaimed slack across
 * the three pinned files, with `literalShellWord` (50) and `skipShellWord` (32) free to grow to
 * 68 inside the repo's most security-load-bearing tokenizer while `bun run check` stayed green.
 * That is the exact failure the entries' own ⚠ note claims to have closed.
 *
 * This is the granularity the claim needs: every function in a pinned file that is above the
 * GLOBAL ceiling is named here at its measured score, and each file's pin must equal its own
 * worst function. Below the global ceiling nothing is pinned — the ceiling is the rule there.
 * Measured by running Biome over those files with the rule's option at 1 and reading the
 * reported scores, which is the same method the note in `biome.jsonc` describes by hand.
 *
 * To retire a row: reduce the function, then lower its number here AND the file's in
 * `biome.jsonc`. A number may go down, never up.
 */

const biomeBinary = join(REPOSITORY_ROOT, 'node_modules', '.bin', 'biome')
const BIOME_CONFIG = 'biome.jsonc'

/** The files `biome.jsonc` pins; every function above the global ceiling lives in one of them. */
const PINNED_FILES = [
  'packages/harness/core/shell-segments.ts',
  'packages/harness/extensions/guards/index.ts',
  'packages/web/src/host/map-events.ts',
] as const

/**
 * `<file>:<function>` → the score measured today. Only functions above the global ceiling: a
 * helper at 21 is governed by the ceiling itself, so pinning it here would be a second rule.
 */
const PINNED_FUNCTIONS: Readonly<Record<string, number>> = {
  'packages/harness/core/shell-segments.ts:extractFlatShellCommandSegments': 68,
  'packages/harness/core/shell-segments.ts:literalShellWord': 50,
  'packages/harness/core/shell-segments.ts:skipShellWord': 32,
  'packages/harness/extensions/guards/index.ts:decide': 44,
  'packages/web/src/host/map-events.ts:mapPiEvent': 28,
}

const COMPLEXITY_OPTION = /"maxAllowedComplexity"\s*:\s*(\d+)/
const DIAGNOSTIC =
  /^(\S+?):(\d+):(\d+) lint\/complexity\/noExcessiveCognitiveComplexity[\s\S]{0,300}?Excessive complexity of (\d+)/gm

/** The ceiling every file starts under: the rule's option outside `overrides`. */
function globalCeiling(): number {
  const config = readFileSync(join(REPOSITORY_ROOT, BIOME_CONFIG), 'utf8')
  const beforeOverrides = config.slice(0, config.indexOf('"overrides"'))
  const ceiling = COMPLEXITY_OPTION.exec(beforeOverrides)?.[1]
  if (ceiling === undefined) throw new Error(`${BIOME_CONFIG}: no global maxAllowedComplexity`)
  return Number(ceiling)
}

/**
 * Each pinned file → the number its `overrides` entry allows.
 *
 * ⚠ A text read, not a JSONC parse — and it REFUSES an ambiguous one (PR #313 review). The
 * scan takes the first `maxAllowedComplexity` after the file's path string, which is the
 * right number only while that path appears once; a second mention, in a comment or a second
 * override, would quietly read another entry's pin and the ratchet would hold against a
 * number nobody set. Counting occurrences costs less than a parser and turns that silent
 * misread into a red line naming the file.
 */
function filePins(): Record<string, number> {
  const config = readFileSync(join(REPOSITORY_ROOT, BIOME_CONFIG), 'utf8')
  const pins: Record<string, number> = {}
  for (const file of PINNED_FILES) {
    const mentions = config.split(`"${file}"`).length - 1
    if (mentions !== 1) {
      throw new Error(`${BIOME_CONFIG}: "${file}" appears ${mentions} times — this reader needs exactly one`)
    }
    const entry = config.slice(config.indexOf(`"${file}"`))
    const pin = COMPLEXITY_OPTION.exec(entry)?.[1]
    if (pin === undefined) throw new Error(`${BIOME_CONFIG}: ${file} has no maxAllowedComplexity of its own`)
    pins[file] = Number(pin)
  }
  return pins
}

/**
 * `<file>:<function>` → score, for every function in the pinned files scoring above `ceiling`.
 *
 * The scratch config lives outside the repo and carries ONLY this rule, at 1, so every function
 * reports and nothing else does. Biome heads each diagnostic with `<path>:<line>:<column>`, and
 * the column is the declared name's first character — a diagnostic above the ceiling whose name
 * cannot be read there is thrown on rather than dropped, because a dropped row is silent slack.
 */
function measuredAboveCeiling(ceiling: number): Record<string, number> {
  const directory = mkdtempSync(join(tmpdir(), 'zen-complexity-'))
  let report: string
  try {
    const config = join(directory, 'biome.jsonc')
    writeFileSync(
      config,
      JSON.stringify({
        linter: {
          enabled: true,
          rules: {
            recommended: false,
            complexity: { noExcessiveCognitiveComplexity: { level: 'error', options: { maxAllowedComplexity: 1 } } },
          },
        },
      }),
    )
    const linted = Bun.spawnSync(
      [biomeBinary, 'lint', `--config-path=${config}`, '--max-diagnostics=500', ...PINNED_FILES],
      {
        cwd: REPOSITORY_ROOT,
      },
    )
    report = `${linted.stdout.toString()}${linted.stderr.toString()}`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const sourceLines: Record<string, string[]> = {}
  for (const file of PINNED_FILES) sourceLines[file] = readFileSync(join(REPOSITORY_ROOT, file), 'utf8').split('\n')
  const measured: Record<string, number> = {}
  for (const [, file, line, column, score] of report.matchAll(DIAGNOSTIC)) {
    if (Number(score) <= ceiling) continue
    const path = file ?? ''
    const declaration = (sourceLines[path]?.[Number(line) - 1] ?? '').slice(Number(column) - 1)
    const name = /^[A-Za-z_$][\w$]*/.exec(declaration)?.[0]
    if (name === undefined) {
      throw new Error(`${path}:${line} scores ${score} but declares no readable name to pin it by`)
    }
    measured[`${path}:${name}`] = Number(score)
  }
  return measured
}

test('⚠ every function above the global ceiling in a pinned file is pinned BY NAME at the score it measures', () => {
  // Named, not counted: a count cannot say which function grew. A row that is too HIGH is the
  // slack this exists to remove, and a row that is too LOW is a function that grew unreviewed.
  expect(measuredAboveCeiling(globalCeiling())).toEqual(PINNED_FUNCTIONS)
})

test("a file's pin equals its own worst function — a pin above that measurement is slack nobody claimed", () => {
  const measured = measuredAboveCeiling(globalCeiling())
  const worstPerFile: Record<string, number> = {}
  for (const [key, score] of Object.entries(measured)) {
    const file = key.slice(0, key.lastIndexOf(':'))
    worstPerFile[file] = Math.max(worstPerFile[file] ?? 0, score)
  }
  expect(filePins()).toEqual(worstPerFile)
})
