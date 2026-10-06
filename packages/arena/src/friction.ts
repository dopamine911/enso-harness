import type { ArenaEvent } from './timeline.ts'

/**
 * Friction the recorder SAW (#556 B3, #611): patterns in the timeline that cost the driver time or
 * attention, whatever the agent wrote about them. The agent's own notes are its account (`agentNotes`);
 * these are the evidence's, and each one cites the timeline seconds it rests on, so a reviewer can
 * open the trace there.
 *
 * Tuned on the first two reference runs (2026-10-05). Run 2 (`snake-2026-10-05T23-22-53Z`) built the
 * game in 6.1 minutes and spent about 5 of them in nine wait→read cycles, clicking a "Yes, allow …"
 * button between most of them (#618). Run 1 was refused at every write (#615) and spent 315 of its
 * 317 seconds waiting. Neither had a failed action, so the retry rule matched nothing, as it should.
 *
 * ⚠ FINDINGS, NOT FAILURES. Friction never changes the verdict: a run that polled is not broken; it
 * says where the interface made the driver wait or ask. Each rule's threshold is a constant here, so
 * what counts as friction is a decision written down, not a feeling.
 */

export type ArenaFrictionPattern = 'polling' | 'approvals' | 'retry' | 'backtracking' | 'repeated-navigation'

/** One pattern the timeline shows: what it was, how often, and where (seconds into the run). */
export interface ArenaFriction {
  readonly pattern: ArenaFrictionPattern
  readonly summary: string
  readonly count: number
  readonly at: readonly number[]
}

/** A wait the driver followed with a look at the page: the shape of polling for Enso to finish. */
const POLLING_MIN_CYCLES = 3
/** Clicks on an approval ("Yes, allow …", "Allow", "Approve"), by role or by text, before it counts as friction. */
const APPROVALS_MIN_CLICKS = 3
/** `back` and `reload` actions before they count as backtracking. */
const BACKTRACKING_MIN_MOVES = 2
/** `goto` to one path before it counts as repeated navigation. */
const REPEATED_NAVIGATION_MIN = 3
/** How many actions after a failure the same action counts as its retry. */
const RETRY_WINDOW = 3

/**
 * A click on an approval, whatever named its target (#641): `click button "Yes…"` by role, and
 * `click text "Yes, allow write…"` by text — the second is how an agent clicked all three approvals
 * of one run, and the pattern that took `button` alone counted none of them.
 */
const APPROVAL_CLICK = /^click \w+ "(yes|allow|approve|ok|confirm)\b/i
const LOOKS = new Set(['read', 'screenshot'])

type ActionEvent = Extract<ArenaEvent, { kind: 'action' }>

const seconds = (event: ArenaEvent): number => Math.round(event.elapsedMs / 1000)

/** Every pattern the timeline shows past its threshold, in a fixed order. */
export function observedFriction(events: readonly ArenaEvent[]): ArenaFriction[] {
  const actions = events.filter((event): event is ActionEvent => event.kind === 'action')
  const runMs = events.at(-1)?.elapsedMs ?? 0
  return [
    polling(actions, runMs),
    approvals(actions),
    retries(actions),
    backtracking(actions),
    repeatedNavigation(actions),
  ].flatMap((found) => (found === undefined ? [] : [found]))
}

function polling(actions: readonly ActionEvent[], runMs: number): ArenaFriction | undefined {
  const cycles = actions.filter(
    (action, index) => action.action === 'wait' && LOOKS.has(actions[index + 1]?.action ?? ''),
  )
  if (cycles.length < POLLING_MIN_CYCLES) return undefined
  const waitedMs = actions
    .filter((action) => action.action === 'wait')
    .reduce((total, action) => total + action.durationMs, 0)
  const minutes = (ms: number): string => (ms / 60_000).toFixed(1)
  return {
    pattern: 'polling',
    summary: `${cycles.length} wait→look cycles: ${minutes(waitedMs)} of ${minutes(runMs)} minutes spent waiting for Enso`,
    count: cycles.length,
    at: cycles.map(seconds),
  }
}

/** The actions a rule matched, as friction once there are `minimum` of them; `describe` words the count. */
function countedFriction(
  pattern: ArenaFrictionPattern,
  matched: readonly ActionEvent[],
  minimum: number,
  describe: (count: number) => string,
): ArenaFriction | undefined {
  if (matched.length < minimum) return undefined
  return { pattern, summary: describe(matched.length), count: matched.length, at: matched.map(seconds) }
}

function approvals(actions: readonly ActionEvent[]): ArenaFriction | undefined {
  const clicks = actions.filter((action) => action.outcome === 'ok' && APPROVAL_CLICK.test(action.detail))
  return countedFriction(
    'approvals',
    clicks,
    APPROVALS_MIN_CLICKS,
    (count) => `${count} approval clicks to let Enso's agent go on`,
  )
}

/** An action tried again within `RETRY_WINDOW` actions after it failed: the same detail, any outcome. */
function retries(actions: readonly ActionEvent[]): ArenaFriction | undefined {
  const retried = actions.filter((action, index) =>
    actions
      .slice(Math.max(0, index - RETRY_WINDOW), index)
      .some((earlier) => earlier.outcome === 'failed' && earlier.detail === action.detail),
  )
  if (retried.length === 0) return undefined
  const failedAgain = retried.filter((action) => action.outcome === 'failed').length
  return {
    pattern: 'retry',
    summary: `${retried.length} action(s) tried again after failing, ${failedAgain} of them failing again`,
    count: retried.length,
    at: retried.map(seconds),
  }
}

function backtracking(actions: readonly ActionEvent[]): ArenaFriction | undefined {
  const moves = actions.filter((action) => action.action === 'back' || action.action === 'reload')
  return countedFriction('backtracking', moves, BACKTRACKING_MIN_MOVES, (count) => `${count} back/reload moves`)
}

function repeatedNavigation(actions: readonly ActionEvent[]): ArenaFriction | undefined {
  const byPath = new Map<string, ActionEvent[]>()
  for (const action of actions.filter((candidate) => candidate.action === 'goto')) {
    byPath.set(action.detail, [...(byPath.get(action.detail) ?? []), action])
  }
  const repeated = [...byPath.entries()].filter(([, visits]) => visits.length >= REPEATED_NAVIGATION_MIN)
  if (repeated.length === 0) return undefined
  const visits = repeated.flatMap(([, list]) => list)
  return {
    pattern: 'repeated-navigation',
    summary: repeated.map(([detail, list]) => `${detail} ×${list.length}`).join(', '),
    count: visits.length,
    at: visits.map(seconds).toSorted((left, right) => left - right),
  }
}
