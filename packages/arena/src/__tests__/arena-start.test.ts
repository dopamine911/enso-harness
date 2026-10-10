import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentsIn,
  type ArenaMatrixSteps,
  driveOf,
  ensoModelIn,
  launchPlanOf,
  loginRefusalOf,
  perceptionOf,
  runMatrix,
  runOptionsOf,
  runSetupOf,
  writePrompts,
} from '../cli.ts'
import type { ArenaDriver } from '../recorder.ts'
import { SNAKE_SCENARIO } from '../scenario.ts'
import { openTimeline } from '../timeline.ts'

/**
 * What `arena start` decides from its arguments before anything of a run begins (#838): which
 * agents run and how, where the runs go and for how long, whether they get a scope of their own,
 * what the recorder is handed. A refusal is what `start` fails with, word for word.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), 'arena-start-'))

test('a run’s own record of how its agent perceived the page wins over `--perception`; without one the flag decides, tree by default (#680)', () => {
  const run = scratch()
  const timeline = openTimeline(join(run, 'timeline.jsonl'))
  timeline.record({ kind: 'run-start', scenario: 'snake', project: join(run, 'project'), perception: 'visual' })
  // A bad flag does not matter once the run says how it was perceived.
  expect(perceptionOf(['--perception', 'smell'], run)).toBe('visual')

  const before680 = scratch()
  openTimeline(join(before680, 'timeline.jsonl')).record({
    kind: 'run-start',
    scenario: 'snake',
    project: join(before680, 'project'),
  })
  expect(perceptionOf(['--perception', 'visual'], before680)).toBe('visual')
  expect(perceptionOf([], scratch())).toBe('tree')
  expect(perceptionOf([])).toBe('tree')
  expect(perceptionOf(['--perception', 'smell'])).toEqual({
    refusal: '--perception takes "tree" (it reads the accessibility tree) or "visual" (it sees a screenshot)',
  })
})

test('a run is driven by hand or by one agent at a known thinking level, medium unless named; never neither, never both', () => {
  expect(driveOf(['--manual'], undefined)).toEqual({ manual: true })
  expect(driveOf([], 'anthropic/claude-test')).toEqual({ reference: 'anthropic/claude-test', thinking: 'medium' })
  expect(driveOf(['--thinking', 'high'], 'anthropic/claude-test')).toEqual({
    reference: 'anthropic/claude-test',
    thinking: 'high',
  })
  expect(driveOf(['--manual'], 'anthropic/claude-test')).toEqual({
    refusal: '--manual and --agent are two ways to drive one run: name one',
  })
  expect(driveOf([], undefined)).toEqual({
    refusal:
      'start takes --agent PROVIDER/MODEL (the agent under test, UI only) or --manual (actions over `arena act`)',
  })
  expect(driveOf(['--thinking', 'deep'], 'anthropic/claude-test')).toEqual({
    refusal: '--thinking takes one of off, minimal, low, medium, high, xhigh, max',
  })
})

test('`--agents` names one run per agent, trimmed; without it `--agent` is the one run, or a manual run (#674)', () => {
  expect(agentsIn(['--agents', 'a/one, b/two'])).toEqual(['a/one', 'b/two'])
  expect(agentsIn(['--agent', 'a/one'])).toEqual(['a/one'])
  expect(agentsIn(['--manual'])).toEqual([undefined])
  const both = { refusal: '--agents runs one run per agent: drop --agent and --manual' }
  expect(agentsIn(['--agents', 'a/one,b/two', '--agent', 'a/one'])).toEqual(both)
  expect(agentsIn(['--agents', 'a/one,b/two', '--manual'])).toEqual(both)
  // An empty entry is a typo, not a model to skip.
  expect(agentsIn(['--agents', 'a/one,,b/two'])).toEqual({
    refusal: '--agents takes PROVIDER/MODEL,PROVIDER/MODEL…, not "a/one,,b/two"',
  })
  expect(agentsIn(['--agents', 'a/one,'])).toMatchObject({ refusal: expect.stringContaining('"a/one,"') })
})

test('`--enso-model` sets the run home’s model as provider and id; over a shared `--home` it is refused (#674)', () => {
  expect(ensoModelIn([])).toBeUndefined()
  expect(ensoModelIn(['--enso-model', 'openrouter/vendor/model'])).toEqual({
    provider: 'openrouter',
    id: 'vendor/model',
  })
  expect(ensoModelIn(['--enso-model', 'a/b', '--home', '/somewhere'])).toEqual({
    refusal: '--enso-model sets the run home’s own settings; over a shared --home it would change yours',
  })
  expect(ensoModelIn(['--enso-model', 'no-slash'])).toEqual({
    refusal: 'an Enso model is provider/id, not "no-slash"',
  })
})

/** A `canScope` stand-in: what systemd answers, and every cap it was asked about (`undefined`: none). */
function systemd(answers: { readonly scopes: boolean; readonly takesCap: boolean }): {
  readonly canScope: (memoryMax?: string) => boolean
  readonly asked: (string | undefined)[]
} {
  const asked: (string | undefined)[] = []
  return {
    asked,
    canScope: (memoryMax) => {
      asked.push(memoryMax)
      return memoryMax === undefined ? answers.scopes : answers.takesCap
    },
  }
}

