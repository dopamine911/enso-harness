/**
 * Fallow with its exemptions off: the whole picture, for reading, never a gate (#825).
 *
 *   bun run health:full            → .local/health-full.md
 *
 * The gate reads fallow through `.fallowrc.jsonc`, whose exemptions each have a reason there. This
 * report shows what they hide. First a table: each exemption removed alone from the real config,
 * and what fallow then finds. Then fallow's dead-code, duplication and health output with every
 * exemption that hides findings turned off, at fallow's own defaults (cyclomatic 20, cognitive 15,
 * CRAP 30), with the findings inside unused files shown (`--show-cascade`).
 *
 * Kept in the full run, because without them fallow reports what is not true: `entry` (programs
 * the runtime loads, which no import reaches), `ignoreDependencies` (packages the runtime, Bun or
 * the page load), `ignorePatterns` and `ignoreUnresolvedImports` (build output). The table still
 * shows what removing each of them would add.
 *
 * CRAP is cyclomatic² × (1 − coverage)³ + cyclomatic. When `coverage/lcov.info` exists, this first
 * converts it to `coverage/coverage-final.json` (`scripts/coverage-istanbul.ts`) and fallow scores
 * CRAP from that measured coverage; the report says how old the LCOV is, because it describes the
 * tree its `bun test` ran on, and this never runs the suite. Without an LCOV, CRAP is fallow's
 * estimate, and the report says so. Measured or not, a file no test loads (and every test file,
 * which Bun leaves out of coverage) keeps fallow's estimate; the health section counts both kinds.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fallowConfig from '../.fallowrc.jsonc'
import { findRepoRoot } from '../packages/core/src/paths.ts'
import { conversionSummary, ISTANBUL_PATH, LCOV_PATH, writeIstanbulCoverage } from './coverage-istanbul.ts'

const ROOT = findRepoRoot(import.meta.url)
const REPORT_PATH = join(ROOT, '.local', 'health-full.md')
const VARIANT_PATH = join(ROOT, '.local', 'fallow-variant.json')
/** fallow's CRAP threshold in the full run, and the line the health section counts against. */
const CRAP_THRESHOLD = 30

/** Where CRAP's coverage comes from: the measured map's `--coverage` flag and its description, or the estimate. */
interface CoverageSource {
  readonly flags: readonly string[]
  readonly description: string
}

function coverageSource(): CoverageSource {
  if (!existsSync(LCOV_PATH)) {
    // fallow reads `coverage/coverage-final.json` without being passed it, so a leftover map still scores CRAP.
    const description = existsSync(ISTANBUL_PATH)
      ? 'a leftover `coverage/coverage-final.json`, with no `coverage/lcov.info` to refresh it from (fallow reads it unasked)'
      : "fallow's estimate (no `coverage/lcov.info`; run `bun test` to measure)"
    return { flags: [], description }
  }
  const summary = conversionSummary(writeIstanbulCoverage())
  process.stdout.write(`health:full: CRAP from measured coverage: ${summary}\n`)
  return { flags: ['--coverage', ISTANBUL_PATH], description: `measured, \`coverage/coverage-final.json\`: ${summary}` }
}

/** The parts of `.fallowrc.jsonc` this report turns off; the rest passes through unread. */
interface FallowConfig {
  readonly [key: string]: unknown
  readonly duplicates: { readonly [key: string]: unknown; readonly ignore: readonly string[] }
  readonly health: { readonly [key: string]: unknown }
}

/** One exemption: its name in the table, the config without it, and whether the full run keeps it. */
interface Exemption {
  readonly name: string
  readonly without: (config: FallowConfig) => FallowConfig
  /** A build fact rather than a hiding rule: without it fallow reports runtime-loaded code as unused. */
  readonly keptInFullRun: boolean
}

const withoutKeys = (config: FallowConfig, ...keys: readonly string[]): FallowConfig =>
  Object.fromEntries(Object.entries(config).filter(([key]) => !keys.includes(key))) as FallowConfig

