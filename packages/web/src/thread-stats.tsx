import { EnsoThreadStats, type EnsoToolCallStats, type EnsoTurnStats } from '@enso/core'
import { useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  type DotItemDotProps,
  Bar,
  BarChart,
  type MouseHandlerDataParam,
  XAxis,
  YAxis,
} from 'recharts'
import type { FetchLike } from './browser-logging.ts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.tsx'
import { cn } from './lib/utils.ts'
import { OptionSelect } from './option-select.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
import { COMPACT, costText, countText, durationsText } from './stats-table.tsx'
import {
  type CallMetric,
  callValue,
  headlineOf,
  rankCalls,
  rankTools,
  type ToolSummary,
  type ToolUsageMetric,
  toolSummaries,
  toolUsageValue,
} from './thread-stats-analysis.ts'
import { toggleMember } from './toggle-member.ts'
import type { RevealStatsTarget, StatsTarget } from './transcript-reveal.ts'
import { Card } from './view-parts.tsx'

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
 * what it is waiting for instead of drawing zeros.
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

// ── building blocks ──────────────────────────────────────────────────────────────────────────

/** One headline figure: what it is, then the number large — the design's `.meter-figure`. */
function Metric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }): React.ReactNode {
  return (
    <div className="grid content-start gap-1 rounded-lg border bg-background px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-heading text-2xl leading-tight font-semibold whitespace-nowrap tabular-nums',
          danger ? 'text-refuse' : 'text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/** A section of the analysis as a card: its title, and on the right what it ranks by or how to read it. */
function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Card
      title={title}
      tools={aside === undefined ? undefined : <span className="text-xs text-muted-foreground">{aside}</span>}
    >
      <div className="grid min-w-0 grid-cols-1 gap-2 text-sm">{children}</div>
    </Card>
  )
}

function Empty({ children }: { children: string }): React.ReactNode {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

/** A chart tooltip's heading: the turn its point is. */
const turnLabel = (label: unknown): string => `turn ${String(label)}`
const dollarTick = (value: number): string => `$${value.toFixed(3)}`
const tokenTick = (value: number): string => COMPACT.format(value)

/** Three ticks on a value axis, as livecraft draws: nothing, half, the most. */
const AXIS_TICKS = 3

/**
 * The grid, the turn axis, a value axis and the tooltip every turn chart shares — returned as
 * elements, not a component, so recharts finds them as its chart's direct children.
 */
function turnAxes(tick: (value: number) => string, width: number): React.ReactNode[] {
  return [
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis key="turn" dataKey="label" tickLine={false} axisLine={false} minTickGap={8} />,
    <YAxis key="value" tickLine={false} axisLine={false} width={width} tickCount={AXIS_TICKS} tickFormatter={tick} />,
    <ChartTooltip key="tooltip" content={<ChartTooltipContent labelFormatter={turnLabel} />} />,
  ]
}

type TurnPoint = EnsoTurnStats & { readonly label: string }

/** Opens a turn in the transcript; absent where there is nowhere to go (a static render). */
type OnTurn = ((turn: number) => void) | undefined

/** A chart's click props: a click → the turn under the pointer, or none without somewhere to go. */
type ChartClick = { onClick: (state: MouseHandlerDataParam) => void; className: string } | Record<never, never>

/**
 * The chart's click → the turn under the pointer. Recharts reports the hovered point's index,
 * which is the one its tooltip shows, so a click anywhere in the column goes where the tooltip says.
 */
function turnClick(data: readonly TurnPoint[], onTurn: OnTurn): ChartClick {
  if (onTurn === undefined) return {}
  return {
    className: 'cursor-pointer',
    onClick: (state: MouseHandlerDataParam): void => {
      const index = state.activeTooltipIndex
      if (index === undefined || index === null) return
      const point = data[Number(index)]
      if (point !== undefined) onTurn(point.turn)
    },
  }
}

/**
 * A cost point as a control (livecraft's `role="button"` points): focusable, and Enter or Space
 * opens its turn — the keyboard's way in, where the click above is the pointer's.
 */
function turnDot(onTurn: OnTurn): ((props: DotItemDotProps) => React.ReactNode) | boolean {
  if (onTurn === undefined) return true
  return function TurnDot(dot: DotItemDotProps): React.ReactNode {
    const point = dot.payload as TurnPoint
    const open = (): void => onTurn(point.turn)
    return (
      <circle
        key={`turn-${dot.index}`}
        cx={dot.cx}
        cy={dot.cy}
        r={3}
        fill="var(--background)"
        stroke={dot.stroke}
        strokeWidth={2}
        role="button"
        tabIndex={0}
        aria-label={`turn ${point.turn}, ${costText(point.cost)} — show it in the transcript`}
        className="cursor-pointer outline-none focus-visible:stroke-foreground"
        // The chart's own `onClick` (`turnClick`) sits on recharts' wrapper, above this point, and
        // names the same hovered turn: bubbling would open it twice (PR #360 review).
        onClick={(event: React.MouseEvent<SVGCircleElement>): void => {
          event.stopPropagation()
          open()
        }}
        onKeyDown={(event: React.KeyboardEvent<SVGCircleElement>): void => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        }}
      />
    )
  }
}

