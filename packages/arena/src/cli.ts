#!/usr/bin/env bun

/**
 * Dogfood Arena (#556): an agent uses Enso through its real UI on an assignment, and a recorder
 * outside Enso keeps the evidence — a Playwright trace, a screenshot every 30 seconds plus one at
 * every significant event, a timeline joining them to Enso's thread ids, Enso's own records, and
 * the agent's notes as it worked.
 *
 *   bun run arena start --agent PROVIDER/MODEL [--thinking LEVEL] [--scenario snake] [--minutes N]
 *                       [--home DIR] [--out DIR] [--chromium PATH] [--headed]
 *       start Enso over a fresh project and a recorded browser, and the agent under test with the
 *       brief and ONE tool, `act` (`arena/agent.ts`): no shell, no files, so the UI is its only way in
 *   bun run arena start --manual [...]
 *       the same run with no agent: actions come over `bun run arena act` from whoever has a shell,
 *       and the manifest says the UI-only boundary was not held
 *   bun run arena brief [--scenario snake] [--manual] [--review] [--out DIR] [--run DIR] [--repo OWNER/NAME]
 *       what the agent under test is told: the assignment, and how to act on the UI (its tool, or
 *       with --manual the `act` command, then the review and the bugs); --review prints the review
 *       and bug-filing prompt on its own, for after an --agent run (`start` writes it as
 *       `<run>/review-brief.md`). Bugs go to --repo, else the checkout's GitHub origin
 *   bun run arena act '<json>' [--run DIR]
 *       one UI action on the live run (the agent's only way in); prints the result as JSON
 *   bun run arena manifest <run directory>
 *       fold a run's manifest again from its timeline, and score it. After a recorder that died,
 *       it also collects Enso's evidence — from the run's stack if it is still up, then stopped
 *   bun run arena score <run directory>
 *       score a run (`arena/score.ts`): its logs read for problems, and whether the UI was the
 *       only way in. Writes `score.json` and `score.md`, prints the Markdown, exits 1 on FAIL.
 *
 * `start` exits 1 too when its run's score is FAIL, so a caller can gate on the run.
 *
 * Runs live under `--out`, `ENSO_HOME/arena` by default: `<scenario>-<time>/` with the project,
 * `timeline.jsonl`, `screenshots/`, `trace/`, `enso/` and `manifest.json`. `<out>/current` names
 * the live run, which is how `act` finds it without `--run`.
 *
 * ⚠ The stack runs over the operator's `ENSO_HOME` unless `--home` names another: the agent's
 * prompts reach a real model, and that needs the operator's login. The project is new and
 * empty, so the work the run produces is all in it.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensoHome, findRepoRoot } from '@enso/core/paths'
import { knownSecretValues } from '@enso/core/secrets'
import { ARENA_THINKING_LEVELS, arenaAgentDriver, resolveArenaModel } from './agent.ts'
import { type ArenaEvidence, arenaEvidenceRowOf, foldArenaManifest } from './manifest.ts'
import { type ArenaDriver, collectAfterRecorderDied, deadRecorderRun, readArenaControl, runArena } from './recorder.ts'
import {
  ARENA_SCENARIOS,
  arenaActCommand,
  arenaBrief,
  type ArenaBriefContext,
  arenaReviewBrief,
  type ArenaScenario,
  githubRepositoryOf,
  SNAKE_SCENARIO,
} from './scenario.ts'
import { renderArenaScore, writeArenaScore } from './score.ts'
import { readTimeline } from './timeline.ts'

const [command, ...rest] = process.argv.slice(2)

/**
 * The flags that take a value: the argument after one is that value, never the action (PR #562
 * review). ONE list: `flag` accepts only these names, so a flag read here cannot be missing from
 * what `act` skips.
 */
const VALUED_FLAGS = ['scenario', 'minutes', 'home', 'out', 'chromium', 'run', 'agent', 'thinking', 'repo'] as const
type ValuedFlag = (typeof VALUED_FLAGS)[number]
const VALUED_FLAG_ARGUMENTS = new Set<string>(VALUED_FLAGS.map((flagName) => `--${flagName}`))

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
const repoRoot = findRepoRoot(import.meta.url)

