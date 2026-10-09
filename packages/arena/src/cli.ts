#!/usr/bin/env bun

/**
 * Dogfood Arena (#556): an agent uses Enso through its real UI on an assignment, and a recorder
 * outside Enso keeps the evidence — a Playwright trace, a screenshot every 30 seconds plus one at
 * every significant event, a timeline joining them to Enso's thread ids, Enso's own records, and
 * the agent's notes as it worked.
 *
 *   bun run arena start --agent PROVIDER/MODEL [--thinking LEVEL] [--scenario snake] [--minutes N]
 *                       [--home DIR] [--out DIR] [--chromium PATH] [--headed] [--memory-max SIZE] [--no-scope]
 *                       [--idle-minutes N] [--max-restarts N] [--max-cost-usd N]
 *       the run stops at the budget (plus a minute's grace for the retrospective), or at a bound:
 *       no action for --idle-minutes (10; 0 = off), a restart of Enso past --max-restarts (3), or
 *       Enso's own spend over --max-cost-usd (10; only over the run's own home)
 *       launched (#742): what an earlier run left is cleared first (a dead recorder's run collected,
 *       abandoned temporary files removed) and the run needs room to start; it then runs in its own
 *       systemd scope, its memory capped at --memory-max (6G), unless --no-scope; afterwards whatever
 *       it left is stopped, and one line says what that was
 *       start Enso over a fresh project and a recorded browser, and the agent under test with the
 *       brief and ONE tool, `act` (`arena/agent.ts`): no shell, no files, so the UI is its only way in
 *   bun run arena start --agents PROVIDER/MODEL,PROVIDER/MODEL [...]
 *       the same scenario once per agent model, one after another (#674); every model resolves, and
 *       each one's cost is estimated from earlier runs, before the first run starts
 *   bun run arena start … --enso-model PROVIDER/ID
 *       the model Enso's sessions start on, set in the run home's own settings (#674); refused
 *       over a shared --home, where it would change the operator's own default
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
 *   bun run arena compare <run directory> <run directory>
 *       two runs side by side (`arena/compare.ts`): outcome, UI checks, which problems each has, the
 *       friction each shows. Reads only: each run is scored afresh, nothing on disk is rewritten.
 *   bun run arena compare --by-model <run directory>…
 *       any number of runs grouped by agent model and perception (#674): runs per model, cost,
 *       the problems one model alone has, friction per run
 *   bun run arena report <run directory> [--run-tests]
 *       the run's report (`arena/report.ts`): the application outcome (files, git, tests) apart from
 *       Enso's findings (observed friction, the agent's account, the reviewer's gaps with every
 *       citation checked). Writes `report.md` and `report.json`. `--run-tests` runs the work's own
 *       tests with only PATH, a throwaway HOME and a time limit: they are agent-written code.
 *   bun run arena prune --keep N | --older-than DAYS [--dry-run]
 *       free what an old run can do without (#742): its trace, and its projects' node_modules, dist
 *       and build; never what `publish` reads, never a live run
 *   bun run arena container build | credential --api-key-stdin|--from FILE|--status | start …
 *       a run in a container (`arena/container.ts`, #676): a TEST account's credential injected
 *       into a Docker volume, the run directory the only host path, Enso's bash inside it too
 *   bun run arena login
 *       pi over the arena's own login directory (#763), for `/login` there: every host run's
 *       `pi-agent` links to it. A login of its own, never a copy of yours; once, then as needed
 *
 * `start` exits 1 too when its run's score is FAIL, so a caller can gate on the run.
 *
 * Runs live under `--out`, `$XDG_DATA_HOME/enso/arena` (`~/.local/share/enso/arena`) by default:
 * `<scenario>-<time>/` with the project, `timeline.jsonl`, `screenshots/`, `trace/`, `enso/` and
 * `manifest.json`. `<out>/current` names the live run, which is how `act` finds it without `--run`.
 *
 * ⚠ Each run gets its own Enso home, `<run>/.enso` (#610, `run-home.ts`): its own projects, threads,
 * logs and Stats. Its `pi-agent` is a link to the arena's own login directory (#763), logged in once
 * with `bun run arena login`, so the agent's prompts reach a real model and never use your login.
 * `--home DIR` runs over DIR instead, shared with whatever else uses it. An `--out` under a `.enso`
 * directory is refused: the guard keeps Enso's agent out of it, so the agent could not touch its
 * own project.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gitChildEnvironment } from '@enso/core/git'
import { redactJudgeText } from '@enso/core/judge'
import { isListening } from '@enso/core/loopback'
import { ensoHome, findRepoRoot } from '@enso/core/paths'
import { ARENA_THINKING_LEVELS, arenaAgentDriver, resolveArenaModel } from './agent.ts'
import { compareByModel, compareRunDirectories } from './compare.ts'
import { runContainerCommand } from './container.ts'
import {
  ARENA_DEFAULT_MEMORY_MAX,
  bytesUnder,
  canScope,
  endScope,
  headroomShortfalls,
  makeRunTmp,
  portHolder,
  scopedCommand,
  sizeOf,
  sweepAbandonedRunTmps,
} from './launch.ts'
import { type ArenaEvidence, arenaEvidenceRowOf, foldArenaManifest } from './manifest.ts'
import { isRunning } from './process-tree.ts'
import { pruneArenaRuns, renderPrunedRuns } from './prune.ts'
import { DEFAULT_ARENA_CORPUS, planArenaPublication, publishArenaRun, runArenaCommand } from './publish.ts'
import {
  type ArenaDriver,
  collectAfterRecorderDied,
  deadRecorderRun,
  readArenaControl,
  recordedRunHome,
  runArena,
  STACK_PORTS,
} from './recorder.ts'
import { writeArenaReport } from './report.ts'
import {
  arenaLoginDir,
  arenaLoginProviders,
  arenaSecretValues,
  defaultArenaOut,
  isGuardedForAgent,
  type EnsoModelSetting,
  parseEnsoModel,
  prepareRunHome,
  runHomeOf,
  setRunHomeModel,
} from './run-home.ts'
import { threadHistoriesIn } from './run-state.ts'
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
import { recordedScanOf, scanRunForSecrets, withEarlierHits } from './secret-scan.ts'
import { type ArenaPerception, readTimeline } from './timeline.ts'
import { costEstimate } from './usage.ts'

const [command, ...rest] = process.argv.slice(2)

/**
 * The flags that take a value: the argument after one is that value, never the action (PR #562
 * review). ONE list: `flag` accepts only these names, so a flag read here cannot be missing from
 * what `act` skips.
 */
