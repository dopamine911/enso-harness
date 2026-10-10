import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actRequestOf, type ArenaLaunchProbe, cleanUpSummary, launchRefusal } from '../cli.ts'
import { type ArenaControl, controlFilePath } from '../recorder.ts'

/**
 * What the arena's commands decide before they touch a process (#742, #832): whether `start` may
 * launch, what `act` posts and where, what the cleanup says. The runs are directories with the
 * control record a recorder writes; the processes, ports and disk a launch looks at are stand-ins.
 */

/** A pid that is certainly not running: a process that has already exited. */
function exitedPid(): number {
  return spawnSync('true').pid
}

/** A run directory whose control record says `control`, or none at all. */
function runWith(control?: Omit<ArenaControl, 'runDirectory'>): string {
  const runDirectory = mkdtempSync(join(tmpdir(), 'arena-cli-'))
  if (control !== undefined) writeFileSync(controlFilePath(runDirectory), JSON.stringify({ ...control, runDirectory }))
  return runDirectory
}

const READ = '{"action":"read"}'
const noCurrentRun = (): undefined => undefined

test('`act` posts the one argument that is not a flag or a flag’s value, to the live run’s endpoint', () => {
  const live = runWith({ pid: process.pid, driver: 'control', port: 4321 })
  const other = runWith({ pid: process.pid, driver: 'control', port: 9999 })

  expect(actRequestOf([READ], () => live)).toEqual({ port: 4321, action: { action: 'read' } })
  // `--run` names the run over `current`, and its value is never taken for the action.
  expect(actRequestOf(['--run', live, READ], () => other)).toEqual({ port: 4321, action: { action: 'read' } })
  expect(actRequestOf(['--out', '/runs', '--run', live], () => other)).toEqual({
    refusal: 'act takes one JSON action — `bun run arena brief` lists them',
  })
  expect(actRequestOf(['--run', live, 'read'], noCurrentRun)).toEqual({ refusal: 'the action is not JSON' })
})

test('`act` is refused, saying why, with no run, a run not live, a dead recorder, or an agent driving', () => {
  expect(actRequestOf([READ], noCurrentRun)).toEqual({ refusal: 'no live run — start one with `bun run arena start`' })

  const stopped = runWith()
  expect(actRequestOf([READ], () => stopped)).toEqual({ refusal: `the run at ${stopped} is not live` })

  const pid = exitedPid()
  const dead = runWith({ pid, driver: 'control', port: 4321 })
  expect(actRequestOf([READ], () => dead)).toEqual({
    refusal: `the recorder of the run at ${dead} is gone (pid ${pid}) — \`bun run arena manifest ${dead}\` collects its evidence`,
  })

  // ⚠ An agent's run has no endpoint (#584): the agent's tool is the page's only door.
  const driven = runWith({ pid: process.pid, driver: 'agent' })
  expect(actRequestOf([READ], () => driven)).toEqual({
    refusal: `the run at ${driven} is driven by its agent: the page takes actions only through the agent's tool`,
  })
})

/** A launch over stand-ins: every step it takes, in order. */
function launchProbe(overrides: Partial<ArenaLaunchProbe> & { readonly listening?: readonly number[] } = {}): {
  readonly probe: ArenaLaunchProbe
  readonly steps: string[]
} {
  const steps: string[] = []
  const { listening: listeningPorts = [], ...probeOverrides } = overrides
  const listening = new Set(listeningPorts)
  return {
    steps,
    probe: {
      sweep: () => [],
      lastRun: () => undefined,
      refold: (runDirectory) => {
        steps.push(`refold ${runDirectory}`)
        return Promise.resolve()
      },
      isListening: (port) => {
        steps.push(`port ${port}?`)
        return Promise.resolve(listening.has(port))
      },
      portHolder: () => ({}),
      shortfalls: () => {
        steps.push('headroom?')
        return []
      },
      say: (line) => steps.push(line),
      ...probeOverrides,
    },
  }
}

test('a launch with nothing in its way says what it swept and checks both ports, then the room to run', async () => {
  const { probe, steps } = launchProbe({ sweep: () => ['/tmp/arena-run-1'], lastRun: () => runWith() })
  expect(await launchRefusal(probe)).toBeUndefined()
  expect(steps).toEqual([
    'arena: removed /tmp/arena-run-1, left by a run that was killed',
    'port 5178?',
    'port 5179?',
    'headroom?',
  ])
})