/** Where bugs are filed: `--repo`, else the checkout's GitHub `origin`, else left for the brief to ask. */
function bugRepository(): string | undefined {
  const named = flag('repo')
  if (named !== undefined) return named
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8' })
  return origin.status === 0 ? githubRepositoryOf(origin.stdout) : undefined
}

/** What a brief names for this invocation: the `act` command for its `--out`, the run, the repository. */
function briefContext(runDirectory?: string): ArenaBriefContext {
  const repository = bugRepository()
  return {
    act: arenaActCommand(flag('out') === undefined ? undefined : outDirectory),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    ...(repository === undefined ? {} : { repository }),
  }
}

/**
 * The agent runner `start` drives the run with, or undefined for `--manual`. One of the two is
 * required: a run with no agent does not hold the UI-only boundary, so it is never the default.
 */
async function driverNamed(
  scenario: ArenaScenario,
  context: ArenaBriefContext,
): Promise<{ readonly driver?: ArenaDriver; readonly brief: string }> {
  const reference = flag('agent')
  if (rest.includes('--manual')) {
    if (reference !== undefined) fail('--manual and --agent are two ways to drive one run: name one')
    return { brief: arenaBrief(scenario, 'command', context) }
  }
  if (reference === undefined) {
    fail('start takes --agent PROVIDER/MODEL (the agent under test, UI only) or --manual (actions over `arena act`)')
  }
  const thinking = ARENA_THINKING_LEVELS.find((level) => level === (flag('thinking') ?? 'medium'))
  if (thinking === undefined) fail(`--thinking takes one of ${ARENA_THINKING_LEVELS.join(', ')}`)
  const { model, streamFn } = await resolveArenaModel(home, reference).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  )
  const brief = arenaBrief(scenario, 'tool')
  const driver = arenaAgentDriver({ model, streamFn, thinking, brief, secretValues: knownSecretValues(home) })
  return { driver, brief }
}

/**
 * A run whose recorder died with its stack still up holds the ports every `start` needs (#607):
 * say which run, and the command that collects its evidence and frees them, before the port check
 * says only "in use".
 */
function refuseOverDeadRun(): void {
  if (!existsSync(currentFile)) return
  const runDirectory = readFileSync(currentFile, 'utf8').trim()
  const dead = deadRecorderRun(runDirectory)
  if (dead?.stackPid === undefined) return
  fail(
    `the last run's recorder died and its Enso stack (pid ${dead.stackPid}) still holds the ports — ` +
      `\`bun run arena manifest ${runDirectory}\` collects its evidence and stops it`,
  )
}

async function start(): Promise<void> {
  refuseOverDeadRun()
  const scenario = scenarioNamed()
  const minutes = Number(flag('minutes') ?? scenario.budgetMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) fail('--minutes takes a positive number')
  const runId = `${scenario.id}-${new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')}`
  const runDirectory = join(outDirectory, runId)
  const chromiumPath = flag('chromium')
  const context = briefContext(runDirectory)
  const { driver, brief } = await driverNamed(scenario, context)
  mkdirSync(runDirectory, { recursive: true })
  const briefPath = join(runDirectory, 'brief.md')
  writeFileSync(briefPath, brief)
  writeFileSync(currentFile, runDirectory)
  if (driver === undefined) {
    process.stdout.write(`arena: the agent's prompt is ${briefPath}\n`)
  } else {
    // The runner's agent has no files to review the run with: the review is a prompt for afterwards.
    const reviewPath = join(runDirectory, 'review-brief.md')
    writeFileSync(reviewPath, arenaReviewBrief(context, 'other'))
    process.stdout.write(`arena: once the run stops, the review and bug-filing prompt is ${reviewPath}\n`)
  }
  let passed = false
  try {
    const score = await runArena({
      scenario,
      repoRoot,
      runDirectory,
      project: join(runDirectory, 'project'),
      home,
      budgetMinutes: minutes,
      headed: rest.includes('--headed'),
      environment: process.env,
      ...(chromiumPath === undefined ? {} : { chromiumPath }),
      ...(driver === undefined ? {} : { driver }),
    })
    passed = score?.verdict === 'pass'
  } finally {
    rmSync(currentFile, { force: true })
  }
  process.exit(passed ? 0 : 1)
}

