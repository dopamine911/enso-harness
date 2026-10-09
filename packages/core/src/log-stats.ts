import { type Static, Type } from 'typebox'
import type { EnsoLogLine } from './log.ts'

/**
 * The day, derived (#144 slice 4): cost per thread and per model, how long each run took to
 * its first token and to settle, how long each tool took, which guard rule refused what, and
 * who wrote to today's file — all of it from the records, none of it from a counter.
 *
 * ⚠ THE LOG IS THE SOURCE, THIS IS A VIEW. Nothing here is measured at the moment it
 * happens and kept somewhere; every number is a fold over `EnsoLogLine`s that already exist.
 * That is the rule the whole debug surface rests on (one home per fact): if a stat cannot be
 * derived from the file, the file gets the record — slice 4 added two, the attributed
 * message's usage at `info` and the `rule` on a denial — and never a side channel the bundle
 * cannot see. A bundle and this page therefore tell the same story by construction.
 *
 * ⚠ THE EVENT NAMES ARE THE TEMPLATES. A record is an event with properties (#132), and on
 * disk the event's name is its message TEMPLATE, values unrendered. So the fold matches on
 * templates — and the templates are declared HERE, imported by the producers, so a reworded
 * record is a type error at the producer rather than a stat that silently reads zero. The
 * one exception is the observation line, whose template is `{kind}` and whose event name
 * is the `kind` property; it is matched on both.
 *
 * Node-free: the server folds the day for `GET /api/logs/stats`, and `bun run logs` may fold
 * a bundle someone attached.
 */

/**
 * The templates that are events a stat folds over — the producer's spelling and the reader's,
 * one constant each.
 *
 * @group Logging
 */
export const ENSO_LOG_EVENTS = {
  /** `log-process.ts`: every process's first record, with `pid` and `startedAt`. */
  loggingConfigured: 'logging configured: file {file}, console {console}, overrides {overrides}',
  /** `log-process.ts`: an orderly stop — written before the flush, so the flush carries it (#385). */
  processStopping: 'process stopping on {signal}',
  /** `log-process.ts`: an error outside every handler, or an unhandled rejection; the process exits 1 after it (#385). */
  processCrashed: 'process crashed: {error}',
  /**
   * `log-process.ts`: at start, a marker left by a previous process that never wrote a stop or
   * crash record — SIGKILL, OOM, power loss (#385). `role`, `pid` and `startedAt` are the DEAD
   * process's own, from its marker; `process` stays the writer's, as on every record.
   */
  processEndedWithoutRecord: 'previous {role} pid {pid} started {startedAt} ended without a record',
  /** `scripts/dev.ts`: a dev child exited, with the code or signal only the launcher can see (#385). */
  devChildExited: '{label} exited ({exit}); stopping the other surface',
  /** `thread-registry.ts`: a run took the thread. */
  runAcquired: 'run {generation} acquired',
  /** `thread-registry.ts`: the run let it go. */
  runReleased: 'run {generation} released; idle timer {idleTimeoutMs} ms',
  /** `observation-log.ts`: time to first token, once per run. */
  runFirstDelta: 'run {generation} first delta after {firstDeltaMs}ms',
  /** `index.ts`: a prompt was admitted — `{admission}` is `opened` or `queued`. */
  promptAdmitted: 'prompt {messageId} {admission} on run {generation}',
  /** `observation-log.ts`: the compact observation line; the event is its `kind` property. */
  observation: '{kind}',
  /** `observation-log.ts`: a message pi attributed spend to, once per message. */
  messageUsage: 'message {role} used {input} in, {output} out',
  /** `guards/index.ts`: a refusal, with its `rule`. */
  toolDenied: '{toolName} denied: {reason}',
  /** `guards/index.ts`: an observed security signal (#464) — what was seen, never a verdict. */
  securitySignal: 'security signal {signal} on {toolCallId}: {detail}',
  /** `guards/index.ts`: the session's risk level rose (#464, observe only). */
  sessionRiskChanged: 'session risk is {level} ({signals} signal(s))',
  /** `guards/index.ts`: the session's risk reached `incident`, and an incident was opened (#466); `model` is the run's (#468). */
  incidentOpened: 'security incident {incidentId} opened; halted {halted}, suspended {suspended}',
  /** `incident-report/index.ts`: the agent's report filed, or recorded missing (#467). */
  incidentReportFiled: 'security incident {incidentId}: {settled}',
  /** `agent-host.ts#resolveIncident`: a human's resolution recorded — once, by the host (#466, #468). */
  incidentResolved: 'security incident {incidentId} resolved {classification}, {outcome}',
  /**
   * `guards/index.ts`: a command judgement recorded (#469 PR1, recorded only). Judged: each
   * question's answer flattened as a number (`risk`, `obscured`, …); unjudged: `reason`.
   */
  commandJudged: 'command {toolCallId} ({scope}) {kind} by {backend} in {latencyMs}ms',
  /** `thread-registry.ts`: the operator's Stop reached the run — the eval's interrupt (#441). */
  runAborted: 'run {generation} told to abort; {restored} queued prompt(s) handed back',
} as const

