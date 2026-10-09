import { ARENA_UI_TOOL } from './actions.ts'
import type { ArenaEnsoBuild, ArenaHistoryMessage, ArenaTurnPlace, ArenaWorkspaceSample } from './run-state.ts'
import { turnAt } from './run-state.ts'
import type { ArenaSecretScan } from './secret-scan.ts'
import type { ArenaActionSource, ArenaEvent, ArenaNoteKind, ArenaPerception, ArenaShotCause } from './timeline.ts'

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

/**
 * One piece of Enso-side evidence: where it was saved, why it was not, or why there was nothing to
 * collect (#671): a thread the run deleted, or one it never ran. Only `missing` is a problem.
 */
export type ArenaEvidence =
  | { readonly kind: string; readonly status: 'collected'; readonly path: string }
  | { readonly kind: string; readonly status: 'missing' | 'skipped'; readonly reason: string }

/** One evidence row read back from a manifest on disk, field by field; undefined when it is not one. */
export function arenaEvidenceRowOf(value: unknown): ArenaEvidence | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('kind' in value) || typeof value.kind !== 'string' || !('status' in value)) return undefined
  if (value.status === 'collected' && 'path' in value && typeof value.path === 'string') {
    return { kind: value.kind, status: 'collected', path: value.path }
  }
  if (
    (value.status === 'missing' || value.status === 'skipped') &&
    'reason' in value &&
    typeof value.reason === 'string'
  ) {
    return { kind: value.kind, status: value.status, reason: value.reason }
  }
  return undefined
}

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
  /** The turn of its thread the screenshot shows (#608), from the thread's collected history. */
  readonly turn?: ArenaTurnPlace
}

/** The work at one sample (#608): when, and each workspace's counts and fingerprint. */
export interface ArenaFilesystemSample {
  readonly at: string
  readonly elapsedMs: number
  readonly workspaces: readonly ArenaWorkspaceSample[]
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
  /** The checkout the run's Enso came from: its commit, and whether it was dirty (#608). */
  readonly ensoBuild?: ArenaEnsoBuild
  /** How the agent perceived the page (#680): `tree`, the only kind before it was recorded, or `visual`. */
  readonly perception: ArenaPerception
  /** The model the run set Enso's sessions to start on (#674); what they ran on is the score's `modelUse.enso`. */
  readonly ensoModel?: string
  readonly startedAt?: string
  readonly stoppedAt?: string
  /** Why the run ended — or `not stopped`: the recorder died, and this manifest was folded after. */
  readonly stopReason: string
  readonly screenshots: readonly ArenaShotIndexEntry[]
  readonly traceChunks: readonly string[]
  readonly threads: readonly ArenaThreadSpan[]
  /** The work over time (#608): one sample per periodic screenshot, of the project and its thread trees. */
  readonly filesystem: readonly ArenaFilesystemSample[]
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
   * this a missing chunk read as a shorter `traceChunks` and nothing more; the
   * evidence's own gaps are evidence too.
   */
  readonly recorderErrors: readonly ArenaRecorderError[]
  readonly evidence: readonly ArenaEvidence[]
  /** Every file the run keeps, read for its secret values at the stop (#610): absent on a run from before it. */
  readonly secretScan?: ArenaSecretScan
  /** What drove the UI, and whether the UI-only boundary held over the whole run (#584). */
  readonly driver: ArenaDriverRecord
  readonly boundary: ArenaBoundary
}

export interface ArenaRecorderError {
  readonly at: string
  readonly elapsedMs: number
  readonly during: string
  readonly error: string
}

/**
 * What the fold needs beyond the timeline: the run's id, the evidence collected at the end, the stop's
 * secret scan, and each thread's history (`threadHistoriesIn`), which places each screenshot on a turn.
 */
export interface ArenaManifestInput {
  readonly runId: string
  readonly events: readonly ArenaEvent[]
  readonly evidence: readonly ArenaEvidence[]
  readonly secretScan?: ArenaSecretScan
  readonly histories?: ReadonlyMap<string, readonly ArenaHistoryMessage[]>
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

/**
 * The screenshot index: every capture, sampled or event-driven, with the page it showed and — when its
 * thread's history was collected — the turn it falls in (#608). The recorder's clock and Enso's are
 * the same machine's, so the two timestamps compare directly.
 */
function shotIndex(
  events: readonly ArenaEvent[],
  histories: ReadonlyMap<string, readonly ArenaHistoryMessage[]>,
): ArenaShotIndexEntry[] {
  return events.flatMap((event): ArenaShotIndexEntry[] => {
    if (event.kind !== 'screenshot') return []
    const threadId = event.page?.threadId
    const history = threadId === undefined ? undefined : histories.get(threadId)
    const turn = history === undefined ? undefined : turnAt(history, Date.parse(event.at))
    return [
      {
        at: event.at,
        elapsedMs: event.elapsedMs,
        cause: event.cause,
        path: event.path,
        ...(event.page === undefined ? {} : { url: event.page.url }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(turn === undefined ? {} : { turn }),
      },
    ]
  })
}

function filesystemTimeline(events: readonly ArenaEvent[]): ArenaFilesystemSample[] {
  return events.flatMap((event): ArenaFilesystemSample[] =>
    event.kind === 'workspace-sample'
      ? [{ at: event.at, elapsedMs: event.elapsedMs, workspaces: event.workspaces }]
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
export function foldArenaManifest({
  runId,
  events,
  evidence,
  secretScan,
  histories = new Map(),
}: ArenaManifestInput): ArenaManifest {
  const start = events.find((event) => event.kind === 'run-start')
  const stop = events.findLast((event) => event.kind === 'run-stop')
  const count = (kind: ArenaEvent['kind']): number => events.filter((event) => event.kind === kind).length
  const actions = events.filter((event) => event.kind === 'action')
  const driver = driverRecord(events)
  return {
    runId,
    scenario: start?.scenario ?? 'unknown',
    project: start?.project ?? 'unknown',
    ...(start?.ensoBuild === undefined ? {} : { ensoBuild: start.ensoBuild }),
    perception: start?.perception ?? 'tree',
    ...(start?.ensoModel === undefined ? {} : { ensoModel: start.ensoModel }),
    driver,
    boundary: boundaryOf(driver, actionsBySource(events)),
    ...(start === undefined ? {} : { startedAt: start.at }),
    ...(stop === undefined ? {} : { stoppedAt: stop.at }),
    stopReason: stop?.reason ?? 'not stopped',
    screenshots: shotIndex(events, histories),
    traceChunks: events.flatMap((event) => (event.kind === 'trace-chunk' ? [event.path] : [])),
    threads: threadSpans(events),
    filesystem: filesystemTimeline(events),
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
    ...(secretScan === undefined ? {} : { secretScan }),
  }
}