async function act(): Promise<void> {
  const body = rest.find(
    (argument, index) => !argument.startsWith('--') && !VALUED_FLAG_ARGUMENTS.has(rest[index - 1] ?? ''),
  )
  if (body === undefined) fail(`act takes one JSON action — \`bun run arena brief\` lists them`)
  const runDirectory = flag('run') ?? (existsSync(currentFile) ? readFileSync(currentFile, 'utf8').trim() : undefined)
  if (runDirectory === undefined) fail('no live run — start one with `bun run arena start`')
  const control = readArenaControl(runDirectory) ?? fail(`the run at ${runDirectory} is not live`)
  if (deadRecorderRun(runDirectory) !== undefined) {
    fail(
      `the recorder of the run at ${runDirectory} is gone (pid ${control.pid}) — ` +
        `\`bun run arena manifest ${runDirectory}\` collects its evidence`,
    )
  }
  if (control.port === undefined) {
    fail(`the run at ${runDirectory} is driven by its agent: the page takes actions only through the agent's tool`)
  }
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

/** The evidence a manifest kept, row by row; undefined when it kept none that reads as evidence. */
function keptEvidenceOf(manifest: unknown): ArenaEvidence[] | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('evidence' in manifest)) return undefined
  if (!Array.isArray(manifest.evidence)) return undefined
  const rows: Array<ArenaEvidence | undefined> = manifest.evidence.map(arenaEvidenceRowOf)
  return rows.every((row): row is ArenaEvidence => row !== undefined) ? rows : undefined
}

/**
 * Fold a run's manifest again. A run that stopped keeps the evidence its stop collected; one whose
 * recorder died has none, so it is collected now (#584 A13, #607) and the dead run's `current`
 * pointer, which its `start` never got to clear, goes with it.
 */
async function refold(): Promise<void> {
  const runDirectory = resolve(rest[0] ?? fail('manifest takes a run directory'))
  const runId = runDirectory.split('/').at(-1) ?? 'run'
  const manifestPath = join(runDirectory, 'manifest.json')
  const kept = existsSync(manifestPath) ? keptEvidenceOf(JSON.parse(readFileSync(manifestPath, 'utf8'))) : undefined
  const evidence =
    kept ??
    (await collectAfterRecorderDied(runDirectory, home).catch((error: unknown) =>
      fail(error instanceof Error ? error.message : String(error)),
    ))
  if (kept === undefined && existsSync(currentFile) && readFileSync(currentFile, 'utf8').trim() === runDirectory) {
    rmSync(currentFile, { force: true })
  }
  const manifest = foldArenaManifest({ runId, events: readTimeline(join(runDirectory, 'timeline.jsonl')), evidence })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${manifestPath}\n`)
  scoreRun(runDirectory)
}

function scoreRun(runDirectory: string): void {
  const scored = writeArenaScore(runDirectory)
  process.stdout.write(renderArenaScore(scored))
  process.exitCode = scored.verdict === 'pass' ? 0 : 1
}

switch (command) {
  case 'start':
    await start()
    break
  case 'brief':
    if (rest.includes('--review')) process.stdout.write(arenaReviewBrief(briefContext(flag('run')), 'other'))
    else {
      const channel = rest.includes('--manual') ? 'command' : 'tool'
      process.stdout.write(arenaBrief(scenarioNamed(), channel, briefContext(flag('run'))))
    }
    break
  case 'act':
    await act()
    break
  case 'manifest':
    await refold()
    break
  case 'score':
    scoreRun(rest[0] ?? fail('score takes a run directory'))
    break
  default:
    fail(
      'usage: bun run arena start --agent PROVIDER/MODEL | start --manual | brief | act <json> | manifest <run directory> | score <run directory>',
    )
}
