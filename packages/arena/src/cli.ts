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
import {
  type ArenaPublication,
  type ArenaPublishOutcome,
  type ArenaPublishPlan,
  DEFAULT_ARENA_CORPUS,
  planArenaPublication,
  publishArenaRun,
  runArenaCommand,
} from './publish.ts'
import {
  type ArenaDriver,
  type ArenaRunOptions,
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

/** A valued flag's value in `argumentList`: the argument after the flag. */
function flagIn(argumentList: readonly string[], name: ValuedFlag): string | undefined {
  const index = argumentList.indexOf(`--${name}`)
  return index === -1 ? undefined : argumentList[index + 1]
}

function flag(name: ValuedFlag): string | undefined {
  return flagIn(rest, name)
}

function fail(message: string): never {
  process.stderr.write(`arena: ${message}\n`)
  process.exit(1)
}

/** Why a command does not go on (#838): decided over the arguments, said by `orFail` as `fail` says it. */
interface ArenaRefusal {
  readonly refusal: string
}

function isRefusal(value: unknown): value is ArenaRefusal {
  return typeof value === 'object' && value !== null && 'refusal' in value
}

/** A decision's value, or its refusal failed the arena's way. */
function orFail<T>(decided: T | ArenaRefusal): T {
  return isRefusal(decided) ? fail(decided.refusal) : decided
}

/** How the agent perceives the page (#680): `--perception tree` (the default) or `visual`. */
function perceptionIn(argumentList: readonly string[]): ArenaPerception | ArenaRefusal {
  const named = flagIn(argumentList, 'perception') ?? 'tree'
  if (named === 'tree' || named === 'visual') return named
  return { refusal: '--perception takes "tree" (it reads the accessibility tree) or "visual" (it sees a screenshot)' }
}

function perceptionNamed(): ArenaPerception {
  return orFail(perceptionIn(rest))
}

function scenarioIn(argumentList: readonly string[]): ArenaScenario | ArenaRefusal {
  const id = flagIn(argumentList, 'scenario') ?? SNAKE_SCENARIO.id
  return ARENA_SCENARIOS[id] ?? { refusal: `no scenario "${id}" — known: ${Object.keys(ARENA_SCENARIOS).join(', ')}` }
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
  // Without a hook's repository variables: run under another repository's hook,
  // the origin read would be that repository's, and bugs would be filed there.
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    env: gitChildEnvironment(),
    encoding: 'utf8',
  })
  return origin.status === 0 ? githubRepositoryOf(origin.stdout) : undefined
}

/** How a run's agent perceived the page (#680): its own `run-start` record when it has one, else `--perception`. */
export function perceptionOf(argumentList: readonly string[], runDirectory?: string): ArenaPerception | ArenaRefusal {
  const timelinePath = runDirectory === undefined ? undefined : join(runDirectory, 'timeline.jsonl')
  if (timelinePath !== undefined && existsSync(timelinePath)) {
    const start = readTimeline(timelinePath).find((event) => event.kind === 'run-start')
    if (start?.kind === 'run-start' && start.perception !== undefined) return start.perception
  }
  return perceptionIn(argumentList)
}

/** What a brief names for this invocation: the `act` command for its `--out`, the run, the repository, the perception. */
function briefContext(runDirectory?: string): ArenaBriefContext {
  const repository = bugRepository()
  return {
    act: arenaActCommand(flag('out') === undefined ? undefined : outDirectory),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    ...(repository === undefined ? {} : { repository }),
    perception: orFail(perceptionOf(rest, runDirectory)),
  }
}

/**
 * How `start` drives a run: by hand over `arena act` (`--manual`), or by the agent `--agent` names at
 * the `--thinking` level (medium by default). One of the two is required: a run with no agent does
 * not hold the UI-only boundary, so it is never the default.
 */
export function driveOf(
  argumentList: readonly string[],
  reference: string | undefined,
):
  | { readonly manual: true }
  | { readonly reference: string; readonly thinking: (typeof ARENA_THINKING_LEVELS)[number] }
  | ArenaRefusal {
  if (argumentList.includes('--manual')) {
    return reference === undefined
      ? { manual: true }
      : { refusal: '--manual and --agent are two ways to drive one run: name one' }
  }
  if (reference === undefined) {
    return {
      refusal:
        'start takes --agent PROVIDER/MODEL (the agent under test, UI only) or --manual (actions over `arena act`)',
    }
  }
  const thinking = ARENA_THINKING_LEVELS.find((level) => level === (flagIn(argumentList, 'thinking') ?? 'medium'))
  return thinking === undefined
    ? { refusal: `--thinking takes one of ${ARENA_THINKING_LEVELS.join(', ')}` }
    : { reference, thinking }
}

