import type { ArenaEvent, ArenaNoteKind, ArenaShotCause } from './timeline.ts'

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

export interface ArenaShotIndexEntry {
  readonly at: string
  readonly elapsedMs: number
  readonly cause: ArenaShotCause
  readonly path: string
  readonly url?: string
  readonly threadId?: string
}

export interface ArenaThreadSpan {
  readonly threadId: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  /** Screenshots taken while the URL named this thread: the jump from a thread to what it looked like. */
  readonly screenshots: number
  readonly actions: number
}

export interface ArenaNote {
  readonly at: string
  readonly elapsedMs: number
  readonly trying: string
  readonly happened: string
  readonly wanted?: string
  readonly threadId?: string
}

export interface ArenaManifest {
  readonly runId: string
  readonly scenario: string
  readonly project: string
  readonly ensoCommit?: string
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
    readonly dialogs: number
    readonly pageCrashes: number
    readonly ensoExits: number
  }
  readonly agentNotes: Readonly<Record<ArenaNoteKind, readonly ArenaNote[]>>
  readonly evidence: readonly ArenaEvidence[]
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

/** The manifest for a run, from its events in timeline order. */
export function foldArenaManifest({ runId, events, evidence }: ArenaManifestInput): ArenaManifest {
  const start = events.find((event) => event.kind === 'run-start')
  const stop = events.findLast((event) => event.kind === 'run-stop')
  const count = (kind: ArenaEvent['kind']): number => events.filter((event) => event.kind === kind).length
  const actions = events.filter((event) => event.kind === 'action')
  return {
    runId,
    scenario: start?.scenario ?? 'unknown',
    project: start?.project ?? 'unknown',
    ...(start?.ensoCommit === undefined ? {} : { ensoCommit: start.ensoCommit }),
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
      dialogs: count('dialog'),
      pageCrashes: count('page-crash'),
      ensoExits: count('enso-exit'),
    },
    agentNotes: notesByKind(events),
    evidence,
  }
}