// ── context and tokens ───────────────────────────────────────────────────────────────────────

/**
 * livecraft's series — what missed the cache, what it served, what the model wrote — plus what
 * was written to it, which Anthropic bills apart and a long first turn is mostly made of.
 */
type TokenSeries = 'input' | 'cacheRead' | 'cacheWrite' | 'output'
const TOKEN_SERIES: Readonly<Record<TokenSeries, { readonly label: string; readonly color: string }>> = {
  input: { label: 'cache miss', color: 'var(--chart-1)' },
  cacheRead: { label: 'cache read', color: 'var(--chart-2)' },
  cacheWrite: { label: 'cache write', color: 'var(--chart-4)' },
  output: { label: 'output', color: 'var(--chart-3)' },
}

/**
 * Tokens per turn, the series stacked in one bar — what the cache served at the base, then what
 * was written to it, what missed it, and what the model wrote — each toggled from its legend
 * button (#407: four crossing lines read as a zig-zag). ⓘ No animation on any chart here: the
 * drawer refetches after each turn, and a chart re-drawing from zero every time would replay the
 * thread's history as if it were happening again.
 */
/** The stack, base first: a long thread is mostly cache reads, and the rarer series sit on top where they show. */
const STACK_ORDER: readonly TokenSeries[] = ['cacheRead', 'cacheWrite', 'input', 'output']

function TokenChart({
  data,
  onTurn,
}: {
  readonly data: readonly TurnPoint[]
  readonly onTurn: OnTurn
}): React.ReactNode {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  // The legend reads in the stack's order, base first.
  const series = STACK_ORDER.map((key) => [key, TOKEN_SERIES[key]] as const)
  const stacked = STACK_ORDER.filter((key) => !hidden.has(key))
  const toggle = (key: string): void => setHidden((current) => toggleMember(current, key))
  return (
    <>
      <fieldset aria-label="token series shown" className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
        {series.map(([key, { label, color }]) => (
          <button
            key={key}
            type="button"
            aria-pressed={!hidden.has(key)}
            className={cn(
              'whitespace-nowrap',
              hidden.has(key) ? 'text-muted-foreground line-through' : 'text-foreground',
            )}
            onClick={() => toggle(key)}
          >
            <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full" style={{ background: color }} />
            {label}
          </button>
        ))}
      </fieldset>
      <ChartContainer config={TOKEN_SERIES} className="aspect-auto h-36 w-full">
        <BarChart data={[...data]} accessibilityLayer {...turnClick(data, onTurn)}>
          {turnAxes(tokenTick, 40)}
          {stacked.map((key) => (
            <Bar key={key} dataKey={key} stackId="tokens" fill={`var(--color-${key})`} isAnimationActive={false} />
          ))}
        </BarChart>
      </ChartContainer>
    </>
  )
}

function ContextSection({
  stats,
  data,
  onTurn,
}: {
  stats: EnsoThreadStats
  data: readonly TurnPoint[]
  onTurn: OnTurn
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
        <Empty>tokens appear after the first response</Empty>
      ) : (
        <TokenChart data={data} onTurn={onTurn} />
      )}
    </Section>
  )
}

// ── cost per turn ────────────────────────────────────────────────────────────────────────────

const COST_SERIES: ChartConfig = { cost: { label: 'cost ($)', color: 'var(--chart-1)' } }

