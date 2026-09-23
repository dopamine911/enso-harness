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
     * Who has written to the file: one row per writer, with the boot facts its first record
     * carried. Liveness is not claimed — `lastAt` is the last write, and a reader infers.
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
    totals: Type.Object(
      {
        runs: Type.Integer({ minimum: 0 }),
        prompts: EnsoDurationSummary,
        firstDelta: EnsoDurationSummary,
        toolCalls: Type.Integer({ minimum: 0 }),
        denials: Type.Integer({ minimum: 0 }),
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
  readonly processes: Map<string, ProcessFold>
  readonly runs: Map<string, RunFold>
  readonly tools: Map<string, ToolFold>
  readonly openCalls: Map<string, { readonly toolName: string; readonly at: number }>
  /** Each closed call's call → result, by `toolCallId` — what `toolCallDurations` answers. */
  readonly callDurations: Map<string, number>
  readonly models: Map<string, SpendTotals>
  readonly denials: Map<string, number>
}

function foldOf(lines: readonly EnsoLogLine[]): Fold {
  const fold: Fold = {
    processes: new Map(),
    runs: new Map(),
    tools: new Map(),
    openCalls: new Map(),
    callDurations: new Map(),
    models: new Map(),
    denials: new Map(),
  }
  for (const line of lines) foldLine(fold, line)
  return fold
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

/** Every record counts for its writer; the first one of a writer is the row. */
function foldWriter(fold: Fold, line: EnsoLogLine, properties: Properties): ProcessFold {
  const writer = stringOf(properties.process) ?? '(unstamped)'
  const at = line['@timestamp']
  const known = fold.processes.get(writer)
  if (known !== undefined) {
    known.lastAt = at
    known.records += 1
    return known
  }
  const fresh: ProcessFold = { process: writer, firstAt: at, lastAt: at, records: 1 }
  fold.processes.set(writer, fresh)
  return fresh
}

function foldBoot(process: ProcessFold, properties: Properties): void {
  process.pid = numberOf(properties.pid)
  process.startedAt = stringOf(properties.startedAt)
  process.file = stringOf(properties.file)
  process.console = stringOf(properties.console)
  process.overrides = Array.isArray(properties.overrides) ? properties.overrides.map(String) : undefined
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

/** The compact observation line: the run's settle, or a tool's call or result. */
function foldObservation(fold: Fold, properties: Properties, instant: number): void {
  const kind = properties.kind
  if (kind === 'settled') {
    const run = runOf(fold, properties)
    if (run !== undefined && run.settledAt === undefined) run.settledAt = instant
  } else if (kind === 'tool-call' || kind === 'tool-result') foldTool(fold, kind, properties, instant)
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

/** One line into the fold, by the event its template names. */
function foldLine(fold: Fold, line: EnsoLogLine): void {
  const properties = line.properties ?? {}
  const instant = Date.parse(line['@timestamp'])
  const writer = foldWriter(fold, line, properties)
  switch (line.message) {
    case ENSO_LOG_EVENTS.loggingConfigured:
      foldBoot(writer, properties)
      return
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
  }
}

/**
 * Each tool call's call → result in these records, by `toolCallId` (#45 phase 2) — the same join
 * `dayStats` sums per tool, kept per call so a reader can rank the calls themselves.
 *
 * @group Logging
 */
export function toolCallDurations(lines: readonly EnsoLogLine[]): ReadonlyMap<string, number> {
  return foldOf(lines).callDurations
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
  const fold = foldOf(lines)

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
  for (const refusals of fold.denials.values()) deniedCalls += refusals

  return {
    day,
    records: lines.length,
    malformed,
    processes: [...fold.processes.values()].map(processRowOf),
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
    denials: [...fold.denials.entries()].map(([rule, refusals]) => ({ rule, count: refusals })),
    totals: {
      runs: runRows.length,
      prompts: summarise(runRows.flatMap((run) => (run.promptMs === undefined ? [] : [run.promptMs]))),
      firstDelta: summarise(runRows.flatMap((run) => (run.firstDeltaMs === undefined ? [] : [run.firstDeltaMs]))),
      toolCalls,
      denials: deniedCalls,
      ...totalSpend,
    },
  }
}
