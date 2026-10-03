import { ARENA_UI_TOOL } from './actions.ts'
import type { ArenaActionSource, ArenaEvent, ArenaNoteKind, ArenaShotCause } from './timeline.ts'

/**
 * The run's evidence manifest (#556), folded from its timeline: which screenshots exist and why,
 * which threads the UI was in and when, what the agent wrote down, which signals the browser and
 * Enso gave, and which pieces of Enso-side evidence were collected — or are missing, and why.
 *
 * ⚠ THE AGENT'S NOTES ARE OBSERVATIONS, NOT FINDINGS. They are listed under `agentNotes`, apart
 * from `observed` (what the recorder saw happen), because the issue's three kinds of finding are
 * kept distinct: a wish is what the agent said; friction is what the evidence shows; a verified
 * gap is what a reviewer checked. The manifest holds the first two as raw material and claims
 * nothing about the third.
 */

/** One piece of Enso-side evidence: where it was saved, or why it was not. */
export type ArenaEvidence =
  | { readonly kind: string; readonly status: 'collected'; readonly path: string }
  | { readonly kind: string; readonly status: 'missing'; readonly reason: string }

/** When a manifest row happened, and in which thread: the timeline's own stamp, carried over. */
interface ArenaStamped {
  readonly at: string
  readonly elapsedMs: number
  readonly threadId?: string
}

export interface ArenaShotIndexEntry extends ArenaStamped {
  readonly cause: ArenaShotCause
  readonly path: string
  readonly url?: string
}

export interface ArenaThreadSpan {
  readonly threadId: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  /** Screenshots taken while the URL named this thread: the jump from a thread to what it looked like. */
  readonly screenshots: number
  readonly actions: number
}

export interface ArenaNote extends ArenaStamped {
  readonly trying: string
  readonly happened: string
  readonly wanted?: string
}

/** What drove the UI: the agent runner (its model and the tools it was given), or the control endpoint. */
export type ArenaDriverRecord =
  | {
      readonly kind: 'agent'
      readonly provider: string
      readonly model: string
      readonly thinking: string
      readonly tools: readonly string[]
      /** Calls the model made to a tool it was not given: asked for, refused, nothing ran. */
      readonly refusedToolCalls: readonly string[]
      readonly endReason?: string
    }
  | { readonly kind: 'control' }

/**
 * Whether this run's UI-only boundary held, read off the timeline rather than asserted: an agent
 * drove it, its tools were exactly the one UI tool, and no action reached the page any other way.
 */
export interface ArenaBoundary {
  readonly held: boolean
  readonly why: string
  readonly actionsBy: Readonly<Record<ArenaActionSource, number>>
}

export interface ArenaManifest {
  readonly runId: string
  readonly scenario: string
  readonly project: string
  readonly ensoCommit?: string
  readonly driver: ArenaDriverRecord
  readonly boundary: ArenaBoundary
  readonly startedAt?: string
  readonly stoppedAt?: string
  /** Why the run ended — or `not stopped`: the recorder died, and this manifest was folded after. */
  readonly stopReason: string
  readonly screenshots: readonly ArenaShotIndexEntry[]
  readonly traceChunks: readonly string[]
  readonly threads: readonly ArenaThreadSpan[]
  readonly actions: { readonly total: number; readonly failed: number }
  readonly observed: {
    readonly consoleErrors: number
    readonly pageErrors: number
    readonly failedRequests: number
    /** Responses with an HTTP error status (4xx, 5xx), by count; the score names their routes. */
    readonly httpErrors: number
    readonly dialogs: number
    readonly pageCrashes: number
    readonly ensoExits: number
  }
  readonly agentNotes: Readonly<Record<ArenaNoteKind, readonly ArenaNote[]>>
  /**
   * What the recorder itself failed to do, in order — a trace chunk not written, for one. Without
   * this a missing chunk read as a shorter `traceChunks` and nothing more (PR #562 review); the
   * evidence's own gaps are evidence too.
   */
  readonly recorderErrors: readonly ArenaRecorderError[]
  readonly evidence: readonly ArenaEvidence[]
}

export interface ArenaRecorderError {
  readonly at: string
  readonly elapsedMs: number
  readonly during: string
  readonly error: string
}

/** What the fold needs beyond the timeline: the run's id and the evidence collected at the end. */
export interface ArenaManifestInput {
  readonly runId: string
  readonly events: readonly ArenaEvent[]
  readonly evidence: readonly ArenaEvidence[]
}

interface ThreadTally {
  firstSeenAt: string
  lastSeenAt: string
  screenshots: number
  actions: number
}

/** Each thread the page's URL named, with when it was first and last named and what happened there. */
function threadSpans(events: readonly ArenaEvent[]): ArenaThreadSpan[] {
  const threads = new Map<string, ThreadTally>()
  for (const event of events) {
    const threadId = event.page?.threadId
    if (threadId === undefined) continue
    const tally = threads.get(threadId) ?? { firstSeenAt: event.at, lastSeenAt: event.at, screenshots: 0, actions: 0 }
    tally.lastSeenAt = event.at
    if (event.kind === 'screenshot') tally.screenshots += 1
    if (event.kind === 'action') tally.actions += 1
    threads.set(threadId, tally)
  }
  return [...threads].map(([threadId, tally]) => ({ threadId, ...tally }))
}