test('a launch is scoped at `--memory-max` (6G by default) where systemd scopes and takes the cap; a cap it refuses is a refusal (#742)', () => {
  const scoping = systemd({ scopes: true, takesCap: true })
  expect(launchPlanOf([], scoping.canScope)).toEqual({ scoped: true, memoryMax: '6G' })
  expect(scoping.asked).toEqual([undefined, '6G'])
  expect(launchPlanOf(['--memory-max', '4096M'], scoping.canScope)).toEqual({ scoped: true, memoryMax: '4096M' })

  expect(launchPlanOf(['--memory-max', '6GB'], systemd({ scopes: true, takesCap: false }).canScope)).toEqual({
    refusal: 'systemd refuses --memory-max 6GB as a MemoryMax; it takes values such as 6G, 4096M, 50% or infinity',
  })
})

test('a launch with no scope says why: `--no-scope` asks systemd nothing, so even a cap it would refuse goes unchecked (#742)', () => {
  const asked = systemd({ scopes: true, takesCap: false })
  expect(launchPlanOf(['--no-scope', '--memory-max', '6GB'], asked.canScope)).toEqual({
    scoped: false,
    said: 'arena: --no-scope, so the run has no memory cap of its own',
  })
  expect(asked.asked).toEqual([])

  const absent = systemd({ scopes: false, takesCap: false })
  expect(launchPlanOf(['--memory-max', '6GB'], absent.canScope)).toEqual({
    scoped: false,
    said: 'arena: `systemd-run --user` is not available here, so the run has no memory cap of its own',
  })
  expect(absent.asked).toEqual([undefined])
})

/** A matrix over stand-ins: every step it took, in order; `failing` fails its run's score, `unknown` its model check. */
function matrixSteps(options: { readonly failing?: string; readonly unknown?: string } = {}): {
  readonly steps: ArenaMatrixSteps
  readonly taken: string[]
} {
  const taken: string[] = []
  return {
    taken,
    steps: {
      checkModel: async (agent) => {
        taken.push(`check ${agent}`)
        if (agent === options.unknown) throw new Error(`no model "${agent}"`)
      },
      sayEstimates: (agents) => taken.push(`estimate ${agents.join(' ')}`),
      run: async (agent) => {
        taken.push(`run ${agent ?? 'manual'}`)
        return {
          runDirectory: `/runs/${agent ?? 'manual'}`,
          passed: options.failing === undefined || agent !== options.failing,
        }
      },
      say: (line) => taken.push(line),
    },
  }
}

test('⚠ a matrix checks every distinct model and says its estimates before the first paid run; a bad model fails it before any (#674)', async () => {
  const { steps, taken } = matrixSteps({ unknown: 'c/three' })
  await expect(runMatrix(['a/one', 'b/two', 'c/three'], steps)).rejects.toThrow('no model "c/three"')
  expect(taken).toEqual(['check a/one', 'check b/two', 'check c/three'])

  const twice = matrixSteps()
  expect(await runMatrix(['a/one', 'b/two', 'a/one'], twice.steps)).toBe(true)
  expect(twice.taken).toEqual([
    'check a/one',
    'check b/two',
    'estimate a/one b/two',
    'run a/one',
    'run b/two',
    'run a/one',
    'arena: 3 runs done; by model: bun run arena compare --by-model /runs/a/one /runs/b/two /runs/a/one',
  ])
})

test('a matrix passes only when every run passed, and runs the rest after one fails', async () => {
  const { steps, taken } = matrixSteps({ failing: 'a/one' })
  expect(await runMatrix(['a/one', 'b/two'], steps)).toBe(false)
  expect(taken.filter((step) => step.startsWith('run '))).toEqual(['run a/one', 'run b/two'])
})

test('one run, by an agent or by hand, is just run: no model check, no estimate, no compare line', async () => {
  for (const agents of [['a/one'], [undefined]]) {
    const { steps, taken } = matrixSteps()
    expect(await runMatrix(agents, steps)).toBe(true)
    expect(taken).toEqual([`run ${agents[0] ?? 'manual'}`])
  }
})

