import { EnsoThreadStats, type EnsoToolCallStats } from '@enso/core'
import { lazy, Suspense, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { IN_FLIGHT_ESTIMATE_TITLE, type LiveRun, runningEmptyText, runningTurnWords } from './live-request.ts'
import { useThreadReadable } from './model-state.tsx'
import { OptionSelect } from './option-select.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readNothingRan, readThreadAnalysis } from './route-read.ts'
import { costText, countText, durationsText } from './stats-table.tsx'
import { useStore, useThreadStores } from './store.ts'
import {
  type CallMetric,
  callValue,
  headlineOf,
  isRefused,
  rankCalls,
  type RefusedCalls,
  rankTools,
  type StatsHeadline,
  type ToolSummary,
  type ToolUsageMetric,
  toolSummaries,
  toolUsageValue,
  unpricedPrompts,
} from './thread-stats-analysis.ts'
import type { OnTurn, TurnPoint } from './thread-stats-charts.tsx'
import type { RevealStatsTarget, StatsTarget } from './transcript-reveal.ts'
import { Card, Empty, Metric, Section } from './view-parts.tsx'

/**
 * The thread's stats drawer (#45 phase 2) — pi-livecraft's session analysis widget
 * (`.inspiration/pi-extensions/pi-livecraft/src/features/session-analysis/`), section for
 * section, over our wire: summary cards, context and tokens per turn, cost per turn, cumulative
 * usage by tool, costliest calls, distribution, costliest prompts. Left out, by decision: the
 * "interpret session" model call.
 *
 * A chart point, a costliest call and a costliest prompt are each a way into the transcript
 * (#359, livecraft's `onNavigate`): a click, or Enter on the focused point or row, scrolls the
 * pane to that turn, call or prompt and rings it (`transcript-reveal.ts` says how each is found).
 *
 * Reads `GET /api/threads/:threadId/stats` on open and again whenever the thread's usage moves
 * (`stores.usage`, #45 PR 1): the status bar's `session-usage` is the one signal that a turn,
 * a run or a compaction just landed, so the drawer refetches exactly when there is something new
 * and never on a timer.
 *
 * ⚠ WHAT IS MEASURED, SAID AS SUCH (livecraft's discipline): pi's session total is the cost, and
 * what the branch's messages do not account for is named, never spread over turns; a duration is
 * the log's, so a resumed thread's older calls say they were not measured; an empty section says
 * what it is waiting for instead of drawing zeros; a model pi has no price for says its cost is
 * unknown, never $0.0000, which reads as free (#692).
 */

export type StatsOutcome = AnalysisOutcome<EnsoThreadStats>

/** The thread's stats (stable, module-level: `useReadOnUsage` subscribes with it). */
const readThreadStats = (threadId: string, fetchImpl: FetchLike): Promise<StatsOutcome> =>
  readThreadAnalysis(threadId, 'stats', EnsoThreadStats, fetchImpl)

// ── formats ──────────────────────────────────────────────────────────────────────────────────

const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** Characters, not tokens: `1.2k chars`. */
function charsText(characters: number): string {
  return characters >= 1000 ? `${ONE_DECIMAL.format(characters / 1000)}k chars` : `${characters} chars`
}

function durationText(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${ONE_DECIMAL.format(milliseconds / 1000)} s`
}

const plural = (count: number, word: string): string => `${countText(count)} ${word}${count === 1 ? '' : 's'}`

// ── context and tokens ───────────────────────────────────────────────────────────────────────

// The charts, and recharts with them, come as their own chunk the first time a thread has a turn
// to draw (#747): the chat screen's bundle is 1.5 MB without a drawer most sessions never open.
const TokenChart = lazy(() => import('./thread-stats-charts.tsx').then((charts) => ({ default: charts.TokenChart })))
const CostChart = lazy(() => import('./thread-stats-charts.tsx').then((charts) => ({ default: charts.CostChart })))
/** Sized as the chart it stands in for, so the drawer does not jump when the chunk lands. */
const CHART_LOADING = <p className="h-36 text-xs text-muted-foreground">loading the chart…</p>

function ContextSection({
  stats,
  data,
  onTurn,
  empty,
}: {
  stats: EnsoThreadStats
  data: readonly TurnPoint[]
  onTurn: OnTurn
  /** What an empty chart says: what it waits for, or that a run is in progress (#913). */
  empty: string
}): React.ReactNode {
  const { usage } = stats
  const context = usage.context
  const percent = context?.percent ?? null
  return (
    <Section
      title="Tokens"
      aside={percent === null ? undefined : `${PERCENT.format(percent / 100)} of the context window`}
    >
      {percent === null ? null : (
        <meter
          aria-label="context window used"
          min={0}
          max={100}
          value={Math.min(percent, 100)}
          className="h-2 w-full appearance-none overflow-hidden rounded-full bg-popover [&::-moz-meter-bar]:bg-foreground [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-transparent [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-foreground [&::-webkit-meter-optimum-value]:bg-none"
        />
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {(
          [
            ['cache miss', countText(usage.input)],
            ['cache read', countText(usage.cacheRead)],
            ['cache write', countText(usage.cacheWrite)],
            ['output', countText(usage.output)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex justify-between">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {data.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <Suspense fallback={CHART_LOADING}>
          <TokenChart data={data} onTurn={onTurn} />
        </Suspense>
      )}
    </Section>
  )
}

// ── a cost pi had no price for (#692) ────────────────────────────────────────────────────────

const UNKNOWN_COST = 'unknown'

/**
 * A cost turns with no price are part of: `unknown` when nothing in it was priced, otherwise at
 * least the priced part — never a bare `$0.0000`, which reads as free (`isUnpriced`).
 */
function partlyPricedCostText(cost: number, unpriced: boolean): string {
  if (!unpriced) return costText(cost)
  return cost === 0 ? UNKNOWN_COST : `≥ ${costText(cost)}`
}

/** A per-turn figure: `—` before the first turn, `unknown` when a turn had no price. */
function perTurnCostText(cost: number | undefined, noTurn: boolean): string {
  if (noTurn) return '—'
  return cost === undefined ? UNKNOWN_COST : costText(cost)
}

/** Beneath the total: whose cost it leaves out. */
function unpricedNote(headline: StatsHeadline): string | undefined {
  if (headline.pricing === 'priced') return undefined
  if (headline.pricing === 'unpriced') return 'no price for this model — its tokens are counted, not its cost'
  return `${plural(headline.unpricedTurnCount, 'turn')} on a model with no price — not in the cost`
}

function CostPerTurn({
  headline,
  data,
  onTurn,
  empty,
}: {
  readonly headline: StatsHeadline
  readonly data: readonly TurnPoint[]
  readonly onTurn: OnTurn
  readonly empty: string
}): React.ReactNode {
  const noTurn = headline.turnCount === 0
  let body: React.ReactNode = (
    <Suspense fallback={CHART_LOADING}>
      <CostChart data={data} onTurn={onTurn} />
    </Suspense>
  )
  if (noTurn) body = <Empty>{empty}</Empty>
  else if (headline.pricing === 'unpriced') body = <Empty>no price for this model, so no cost to chart</Empty>
  return (
    <Section
      title="Cost per turn"
      aside={noTurn ? undefined : `median ${perTurnCostText(headline.medianTurnCost, noTurn)}`}
    >
      {body}
    </Section>
  )
}

// ── tools ────────────────────────────────────────────────────────────────────────────────────

const USAGE_METRICS: ReadonlyArray<readonly [ToolUsageMetric, string]> = [
  ['output', 'cumulative output'],
  ['input', 'cumulative input'],
  ['duration', 'cumulative duration'],
]

function ToolUsageRow({
  tool,
  metric,
  largest,
}: {
  tool: ToolSummary
  metric: ToolUsageMetric
  largest: number
}): React.ReactNode {
  const value = toolUsageValue(tool, metric)
  const measured =
    metric === 'duration' && tool.measured < tool.calls ? ` · ${tool.measured}/${tool.calls} durations measured` : ''
  const failures = tool.failed > 0 ? ` · ${plural(tool.failed, 'failure')}` : ''
  const refusals = tool.refused > 0 ? ` · ${countText(tool.refused)} refused` : ''
  return (
    <li className="grid gap-1">
      <div className="flex justify-between gap-2">
        <code className="font-mono">{tool.toolName}</code>
        <b className="font-mono font-medium tabular-nums">
          {metric === 'duration' ? durationText(value) : charsText(value)}
        </b>
      </div>
      <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-popover">
        <span
          className="block h-full rounded-full bg-chart-1"
          style={{ width: `${largest > 0 ? (value / largest) * 100 : 0}%` }}
        />
      </span>
      <small className="text-xs text-muted-foreground">
        {plural(tool.calls, 'call')}
        {measured}
        {failures}
        {refusals}
      </small>
    </li>
  )
}

function ToolUsage({ tools }: { tools: readonly ToolSummary[] }): React.ReactNode {
  const [metric, setMetric] = useState<ToolUsageMetric>('output')
  const ranked = rankTools(tools, metric)
  const largest = ranked[0] === undefined ? 0 : toolUsageValue(ranked[0], metric)
  return (
    <Section
      title="Cumulative usage by tool"
      aside={
        <OptionSelect label="rank cumulative tool usage" value={metric} options={USAGE_METRICS} onChange={setMetric} />
      }
    >
      {ranked.length === 0 ? (
        <Empty>
          {metric === 'duration'
            ? 'no call on this branch was timed — durations come from the log, which keeps 14 days'
            : 'no tool called on this branch yet'}
        </Empty>
      ) : (
        <ol className="grid gap-2">
          {ranked.map((tool) => (
            <ToolUsageRow key={tool.toolName} tool={tool} metric={metric} largest={largest} />
          ))}
        </ol>
      )}
    </Section>
  )
}

const CALL_METRICS: ReadonlyArray<readonly [CallMetric, string]> = [
  ['input', 'input'],
  ['output', 'output'],
  ['duration', 'observed duration'],
  ['failure', 'failures'],
]

function callMetricText(call: EnsoToolCallStats, metric: CallMetric, refused: RefusedCalls): string {
  if (metric === 'duration') return durationText(call.durationMs ?? 0)
  if (metric === 'failure') return 'failed'
  return charsText(callValue(call, metric, refused))
}

/** What became of a ranked call, beside its name: refused by a guard (#407), failed, or nothing. */
function CallOutcome({ call, refused }: { call: EnsoToolCallStats; refused: RefusedCalls }): React.ReactNode {
  if (isRefused(call, refused)) return <i className="ml-1.5 text-muted-foreground not-italic">refused</i>
  return call.isError ? <i className="ml-1.5 text-refuse not-italic">failed</i> : null
}

/** Opens a target in the transcript; absent where there is nowhere to go (a static render). */
type Navigate = ((target: StatsTarget) => void) | undefined

/**
 * A ranked row that opens what it ranks — a real `<button>`, so a keyboard reaches it and Enter
 * or Space opens it. Without somewhere to go (a static render) it is plain content.
 */
function RankedRow({
  target,
  onNavigate,
  children,
}: {
  target: StatsTarget
  onNavigate: Navigate
  children: React.ReactNode
}): React.ReactNode {
  const layout = 'flex w-full items-start justify-between gap-3 px-2 py-2 text-left'
  return (
    <li className="border-b last:border-b-0">
      {onNavigate === undefined ? (
        <div className={layout}>{children}</div>
      ) : (
        <button
          type="button"
          className={`${layout} cursor-pointer transition-colors hover:bg-popover focus-visible:outline-2 focus-visible:outline-ring`}
          onClick={() => onNavigate(target)}
        >
          {children}
        </button>
      )}
    </li>
  )
}

function CostliestCalls({
  calls,
  refused,
  onNavigate,
}: {
  calls: readonly EnsoToolCallStats[]
  refused: RefusedCalls
  onNavigate: Navigate
}): React.ReactNode {
  const [metric, setMetric] = useState<CallMetric>('input')
  const ranked = rankCalls(calls, metric, refused)
  const empty: Record<CallMetric, string> = {
    input: 'no tool called on this branch yet',
    output: 'no tool called on this branch yet',
    duration: 'no call on this branch was timed — durations come from the log, which keeps 14 days',
    failure: 'no call on this branch failed',
  }
  return (
    <Section
      title="Costliest calls"
      aside={<OptionSelect label="rank tool calls" value={metric} options={CALL_METRICS} onChange={setMetric} />}
    >
      {ranked.length === 0 ? (
        <Empty>{empty[metric]}</Empty>
      ) : (
        <ol className="-mx-2">
          {ranked.map((call) => (
            <RankedRow
              key={call.toolCallId}
              target={{ kind: 'tool-call', toolCallId: call.toolCallId }}
              onNavigate={onNavigate}
            >
              <span>
                <code className="font-mono">{call.toolName}</code>
                <CallOutcome call={call} refused={refused} />
                {call.pending ? <i className="ml-1.5 text-muted-foreground not-italic">in progress</i> : null}
                <small className="block text-xs text-muted-foreground">
                  turn {call.turn} · {charsText(call.inputChars)} input · {charsText(call.outputChars)} output
                </small>
              </span>
              <b className="shrink-0 font-mono font-medium tabular-nums">{callMetricText(call, metric, refused)}</b>
            </RankedRow>
          ))}
        </ol>
      )}
    </Section>
  )
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────

/** livecraft shows the five prompts that cost the most. */
const COSTLIEST_PROMPTS = 5

/** The drawer's word for a target the transcript on screen does not have (`transcript-reveal.ts`); the eval's too (#727). */
export function missedText(target: StatsTarget): string {
  if (target.kind === 'turn') return `turn ${target.turn} is not in the transcript on screen`
  if (target.kind === 'prompt') return 'that prompt is not in the transcript on screen'
  return 'that call is not in the transcript on screen'
}

/**
 * Pure view — the data arrives as props; only the rankings' choices are its own state. `onNavigate`
 * opens a target in the transcript; `missed` says the last one could not be found.
 */
const NO_REFUSALS: RefusedCalls = new Map()

/**
 * The turn in flight (#913): its time and its output so far, said as estimates and kept out of
 * every total above — the provider counts it when it completes, and only then is it a turn here.
 */
function RunningTurn({ turn, live }: { turn: number; live: LiveRun | undefined }): React.ReactNode {
  if (live === undefined) return null
  const { head, figures, note } = runningTurnWords(turn, live)
  return (
    <p
      data-running-turn=""
      className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
      title={live.request === undefined ? undefined : IN_FLIGHT_ESTIMATE_TITLE}
    >
      <b className="font-medium text-foreground">{head}</b>
      <span className="font-mono tabular-nums">{figures}</span> — {note}
    </p>
  )
}

/** What an empty section says: what it waits for, or — while a run is in flight (#913) — that it runs. */
function emptyWhile(live: LiveRun | undefined, noTurn: boolean, waiting: string): string {
  if (live === undefined) return waiting
  return runningEmptyText(noTurn && live.request !== undefined, live.request?.startedAt ?? live.runSince, live.now)
}

export function ThreadStatsView({
  outcome,
  onNavigate,
  missed,
  refused = NO_REFUSALS,
  live,
}: {
  readonly outcome: StatsOutcome
  readonly onNavigate?: ((target: StatsTarget) => void) | undefined
  readonly missed?: string | undefined
  /** The calls something refused (#387, #523) — the thread's `refusals`; none in a static render. */
  readonly refused?: RefusedCalls
  /** The run in flight (#913), undefined at rest: its turn is shown apart, never counted in. */
  readonly live?: LiveRun | undefined
}): React.ReactNode {
  if (outcome.kind === 'reading')
    return <p className="p-3 text-xs text-muted-foreground">reading the thread's stats…</p>
  if (outcome.kind === 'failed') return <p className="p-3 text-xs text-muted-foreground">no stats: {outcome.problem}</p>
  const stats = outcome.payload
  const headline = headlineOf(stats, refused)
  const tools = toolSummaries(stats.callStats, refused)
  const data = stats.turnStats.map((turn) => ({ ...turn, label: String(turn.turn) }))
  const costliest = stats.promptStats
    .filter((prompt) => prompt.turnCount > 0)
    .toSorted((first, second) => second.cost - first.cost)
    .slice(0, COSTLIEST_PROMPTS)
  const unpriced = unpricedPrompts(stats.turnStats)
  const noTurn = headline.turnCount === 0
  const onTurn = onNavigate === undefined ? undefined : (turn: number): void => onNavigate({ kind: 'turn', turn })
  const emptyUntil = (waiting: string): string => emptyWhile(live, noTurn, waiting)
  return (
    <section aria-label="thread stats" className="@container grid grid-cols-1 gap-4 p-6">
      <Card
        title="Session analysis"
        sub={`${plural(stats.promptStats.length, 'prompt')} analysed · ${stats.live ? 'live' : 'from the file'}`}
      >
        {missed === undefined ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {missed}
          </p>
        )}
        <RunningTurn turn={(stats.turnStats.at(-1)?.turn ?? 0) + 1} live={live} />
        <dl className="grid grid-cols-2 gap-2 @3xl:grid-cols-3">
          <Metric
            label="total cost"
            value={partlyPricedCostText(stats.usage.cost, headline.pricing !== 'priced')}
            note={unpricedNote(headline)}
          />
          <Metric label="average cost / turn" value={perTurnCostText(headline.averageTurnCost, noTurn)} />
          <Metric label="turn count" value={countText(headline.turnCount)} />
          <Metric
            label="average tools / turn"
            value={noTurn ? '—' : ONE_DECIMAL.format(headline.averageToolsPerTurn)}
          />
          <Metric label="tool calls" value={countText(headline.toolCalls)} />
          <Metric
            label="failures"
            value={`${countText(headline.failedToolCalls)} · ${PERCENT.format(headline.failureRate)}`}
            danger={headline.failedToolCalls > 0}
            // Policy doing its job is not danger (#407): a refusal is said beside, never counted in.
            note={
              headline.refusedToolCalls > 0
                ? `${countText(headline.refusedToolCalls)} refused by a guard — not failures`
                : undefined
            }
          />
        </dl>
        {headline.offBranchCost > 0 ? (
          <p
            className="text-sm text-muted-foreground"
            title="compactions, branch summaries, cache warms and abandoned branches"
          >
            <b className="font-mono font-medium text-foreground">{costText(headline.offBranchCost)}</b> not attributed
            to a turn on this branch.
          </p>
        ) : null}
      </Card>
      <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
        <ContextSection
          stats={stats}
          data={data}
          onTurn={onTurn}
          empty={emptyUntil('tokens appear after the first response')}
        />
        <CostPerTurn
          headline={headline}
          data={data}
          onTurn={onTurn}
          empty={emptyUntil('costs appear after the first response')}
        />
        <ToolUsage tools={tools} />
        <CostliestCalls calls={stats.callStats} refused={refused} onNavigate={onNavigate} />
        {tools.length === 0 ? null : (
          <Section title="Distribution" aside="calls · failures">
            <ul className="grid gap-1">
              {tools.map((tool) => (
                <li key={tool.toolName} className="flex justify-between gap-2">
                  <code className="font-mono">{tool.toolName}</code>
                  <span className="font-mono tabular-nums">
                    {countText(tool.calls)}
                    {tool.failed > 0 ? (
                      <b className="ml-1 font-medium text-refuse">· {countText(tool.failed)}</b>
                    ) : null}
                    {tool.refused > 0 ? (
                      <span className="ml-1 text-muted-foreground">· {countText(tool.refused)} refused</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Costliest prompts" aside="cost">
          {costliest.length === 0 ? (
            <Empty>{emptyUntil('costs appear after the first response')}</Empty>
          ) : (
            <ol className="-mx-2">
              {costliest.map((prompt) => (
                <RankedRow
                  key={prompt.prompt}
                  target={{ kind: 'prompt', prompt: prompt.prompt }}
                  onNavigate={onNavigate}
                >
                  <span className="min-w-0">
                    <strong className="block truncate font-medium text-foreground" title={prompt.text}>
                      {prompt.text || '(before the first prompt)'}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {plural(prompt.turnCount, 'model call')} · {plural(prompt.toolCalls, 'tool')}
                      {prompt.durationMs === undefined ? null : (
                        <span title="the prompt to the last reply entry, as pi stamped them">
                          {' '}
                          · {durationText(prompt.durationMs)}
                        </span>
                      )}
                    </small>
                  </span>
                  <b className="shrink-0 font-mono font-medium tabular-nums">
                    {partlyPricedCostText(prompt.cost, unpriced.has(prompt.prompt))}
                  </b>
                </RankedRow>
              ))}
            </ol>
          )}
        </Section>
        <Section title="Latency" aside="from the log">
          <dl className="grid grid-cols-label-value gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">prompt → settle</dt>
            <dd className="font-mono tabular-nums">{durationsText(stats.latency.prompts, 'not in the log')}</dd>
            <dt className="text-muted-foreground">first token</dt>
            <dd className="font-mono tabular-nums">{durationsText(stats.latency.firstDelta, 'not in the log')}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            {stats.logDays.length === 0
              ? 'no day file covers this thread — the log keeps 14 days'
              : `read from ${stats.logDays.join(', ')}`}
          </p>
        </Section>
      </div>
    </section>
  )
}

/**
 * The Stats view wired to its thread: read on open and whenever the thread's usage moves
 * (`read-on-usage.ts`). `onNavigate` is the pane's (`chat-layout.tsx`): it finds the target in
 * that pane's transcript and says whether it could.
 */
export function ThreadStatsDrawer({
  onNavigate,
  live,
}: {
  readonly onNavigate?: RevealStatsTarget
  readonly live?: LiveRun | undefined
}): React.ReactNode {
  // #659: no request until the thread can answer — a never-run thread's 404s were console errors.
  const outcome = useReadOnUsage<StatsOutcome>(useThreadReadable() ? readThreadStats : readNothingRan, ANALYSIS_READING)
  const [missed, setMissed] = useState<string | undefined>(undefined)
  const navigate =
    onNavigate === undefined || outcome.kind !== 'read'
      ? undefined
      : (target: StatsTarget): void => setMissed(onNavigate(target, outcome.payload) ? undefined : missedText(target))
  const refused = useStore(useThreadStores().refusals)
  return <ThreadStatsView outcome={outcome} onNavigate={navigate} missed={missed} refused={refused} live={live} />
}