/** The agent runner `start` drives the run with, or undefined for `--manual`; and the brief it is given. */
async function driverNamed(
  scenario: ArenaScenario,
  context: ArenaBriefContext,
  reference: string | undefined,
): Promise<{ readonly driver?: ArenaDriver; readonly brief: string }> {
  const drive = orFail(driveOf(rest, reference))
  if ('manual' in drive) return { brief: arenaBrief(scenario, 'command', context) }
  const { model, streamFn } = await agentModelNamed(drive.reference)
  const perception = perceptionNamed()
  const brief = arenaBrief(scenario, 'tool', { perception })
  const driver = arenaAgentDriver({
    model,
    streamFn,
    thinking: drive.thinking,
    brief,
    perception,
    secretValues: arenaSecretValues(operatorHome),
  })
  return { driver, brief }
}

/** The run a `current` file names: the live one, or one whose recorder died before clearing it. */
function currentRunIn(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

/** The run `<out>/current` names. */
function currentRun(): string | undefined {
  return currentRunIn(currentFile)
}

/** What a launch looks at and acts on before a `start`: the host's, or a test's stand-ins (#832). */
export interface ArenaLaunchProbe {
  /** Remove the TMPDIRs killed runs left, naming each (`launch.ts#sweepAbandonedRunTmps`). */
  readonly sweep: () => readonly string[]
  /** The run `<out>/current` names. */
  readonly lastRun: () => string | undefined
  /** Collect a dead recorder's run and stop its stack (`refoldRun`); throws when it cannot. */
  readonly refold: (runDirectory: string) => Promise<void>
  readonly isListening: (port: number) => Promise<boolean>
  readonly portHolder: (port: number) => { readonly pid?: number; readonly command?: string }
  /** What a run would start short of (`launch.ts#headroomShortfalls`). */
  readonly shortfalls: () => readonly string[]
  /** One line on stdout. */
  readonly say: (line: string) => void
}

/**
 * Before a `start` (#742): what an earlier run left is taken back, and a run starts only with its
 * ports free and room to run in — undefined then, else why not. A run whose recorder died (#607) gets
 * its evidence collected and its stack stopped, as `arena manifest` does, rather than a refusal
 * naming the command. ⚠ Before the ports are looked at: its stack is what holds them. A live run, or
 * anything else on the ports, is a refusal naming it.
 */
export async function launchRefusal(probe: ArenaLaunchProbe): Promise<string | undefined> {
  for (const swept of probe.sweep()) probe.say(`arena: removed ${swept}, left by a run that was killed`)
  const last = probe.lastRun()
  const lastRefusal = last === undefined ? undefined : await lastRunRefusal(last, probe)
  if (lastRefusal !== undefined) return lastRefusal
  for (const port of STACK_PORTS) {
    if (await probe.isListening(port)) return portInUseRefusal(port, probe.portHolder(port))
  }
  const shortfalls = probe.shortfalls()
  return shortfalls.length > 0 ? `not enough room to start a run: ${shortfalls.join('; ')}` : undefined
}

/**
 * The last run in a launch's way: refused while it is live; collected first when its recorder died
 * (#607), and refused only when it cannot be collected.
 */
async function lastRunRefusal(
  last: string,
  probe: Pick<ArenaLaunchProbe, 'refold' | 'say'>,
): Promise<string | undefined> {
  const control = readArenaControl(last)
  if (control !== undefined && isRunning(control.pid)) {
    return `a run is live at ${last} (recorder pid ${control.pid}): stop it with its \`stop\` action first`
  }
  if (deadRecorderRun(last) === undefined) return undefined
  probe.say(`arena: the last run's recorder died; collecting its evidence and stopping its stack first — ${last}`)
  try {
    await probe.refold(last)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A port in use refuses a launch, naming what holds it when `ss` could say. */
function portInUseRefusal(port: number, holder: { readonly pid?: number; readonly command?: string }): string {
  const command = holder.command === undefined ? '' : ` (${holder.command})`
  const who = holder.pid === undefined ? '' : ` by pid ${holder.pid}${command}`
  return `port ${port} is in use${who}: the arena starts its own stack`
}

/** `launchRefusal` over this host: a refusal fails the `start` before anything of it begins. */
async function prepareLaunch(): Promise<void> {
  const refusal = await launchRefusal({
    sweep: () => sweepAbandonedRunTmps(),
    lastRun: currentRun,
    refold: refoldAndScore,
    isListening,
    portHolder,
    shortfalls: () => headroomShortfalls(outDirectory),
    say: (line) => {
      process.stdout.write(`${line}\n`)
    },
  })
  if (refusal !== undefined) fail(refusal)
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
 * What `cleanUp` says it found (#742), in one line: what was left in the run's scope and whether it
 * hit its memory cap, whether the ports came free, and how much the runs' TMPDIR held.
 */
export function cleanUpSummary(found: {
  readonly scope:
    | { readonly unit: string; readonly memoryMax: string; readonly stopped: number; readonly result: string }
    | undefined
  readonly portsFree: boolean
  readonly tmpBytes: number
}): string {
  const { scope } = found
  const said = [
    ...(scope === undefined ? [] : [`${scope.stopped} process(es) left in ${scope.unit} stopped`]),
    ...(scope?.result === 'oom-kill' ? [`⚠ the run hit its ${scope.memoryMax} memory cap`] : []),
    found.portsFree ? `ports ${STACK_PORTS.join('/')} free` : `⚠ ports ${STACK_PORTS.join('/')} still in use`,
    `its TMPDIR removed (${sizeOf(found.tmpBytes)})`,
  ]
  return `arena: cleaned up — ${said.join('; ')}`
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
    await refoldAndScore(last).catch((error: unknown) => {
      process.stderr.write(`arena: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }
  const ended = scope === undefined ? undefined : { ...scope, ...endScope(scope.unit) }
  const portsFree = await portsFreeWithin(10_000)
  const tmpBytes = bytesUnder(runTmp)
  rmSync(runTmp, { recursive: true, force: true })
  process.stdout.write(`${cleanUpSummary({ scope: ended, portsFree, tmpBytes })}\n`)
}

/** The agents `start` runs, one run each (#674): `--agents A,B`, else `--agent A`, else none for `--manual`. */
export function agentsIn(argumentList: readonly string[]): readonly (string | undefined)[] | ArenaRefusal {
  const many = flagIn(argumentList, 'agents')
  if (many === undefined) return [flagIn(argumentList, 'agent')]
  if (flagIn(argumentList, 'agent') !== undefined || argumentList.includes('--manual')) {
    return { refusal: '--agents runs one run per agent: drop --agent and --manual' }
  }
  const references = many.split(',').map((reference) => reference.trim())
  // An empty entry (`a,,b`, a trailing comma) is a typo, not a model to skip.
  if (references.some((reference) => reference === '')) {
    return { refusal: `--agents takes PROVIDER/MODEL,PROVIDER/MODEL…, not "${many}"` }
  }
  return references
}

/**
 * The agent's model, resolved and checked against the run's perception — the one check a single
 * run and a matrix's up-front pass both make. A visual agent knows the page only by
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
export function ensoModelIn(argumentList: readonly string[]): EnsoModelSetting | undefined | ArenaRefusal {
  const named = flagIn(argumentList, 'enso-model')
  if (named === undefined) return undefined
  if (flagIn(argumentList, 'home') !== undefined) {
    return { refusal: '--enso-model sets the run home’s own settings; over a shared --home it would change yours' }
  }
  try {
    return parseEnsoModel(named)
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Where `start` runs its runs (#742): in a scope of their own capped at `--memory-max`, where
 * `canScopeHere` (`systemd-run --user`) says it can and `--no-scope` is not given; else here, with
 * the line that says why there is no cap. A cap systemd refuses is a refusal, decided before
 * anything of the launch begins.
 */
export function launchPlanOf(
  argumentList: readonly string[],
  canScopeHere: (memoryMax?: string) => boolean,
):
  | { readonly scoped: true; readonly memoryMax: string }
  | { readonly scoped: false; readonly said: string }
  | ArenaRefusal {
  const memoryMax = flagIn(argumentList, 'memory-max') ?? ARENA_DEFAULT_MEMORY_MAX
  if (argumentList.includes('--no-scope')) {
    return { scoped: false, said: 'arena: --no-scope, so the run has no memory cap of its own' }
  }
  if (!canScopeHere()) {
    return {
      scoped: false,
      said: 'arena: `systemd-run --user` is not available here, so the run has no memory cap of its own',
    }
  }
  if (!canScopeHere(memoryMax)) {
    return {
      refusal: `systemd refuses --memory-max ${memoryMax} as a MemoryMax; it takes values such as 6G, 4096M, 50% or infinity`,
    }
  }
  return { scoped: true, memoryMax }
}

/**
 * `start`: one run, or with `--agents` one run per agent, one after another — the ports are one
 * stack at a time. Exits 1 when any run's score is FAIL.
 *
 * Launched (#742): planned (`launchPlanOf`), then prepared (`prepareLaunch`). A scoped launch runs
 * `start` again as a child in its own memory-capped scope while this process waits outside it to
 * clean up; else the runs run here. Either way they get their own TMPDIR.
 */
async function start(): Promise<void> {
  // The scoped child: its launcher prepared, and cleans up after it.
  if (process.env['ENSO_ARENA_SCOPE'] !== undefined) exitWith(await settledRuns())
  const plan = orFail(launchPlanOf(rest, canScope))
  await prepareLaunch()
  if (plan.scoped) process.exit(await launchScoped(plan.memoryMax))
  process.stdout.write(`${plan.said}\n`)
  const runTmp = makeRunTmp({ pid: process.pid })
  process.env['TMPDIR'] = runTmp
  const outcome = await settledRuns()
  await cleanUp(runTmp)
  exitWith(outcome)
}

/** The runs' outcome, a throw included, so the caller can clean up before it is said. */
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
  const unit = `arena-${stampOf(new Date())}.scope`
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

/** A time as a run id or a scope's name carries it: ISO to the second, its colons dashes. */
function stampOf(time: Date): string {
  return time
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')
}

/** What a matrix of runs does with each agent (#674): the host's steps, or a test's stand-ins. */
export interface ArenaMatrixSteps {
  /** Resolve the agent's model and check it suits the perception; throws or fails when it does not. */
  readonly checkModel: (agent: string) => Promise<unknown>
  readonly sayEstimates: (agents: readonly string[]) => void
  readonly run: (agent: string | undefined) => Promise<{ readonly runDirectory: string; readonly passed: boolean }>
  readonly say: (line: string) => void
}

/** Each agent's run, one after another; true when every one passed. */
export async function runMatrix(agents: readonly (string | undefined)[], steps: ArenaMatrixSteps): Promise<boolean> {
  const matrix = agents.filter((agent) => agent !== undefined)
  if (matrix.length > 1) {
    // Every model resolves and suits the perception before the first run: a bad third model must
    // not fail after two paid runs.
    for (const agent of new Set(matrix)) await steps.checkModel(agent)
    steps.sayEstimates([...new Set(matrix)])
  }
  const runs: string[] = []
  let passed = true
  for (const agent of agents) {
    const run = await steps.run(agent)
    runs.push(run.runDirectory)
    passed &&= run.passed
  }
  if (runs.length > 1) {
    steps.say(`arena: ${runs.length} runs done; by model: bun run arena compare --by-model ${runs.join(' ')}`)
  }
  return passed
}

async function startRuns(): Promise<boolean> {
  const ensoModel = orFail(ensoModelIn(rest))
  return await runMatrix(orFail(agentsIn(rest)), {
    checkModel: agentModelNamed,
    sayEstimates,
    run: (agent) => startRun(agent, ensoModel),
    say: (line) => {
      process.stdout.write(`${line}\n`)
    },
  })
}

/**
 * Where a run goes, and its scenario with the run's own budget (#609) — or why it cannot start:
 * an `--out` the guard keeps Enso's agent out of, an unknown scenario, a budget that is not one.
 */
export function runSetupOf(
  argumentList: readonly string[],
  where: { readonly outDirectory: string; readonly now: Date },
): { readonly scenario: ArenaScenario; readonly runDirectory: string } | ArenaRefusal {
  if (isGuardedForAgent(where.outDirectory)) {
    return {
      refusal:
        `--out ${where.outDirectory} is under a .enso directory, which the guard keeps Enso's agent out of: ` +
        'it could not read or write its own project there. Name another --out.',
    }
  }
  const named = scenarioIn(argumentList)
  if (isRefusal(named)) return named
  const minutes = Number(flagIn(argumentList, 'minutes') ?? named.budgetMinutes)
  if (!Number.isFinite(minutes) || minutes <= 0) return { refusal: '--minutes takes a positive number' }
  // The brief says how long the run has: the run's own budget, not the scenario's default (#609).
  const scenario = { ...named, budgetMinutes: minutes }
  return { scenario, runDirectory: join(where.outDirectory, `${scenario.id}-${stampOf(where.now)}`) }
}

/**
 * A run over its own home signs in with the arena's login (#763), so it does not start without
 * one; a `--home` run uses that home's own.
 */
export function loginRefusalOf(argumentList: readonly string[], loginAgentDir: string): ArenaRefusal | undefined {
  if (flagIn(argumentList, 'home') !== undefined || arenaLoginProviders(loginAgentDir).length > 0) return undefined
  return { refusal: `the arena has no login yet: run \`bun run arena login\` once (it logs in ${loginAgentDir})` }
}

/**
 * The run's prompts, written into it, and the line naming the one to use: the brief, for a run
 * driven by hand; for an agent's run, whose runner has no files to review the run with, the review
 * and bug-filing prompt for afterwards.
 */
export function writePrompts(
  runDirectory: string,
  prompts: { readonly brief: string; readonly context: ArenaBriefContext; readonly driven: boolean },
): string {
  const briefPath = join(runDirectory, 'brief.md')
  writeFileSync(briefPath, prompts.brief)
  if (!prompts.driven) return `arena: the agent's prompt is ${briefPath}`
  const reviewPath = join(runDirectory, 'review-brief.md')
  writeFileSync(reviewPath, arenaReviewBrief(prompts.context, 'other'))
  return `arena: once the run stops, the review and bug-filing prompt is ${reviewPath}`
}

/**
 * What `runArena` is handed for one run: what the run decided, its project in its directory, its
 * budget its scenario's (#609), and the flags that pass through — `--headed`, `--chromium` — with
 * Enso's model as `provider/id` (#674) and the driver only when an agent drives.
 */
export function runOptionsOf(
  argumentList: readonly string[],
  run: Omit<ArenaRunOptions, 'project' | 'budgetMinutes' | 'headed' | 'chromiumPath' | 'ensoModel' | 'driver'> & {
    readonly ensoModel: EnsoModelSetting | undefined
    readonly driver: ArenaDriver | undefined
  },
): ArenaRunOptions {
  const { ensoModel, driver, ...decided } = run
  const chromiumPath = flagIn(argumentList, 'chromium')
  return {
    ...decided,
    project: join(run.runDirectory, 'project'),
    budgetMinutes: run.scenario.budgetMinutes,
    headed: argumentList.includes('--headed'),
    ...(ensoModel === undefined ? {} : { ensoModel: `${ensoModel.provider}/${ensoModel.id}` }),
    ...(chromiumPath === undefined ? {} : { chromiumPath }),
    ...(driver === undefined ? {} : { driver }),
  }
}

/**
 * One run, orchestrated: each step's decision is its own function above; what stays here is
 * their order and the effects — the run home, the `current` pointer, the recorder.
 */
async function startRun(
  agent: string | undefined,
  ensoModel: EnsoModelSetting | undefined,
): Promise<{ readonly runDirectory: string; readonly passed: boolean }> {
  const { scenario, runDirectory } = orFail(runSetupOf(rest, { outDirectory, now: new Date() }))
  const context = briefContext(runDirectory)
  const { driver, brief } = await driverNamed(scenario, context, agent)
  const loginAgentDir = arenaLoginDir(process.env)
  orFail(loginRefusalOf(rest, loginAgentDir))
  mkdirSync(runDirectory, { recursive: true })
  const home = flag('home') === undefined ? prepareRunHome(runDirectory, operatorHome, loginAgentDir) : operatorHome
  if (ensoModel !== undefined) setRunHomeModel(home, ensoModel)
  const said = writePrompts(runDirectory, { brief, context, driven: driver !== undefined })
  writeFileSync(currentFile, runDirectory)
  process.stdout.write(`${said}\n`)
  try {
    const options = runOptionsOf(rest, {
      scenario,
      repoRoot,
      runDirectory,
      home,
      limits: runLimits(),
      perception: perceptionNamed(),
      environment: process.env,
      ensoModel,
      driver,
    })
    const score = await runArena(options)
    return { runDirectory, passed: score?.verdict === 'pass' }
  } finally {
    rmSync(currentFile, { force: true })
  }
}

/**
 * What `act` posts, and where (#832): the one argument that is neither a flag nor a flag's value, as
 * JSON, to the endpoint of the run `--run` names, else the current one — or why it cannot: no action,
 * no run, a run not live, a recorder that died, a run its agent drives (it has no endpoint).
 */
export function actRequestOf(
  argumentList: readonly string[],
  currentRunDirectory: () => string | undefined,
): { readonly port: number; readonly action: unknown } | { readonly refusal: string } {
  const body = argumentList.find(
    (argument, index) => !argument.startsWith('--') && !VALUED_FLAG_ARGUMENTS.has(argumentList[index - 1] ?? ''),
  )
  if (body === undefined) return { refusal: 'act takes one JSON action — `bun run arena brief` lists them' }
  const runDirectory = flagIn(argumentList, 'run') ?? currentRunDirectory()
  if (runDirectory === undefined) return { refusal: 'no live run — start one with `bun run arena start`' }
  const control = readArenaControl(runDirectory)
  if (control === undefined) return { refusal: `the run at ${runDirectory} is not live` }
  if (deadRecorderRun(runDirectory) !== undefined) {
    return {
      refusal:
        `the recorder of the run at ${runDirectory} is gone (pid ${control.pid}) — ` +
        `\`bun run arena manifest ${runDirectory}\` collects its evidence`,
    }
  }
  if (control.port === undefined) {
    return {
      refusal: `the run at ${runDirectory} is driven by its agent: the page takes actions only through the agent's tool`,
    }
  }
  try {
    return { port: control.port, action: JSON.parse(body) }
  } catch {
    return { refusal: 'the action is not JSON' }
  }
}

async function act(): Promise<void> {
  const request = actRequestOf(rest, currentRun)
  if ('refusal' in request) fail(request.refusal)
  const response = await fetch(`http://127.0.0.1:${request.port}/act`, {
    method: 'POST',
    body: JSON.stringify(request.action),
  })
  const answer = (await response.json()) as { readonly ok: boolean }
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`)
  process.exit(answer.ok ? 0 : 1)
}

/** The evidence a manifest kept, row by row; undefined when it kept none that reads as evidence. */
export function keptEvidenceOf(manifest: unknown): ArenaEvidence[] | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('evidence' in manifest)) return undefined
  if (!Array.isArray(manifest.evidence)) return undefined
  const rows: Array<ArenaEvidence | undefined> = manifest.evidence.map(arenaEvidenceRowOf)
  return rows.every((row): row is ArenaEvidence => row !== undefined) ? rows : undefined
}

/** What a refold reads besides the run (#838): the home a run that recorded none falls back to, and `<out>/current`. */
export interface ArenaRefoldPlaces {
  readonly operatorHome: string
  readonly currentFile: string
}

/**
 * Fold a run's manifest again, and answer its path. A run that stopped keeps the evidence its stop
 * collected; one whose recorder died has none, so it is collected now (#584 A13, #607) and the dead
 * run's `current` pointer, which its `start` never got to clear, goes with it. Throws rather than
 * exits: a launcher recovering a dead run still has its own cleanup to do (#742).
 */
export async function refoldRun(runDirectory: string, places: ArenaRefoldPlaces): Promise<string> {
  const runId = runDirectory.split('/').at(-1) ?? 'run'
  const manifestPath = join(runDirectory, 'manifest.json')
  const manifestKept = existsSync(manifestPath)
  const earlier: unknown = manifestKept ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined
  const kept = manifestKept ? keptEvidenceOf(earlier) : undefined
  // ⚠ A manifest is only written once evidence was taken: one whose evidence does
  // not read is damaged, not a dead recorder's run. Collecting again would read whatever home this
  // command defaults to, since a stopped run left no control record naming its own.
  if (manifestKept && kept === undefined) {
    throw new Error(`${manifestPath} has no evidence that reads as evidence — not refolding over it`)
  }
  const evidence = kept ?? (await collectAfterRecorderDied(runDirectory, places.operatorHome))
  if (kept === undefined && currentRunIn(places.currentFile) === runDirectory)
    rmSync(places.currentFile, { force: true })
  // The home the run recorded, not this shell's; and a hit an earlier scan found stands.
  // A file the earlier scan stamped and that is unchanged since is not read again (#741).
  const home = runHomeOf(runDirectory, places.operatorHome, recordedRunHome(runDirectory))
  const scan = scanRunForSecrets(runDirectory, arenaSecretValues(home), recordedScanOf(earlier))
  const secretScan = withEarlierHits(scan, earlier, runDirectory)
  const events = readTimeline(join(runDirectory, 'timeline.jsonl'))
  const histories = threadHistoriesIn(join(runDirectory, 'enso', 'evidence'))
  const manifest = foldArenaManifest({ runId, events, evidence, secretScan, histories })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

/**
 * The run refolded over this invocation's home and `--out`, its manifest path printed, the run
 * scored, and `process.exitCode` set by the verdict. Called by `arena manifest`, by `start` to
 * recover a dead run before a new one, and after a scoped launch ends with its recorder dead.
 */
async function refoldAndScore(runDirectory: string): Promise<void> {
  process.stdout.write(`${await refoldRun(runDirectory, { operatorHome, currentFile })}\n`)
  scoreRun(runDirectory)
}

function scoreRun(runDirectory: string): void {
  const scored = writeArenaScore(runDirectory)
  process.stdout.write(renderArenaScore(scored))
  process.exitCode = scored.verdict === 'pass' ? 0 : 1
}

/**
 * What `publish` does with a run's plan (#677): refuses it with every reason; under `--dry-run`, shows
 * what would go to `--corpus` (the default corpus otherwise) without touching GitHub; else publishes.
 */
export function publishStepOf(
  plan: ArenaPublishPlan,
  argumentList: readonly string[],
): ArenaRefusal | { readonly preview: string } | { readonly publication: ArenaPublication; readonly corpus: string } {
  if (plan.kind === 'refused') {
    return { refusal: `not published:\n${plan.reasons.map((reason) => `  - ${reason}`).join('\n')}` }
  }
  const corpus = flagIn(argumentList, 'corpus') ?? DEFAULT_ARENA_CORPUS
  const { publication } = plan
  if (!argumentList.includes('--dry-run')) return { publication, corpus }
  const preview = [
    `would publish to ${corpus}: ${publication.title}`,
    `labels: ${publication.labels.map((label) => label.name).join(', ')}`,
    `files (${publication.files.length}): ${publication.files.join(', ')}`,
    `would comment on: ${publication.backlinks.map((backlink) => backlink.issue).join(', ') || 'none'}`,
    '',
    publication.issueBody({ corpus, commit: '<commit>' }),
    '',
  ]
  return { preview: preview.join('\n') }
}

/** What `publish` says of what it did (#677): the run's issue at its commit, and the issues linked back from. */
export function publishedSaid(runId: string, outcome: ArenaPublishOutcome): string | ArenaRefusal {
  if (outcome.kind === 'refused') return { refusal: `not published: ${outcome.reasons.join('; ')}` }
  return (
    `arena: published ${runId} at ${outcome.commit.slice(0, 7)}: ${outcome.issue}\n` +
    (outcome.backlinks.length === 0 ? '' : `arena: linked back from ${outcome.backlinks.join(', ')}\n`)
  )
}

/**
 * `publish` (#677): a reviewed run to the corpus — its documents and cited screenshots committed, one
 * issue for the run, a comment on each product issue it maps to. Refused, with every reason, until
 * the run is reviewed and clean.
 */
function publish(runDirectory: string): void {
  const secrets = arenaSecretValues(runHomeOf(runDirectory, operatorHome, recordedRunHome(runDirectory)))
  const plan = planArenaPublication(runDirectory, { productRepo: bugRepository(), secretValues: secrets })
  const step = orFail(publishStepOf(plan, rest))
  if ('preview' in step) {
    process.stdout.write(step.preview)
    return
  }
  const { publication, corpus } = step
  const checkout = join(dirname(outDirectory), 'arena-corpus', ...corpus.split('/'))
  const outcome = publishArenaRun(runDirectory, publication, { corpus, checkout, run: runArenaCommand })
  process.stdout.write(orFail(publishedSaid(publication.runId, outcome)))
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

// Run as a command only (#832): a test imports this file for its decisions without starting the arena.
if (import.meta.main) {
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
        process.stdout.write(arenaBrief(orFail(scenarioIn(rest)), channel, briefContext(flag('run'))))
      }
      break
    case 'act':
      await act()
      break
    case 'manifest': {
      const runDirectory = resolve(rest[0] ?? fail('manifest takes a run directory'))
      await refoldAndScore(runDirectory).catch((error: unknown) =>
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
}