test('a run goes under `--out`, named by its scenario and start time, with `--minutes` as its budget (#609)', () => {
  const out = scratch()
  const now = new Date('2026-10-10T09:08:07.654Z')
  const setup = runSetupOf(['--minutes', '45'], { outDirectory: out, now })
  expect(setup).toEqual({
    scenario: { ...SNAKE_SCENARIO, budgetMinutes: 45 },
    runDirectory: join(out, 'snake-2026-10-10T09-08-07Z'),
  })
  expect(runSetupOf([], { outDirectory: out, now })).toMatchObject({
    scenario: { id: 'snake', budgetMinutes: SNAKE_SCENARIO.budgetMinutes },
  })
})

test('a run is refused under a guarded `--out`, for an unknown scenario, or with a budget that is not a positive number', () => {
  const now = new Date()
  const guarded = join(scratch(), '.enso', 'arena')
  expect(runSetupOf([], { outDirectory: guarded, now })).toEqual({
    refusal:
      `--out ${guarded} is under a .enso directory, which the guard keeps Enso's agent out of: ` +
      'it could not read or write its own project there. Name another --out.',
  })
  const out = scratch()
  expect(runSetupOf(['--scenario', 'chess'], { outDirectory: out, now })).toMatchObject({
    refusal: expect.stringMatching(/^no scenario "chess" — known: .*snake/),
  })
  for (const minutes of ['0', '-5', 'soon']) {
    expect(runSetupOf(['--minutes', minutes], { outDirectory: out, now })).toEqual({
      refusal: '--minutes takes a positive number',
    })
  }
})

test('a run over its own home needs the arena’s login; a `--home` run does not look for one (#763)', () => {
  const loginAgentDir = scratch()
  expect(loginRefusalOf([], loginAgentDir)).toEqual({
    refusal: `the arena has no login yet: run \`bun run arena login\` once (it logs in ${loginAgentDir})`,
  })
  expect(loginRefusalOf(['--home', '/operator'], loginAgentDir)).toBeUndefined()
  writeFileSync(join(loginAgentDir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'k' } }))
  expect(loginRefusalOf([], loginAgentDir)).toBeUndefined()
})

test('a run by hand gets its brief and names it; an agent’s run also gets the review prompt for afterwards, and names that', () => {
  const context = { runDirectory: '/runs/snake-1', perception: 'tree' as const }
  const byHand = scratch()
  expect(writePrompts(byHand, { brief: 'the brief', context, driven: false })).toBe(
    `arena: the agent's prompt is ${join(byHand, 'brief.md')}`,
  )
  expect(readFileSync(join(byHand, 'brief.md'), 'utf8')).toBe('the brief')
  expect(existsSync(join(byHand, 'review-brief.md'))).toBe(false)

  const driven = scratch()
  expect(writePrompts(driven, { brief: 'the brief', context, driven: true })).toBe(
    `arena: once the run stops, the review and bug-filing prompt is ${join(driven, 'review-brief.md')}`,
  )
  expect(readFileSync(join(driven, 'brief.md'), 'utf8')).toBe('the brief')
  expect(readFileSync(join(driven, 'review-brief.md'), 'utf8')).toContain('/runs/snake-1')
})

test('the recorder gets the run’s project, its budget, `--headed` and `--chromium`, Enso’s model as provider/id, and a driver only when an agent drives', () => {
  const runDirectory = join(scratch(), 'snake-1')
  mkdirSync(runDirectory)
  const scenario = { ...SNAKE_SCENARIO, budgetMinutes: 30 }
  const run = {
    scenario,
    repoRoot: '/repo',
    runDirectory,
    home: '/home/run',
    limits: { maxRestarts: 3 },
    perception: 'visual' as const,
    environment: { PATH: '/usr/bin' },
  }
  const driver: ArenaDriver = async () => 'it stopped the run'

  const plain = runOptionsOf([], { ...run, ensoModel: undefined, driver: undefined })
  // Strict: an option not given is absent, not present as undefined.
  expect(plain).toStrictEqual({ ...run, project: join(runDirectory, 'project'), budgetMinutes: 30, headed: false })

  const everything = runOptionsOf(['--headed', '--chromium', '/opt/chromium'], {
    ...run,
    ensoModel: { provider: 'openrouter', id: 'vendor/model' },
    driver,
  })
  expect(everything).toMatchObject({
    headed: true,
    chromiumPath: '/opt/chromium',
    ensoModel: 'openrouter/vendor/model',
  })
  expect(everything.driver).toBe(driver)
})