const EXEMPTIONS: readonly Exemption[] = [
  {
    name: '`ignoreFindings` (vendored components)',
    without: (config) => withoutKeys(config, 'ignoreFindings'),
    keptInFullRun: false,
  },
  {
    name: '`ignoreExports` (schema types)',
    without: (config) => withoutKeys(config, 'ignoreExports'),
    keptInFullRun: false,
  },
  {
    name: '`duplicates.ignore`',
    without: (config) => ({ ...config, duplicates: { ...config.duplicates, ignore: [] } }),
    keptInFullRun: false,
  },
  {
    name: '`health.ignore` and `thresholdOverrides`',
    without: (config) => ({ ...config, health: { ...config.health, ignore: [], thresholdOverrides: [] } }),
    keptInFullRun: false,
  },
  {
    name: '`health.maxCrap: 0` (CRAP off)',
    without: (config) => ({ ...config, health: { ...config.health, maxCrap: CRAP_THRESHOLD } }),
    keptInFullRun: false,
  },
  { name: '`entry`', without: (config) => withoutKeys(config, 'entry'), keptInFullRun: true },
  {
    name: '`ignoreDependencies`',
    without: (config) => withoutKeys(config, 'ignoreDependencies'),
    keptInFullRun: true,
  },
]

/** The config the full run reads: every exemption that hides findings off, the build facts kept. */
function fullConfig(config: FallowConfig): FallowConfig {
  const hiding = EXEMPTIONS.filter((exemption) => !exemption.keptInFullRun)
  return hiding.reduce((current, exemption) => exemption.without(current), config)
}

/** fallow's JSON for one command under one config; fallow exits 1 when it finds something, which is not a failure here. */
async function fallowJson(command: string, config: FallowConfig): Promise<Record<string, unknown>> {
  writeFileSync(VARIANT_PATH, JSON.stringify(config))
  const coverage = command === 'health' ? COVERAGE.flags : []
  const run = await Bun.$`fallow ${command} -c ${VARIANT_PATH} ${coverage} --format json --quiet`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  return JSON.parse(run.stdout.toString()) as Record<string, unknown>
}

/** fallow's human output for one command under the full config, as the terminal would show it. */
async function fallowText(command: string, flags: readonly string[]): Promise<string> {
  writeFileSync(VARIANT_PATH, JSON.stringify(fullConfig(fallowConfig as FallowConfig)))
  const coverage = command === 'health' ? COVERAGE.flags : []
  // Piped, fallow writes no colour codes, so the report reads as plain text.
  const run = await Bun.$`fallow ${command} -c ${VARIANT_PATH} ${flags} ${coverage} --quiet`.cwd(ROOT).nothrow().quiet()
  return run.stdout.toString().trimEnd()
}

/** What one run found, as one table cell: dead-code counts by kind, health findings, duplication. */
interface Measured {
  readonly deadCode: Readonly<Record<string, number>>
  readonly healthFindings: number
  readonly duplication: string
}

/** A list in fallow's JSON. ⚠ Throws rather than counting zero when fallow's output changes shape. */
function listField(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`health:full: fallow's JSON has no \`${key}\` list`)
  return value
}

/** `fallow dupes`'s headline, read checked: the percentage and the clone groups. */
function duplicationOf(dupes: Readonly<Record<string, unknown>>): string {
  const stats = dupes.stats
  if (
    typeof stats !== 'object' ||
    stats === null ||
    !('duplication_percentage' in stats) ||
    !('clone_groups' in stats)
  ) {
    throw new Error("health:full: fallow's dupes JSON has no `stats`")
  }
  const { duplication_percentage: percentage, clone_groups: groups } = stats
  if (typeof percentage !== 'number' || typeof groups !== 'number') {
    throw new Error("health:full: fallow's dupes `stats` are not numbers")
  }
  return `${percentage.toFixed(2)}% · ${groups} groups`
}

async function measure(config: FallowConfig): Promise<Measured> {
  const deadCode = await fallowJson('dead-code', config)
  const health = await fallowJson('health', config)
  const counts = Object.entries(deadCode).flatMap(([key, value]) =>
    Array.isArray(value) && value.length > 0 && key !== 'next_steps' ? [[key, value.length] as const] : [],
  )
  return {
    deadCode: Object.fromEntries(counts),
    healthFindings: listField(health, 'findings').length,
    duplication: duplicationOf(await fallowJson('dupes', config)),
  }
}