/**
 * A set of durations, summarised — never the list, which a `trace` day would make thousands
 * long for a page that wants one line per tool.
 *
 * @group Logging
 */
export const EnsoDurationSummary = Type.Object(
  {
    count: Type.Integer({ minimum: 0 }),
    minMs: Type.Number({ minimum: 0 }),
    maxMs: Type.Number({ minimum: 0 }),
    meanMs: Type.Number({ minimum: 0 }),
    totalMs: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
)
/** @group Logging */
export type EnsoDurationSummary = Static<typeof EnsoDurationSummary>

/** Tokens and cost, summed. */
const Spend = {
  input: Type.Integer({ minimum: 0 }),
  output: Type.Integer({ minimum: 0 }),
  cacheRead: Type.Integer({ minimum: 0 }),
  cacheWrite: Type.Integer({ minimum: 0 }),
  /** Summed from `totalCost` where pi attributed one; `0` for a provider that reports none. */
  cost: Type.Number({ minimum: 0 }),
  /** How many attributed messages the sums cover. */
  messages: Type.Integer({ minimum: 0 }),
}

/**
 * The day's stats, as `GET /api/logs/stats` answers and the page reads.
 *
 * @group Logging
 */
export const EnsoDayStats = Type.Object(
  {
    /** `2026-09-22` — the local day the file is named for. */
    day: Type.String(),
    /** Lines folded, and lines that were not records at all (the file is the honest place). */
    records: Type.Integer({ minimum: 0 }),
    malformed: Type.Integer({ minimum: 0 }),
    /**
     * Who has written to the file: one row per LAUNCH — a writer's second `logging configured`
     * of the day is a second row (#385) — with the boot facts its first record carried and, when
     * the file says, how it ended. A row with no `ended` is still writing, or ended in a way
     * nothing recorded and no later start has noticed yet. Liveness is not claimed — `lastAt` is
     * the last write, and a reader infers.
     */
    processes: Type.Array(
      Type.Object(
        {
          process: Type.String(),
          pid: Type.Optional(Type.Integer({ minimum: 0 })),
          startedAt: Type.Optional(Type.String()),
          /** The knobs it booted with, from `logging configured`. */
          file: Type.Optional(Type.String()),
          console: Type.Optional(Type.String()),
          overrides: Type.Optional(Type.Array(Type.String())),
          firstAt: Type.String(),
          lastAt: Type.String(),
          records: Type.Integer({ minimum: 0 }),
          /**
           * How it ended (#385): `stopped` on a signal (`detail` names it), `crashed` (`detail` is
           * the error), or `unclean` — a later start found its marker with no owner (`at` is when
           * that was noticed, not when it died).
           */
          ended: Type.Optional(
            Type.Object(
              {
                kind: Type.Union([Type.Literal('stopped'), Type.Literal('crashed'), Type.Literal('unclean')]),
                at: Type.String(),
                detail: Type.String(),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    /** Every run of the day: when it was taken, how long to the first token, how long to settle. */
    runs: Type.Array(
      Type.Object(
        {
          threadId: Type.String(),
          generation: Type.Integer({ minimum: 0 }),
          acquiredAt: Type.Optional(Type.String()),
          releasedAt: Type.Optional(Type.String()),
          /** `acquired` → `released`. */
          runMs: Type.Optional(Type.Number({ minimum: 0 })),
          /** The first `opened` prompt → the run's `settled` observation: the wait as the person who sent it felt it. */
          promptMs: Type.Optional(Type.Number({ minimum: 0 })),
          firstDeltaMs: Type.Optional(Type.Number({ minimum: 0 })),
          ...Spend,
        },
        { additionalProperties: false },
      ),
    ),
    /** Spend per thread, the day's attributed messages summed, with how many runs it had. */
    threads: Type.Array(
      Type.Object(
        { threadId: Type.String(), runs: Type.Integer({ minimum: 0 }), ...Spend },
        { additionalProperties: false },
      ),
    ),
    /** Spend per model, as pi named it; `(unattributed)` for an attributed message that named none. */
    models: Type.Array(Type.Object({ model: Type.String(), ...Spend }, { additionalProperties: false })),
    /** Per tool: calls, completed results, results that were errors, and the call → result durations. */
    tools: Type.Array(
      Type.Object(
        {
          toolName: Type.String(),
          calls: Type.Integer({ minimum: 0 }),
          results: Type.Integer({ minimum: 0 }),
          errors: Type.Integer({ minimum: 0 }),
          durations: EnsoDurationSummary,
        },
        { additionalProperties: false },
      ),
    ),
    /** Guard refusals by rule (`ENSO_GUARD_RULES`); a record from before the rule existed counts under `(no rule)`. */
    denials: Type.Array(
      Type.Object({ rule: Type.String(), count: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    ),
    /**
     * Model-provider refusals by provider and HTTP status (#340) — a 429, a missing login, a model
     * the account may not use. `(unknown)` when the refusal named no provider; no `status` when
     * the provider's message carried none.
     */
    refusals: Type.Array(
      Type.Object(
        {
          provider: Type.String(),
          status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
          count: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    /**
     * The day's security record (#468), from the log alone: signals by kind, incidents opened
     * (halting ones apart) and by the run's model, the agents' reports (filed — `checked` when
     * every factual claim verified and nothing mismatched — or missing), and the human
     * resolutions by classification and outcome. One line per fact, so nothing counts twice.
     */
    security: Type.Object(
      {
        signals: Type.Array(
          Type.Object({ signal: Type.String(), count: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
        ),
        incidents: Type.Object(
          { opened: Type.Integer({ minimum: 0 }), halted: Type.Integer({ minimum: 0 }) },
          { additionalProperties: false },
        ),
        models: Type.Array(
          Type.Object(
            { model: Type.String(), incidents: Type.Integer({ minimum: 0 }) },
            { additionalProperties: false },
          ),
        ),
        reports: Type.Object(
          {
            filed: Type.Integer({ minimum: 0 }),
            checked: Type.Integer({ minimum: 0 }),
            missing: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
        resolutions: Type.Array(
          Type.Object(
            { classification: Type.String(), outcome: Type.String(), count: Type.Integer({ minimum: 0 }) },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    totals: Type.Object(
      {
        runs: Type.Integer({ minimum: 0 }),
        prompts: EnsoDurationSummary,
        firstDelta: EnsoDurationSummary,
        toolCalls: Type.Integer({ minimum: 0 }),
        denials: Type.Integer({ minimum: 0 }),
        refusals: Type.Integer({ minimum: 0 }),
        /** How the day's processes ended (#385): orderly stops, recorded crashes, and ends nothing could record. */
        stops: Type.Integer({ minimum: 0 }),
        crashes: Type.Integer({ minimum: 0 }),
        uncleanEnds: Type.Integer({ minimum: 0 }),
        ...Spend,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
/** @group Logging */
export type EnsoDayStats = Static<typeof EnsoDayStats>

type SpendTotals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  messages: number
}

function emptySpend(): SpendTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * The middle of a list of numbers — the mean of the two middle ones for an even count — or 0 for
 * none. One copy for every surface that reports a median (the stats drawer, `bun run judge`).
 *
 * @group Logging
 */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function summarise(durations: readonly number[]): EnsoDurationSummary {
  if (durations.length === 0) return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 }
  let minMs = Number.POSITIVE_INFINITY
  let maxMs = 0
  let totalMs = 0
  for (const duration of durations) {
    if (duration < minMs) minMs = duration
    if (duration > maxMs) maxMs = duration
    totalMs += duration
  }
  return { count: durations.length, minMs, maxMs, meanMs: totalMs / durations.length, totalMs }
}

/**
 * Several summaries as one — the days of a thread that spans them (#45), each folded on its own
 * so a run's generation, which restarts with the server, never joins across a day boundary.
 * No summary, or only empty ones, is the empty summary.
 *
 * @group Logging
 */
export function mergeDurationSummaries(summaries: readonly EnsoDurationSummary[]): EnsoDurationSummary {
  const measured = summaries.filter((summary) => summary.count > 0)
  if (measured.length === 0) return summarise([])
  let count = 0
  let totalMs = 0
  let minMs = Number.POSITIVE_INFINITY
  let maxMs = 0
  for (const summary of measured) {
    count += summary.count
    totalMs += summary.totalMs
    minMs = Math.min(minMs, summary.minMs)
    maxMs = Math.max(maxMs, summary.maxMs)
  }
  return { count, minMs, maxMs, meanMs: totalMs / count, totalMs }
}

function addSpend(into: SpendTotals, properties: Readonly<Record<string, unknown>>): void {
  into.input += numberOf(properties.input) ?? 0
  into.output += numberOf(properties.output) ?? 0
  into.cacheRead += numberOf(properties.cacheRead) ?? 0
  into.cacheWrite += numberOf(properties.cacheWrite) ?? 0
  into.cost += numberOf(properties.totalCost) ?? 0
  into.messages += 1
}

interface RunFold {
  readonly threadId: string
  readonly generation: number
  acquiredAt?: string | undefined
  releasedAt?: string | undefined
  openedAt?: number | undefined
  settledAt?: number | undefined
  firstDeltaMs?: number | undefined
  readonly spend: SpendTotals
}

type ProcessEnd = NonNullable<EnsoDayStats['processes'][number]['ended']>

interface ProcessFold {
  readonly process: string
  pid?: number | undefined
  startedAt?: string | undefined
  file?: string | undefined
  console?: string | undefined
  overrides?: string[] | undefined
  firstAt: string
  lastAt: string
  records: number
  ended?: ProcessEnd | undefined
}

interface ToolFold {
  calls: number
  results: number
  errors: number
  readonly durations: number[]
}

type Properties = Readonly<Record<string, unknown>>

/** The fold's working state: every join keyed by the ids a record carries. */
interface Fold {
  /** The CURRENT launch of each writer — a record is attributed to its writer's latest start (#385). */
  readonly processes: Map<string, ProcessFold>
  /** Every launch of the day in order of first appearance: the rows. */
  readonly launches: ProcessFold[]
  /** Ends a later start reported for a pid no row of today's file carries (it started yesterday). */
  uncleanEndsOffFile: number
  readonly runs: Map<string, RunFold>
  readonly tools: Map<string, ToolFold>
  readonly openCalls: Map<string, { readonly toolName: string; readonly at: number }>
  /** Each closed call's call → result, by `toolCallId` — what `toolCallDurations` answers. */
  readonly callDurations: Map<string, number>
  readonly models: Map<string, SpendTotals>
  readonly denials: Map<string, number>
  /** Provider refusals (#340), keyed `provider|status`. */
  readonly refusals: Map<string, { readonly provider: string; readonly status: number | undefined; count: number }>
  readonly security: SecurityFold
}

/** The day's security lines (#468), counted as they come. */
interface SecurityFold {
  readonly signals: Map<string, number>
  readonly incidents: { opened: number; halted: number }
  readonly models: Map<string, number>
  readonly reports: { filed: number; checked: number; missing: number }
  /** Keyed `classification|outcome`. */
  readonly resolutions: Map<string, number>
}

function countInto(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** One security line into the fold; false when the line is no security event. */
function foldSecurity(security: SecurityFold, message: string, properties: Properties): boolean {
  switch (message) {
    case ENSO_LOG_EVENTS.securitySignal:
      countInto(security.signals, stringOf(properties.signal) ?? '(unknown)')
      return true
    case ENSO_LOG_EVENTS.incidentOpened:
      security.incidents.opened += 1
      if (properties.halted === true) security.incidents.halted += 1
      countInto(security.models, stringOf(properties.model) ?? '(unknown)')
      return true
    case ENSO_LOG_EVENTS.incidentReportFiled:
      if (properties.filed === true) {
        security.reports.filed += 1
        if (properties.checked === true) security.reports.checked += 1
      } else security.reports.missing += 1
      return true
    case ENSO_LOG_EVENTS.incidentResolved:
      countInto(
        security.resolutions,
        `${stringOf(properties.classification) ?? '(unknown)'}|${stringOf(properties.outcome) ?? '(unknown)'}`,
      )
      return true
    default:
      return false
  }
}

function emptyFold(): Fold {
  return {
    processes: new Map(),
    launches: [],
    uncleanEndsOffFile: 0,
    runs: new Map(),
    tools: new Map(),
    openCalls: new Map(),
    callDurations: new Map(),
    models: new Map(),
    denials: new Map(),
    refusals: new Map(),
    security: {
      signals: new Map(),
      incidents: { opened: 0, halted: 0 },
      models: new Map(),
      reports: { filed: 0, checked: 0, missing: 0 },
      resolutions: new Map(),
    },
  }
}

function securityOf(security: SecurityFold): EnsoDayStats['security'] {
  return {
    signals: [...security.signals.entries()].map(([signal, count]) => ({ signal, count })),
    incidents: { ...security.incidents },
    models: [...security.models.entries()].map(([model, incidents]) => ({ model, incidents })),
    reports: { ...security.reports },
    resolutions: [...security.resolutions.entries()].map(([key, count]) => {
      const [classification = '(unknown)', outcome = '(unknown)'] = key.split('|')
      return { classification, outcome, count }
    }),
  }
}

function runOf(fold: Fold, properties: Properties): RunFold | undefined {
  const threadId = stringOf(properties.threadId)
  const generation = numberOf(properties.generation)
  if (threadId === undefined || generation === undefined) return undefined
  const key = `${threadId}#${generation}`
  let run = fold.runs.get(key)
  if (run === undefined) {
    run = { threadId, generation, spend: emptySpend() }
    fold.runs.set(key, run)
  }
  return run
}

/**
 * Every record counts for its writer's CURRENT launch; the first record of a writer, or its
 * `logging configured` after an earlier launch already booted, opens a new row (#385). Records
 * carry the writer's name, not its pid, so a launch is "the records since this writer's last
 * boot" — two launches of one writer at the same moment (another checkout) would interleave.
 */
function foldWriter(fold: Fold, line: EnsoLogLine, properties: Properties): ProcessFold {
  const writer = stringOf(properties.process) ?? '(unstamped)'
  const at = line['@timestamp']
  const known = fold.processes.get(writer)
  const boots = line.message === ENSO_LOG_EVENTS.loggingConfigured
  if (known !== undefined && !(boots && known.pid !== undefined)) {
    known.lastAt = at
    known.records += 1
    return known
  }
  const fresh: ProcessFold = { process: writer, firstAt: at, lastAt: at, records: 1 }
  fold.processes.set(writer, fresh)
  fold.launches.push(fresh)
  return fresh
}

function foldBoot(process: ProcessFold, properties: Properties): void {
  process.pid = numberOf(properties.pid)
  process.startedAt = stringOf(properties.startedAt)
  process.file = stringOf(properties.file)
  process.console = stringOf(properties.console)
  process.overrides = Array.isArray(properties.overrides) ? properties.overrides.map(String) : undefined
}

/** An end the writer recorded itself: a stop on a signal, or a crash. */
function foldOwnEnd(writer: ProcessFold, kind: 'stopped' | 'crashed', at: string, detail: string): void {
  writer.ended = { kind, at, detail }
}

/**
 * An end a LATER start reported (#385): the row is the dead process's, wherever it is in the
 * day — matched on its pid AND its start time, the same two facts the marker's liveness check
 * uses, since a pid is handed out again within a day and the first launch with it is not the
 * one that died. A pid-and-start no row carries started before today's file and is counted
 * without a row.
 */
function foldReportedEnd(fold: Fold, at: string, properties: Properties): void {
  const pid = numberOf(properties.pid)
  const startedAt = stringOf(properties.startedAt)
  // A report missing either fact names no launch: never let two absences match an unbooted row.
  const row =
    pid === undefined || startedAt === undefined
      ? undefined
      : fold.launches.find((launch) => launch.pid === pid && launch.startedAt === startedAt)
  if (row === undefined) {
    fold.uncleanEndsOffFile += 1
    return
  }
  row.ended = { kind: 'unclean', at, detail: 'ended without a record' }
}

function foldUsage(fold: Fold, properties: Properties): void {
  const run = runOf(fold, properties)
  if (run !== undefined) addSpend(run.spend, properties)
  const model = stringOf(properties.model) ?? '(unattributed)'
  const spend = fold.models.get(model) ?? emptySpend()
  addSpend(spend, properties)
  fold.models.set(model, spend)
}

/**
 * A tool's call or result, joined by `toolCallId`.
 *
 * The CALL names the bucket. A result is joined to its call by id and counted under the name
 * the call carried; only a result with no call in sight falls back to its own name, and to
 * `(unnamed)` when it has none — never a results row beside a calls row for the same tool
 * because the two records spelled the name differently (PR #336 review).
 */
function foldTool(fold: Fold, kind: 'tool-call' | 'tool-result', properties: Properties, instant: number): void {
  const toolCallId = stringOf(properties.toolCallId)
  const call = kind === 'tool-result' && toolCallId !== undefined ? fold.openCalls.get(toolCallId) : undefined
  const toolName = call?.toolName ?? stringOf(properties.toolName) ?? '(unnamed)'
  let tool = fold.tools.get(toolName)
  if (tool === undefined) {
    tool = { calls: 0, results: 0, errors: 0, durations: [] }
    fold.tools.set(toolName, tool)
  }
  if (kind === 'tool-call') {
    tool.calls += 1
    if (toolCallId !== undefined) fold.openCalls.set(toolCallId, { toolName, at: instant })
    return
  }
  // A partial result is elided at the wire and never logged at `info`; the completed one is
  // the result. Guarded anyway, so a `complete: false` that ever lands is not counted twice.
  if (properties.complete === false) return
  tool.results += 1
  if (properties.isError === true) tool.errors += 1
  if (call === undefined || toolCallId === undefined) return
  fold.openCalls.delete(toolCallId)
  const duration = instant - call.at
  if (!Number.isNaN(duration) && duration >= 0) {
    tool.durations.push(duration)
    fold.callDurations.set(toolCallId, duration)
  }
}

/** A provider's refusal (#340), counted by provider and status. */
function foldRefusal(fold: Fold, properties: Properties): void {
  const provider = stringOf(properties.provider) ?? '(unknown)'
  const status = numberOf(properties.status)
  const key = `${provider}|${status ?? ''}`
  const known = fold.refusals.get(key)
  if (known !== undefined) known.count += 1
  else fold.refusals.set(key, { provider, status, count: 1 })
}

/** The compact observation line: the run's settle, a tool's call or result, or a provider's refusal. */
function foldObservation(fold: Fold, properties: Properties, instant: number): void {
  const kind = properties.kind
  if (kind === 'settled') {
    const run = runOf(fold, properties)
    if (run !== undefined && run.settledAt === undefined) run.settledAt = instant
  } else if (kind === 'tool-call' || kind === 'tool-result') foldTool(fold, kind, properties, instant)
  else if (kind === 'provider-refused') foldRefusal(fold, properties)
}

/**
 * ⚠ The browser logs the SAME admission line (`follow-connection.ts`), re-emitted into the
 * file as process `browser` and stamped at receipt — a second later. Only the server's own
 * record is the moment the wait began.
 */
function foldAdmission(fold: Fold, line: EnsoLogLine, properties: Properties, instant: number): void {
  if (properties.admission !== 'opened' || !line.logger.startsWith('enso.server')) return
  const run = runOf(fold, properties)
  // The FIRST opened prompt: a second on the same run is queued work, not a new wait.
  if (run !== undefined && run.openedAt === undefined) run.openedAt = instant
}

/** The process-lifecycle lines (#144, #385): a boot, an own end, an end a later start reported. True when the line was one. */
function foldProcessLifecycle(fold: Fold, writer: ProcessFold, line: EnsoLogLine, properties: Properties): boolean {
  const at = line['@timestamp']
  switch (line.message) {
    case ENSO_LOG_EVENTS.loggingConfigured:
      foldBoot(writer, properties)
      return true
    case ENSO_LOG_EVENTS.processStopping:
      foldOwnEnd(writer, 'stopped', at, stringOf(properties.signal) ?? '(no signal)')
      return true
    case ENSO_LOG_EVENTS.processCrashed:
      foldOwnEnd(writer, 'crashed', at, stringOf(properties.error) ?? '(no error)')
      return true
    case ENSO_LOG_EVENTS.processEndedWithoutRecord:
      foldReportedEnd(fold, at, properties)
      return true
    default:
      return false
  }
}

/** One line into the fold, by the event its template names. */
function foldLine(fold: Fold, line: EnsoLogLine): void {
  const properties = line.properties ?? {}
  const instant = Date.parse(line['@timestamp'])
  const writer = foldWriter(fold, line, properties)
  if (line.message !== undefined && foldSecurity(fold.security, line.message, properties)) return
  if (foldProcessLifecycle(fold, writer, line, properties)) return
  switch (line.message) {
    case ENSO_LOG_EVENTS.runAcquired: {
      const run = runOf(fold, properties)
      if (run !== undefined) run.acquiredAt = line['@timestamp']
      return
    }
    case ENSO_LOG_EVENTS.runReleased: {
      const run = runOf(fold, properties)
      if (run !== undefined) run.releasedAt = line['@timestamp']
      return
    }
    case ENSO_LOG_EVENTS.runFirstDelta: {
      const run = runOf(fold, properties)
      if (run !== undefined) run.firstDeltaMs = numberOf(properties.firstDeltaMs)
      return
    }
    case ENSO_LOG_EVENTS.promptAdmitted:
      foldAdmission(fold, line, properties, instant)
      return
    case ENSO_LOG_EVENTS.messageUsage:
      foldUsage(fold, properties)
      return
    case ENSO_LOG_EVENTS.toolDenied: {
      const rule = stringOf(properties.rule) ?? '(no rule)'
      fold.denials.set(rule, (fold.denials.get(rule) ?? 0) + 1)
      return
    }
    case ENSO_LOG_EVENTS.observation:
      foldObservation(fold, properties, instant)
      return
    default:
      return
  }
}

/** A span between two instants, or nothing when either is missing or the clocks disagree. */
function spanMs(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined
  const span = to - from
  return Number.isNaN(span) || span < 0 ? undefined : span
}

type RunRow = EnsoDayStats['runs'][number]

function runRowOf(run: RunFold): RunRow {
  const acquired = run.acquiredAt === undefined ? undefined : Date.parse(run.acquiredAt)
  const released = run.releasedAt === undefined ? undefined : Date.parse(run.releasedAt)
  const runMs = spanMs(acquired, released)
  const promptMs = spanMs(run.openedAt, run.settledAt)
  return {
    threadId: run.threadId,
    generation: run.generation,
    ...(run.acquiredAt === undefined ? {} : { acquiredAt: run.acquiredAt }),
    ...(run.releasedAt === undefined ? {} : { releasedAt: run.releasedAt }),
    ...(runMs === undefined ? {} : { runMs }),
    ...(promptMs === undefined ? {} : { promptMs }),
    ...(run.firstDeltaMs === undefined ? {} : { firstDeltaMs: run.firstDeltaMs }),
    ...run.spend,
  }
}

function addTotals(into: SpendTotals, spend: SpendTotals): void {
  into.input += spend.input
  into.output += spend.output
  into.cacheRead += spend.cacheRead
  into.cacheWrite += spend.cacheWrite
  into.cost += spend.cost
  into.messages += spend.messages
}

function processRowOf(process: ProcessFold): EnsoDayStats['processes'][number] {
  return {
    process: process.process,
    ...(process.pid === undefined ? {} : { pid: process.pid }),
    ...(process.startedAt === undefined ? {} : { startedAt: process.startedAt }),
    ...(process.file === undefined ? {} : { file: process.file }),
    ...(process.console === undefined ? {} : { console: process.console }),
    ...(process.overrides === undefined ? {} : { overrides: process.overrides }),
    firstAt: process.firstAt,
    lastAt: process.lastAt,
    records: process.records,
    ...(process.ended === undefined ? {} : { ended: process.ended }),
  }
}

/**
 * Fold the day's records into its stats.
 *
 * Every join is by the ids a record carries — `threadId` + `generation` for a run,
 * `toolCallId` for a tool, `process` for a writer — never by adjacency in the file, which
 * three processes share and interleave.
 *
 * @group Logging
 */
export function dayStats(day: string, lines: readonly EnsoLogLine[], malformed: number): EnsoDayStats {
  const fold = emptyFold()
  for (const line of lines) foldLine(fold, line)
  return statsOf(day, fold, lines.length, malformed)
}

/**
 * A day's fold held open (#739): records go in as the day file grows, and the stats are read off
 * at any point — the same fold {@link dayStats} runs over a whole file, so a reader that follows
 * today's file from the offset it reached answers what a whole re-read would, without re-reading
 * 52 MB per request. The fold is a left fold over records in file order — each record only updates
 * the state the ones before it left — so adding the appended records is the whole re-fold.
 *
 * @group Logging
 */
export interface EnsoDayFold {
  /** One record into the fold. */
  readonly add: (line: EnsoLogLine) => void
  /** One line that was not a record: counted, never folded. */
  readonly addMalformed: () => void
  /** The stats of every line added so far: a fresh answer each call, which later records never change. */
  readonly stats: () => EnsoDayStats
  /**
   * Each closed tool call's call → result so far, by `toolCallId` (#45 phase 2) — the join
   * `stats.tools` sums per tool, kept per call so a reader can rank the calls themselves. ⚠ The
   * fold's own map, growing as records are added: copy it to keep it.
   */
  readonly callDurations: ReadonlyMap<string, number>
}

/**
 * A fold of `day` with nothing in it yet.
 *
 * @group Logging
 */
export function openDayFold(day: string): EnsoDayFold {
  const fold = emptyFold()
  let records = 0
  let malformed = 0
  return {
    add: (line: EnsoLogLine): void => {
      foldLine(fold, line)
      records += 1
    },
    addMalformed: (): void => {
      malformed += 1
    },
    stats: (): EnsoDayStats => statsOf(day, fold, records, malformed),
    callDurations: fold.callDurations,
  }
}

function statsOf(day: string, fold: Fold, records: number, malformed: number): EnsoDayStats {
  const runRows = [...fold.runs.values()].map(runRowOf)
  const threads = new Map<string, { runs: number } & SpendTotals>()
  for (const run of runRows) {
    const thread = threads.get(run.threadId) ?? { runs: 0, ...emptySpend() }
    thread.runs += 1
    addTotals(thread, run)
    threads.set(run.threadId, thread)
  }
  const totalSpend = emptySpend()
  for (const spend of fold.models.values()) addTotals(totalSpend, spend)
  let toolCalls = 0
  for (const tool of fold.tools.values()) toolCalls += tool.calls
  let deniedCalls = 0
  for (const ruleDenials of fold.denials.values()) deniedCalls += ruleDenials
  let refusedRequests = 0
  for (const refusal of fold.refusals.values()) refusedRequests += refusal.count
  const endsOf = (kind: ProcessEnd['kind']): number =>
    fold.launches.filter((launch) => launch.ended?.kind === kind).length

  return {
    day,
    records,
    malformed,
    processes: fold.launches.map(processRowOf),
    runs: runRows,
    threads: [...threads.entries()].map(([threadId, thread]) => ({ threadId, ...thread })),
    models: [...fold.models.entries()].map(([model, spend]) => ({ model, ...spend })),
    tools: [...fold.tools.entries()].map(([toolName, tool]) => ({
      toolName,
      calls: tool.calls,
      results: tool.results,
      errors: tool.errors,
      durations: summarise(tool.durations),
    })),
    denials: [...fold.denials.entries()].map(([rule, count]) => ({ rule, count })),
    refusals: [...fold.refusals.values()].map(({ provider, status, count }) =>
      status === undefined ? { provider, count } : { provider, status, count },
    ),
    security: securityOf(fold.security),
    totals: {
      runs: runRows.length,
      prompts: summarise(runRows.flatMap((run) => (run.promptMs === undefined ? [] : [run.promptMs]))),
      firstDelta: summarise(runRows.flatMap((run) => (run.firstDeltaMs === undefined ? [] : [run.firstDeltaMs]))),
      toolCalls,
      denials: deniedCalls,
      refusals: refusedRequests,
      stops: endsOf('stopped'),
      crashes: endsOf('crashed'),
      uncleanEnds: endsOf('unclean') + fold.uncleanEndsOffFile,
      ...totalSpend,
    },
  }
}