const VALUED_FLAGS = [
  'scenario',
  'minutes',
  'home',
  'out',
  'chromium',
  'run',
  'agent',
  'agents',
  'enso-model',
  'thinking',
  'repo',
  'idle-minutes',
  'max-restarts',
  'max-cost-usd',
  'perception',
  'corpus',
  'memory-max',
  'keep',
  'older-than',
] as const
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

/** How the agent perceives the page (#680): `--perception tree` (the default) or `visual`. */
function perceptionNamed(): ArenaPerception {
  const named = flag('perception') ?? 'tree'
  if (named === 'tree' || named === 'visual') return named
  return fail('--perception takes "tree" (it reads the accessibility tree) or "visual" (it sees a screenshot)')
}

function scenarioNamed(): ArenaScenario {
  const id = flag('scenario') ?? SNAKE_SCENARIO.id
  return ARENA_SCENARIOS[id] ?? fail(`no scenario "${id}" — known: ${Object.keys(ARENA_SCENARIOS).join(', ')}`)
}

/** A non-negative number flag, or its default; anything else fails with the flag's name. */
function numberFlag(name: ValuedFlag, fallback: number): number {
  const given = flag(name)
  const value = given === undefined ? fallback : Number(given)
  if (!Number.isFinite(value) || value < 0) fail(`--${name} takes a number, 0 or more`)
  return value
}

/**
 * The run's bounds besides the budget (#609). `--idle-minutes 0` turns the idle stop off. The cost
 * bound reads Enso's spend from the home's logs, which is the run's own only in the run home (#610):
 * over a shared `--home` it would count everything else that home ran, so it is off there.
 */