/** What removing one exemption adds over the configured run, in words; "nothing" when it adds nothing. */
function difference(configured: Measured, without: Measured): string {
  const deadCode = Object.entries(without.deadCode)
    .map(([kind, count]) => [kind, count - (configured.deadCode[kind] ?? 0)] as const)
    .filter(([, added]) => added > 0)
    .map(([kind, added]) => `+${added} ${kind.replaceAll('_', ' ')}`)
  const health = without.healthFindings - configured.healthFindings
  const parts = [
    ...deadCode,
    ...(health > 0 ? [`+${health} health findings`] : []),
    ...(without.duplication === configured.duplication ? [] : [`duplication ${without.duplication}`]),
  ]
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}

async function exemptionTable(config: FallowConfig): Promise<string> {
  const configured = await measure(config)
  const rows: string[] = []
  for (const exemption of EXEMPTIONS) {
    const label = exemption.keptInFullRun ? `${exemption.name} (kept in the full run)` : exemption.name
    rows.push(`| ${label} | ${difference(configured, await measure(exemption.without(config)))} |`)
  }
  const deadCode = Object.entries(configured.deadCode).map(([kind, count]) => `${count} ${kind.replaceAll('_', ' ')}`)
  return [
    `Configured (what the gate sees): ${deadCode.length === 0 ? 'no dead code' : deadCode.join(', ')}; ` +
      `${configured.healthFindings} health findings; duplication ${configured.duplication}.`,
    '',
    '| Exemption removed alone | What fallow then finds |',
    '|---|---|',
    ...rows,
  ].join('\n')
}

const fenced = (text: string): string => `\`\`\`\n${text}\n\`\`\``

/** Whether one health finding scores at or over the CRAP threshold. */
const crapAtOrOver = (finding: unknown): boolean =>
  typeof finding === 'object' &&
  finding !== null &&
  'crap' in finding &&
  typeof finding.crap === 'number' &&
  finding.crap >= CRAP_THRESHOLD

/** Whether fallow scored one finding from the converted map rather than its estimate (#826). */
const scoredFromMap = (finding: unknown): boolean =>
  typeof finding === 'object' &&
  finding !== null &&
  'coverage_source' in finding &&
  finding.coverage_source === 'istanbul'

/** The full run's functions at or over the CRAP threshold, split by where each one's coverage came from. */
async function crapCount(): Promise<string> {
  const health = await fallowJson('health', fullConfig(fallowConfig as FallowConfig))
  const over = listField(health, 'findings').filter(crapAtOrOver)
  const measured = over.filter(scoredFromMap).length
  return (
    `CRAP at or over ${CRAP_THRESHOLD}: ${over.length} functions, ${measured} scored from measured coverage and ` +
    `${over.length - measured} from fallow's estimate.`
  )
}

async function report(): Promise<string> {
  const config = fallowConfig as FallowConfig
  return [
    '# Fallow, with its exemptions off',
    '',
    `Generated by \`bun run health:full\` (\`scripts/health-full.ts\`). CRAP coverage: ${COVERAGE.description}.`,
    '',
    '## What each exemption hides',
    '',
    await exemptionTable(config),
    '',
    '## Dead code',
    '',
    fenced(await fallowText('dead-code', ['--show-cascade'])),
    '',
    '## Duplication',
    '',
    fenced(await fallowText('dupes', [])),
    '',
    '## Health',
    '',
    await crapCount(),
    '',
    fenced(
      await fallowText('health', [
        '--max-cyclomatic',
        '20',
        '--max-cognitive',
        '15',
        '--max-crap',
        `${CRAP_THRESHOLD}`,
      ]),
    ),
    '',
  ].join('\n')
}

const COVERAGE = coverageSource()

mkdirSync(join(ROOT, '.local'), { recursive: true })
writeFileSync(REPORT_PATH, await report())
process.stdout.write(`health:full: wrote ${REPORT_PATH}\n`)
