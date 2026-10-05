import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayStats, EnsoLogLine } from '@enso/core'
import { ensoLogsDir } from '@enso/core/paths'
import { Check } from 'typebox/value'
import type { ArenaAction } from './actions.ts'

/**
 * When an arena run stops, besides the agent's own `stop` (#584 A5, A6; #609): its clock and its
 * bounds, kept apart from the recorder so each is checked by a call, not a browser.
 *
 * ⚠ THE BUDGET HAS A GRACE WINDOW. The brief asks for a retrospective "when you are finished — or
 * out of time", and when the budget ended the run on the spot, a retrospective written at the
 * deadline was refused with the run. Now the budget opens `ARENA_GRACE_MS` in which only `note` and
 * `stop` are taken, and every answer says how long is left, so the agent can see the end coming.
 *
 * ⚠ EACH BOUND IS ITS OWN STOP REASON (`ARENA_STOP`), so the manifest says which one ended the run:
 *   • idle — no action, refused ones included, for `idleMs`: an agent stuck in a model call, or a
 *     manual run left open;
 *   • restarts — a `restart-enso` past `maxRestarts`: Enso that keeps dying is the finding, and a
 *     loop of restarts only burns the budget;
 *   • cost — Enso's own spend, from the run home's logs, past `maxCostUsd`. Only the run's own home
 *     (#610) is the run's spend: over a shared `--home` the bound is off. The agent under test's own
 *     model calls are not in Enso's logs and are not counted.
 */

/** How long after the budget a retrospective is still taken. */
export const ARENA_GRACE_MS = 60_000
/** How often Enso's spend is read: the logs are folded whole, so not on every tick. */
const COST_CHECK_MS = 30_000

/** The run's bounds. An absent bound is off. */
export interface ArenaBounds {
  readonly budgetMs: number
  readonly graceMs: number
  readonly idleMs?: number
  readonly maxRestarts: number
  readonly maxCostUsd?: number
}

/** Where the run is: before the budget, in its grace window, or over. */
export type ArenaPhase =
  | { readonly phase: 'running'; readonly remainingMs: number }
  | { readonly phase: 'grace'; readonly remainingMs: number }
  | { readonly phase: 'over' }

/** The stop reasons a bound gives; `budget` keeps the words the score already reads. */
export const ARENA_STOP = {
  budget: (budgetMs: number): string => `budget: ${budgetMs / 60_000} minutes`,
  idle: (idleMs: number): string => `idle: no action for ${idleMs / 60_000} minutes`,
  restarts: (maxRestarts: number): string => `restart limit: Enso was restarted ${maxRestarts} times`,
  cost: (spentUsd: number, maxCostUsd: number): string =>
    `cost limit: Enso spent $${spentUsd.toFixed(2)}, over the $${maxCostUsd.toFixed(2)} bound`,
} as const

/** The prefixes of the bound stops other than the budget, for the score to tell them apart. */
export const ARENA_BOUND_STOP_PREFIXES = ['idle:', 'restart limit:', 'cost limit:'] as const

/** What the grace window takes: the retrospective, and the stop. */
const GRACE_ACTIONS: ReadonlySet<ArenaAction['action']> = new Set(['note', 'stop'])

export interface ArenaRunControl {
  /** Where the run is now, with the time left in this phase. */
  readonly phase: () => ArenaPhase
  /** An action arrived, taken or not: the idle clock starts again. */
  readonly acted: () => void
  /** Why this action is refused now — only `note` and `stop` in the grace window — or undefined. */
  readonly refusal: (action: ArenaAction['action']) => string | undefined
  /** Before a `restart-enso`: undefined and counted, or the refusal — and the run stops at the limit. */
  readonly restart: () => string | undefined
  /** Check the clock and the bounds; the recorder calls it every second. */
  readonly tick: () => void
}

/**
 * The run's control, started now. `onGrace` is called once when the budget is spent; `onStop` with
 * the reason when the run must stop — the recorder's own stop takes the first reason it is given.
 */
export function createRunControl(options: {
  readonly bounds: ArenaBounds
  readonly onGrace: () => void
  readonly onStop: (reason: string) => void
  readonly readCost?: () => number
  readonly now?: () => number
}): ArenaRunControl {
  const { bounds } = options
  const now = options.now ?? Date.now
  const startedAt = now()
  let lastActionAt = startedAt
  let lastCostCheckAt = startedAt
  let restarts = 0
  let graceOpened = false

  const phase = (): ArenaPhase => {
    const elapsed = now() - startedAt
    if (elapsed < bounds.budgetMs) return { phase: 'running', remainingMs: bounds.budgetMs - elapsed }
    if (elapsed < bounds.budgetMs + bounds.graceMs) {
      return { phase: 'grace', remainingMs: bounds.budgetMs + bounds.graceMs - elapsed }
    }
    return { phase: 'over' }
  }

  const checkCost = (at: number): void => {
    if (bounds.maxCostUsd === undefined || options.readCost === undefined) return
    if (at - lastCostCheckAt < COST_CHECK_MS) return
    lastCostCheckAt = at
    const spent = options.readCost()
    if (spent > bounds.maxCostUsd) options.onStop(ARENA_STOP.cost(spent, bounds.maxCostUsd))
  }

  return {
    phase,
    acted: () => {
      lastActionAt = now()
    },
    refusal: (action) =>
      phase().phase === 'grace' && !GRACE_ACTIONS.has(action)
        ? 'the budget is spent: only a note (your retrospective) and stop are taken now'
        : undefined,
    restart: () => {
      if (restarts >= bounds.maxRestarts) {
        options.onStop(ARENA_STOP.restarts(bounds.maxRestarts))
        return `refused: Enso has been restarted ${bounds.maxRestarts} times, the run's limit — the run stops`
      }
      restarts += 1
      return undefined
    },
    tick: () => {
      const at = now()
      const current = phase()
      if (current.phase === 'over') {
        options.onStop(ARENA_STOP.budget(bounds.budgetMs))
        return
      }
      if (current.phase === 'grace' && !graceOpened) {
        graceOpened = true
        options.onGrace()
      }
      if (bounds.idleMs !== undefined && at - lastActionAt >= bounds.idleMs) {
        options.onStop(ARENA_STOP.idle(bounds.idleMs))
        return
      }
      checkCost(at)
    },
  }
}

/**
 * What Enso has spent in `home`, in dollars: every day file under its logs, folded by core's own
 * Stats fold (`dayStats`), summed. A line that is not a log record is counted malformed, as the
 * fold's own reader counts it.
 */
export function ensoSpendUsd(home: string): number {
  const directory = ensoLogsDir(home)
  if (!existsSync(directory)) return 0
  return readdirSync(directory)
    .filter((fileName) => /^enso-\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName))
    .reduce((total, fileName) => {
      const lines: EnsoLogLine[] = []
      let malformed = 0
      for (const recordText of readFileSync(join(directory, fileName), 'utf8').split('\n')) {
        if (recordText.trim().length === 0) continue
        const parsed = parsedOrUndefined(recordText)
        if (Check(EnsoLogLine, parsed)) lines.push(parsed)
        else malformed += 1
      }
      return total + dayStats(fileName.slice(5, 15), lines, malformed).totals.cost
    }, 0)
}

function parsedOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