function runLimits(): { readonly idleMinutes?: number; readonly maxRestarts: number; readonly maxCostUsd?: number } {
  const idleMinutes = numberFlag('idle-minutes', 10)
  const maxCostUsd = numberFlag('max-cost-usd', 10)
  if (flag('home') !== undefined && flag('max-cost-usd') !== undefined) {
    fail('--max-cost-usd reads the run home’s own spend; over a shared --home it cannot, so drop one of them')
  }
  return {
    maxRestarts: numberFlag('max-restarts', 3),
    ...(idleMinutes === 0 ? {} : { idleMinutes }),
    ...(flag('home') === undefined ? { maxCostUsd } : {}),
  }
}

/** The operator's Enso home: the login a run borrows, and the home a `--home` run runs over. */
const operatorHome = resolve(flag('home') ?? ensoHome(process.env))
const outDirectory = resolve(flag('out') ?? defaultArenaOut(process.env))
const currentFile = join(outDirectory, 'current')
const repoRoot = findRepoRoot(import.meta.url)

/** Where bugs are filed: `--repo`, else the checkout's GitHub `origin`, else left for the brief to ask. */
function bugRepository(): string | undefined {
  const named = flag('repo')
  if (named !== undefined) return named
  // Without a hook's repository variables (PR #683 review): run under another repository's hook,
  // the origin read would be that repository's, and bugs would be filed there.
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    env: gitChildEnvironment(),
    encoding: 'utf8',
  })
  return origin.status === 0 ? githubRepositoryOf(origin.stdout) : undefined
}

/** How a run's agent perceived the page (#680): its own `run-start` record when it has one, else `--perception`. */
function perceptionOf(runDirectory?: string): ArenaPerception {
  const timelinePath = runDirectory === undefined ? undefined : join(runDirectory, 'timeline.jsonl')
  if (timelinePath !== undefined && existsSync(timelinePath)) {
    const start = readTimeline(timelinePath).find((event) => event.kind === 'run-start')
    if (start?.kind === 'run-start' && start.perception !== undefined) return start.perception
  }
  return perceptionNamed()
}

/** What a brief names for this invocation: the `act` command for its `--out`, the run, the repository, the perception. */
function briefContext(runDirectory?: string): ArenaBriefContext {
  const repository = bugRepository()
  return {
    act: arenaActCommand(flag('out') === undefined ? undefined : outDirectory),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    ...(repository === undefined ? {} : { repository }),
    perception: perceptionOf(runDirectory),
  }
}

/**
 * The agent runner `start` drives the run with, or undefined for `--manual`. One of the two is
 * required: a run with no agent does not hold the UI-only boundary, so it is never the default.
 */
async function driverNamed(
  scenario: ArenaScenario,
  context: ArenaBriefContext,
  reference: string | undefined,
): Promise<{ readonly driver?: ArenaDriver; readonly brief: string }> {
  if (rest.includes('--manual')) {
    if (reference !== undefined) fail('--manual and --agent are two ways to drive one run: name one')
    return { brief: arenaBrief(scenario, 'command', context) }
  }
  if (reference === undefined) {
    fail('start takes --agent PROVIDER/MODEL (the agent under test, UI only) or --manual (actions over `arena act`)')
  }
  const thinking = ARENA_THINKING_LEVELS.find((level) => level === (flag('thinking') ?? 'medium'))
  if (thinking === undefined) fail(`--thinking takes one of ${ARENA_THINKING_LEVELS.join(', ')}`)
  const { model, streamFn } = await agentModelNamed(reference)
  const perception = perceptionNamed()
  const brief = arenaBrief(scenario, 'tool', { perception })
  const driver = arenaAgentDriver({
    model,
    streamFn,
    thinking,
    brief,
    perception,
    secretValues: arenaSecretValues(operatorHome),
  })
  return { driver, brief }
}

/** The run `<out>/current` names: the live one, or one whose recorder died before clearing it. */
function currentRun(): string | undefined {
  return existsSync(currentFile) ? readFileSync(currentFile, 'utf8').trim() : undefined
}