function CostChart({
  data,
  onTurn,
}: {
  readonly data: readonly TurnPoint[]
  readonly onTurn: OnTurn
}): React.ReactNode {
  return (
    <ChartContainer config={COST_SERIES} className="aspect-auto h-36 w-full">
      <AreaChart data={[...data]} accessibilityLayer {...turnClick(data, onTurn)}>
        {turnAxes(dollarTick, 48)}
        <Area
          dataKey="cost"
          type="linear"
          stroke="var(--color-cost)"
          fill="var(--color-cost)"
          fillOpacity={0.2}
          strokeWidth={2}
          dot={turnDot(onTurn)}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
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

function callMetricText(call: EnsoToolCallStats, metric: CallMetric): string {
  if (metric === 'duration') return durationText(call.durationMs ?? 0)
  if (metric === 'failure') return 'failed'
  return charsText(callValue(call, metric))
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
  onNavigate,
}: {
  calls: readonly EnsoToolCallStats[]
  onNavigate: Navigate
}): React.ReactNode {
  const [metric, setMetric] = useState<CallMetric>('input')
  const ranked = rankCalls(calls, metric)
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
                {call.isError ? <i className="ml-1.5 text-refuse not-italic">failed</i> : null}
                {call.pending ? <i className="ml-1.5 text-muted-foreground not-italic">in progress</i> : null}
                <small className="block text-xs text-muted-foreground">
                  turn {call.turn} · {charsText(call.inputChars)} input · {charsText(call.outputChars)} output
                </small>
              </span>
              <b className="shrink-0 font-mono font-medium tabular-nums">{callMetricText(call, metric)}</b>
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

/** The drawer's word for a target the transcript on screen does not have (`transcript-reveal.ts`). */
function missedText(target: StatsTarget): string {
  if (target.kind === 'turn') return `turn ${target.turn} is not in the transcript on screen`
  if (target.kind === 'prompt') return 'that prompt is not in the transcript on screen'
  return 'that call is not in the transcript on screen'
}

/**
 * Pure view — the data arrives as props; only the rankings' choices are its own state. `onNavigate`
 * opens a target in the transcript; `missed` says the last one could not be found.
 */
export function ThreadStatsView({
  outcome,
  onNavigate,
  missed,
}: {
  readonly outcome: StatsOutcome
  readonly onNavigate?: ((target: StatsTarget) => void) | undefined
  readonly missed?: string | undefined
}): React.ReactNode {
  if (outcome.kind === 'reading')
    return <p className="p-3 text-xs text-muted-foreground">reading the thread's stats…</p>
  if (outcome.kind === 'failed') return <p className="p-3 text-xs text-muted-foreground">no stats: {outcome.problem}</p>
  const stats = outcome.payload
  const headline = headlineOf(stats)
  const tools = toolSummaries(stats.callStats)
  const data = stats.turnStats.map((turn) => ({ ...turn, label: String(turn.turn) }))
  const costliest = stats.promptStats
    .filter((prompt) => prompt.turnCount > 0)
    .sort((first, second) => second.cost - first.cost)
    .slice(0, COSTLIEST_PROMPTS)
  const noTurn = headline.turnCount === 0
  const onTurn = onNavigate === undefined ? undefined : (turn: number): void => onNavigate({ kind: 'turn', turn })
  return (
    <section aria-label="thread stats" className="@container grid grid-cols-1 gap-4 p-4">
      <Card
        title="Session analysis"
        sub={`${plural(stats.promptStats.length, 'prompt')} analysed · ${stats.live ? 'live' : 'from the file'}`}
      >
        {missed === undefined ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {missed}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-2 @3xl:grid-cols-3">
          <Metric label="total cost" value={costText(stats.usage.cost)} />
          <Metric label="average cost / turn" value={noTurn ? '—' : costText(headline.averageTurnCost)} />
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
        <ContextSection stats={stats} data={data} onTurn={onTurn} />
        <Section title="Cost per turn" aside={noTurn ? undefined : `median ${costText(headline.medianTurnCost)}`}>
          {noTurn ? <Empty>costs appear after the first response</Empty> : <CostChart data={data} onTurn={onTurn} />}
        </Section>
        <ToolUsage tools={tools} />
        <CostliestCalls calls={stats.callStats} onNavigate={onNavigate} />
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
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Costliest prompts" aside="cost">
          {costliest.length === 0 ? (
            <Empty>costs appear after the first response</Empty>
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
                  <b className="shrink-0 font-mono font-medium tabular-nums">{costText(prompt.cost)}</b>
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
 * (`read-on-usage.ts`). `onNavigate` is the pane's (`chat-screen.tsx`): it finds the target in
 * that pane's transcript and says whether it could.
 */
export function ThreadStatsDrawer({ onNavigate }: { readonly onNavigate?: RevealStatsTarget }): React.ReactNode {
  const outcome = useReadOnUsage<StatsOutcome>(readThreadStats, ANALYSIS_READING)
  const [missed, setMissed] = useState<string | undefined>(undefined)
  const navigate =
    onNavigate === undefined || outcome.kind !== 'read'
      ? undefined
      : (target: StatsTarget): void => setMissed(onNavigate(target, outcome.payload) ? undefined : missedText(target))
  return <ThreadStatsView outcome={outcome} onNavigate={navigate} missed={missed} />
}