/** The screenshot index: every capture, sampled or event-driven, with the page it showed. */
function shotIndex(events: readonly ArenaEvent[]): ArenaShotIndexEntry[] {
  return events.flatMap((event): ArenaShotIndexEntry[] =>
    event.kind === 'screenshot'
      ? [
          {
            at: event.at,
            elapsedMs: event.elapsedMs,
            cause: event.cause,
            path: event.path,
            ...(event.page === undefined ? {} : { url: event.page.url }),
            ...(event.page?.threadId === undefined ? {} : { threadId: event.page.threadId }),
          },
        ]
      : [],
  )
}

/** The agent's notes by kind, in the order it wrote them. */
function notesByKind(events: readonly ArenaEvent[]): Record<ArenaNoteKind, ArenaNote[]> {
  const notes: Record<ArenaNoteKind, ArenaNote[]> = { wish: [], friction: [], retrospective: [] }
  for (const event of events) {
    if (event.kind !== 'note') continue
    notes[event.note].push({
      at: event.at,
      elapsedMs: event.elapsedMs,
      trying: event.trying,
      happened: event.happened,
      ...(event.wanted === undefined ? {} : { wanted: event.wanted }),
      ...(event.page?.threadId === undefined ? {} : { threadId: event.page.threadId }),
    })
  }
  return notes
}

function driverRecord(events: readonly ArenaEvent[]): ArenaDriverRecord {
  const start = events.find((event) => event.kind === 'agent-start')
  if (start === undefined) return { kind: 'control' }
  const end = events.findLast((event) => event.kind === 'agent-end')
  return {
    kind: 'agent',
    provider: start.provider,
    model: start.model,
    thinking: start.thinking,
    tools: start.tools,
    refusedToolCalls: events.flatMap((event) => (event.kind === 'agent-tool-refused' ? [event.tool] : [])),
    ...(end === undefined ? {} : { endReason: end.reason }),
  }
}

/** Every UI action and note, by who sent it. A line from before `via` existed came over the control endpoint. */
function actionsBySource(events: readonly ArenaEvent[]): Record<ArenaActionSource, number> {
  const counts: Record<ArenaActionSource, number> = { agent: 0, control: 0 }
  for (const event of events) {
    if (event.kind === 'action' || event.kind === 'note') counts[event.via === 'agent' ? 'agent' : 'control'] += 1
  }
  return counts
}

function boundaryOf(driver: ArenaDriverRecord, actionsBy: Record<ArenaActionSource, number>): ArenaBoundary {
  if (driver.kind === 'control') {
    return { held: false, why: 'no agent runner: actions came over the control endpoint, from a shell', actionsBy }
  }
  const extra = driver.tools.filter((tool) => tool !== ARENA_UI_TOOL)
  if (extra.length > 0)
    return { held: false, why: `the agent was given more than the UI: ${extra.join(', ')}`, actionsBy }
  if (actionsBy.control > 0) {
    return { held: false, why: `${actionsBy.control} action(s) reached the page over the control endpoint`, actionsBy }
  }
  if (!driver.tools.includes(ARENA_UI_TOOL))
    return { held: false, why: `the agent was not given ${ARENA_UI_TOOL}`, actionsBy }
  return { held: true, why: `the agent's only tool was ${ARENA_UI_TOOL}, and every action came through it`, actionsBy }
}

/** The manifest for a run, from its events in timeline order. */
export function foldArenaManifest({ runId, events, evidence }: ArenaManifestInput): ArenaManifest {
  const start = events.find((event) => event.kind === 'run-start')
  const stop = events.findLast((event) => event.kind === 'run-stop')
  const count = (kind: ArenaEvent['kind']): number => events.filter((event) => event.kind === kind).length
  const actions = events.filter((event) => event.kind === 'action')
  const driver = driverRecord(events)
  return {
    runId,
    scenario: start?.scenario ?? 'unknown',
    project: start?.project ?? 'unknown',
    ...(start?.ensoCommit === undefined ? {} : { ensoCommit: start.ensoCommit }),
    driver,
    boundary: boundaryOf(driver, actionsBySource(events)),
    ...(start === undefined ? {} : { startedAt: start.at }),
    ...(stop === undefined ? {} : { stoppedAt: stop.at }),
    stopReason: stop?.reason ?? 'not stopped',
    screenshots: shotIndex(events),
    traceChunks: events.flatMap((event) => (event.kind === 'trace-chunk' ? [event.path] : [])),
    threads: threadSpans(events),
    actions: { total: actions.length, failed: actions.filter((event) => event.outcome === 'failed').length },
    observed: {
      consoleErrors: count('console-error'),
      pageErrors: count('page-error'),
      failedRequests: count('request-failed'),
      httpErrors: count('response-error'),
      dialogs: count('dialog'),
      pageCrashes: count('page-crash'),
      ensoExits: count('enso-exit'),
    },
    agentNotes: notesByKind(events),
    recorderErrors: events.flatMap((event): ArenaRecorderError[] =>
      event.kind === 'recorder-error'
        ? [{ at: event.at, elapsedMs: event.elapsedMs, during: event.during, error: event.error }]
        : [],
    ),
    evidence,
  }
}