/**
 * Before a `start` (#742): what an earlier run left is taken back, and a run starts only with its
 * ports free and room to run in. A run whose recorder died (#607) gets its evidence collected and its
 * stack stopped, as `arena manifest` does, rather than a refusal naming the command. A live run, or
 * anything else on the ports, is a refusal naming it.
 */
async function prepareLaunch(): Promise<void> {
  for (const swept of sweepAbandonedRunTmps())
    process.stdout.write(`arena: removed ${swept}, left by a run that was killed\n`)
  const last = currentRun()
  const control = last === undefined ? undefined : readArenaControl(last)
  if (last !== undefined && control !== undefined && isRunning(control.pid)) {
    fail(`a run is live at ${last} (recorder pid ${control.pid}): stop it with its \`stop\` action first`)
  }
  if (last !== undefined && deadRecorderRun(last) !== undefined) {
    process.stdout.write(
      `arena: the last run's recorder died; collecting its evidence and stopping its stack first — ${last}\n`,
    )
    await refoldRun(last).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
  }
  for (const port of STACK_PORTS) {
    if (!(await isListening(port))) continue
    const holder = portHolder(port)
    const who =
      holder.pid === undefined
        ? ''
        : ` by pid ${holder.pid}${holder.command === undefined ? '' : ` (${holder.command})`}`
    fail(`port ${port} is in use${who}: the arena starts its own stack`)
  }
  const shortfalls = headroomShortfalls(outDirectory)
  if (shortfalls.length > 0) fail(`not enough room to start a run: ${shortfalls.join('; ')}`)
}

/** Whether the stack's ports are free within `milliseconds`: a stopped stack's sockets close as its processes go. */
async function portsFreeWithin(milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const listening = await Promise.all(STACK_PORTS.map((port) => isListening(port)))
    if (!listening.includes(true)) return true
    await Bun.sleep(200)
  }
  return false
}

/**
 * After the runs (#742), whatever ended them: a run whose recorder died is collected while its stack
 * may still be up; what is left in the scope is stopped; the ports are waited for; the runs' TMPDIR
 * goes. One line says what was found, so a leak is seen at the run that caused it.
 */
