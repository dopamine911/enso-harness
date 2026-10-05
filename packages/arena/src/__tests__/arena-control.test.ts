import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_LOG_EVENTS } from '@enso/core'
import { ensoLogsDir } from '@enso/core/paths'
import { describeArenaAction, parseArenaAction, typedSecretRefusal } from '../actions.ts'
import { ARENA_STOP, type ArenaBounds, type ArenaRunControl, createRunControl, ensoSpendUsd } from '../run-control.ts'

/**
 * When an arena run stops besides the agent's own `stop` (#609): the budget and its grace window,
 * the idle, restart and cost bounds, each with its own reason. The clock is a number this file
 * moves: the recorder's one-second tick is `tick()`, called here when the time has come.
 */

const MINUTE = 60_000

/** A run control over a clock this test owns, recording what it was told. */
interface Controlled {
  readonly control: ArenaRunControl
  readonly stops: string[]
  readonly graces: () => number
  readonly at: (ms: number) => void
}

function controlled(bounds: Partial<ArenaBounds>, readCost?: () => number): Controlled {
  let clock = 0
  const stops: string[] = []
  let graces = 0
  const control = createRunControl({
    bounds: { budgetMs: 10 * MINUTE, graceMs: MINUTE, maxRestarts: 3, ...bounds },
    onGrace: () => {
      graces += 1
    },
    onStop: (reason) => stops.push(reason),
    now: () => clock,
    ...(readCost === undefined ? {} : { readCost }),
  })
  return {
    control,
    stops,
    graces: (): number => graces,
    at: (ms: number): void => {
      clock = ms
      control.tick()
    },
  }
}

test('⚠ the budget opens a grace window: time left is said, only a note and stop are taken, then the run stops (#609)', () => {
  const run = controlled({})
  run.at(4 * MINUTE)
  expect(run.control.phase()).toEqual({ phase: 'running', remainingMs: 6 * MINUTE })
  expect(run.control.refusal('click')).toBeUndefined()

  run.at(10 * MINUTE + 15_000)
  expect(run.control.phase()).toEqual({ phase: 'grace', remainingMs: 45_000 })
  expect(run.graces()).toBe(1)
  expect(run.control.refusal('note')).toBeUndefined()
  expect(run.control.refusal('stop')).toBeUndefined()
  expect(run.control.refusal('click')).toContain('only a note (your retrospective) and stop')
  expect(run.stops).toEqual([])

  run.at(10 * MINUTE + 30_000)
  expect(run.graces()).toBe(1)
  run.at(11 * MINUTE)
  expect(run.stops).toEqual([ARENA_STOP.budget(10 * MINUTE)])
  // The words the score already reads for a budget stop.
  expect(run.stops[0]).toBe('budget: 10 minutes')
})

test('⚠ no action for the idle bound stops the run with its own reason; any action starts the clock again (#609)', () => {
  const run = controlled({ idleMs: 5 * MINUTE })
  run.at(4 * MINUTE)
  run.control.acted()
  run.at(8 * MINUTE)
  expect(run.stops).toEqual([])
  run.at(9 * MINUTE)
  expect(run.stops).toEqual(['idle: no action for 5 minutes'])
})

test('without an idle bound, a quiet run waits for its budget', () => {
  const run = controlled({})
  run.at(9 * MINUTE)
  expect(run.stops).toEqual([])
})

test('⚠ a restart past the limit is refused and stops the run (#609)', () => {
  const run = controlled({ maxRestarts: 2 })
  expect(run.control.restart()).toBeUndefined()
  expect(run.control.restart()).toBeUndefined()
  expect(run.stops).toEqual([])
  expect(run.control.restart()).toContain('restarted 2 times')
  expect(run.stops).toEqual(['restart limit: Enso was restarted 2 times'])
})

test('⚠ Enso’s spend over the bound stops the run, read at most every 30 s (#609)', () => {
  let spent = 4
  let reads = 0
  const run = controlled({ maxCostUsd: 5 }, () => {
    reads += 1
    return spent
  })
  run.at(10_000)
  expect(reads).toBe(0)
  run.at(30_000)
  expect(reads).toBe(1)
  spent = 5.5
  run.at(45_000)
  expect(run.stops).toEqual([])
  run.at(60_000)
  expect(run.stops).toEqual(['cost limit: Enso spent $5.50, over the $5.00 bound'])
})

test('Enso’s spend is its own Stats fold over every day file in the home’s logs; a torn line is not a record', () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-spend-'))
  mkdirSync(ensoLogsDir(home), { recursive: true })
  const usage = (totalCost: number, at: string): string =>
    JSON.stringify({
      '@timestamp': at,
      level: 'INFO',
      logger: 'enso.web.server',
      message: ENSO_LOG_EVENTS.messageUsage,
      properties: { role: 'assistant', input: 10, output: 5, totalCost, model: 'm' },
    })
  writeFileSync(
    join(ensoLogsDir(home), 'enso-2026-10-05.jsonl'),
    `${usage(1.25, '2026-10-05T23:59:00.000Z')}\n{"torn": \n${usage(0.5, '2026-10-05T23:59:30.000Z')}\n`,
  )
  writeFileSync(join(ensoLogsDir(home), 'enso-2026-10-06.jsonl'), `${usage(2, '2026-10-06T00:01:00.000Z')}\n`)
  writeFileSync(join(ensoLogsDir(home), 'notes.txt'), usage(100, '2026-10-06T00:02:00.000Z'))
  expect(ensoSpendUsd(home)).toBeCloseTo(3.75)
  expect(ensoSpendUsd(join(home, 'no-such-home'))).toBe(0)
})

test('a native dialog is answered by its own actions; a prompt’s text is checked like anything typed (#609)', () => {
  expect(parseArenaAction({ action: 'accept-dialog' })).toEqual({ ok: true, action: { action: 'accept-dialog' } })
  expect(parseArenaAction({ action: 'accept-dialog', text: 'Snake' })).toEqual({
    ok: true,
    action: { action: 'accept-dialog', text: 'Snake' },
  })
  expect(parseArenaAction({ action: 'accept-dialog', text: 3 })).toMatchObject({ ok: false })
  expect(parseArenaAction({ action: 'dismiss-dialog' })).toEqual({ ok: true, action: { action: 'dismiss-dialog' } })

  const secret = 'sk-ant-api-notarealkey-0123456789'
  const typed = { action: 'accept-dialog', text: secret } as const
  expect(typedSecretRefusal(typed, [secret])).toContain('refused')
  expect(describeArenaAction(typed, [secret])).not.toContain(secret)
})