test('a live run refuses the launch, naming it and its recorder, before anything is collected or looked at', async () => {
  const live = runWith({ pid: process.pid, driver: 'agent' })
  const { probe, steps } = launchProbe({ lastRun: () => live })
  expect(await launchRefusal(probe)).toBe(
    `a run is live at ${live} (recorder pid ${process.pid}): stop it with its \`stop\` action first`,
  )
  expect(steps).toEqual([])
})

test('⚠ a run whose recorder died is collected — its stack stopped — before the ports are looked at (#607)', async () => {
  const dead = runWith({ pid: exitedPid(), driver: 'agent' })
  const { probe, steps } = launchProbe({ lastRun: () => dead })
  expect(await launchRefusal(probe)).toBeUndefined()
  expect(steps).toEqual([
    `arena: the last run's recorder died; collecting its evidence and stopping its stack first — ${dead}`,
    `refold ${dead}`,
    'port 5178?',
    'port 5179?',
    'headroom?',
  ])

  // A run that cannot be collected refuses the launch with why, and nothing after it runs.
  const damaged = launchProbe({
    lastRun: () => dead,
    refold: () => Promise.reject(new Error(`${dead}/manifest.json has no evidence that reads as evidence`)),
  })
  expect(await launchRefusal(damaged.probe)).toBe(`${dead}/manifest.json has no evidence that reads as evidence`)
  expect(damaged.steps).toEqual([
    `arena: the last run's recorder died; collecting its evidence and stopping its stack first — ${dead}`,
  ])
})

test('a port in use refuses the launch, naming what holds it when that can be said', async () => {
  const held = launchProbe({ listening: [5178], portHolder: () => ({ pid: 4242, command: 'bun run dev /work' }) })
  expect(await launchRefusal(held.probe)).toBe(
    'port 5178 is in use by pid 4242 (bun run dev /work): the arena starts its own stack',
  )
  expect(held.steps).toEqual(['port 5178?'])

  const noCommand = launchProbe({ listening: [5179], portHolder: () => ({ pid: 4242 }) })
  expect(await launchRefusal(noCommand.probe)).toBe('port 5179 is in use by pid 4242: the arena starts its own stack')

  const unknown = launchProbe({ listening: [5179] })
  expect(await launchRefusal(unknown.probe)).toBe('port 5179 is in use: the arena starts its own stack')
})

test('a launch short of room is refused with every shortfall', async () => {
  const { probe } = launchProbe({
    shortfalls: () => [
      'only 900 MB memory available; a run needs 4.0 GB',
      'only 2 MB free in /tmp; a run needs 1.0 GB',
    ],
  })
  expect(await launchRefusal(probe)).toBe(
    'not enough room to start a run: only 900 MB memory available; a run needs 4.0 GB; only 2 MB free in /tmp; a run needs 1.0 GB',
  )
})

test('the cleanup line says what the scope held and how it ended, whether the ports came free, and the TMPDIR’s size (#742)', () => {
  expect(cleanUpSummary({ scope: undefined, portsFree: true, tmpBytes: 3 * 2 ** 20 })).toBe(
    'arena: cleaned up — ports 5178/5179 free; its TMPDIR removed (3 MB)',
  )
  expect(
    cleanUpSummary({
      scope: { unit: 'arena-2026-10-10T12-00-00Z.scope', memoryMax: '6G', stopped: 2, result: 'oom-kill' },
      portsFree: false,
      tmpBytes: 1.5 * 2 ** 30,
    }),
  ).toBe(
    'arena: cleaned up — 2 process(es) left in arena-2026-10-10T12-00-00Z.scope stopped; ' +
      '⚠ the run hit its 6G memory cap; ⚠ ports 5178/5179 still in use; its TMPDIR removed (1.5 GB)',
  )
  // A scope that ended on its own is no cap hit.
  expect(
    cleanUpSummary({
      scope: { unit: 'arena-x.scope', memoryMax: '6G', stopped: 0, result: 'success' },
      portsFree: true,
      tmpBytes: 0,
    }),
  ).toBe(
    'arena: cleaned up — 0 process(es) left in arena-x.scope stopped; ports 5178/5179 free; its TMPDIR removed (0 MB)',
  )
})