async function cleanUp(runTmp: string, scope?: { readonly unit: string; readonly memoryMax: string }): Promise<void> {
  const last = currentRun()
  if (last !== undefined && deadRecorderRun(last) !== undefined) {
    process.stdout.write(`arena: the run's recorder died; collecting its evidence — ${last}\n`)
    await refoldRun(last).catch((error: unknown) => {
      process.stderr.write(`arena: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }
  const ended = scope === undefined ? undefined : endScope(scope.unit)
  const portsFree = await portsFreeWithin(10_000)
  const tmpBytes = bytesUnder(runTmp)
  rmSync(runTmp, { recursive: true, force: true })
  const said = [
    ...(scope === undefined || ended === undefined
      ? []
      : [`${ended.stopped} process(es) left in ${scope.unit} stopped`]),
    ...(scope !== undefined && ended?.result === 'oom-kill' ? [`⚠ the run hit its ${scope.memoryMax} memory cap`] : []),
    portsFree ? `ports ${STACK_PORTS.join('/')} free` : `⚠ ports ${STACK_PORTS.join('/')} still in use`,
    `its TMPDIR removed (${sizeOf(tmpBytes)})`,
  ]
  process.stdout.write(`arena: cleaned up — ${said.join('; ')}\n`)
}

/** The agents `start` runs, one run each (#674): `--agents A,B`, else `--agent A`, else none for `--manual`. */
function agentsNamed(): readonly (string | undefined)[] {
  const many = flag('agents')
  if (many === undefined) return [flag('agent')]
  if (flag('agent') !== undefined || rest.includes('--manual')) {
    fail('--agents runs one run per agent: drop --agent and --manual')
  }
  const references = many.split(',').map((reference) => reference.trim())
  // An empty entry (`a,,b`, a trailing comma) is a typo, not a model to skip.
  if (references.some((reference) => reference === ''))
    fail(`--agents takes PROVIDER/MODEL,PROVIDER/MODEL…, not "${many}"`)
  return references
}

/**
 * The agent's model, resolved and checked against the run's perception — the one check a single
 * run and a matrix's up-front pass both make (PR #705 review). A visual agent knows the page only by
 * its screenshots: a model that cannot take one cannot see.
 */
async function agentModelNamed(reference: string): Promise<Awaited<ReturnType<typeof resolveArenaModel>>> {
  const resolved = await resolveArenaModel(operatorHome, reference).catch((error: unknown) =>
    fail(`${reference}: ${error instanceof Error ? error.message : String(error)}`),
  )
  if (perceptionNamed() === 'visual' && !resolved.model.input.includes('image')) {
    fail(`--perception visual needs a model that takes images, and ${reference} does not`)
  }
  return resolved
}

/** What each agent's run is likely to cost, from earlier runs under `--out` (#674): measured, never guessed. */
function sayEstimates(agents: readonly string[]): void {
  const perception = perceptionNamed()
  for (const agent of agents) {
    const estimate = costEstimate(outDirectory, agent, perception)
    let said = `about $${estimate.meanCostUsd?.toFixed(2)} a run, the mean of ${estimate.runs} earlier ${perception} run(s)`
    if (estimate.runs === 0) said = `no earlier ${perception} run to estimate from`
    else if (estimate.meanCostUsd === undefined) said = `${estimate.runs} earlier run(s), none priced`
    process.stdout.write(`arena: ${agent}: ${said} (its own calls; Enso's spend is bounded by --max-cost-usd)\n`)
  }
}

/**
 * The model Enso's sessions start on, when `--enso-model` names one (#674). Only the run's own home
 * can carry it: over a shared `--home` it would change the operator's own default.
 */
function ensoModelNamed(): EnsoModelSetting | undefined {
  const named = flag('enso-model')
  if (named === undefined) return undefined
  if (flag('home') !== undefined)
    fail('--enso-model sets the run home’s own settings; over a shared --home it would change yours')
  try {
    return parseEnsoModel(named)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/**
 * `start`: one run, or with `--agents` one run per agent, one after another — the ports are one
 * stack at a time. Exits 1 when any run's score is FAIL.
 *
 * Launched (#742): prepared first (`prepareLaunch`). Then, where `systemd-run --user` works and
 * `--no-scope` is not given, `start` runs again as a child in its own memory-capped scope while this
 * process waits outside it to clean up; else the runs run here. Either way they get their own TMPDIR.
 */
async function start(): Promise<void> {
  // The scoped child: its launcher prepared, and cleans up after it.
  if (process.env['ENSO_ARENA_SCOPE'] !== undefined) exitWith(await settledRuns())
  const memoryMax = flag('memory-max') ?? ARENA_DEFAULT_MEMORY_MAX
  const wantsScope = !rest.includes('--no-scope')
  const scoped = wantsScope && canScope()
  // Checked before anything starts: preparing collects dead runs and sweeps temporary directories.
  if (scoped && !canScope(memoryMax)) {
    fail(`systemd refuses --memory-max ${memoryMax} as a MemoryMax; it takes values such as 6G, 4096M, 50% or infinity`)
  }
  await prepareLaunch()
  if (scoped) process.exit(await launchScoped(memoryMax))
  process.stdout.write(
    wantsScope
      ? 'arena: `systemd-run --user` is not available here, so the run has no memory cap of its own\n'
      : 'arena: --no-scope, so the run has no memory cap of its own\n',
  )
  const runTmp = makeRunTmp({ pid: process.pid })
  process.env['TMPDIR'] = runTmp
  const outcome = await settledRuns()
  await cleanUp(runTmp)
  exitWith(outcome)
}

/** The runs' outcome, a throw included, so the caller can clean up before it is said (PR #746 review). */
async function settledRuns(): Promise<{ readonly passed: boolean } | { readonly error: string }> {
  try {
    return { passed: await startRuns() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Exit as `start` does: a thrown error said the arena's way (exit 1), else 1 when a run failed its score. */
function exitWith(outcome: { readonly passed: boolean } | { readonly error: string }): never {
  if ('error' in outcome) fail(outcome.error)
  process.exit(outcome.passed ? 0 : 1)
}

/**
 * `start` again, as the transient scope `arena-<time>.scope` capped at `memoryMax` (#742); settles
 * with its exit code once it has ended and been cleaned up after. ⚠ The child is its own process
 * group: a Ctrl-C reaches it once, passed on from here, so its first signal is its graceful stop and
 * a second still ends it.
 */
async function launchScoped(memoryMax: string): Promise<number> {
  const unit = `arena-${new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')}.scope`
  const runTmp = makeRunTmp({ pid: process.pid, unit })
  const child = Bun.spawn(scopedCommand(unit, memoryMax, [process.execPath, import.meta.path, 'start', ...rest]), {
    env: { ...process.env, ENSO_ARENA_SCOPE: unit, TMPDIR: runTmp },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  })
  process.stdout.write(`arena: the run is in its own scope, ${unit}, its memory capped at ${memoryMax}\n`)
  for (const signalName of ['SIGINT', 'SIGTERM'] as const) process.on(signalName, () => child.kill(signalName))
  const exit = await child.exited
  await cleanUp(runTmp, { unit, memoryMax })
  return exit
}

/** Each agent's run, one after another; true when every one passed. */
async function startRuns(): Promise<boolean> {
  const ensoModel = ensoModelNamed()
  const agents = agentsNamed()
  const matrix = agents.filter((agent) => agent !== undefined)
  if (matrix.length > 1) {
    // Every model resolves and suits the perception before the first run: a bad third model must
    // not fail after two paid runs.
    for (const agent of new Set(matrix)) await agentModelNamed(agent)
    sayEstimates([...new Set(matrix)])
  }
  const runs: string[] = []
  let passed = true
  for (const agent of agents) {
    const run = await startRun(agent, ensoModel)
    runs.push(run.runDirectory)
    passed &&= run.passed
  }
  if (runs.length > 1) {
    process.stdout.write(
      `arena: ${runs.length} runs done; by model: bun run arena compare --by-model ${runs.join(' ')}\n`,
    )
  }
  return passed
}

async function startRun(
  agent: string | undefined,
  ensoModel: EnsoModelSetting | undefined,
): Promise<{ readonly runDirectory: string; readonly passed: boolean }> {
  if (isGuardedForAgent(outDirectory)) {
    fail(
      `--out ${outDirectory} is under a .enso directory, which the guard keeps Enso's agent out of: ` +
        'it could not read or write its own project there. Name another --out.',
    )
  }
  const named = scenarioNamed()
  const minutes = Number(flag('minutes') ?? named.budgetMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) fail('--minutes takes a positive number')
  // The brief says how long the run has: the run's own budget, not the scenario's default (#609).
  const scenario = { ...named, budgetMinutes: minutes }
  const runId = `${scenario.id}-${new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')}`
  const runDirectory = join(outDirectory, runId)
  const chromiumPath = flag('chromium')
  const context = briefContext(runDirectory)
  const { driver, brief } = await driverNamed(scenario, context, agent)
  const loginAgentDir = arenaLoginDir(process.env)
  if (flag('home') === undefined && arenaLoginProviders(loginAgentDir).length === 0) {
    fail(`the arena has no login yet: run \`bun run arena login\` once (it logs in ${loginAgentDir})`)
  }
  mkdirSync(runDirectory, { recursive: true })
  const home = flag('home') === undefined ? prepareRunHome(runDirectory, operatorHome, loginAgentDir) : operatorHome
  if (ensoModel !== undefined) setRunHomeModel(home, ensoModel)
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
      limits: runLimits(),
      headed: rest.includes('--headed'),
      perception: perceptionNamed(),
      ...(ensoModel === undefined ? {} : { ensoModel: `${ensoModel.provider}/${ensoModel.id}` }),
      environment: process.env,
      ...(chromiumPath === undefined ? {} : { chromiumPath }),
      ...(driver === undefined ? {} : { driver }),
    })
    passed = score?.verdict === 'pass'
  } finally {
    rmSync(currentFile, { force: true })
  }
  return { runDirectory, passed }
}

async function act(): Promise<void> {
  const body = rest.find(
    (argument, index) => !argument.startsWith('--') && !VALUED_FLAG_ARGUMENTS.has(rest[index - 1] ?? ''),
  )
  if (body === undefined) fail(`act takes one JSON action — \`bun run arena brief\` lists them`)
  const runDirectory = flag('run') ?? currentRun()
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
 * pointer, which its `start` never got to clear, goes with it. Throws rather than exits: a launcher
 * recovering a dead run still has its own cleanup to do (#742).
 */
async function refoldRun(runDirectory: string): Promise<void> {
  const runId = runDirectory.split('/').at(-1) ?? 'run'
  const manifestPath = join(runDirectory, 'manifest.json')
  const manifestKept = existsSync(manifestPath)
  const earlier: unknown = manifestKept ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined
  const kept = manifestKept ? keptEvidenceOf(earlier) : undefined
  // ⚠ A manifest is only written once evidence was taken (PR #612 review): one whose evidence does
  // not read is damaged, not a dead recorder's run. Collecting again would read whatever home this
  // command defaults to, since a stopped run left no control record naming its own.
  if (manifestKept && kept === undefined) {
    throw new Error(`${manifestPath} has no evidence that reads as evidence — not refolding over it`)
  }
  const evidence = kept ?? (await collectAfterRecorderDied(runDirectory, operatorHome))
  if (kept === undefined && currentRun() === runDirectory) rmSync(currentFile, { force: true })
  // The home the run recorded, not this shell's; and a hit an earlier scan found stands (PR #613 review).
  // A file the earlier scan stamped and that is unchanged since is not read again (#741).
  const home = runHomeOf(runDirectory, operatorHome, recordedRunHome(runDirectory))
  const scan = scanRunForSecrets(runDirectory, arenaSecretValues(home), recordedScanOf(earlier))
  const secretScan = withEarlierHits(scan, earlier, runDirectory)
  const events = readTimeline(join(runDirectory, 'timeline.jsonl'))
  const histories = threadHistoriesIn(join(runDirectory, 'enso', 'evidence'))
  const manifest = foldArenaManifest({ runId, events, evidence, secretScan, histories })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${manifestPath}\n`)
  scoreRun(runDirectory)
}

function scoreRun(runDirectory: string): void {
  const scored = writeArenaScore(runDirectory)
  process.stdout.write(renderArenaScore(scored))
  process.exitCode = scored.verdict === 'pass' ? 0 : 1
}

/**
 * `publish` (#677): a reviewed run to the corpus — its documents and cited screenshots committed, one
 * issue for the run, a comment on each product issue it maps to. Refused, with every reason, until
 * the run is reviewed and clean; `--dry-run` shows what would go without touching GitHub.
 */
function publish(runDirectory: string): void {
  const secrets = arenaSecretValues(runHomeOf(runDirectory, operatorHome, recordedRunHome(runDirectory)))
  const plan = planArenaPublication(runDirectory, { productRepo: bugRepository(), secretValues: secrets })
  if (plan.kind === 'refused') fail(`not published:\n${plan.reasons.map((reason) => `  - ${reason}`).join('\n')}`)
  const corpus = flag('corpus') ?? DEFAULT_ARENA_CORPUS
  const { publication } = plan
  if (rest.includes('--dry-run')) {
    process.stdout.write(
      [
        `would publish to ${corpus}: ${publication.title}`,
        `labels: ${publication.labels.map((label) => label.name).join(', ')}`,
        `files (${publication.files.length}): ${publication.files.join(', ')}`,
        `would comment on: ${publication.backlinks.map((backlink) => backlink.issue).join(', ') || 'none'}`,
        '',
        publication.issueBody({ corpus, commit: '<commit>' }),
        '',
      ].join('\n'),
    )
    return
  }
  const checkout = join(dirname(outDirectory), 'arena-corpus', ...corpus.split('/'))
  const outcome = publishArenaRun(runDirectory, publication, { corpus, checkout, run: runArenaCommand })
  if (outcome.kind === 'refused') fail(`not published: ${outcome.reasons.join('; ')}`)
  process.stdout.write(
    `arena: published ${publication.runId} at ${outcome.commit.slice(0, 7)}: ${outcome.issue}\n` +
      (outcome.backlinks.length === 0 ? '' : `arena: linked back from ${outcome.backlinks.join(', ')}\n`),
  )
}

/**
 * `login`: pi over the arena's own login directory, for `/login` there (#763). Its own grant, never
 * a copy of the operator's. `--no-session`: Enso migrates sessions it finds in an agent dir into the
 * home's projects, and this directory is every run's.
 */
function login(): void {
  if (!process.stdin.isTTY) fail('arena login runs pi for its /login, so it needs a terminal')
  const loginAgentDir = arenaLoginDir(process.env)
  mkdirSync(loginAgentDir, { recursive: true, mode: 0o700 })
  process.stdout.write(`arena: pi over ${loginAgentDir}: run /login, then /quit\n`)
  const pi = spawnSync('pi', ['--no-session'], {
    stdio: 'inherit',
    cwd: loginAgentDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: loginAgentDir },
  })
  if (pi.error !== undefined) fail(`could not start pi: ${pi.error.message}`)
  const providers = arenaLoginProviders(loginAgentDir)
  if (providers.length === 0) fail('the arena still has no login: nothing was saved in pi')
  process.stdout.write(`arena: logged in: ${providers.join(', ')}\n`)
}

switch (command) {
  case 'container':
    process.exitCode = await runContainerCommand(rest, { repoRoot, defaultOut: outDirectory })
    break
  case 'start':
    await start()
    break
  case 'login':
    login()
    break
  case 'prune': {
    const keep = flag('keep')
    const olderThan = flag('older-than')
    if (keep === undefined && olderThan === undefined) fail('prune takes --keep N, --older-than DAYS, or both')
    const dryRun = rest.includes('--dry-run')
    const pruned = pruneArenaRuns({
      outDirectory,
      dryRun,
      now: new Date(),
      ...(keep === undefined ? {} : { keep: numberFlag('keep', 0) }),
      ...(olderThan === undefined ? {} : { olderThanDays: numberFlag('older-than', 0) }),
    })
    process.stdout.write(`${renderPrunedRuns(pruned, dryRun)}\n`)
    break
  }
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
  case 'manifest': {
    const runDirectory = resolve(rest[0] ?? fail('manifest takes a run directory'))
    await refoldRun(runDirectory).catch((error: unknown) =>
      fail(error instanceof Error ? error.message : String(error)),
    )
    break
  }
  case 'score':
    scoreRun(rest[0] ?? fail('score takes a run directory'))
    break
  case 'compare': {
    // --by-model (#674): any number of runs, grouped by agent model and perception.
    const runDirectories = rest.filter((argument) => argument !== '--by-model').map((argument) => resolve(argument))
    if (rest.includes('--by-model')) {
      if (runDirectories.length === 0) fail('compare --by-model takes the run directories to group')
      process.stdout.write(compareByModel(runDirectories))
      break
    }
    process.stdout.write(
      compareRunDirectories(
        runDirectories[0] ?? fail('compare takes two run directories'),
        runDirectories[1] ?? fail('compare takes two run directories'),
      ),
    )
    break
  }
  case 'report': {
    const runDirectory = resolve(rest[0] ?? fail('report takes a run directory'))
    // Test output is redacted with the run's own secrets, like everything else the run keeps (#610).
    const secrets = arenaSecretValues(runHomeOf(runDirectory, operatorHome, recordedRunHome(runDirectory)))
    writeArenaReport(runDirectory, {
      runTests: rest.includes('--run-tests'),
      path: process.env['PATH'] ?? '/usr/bin:/bin',
      redact: (text) => redactJudgeText(text, secrets),
      bun: process.execPath,
    })
    process.stdout.write(`${join(runDirectory, 'report.md')}\n`)
    break
  }
  case 'publish':
    publish(resolve(rest[0] ?? fail('publish takes a reviewed run directory')))
    break
  default:
    fail(
      'usage: bun run arena start --agent PROVIDER/MODEL | start --agents A,B | start --manual | login | brief | act <json> | manifest <run directory> | score <run directory> | compare <run directory> <run directory> | compare --by-model <run directory>… | report <run directory> [--run-tests] | publish <run directory> [--corpus OWNER/REPO] [--dry-run] | prune --keep N | --older-than DAYS [--dry-run] | container build|credential|start',
    )
}
