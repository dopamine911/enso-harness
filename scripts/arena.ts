#!/usr/bin/env bun

/**
 * Dogfood Arena (#556): an agent uses Enso through its real UI on an assignment, and a recorder
 * outside Enso keeps the evidence — a Playwright trace, a screenshot every 30 seconds plus one at
 * every significant event, a timeline joining them to Enso's thread ids, Enso's own records, and
 * the agent's notes as it worked.
 *
 *   bun run arena start [--scenario snake] [--minutes N] [--home DIR] [--out DIR] [--chromium PATH] [--headed]
 *       start Enso over a fresh project and a recorded browser; runs until a stop condition
 *   bun run arena brief [--scenario snake]
 *       what the agent under test is told: the assignment, and how to act on the UI
 *   bun run arena act '<json>' [--run DIR]
 *       one UI action on the live run (the agent's only way in); prints the result as JSON
 *   bun run arena manifest <run directory>
 *       fold a run's manifest again from its timeline — after a recorder that died, for one
 *
 * Runs live under `--out`, `ENSO_HOME/arena` by default: `<scenario>-<time>/` with the project,
 * `timeline.jsonl`, `screenshots/`, `trace/`, `enso/` and `manifest.json`. `<out>/current` names
 * the live run, which is how `act` finds it without `--run`.
 *
 * ⚠ The stack runs over the operator's `ENSO_HOME` unless `--home` names another: the agent's
 * prompts reach a real model, and that needs the operator's login. The project is new and
 * empty, so the work the run produces is all in it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensoHome, findRepoRoot } from '../packages/core/src/paths.ts'
import { foldArenaManifest } from './arena/manifest.ts'
import { type ArenaControl, controlFilePath, runArena } from './arena/recorder.ts'
import { ARENA_SCENARIOS, arenaBrief, type ArenaScenario, SNAKE_SCENARIO } from './arena/scenario.ts'
import { readTimeline } from './arena/timeline.ts'

const [command, ...rest] = process.argv.slice(2)

/**
 * The flags that take a value: the argument after one is that value, never the action (PR #562
 * review). ONE list: `flag` accepts only these names, so a flag read here cannot be missing from
 * what `act` skips.
 */
const VALUED_FLAGS = ['scenario', 'minutes', 'home', 'out', 'chromium', 'run'] as const
type ValuedFlag = (typeof VALUED_FLAGS)[number]
const VALUED_FLAG_ARGUMENTS = new Set<string>(VALUED_FLAGS.map((name) => `--${name}`))

function flag(name: ValuedFlag): string | undefined {
  const index = rest.indexOf(`--${name}`)
  return index === -1 ? undefined : rest[index + 1]
}

function fail(message: string): never {
  process.stderr.write(`arena: ${message}\n`)
  process.exit(1)
}

function scenarioNamed(): ArenaScenario {
  const id = flag('scenario') ?? SNAKE_SCENARIO.id
  return ARENA_SCENARIOS[id] ?? fail(`no scenario "${id}" — known: ${Object.keys(ARENA_SCENARIOS).join(', ')}`)
}

const home = resolve(flag('home') ?? ensoHome(process.env))
const outDirectory = resolve(flag('out') ?? join(ensoHome(process.env), 'arena'))
const currentFile = join(outDirectory, 'current')

async function start(): Promise<void> {
  const scenario = scenarioNamed()
  const minutes = Number(flag('minutes') ?? scenario.budgetMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) fail('--minutes takes a positive number')
  const runId = `${scenario.id}-${new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')}`
  const runDirectory = join(outDirectory, runId)
  const chromiumPath = flag('chromium')
  mkdirSync(runDirectory, { recursive: true })
  writeFileSync(join(runDirectory, 'brief.md'), arenaBrief(scenario))
  writeFileSync(currentFile, runDirectory)
  try {
    await runArena({
      scenario,
      repoRoot: findRepoRoot(import.meta.url),
      runDirectory,
      project: join(runDirectory, 'project'),
      home,
      budgetMinutes: minutes,
      headed: rest.includes('--headed'),
      environment: process.env,
      ...(chromiumPath === undefined ? {} : { chromiumPath }),
    })
  } finally {
    rmSync(currentFile, { force: true })
  }
  process.exit(0)
}

async function act(): Promise<void> {
  const body = rest.find(
    (argument, index) => !argument.startsWith('--') && !VALUED_FLAG_ARGUMENTS.has(rest[index - 1] ?? ''),
  )
  if (body === undefined) fail(`act takes one JSON action — \`bun run arena brief\` lists them`)
  const runDirectory = flag('run') ?? (existsSync(currentFile) ? readFileSync(currentFile, 'utf8').trim() : undefined)
  if (runDirectory === undefined) fail('no live run — start one with `bun run arena start`')
  const controlFile = controlFilePath(runDirectory)
  if (!existsSync(controlFile)) fail(`the run at ${runDirectory} is not live`)
  const control = JSON.parse(readFileSync(controlFile, 'utf8')) as ArenaControl
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    fail('the action is not JSON')
  }
  const response = await fetch(`http://127.0.0.1:${control.port}/act`, { method: 'POST', body: JSON.stringify(parsed) })
  const answer = (await response.json()) as { readonly ok: boolean }
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`)
  process.exit(answer.ok ? 0 : 1)
}

function refold(): void {
  const runDirectory = rest[0] ?? fail('manifest takes a run directory')
  const runId = runDirectory.replace(/\/+$/, '').split('/').at(-1) ?? 'run'
  const manifestPath = join(runDirectory, 'manifest.json')
  const kept = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly evidence?: [] }).evidence
    : undefined
  const evidence = kept ?? [{ kind: 'enso', status: 'missing' as const, reason: 'the recorder did not reach its stop' }]
  const manifest = foldArenaManifest({ runId, events: readTimeline(join(runDirectory, 'timeline.jsonl')), evidence })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${manifestPath}\n`)
}

switch (command) {
  case 'start':
    await start()
    break
  case 'brief':
    process.stdout.write(arenaBrief(scenarioNamed()))
    break
  case 'act':
    await act()
    break
  case 'manifest':
    refold()
    break
  default:
    fail('usage: bun run arena start | brief | act <json> | manifest <run directory>')
}
