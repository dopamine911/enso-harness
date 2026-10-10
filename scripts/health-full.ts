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
 * CRAP is cyclomatic × (1 − coverage)³ + cyclomatic. With `coverage/coverage-final.json` present,
 * fallow scores it from measured coverage; without it, from fallow's estimate, and the report says
 * which.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fallowConfig from '../.fallowrc.jsonc'
import { findRepoRoot } from '../packages/core/src/paths.ts'

const ROOT = findRepoRoot(import.meta.url)
const REPORT_PATH = join(ROOT, '.local', 'health-full.md')
const VARIANT_PATH = join(ROOT, '.local', 'fallow-variant.json')
const COVERAGE_PATH = join(ROOT, 'coverage', 'coverage-final.json')

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
    without: (config) => ({ ...config, health: { ...config.health, maxCrap: 30 } }),
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
  const coverage = command === 'health' && existsSync(COVERAGE_PATH) ? ['--coverage', COVERAGE_PATH] : []
  const run = await Bun.$`fallow ${command} -c ${VARIANT_PATH} ${coverage} --format json --quiet`
    .cwd(ROOT)
    .nothrow()
    .quiet()
  return JSON.parse(run.stdout.toString()) as Record<string, unknown>
}

/** fallow's human output for one command under the full config, as the terminal would show it. */
async function fallowText(command: string, flags: readonly string[]): Promise<string> {
  writeFileSync(VARIANT_PATH, JSON.stringify(fullConfig(fallowConfig as FallowConfig)))
  const coverage = command === 'health' && existsSync(COVERAGE_PATH) ? ['--coverage', COVERAGE_PATH] : []
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

async function measure(config: FallowConfig): Promise<Measured> {
  const deadCode = await fallowJson('dead-code', config)
  const health = await fallowJson('health', config)
  const dupes = await fallowJson('dupes', config)
  const counts = Object.entries(deadCode)
    .filter(([key, value]) => Array.isArray(value) && value.length > 0 && key !== 'next_steps')
    .map(([key, value]) => [key, (value as unknown[]).length] as const)
  const stats = dupes.stats as { readonly duplication_percentage: number; readonly clone_groups: number }
  return {
    deadCode: Object.fromEntries(counts),
    healthFindings: (health.findings as unknown[]).length,
    duplication: `${stats.duplication_percentage.toFixed(2)}% · ${stats.clone_groups} groups`,
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

async function report(): Promise<string> {
  const config = fallowConfig as FallowConfig
  const coverage = existsSync(COVERAGE_PATH)
    ? 'measured (`coverage/coverage-final.json`)'
    : "fallow's estimate (no `coverage/coverage-final.json`)"
  return [
    '# Fallow, with its exemptions off',
    '',
    `Generated by \`bun run health:full\` (\`scripts/health-full.ts\`). CRAP coverage: ${coverage}.`,
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
    fenced(await fallowText('health', ['--max-cyclomatic', '20', '--max-cognitive', '15', '--max-crap', '30'])),
    '',
  ].join('\n')
}

mkdirSync(join(ROOT, '.local'), { recursive: true })
writeFileSync(REPORT_PATH, await report())
process.stdout.write(`health:full: wrote ${REPORT_PATH}\n`)
