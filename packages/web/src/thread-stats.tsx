import { EnsoThreadStats, type EnsoToolCallStats, type EnsoTurnStats } from '@enso/core'
import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  type DotItemDotProps,
  Line,
  LineChart,
  type MouseHandlerDataParam,
  XAxis,
  YAxis,
} from 'recharts'
import type { FetchLike } from './browser-logging.ts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.tsx'
import { OptionSelect } from './option-select.tsx'
import { readSchemaRoute } from './route-read.ts'
import { costText, countText, durationsText } from './stats-table.tsx'
import { useThreadStores } from './store.ts'
import { latestWins } from './thread-debug.tsx'
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
import type { RevealStatsTarget, StatsTarget } from './transcript-reveal.ts'

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

export type StatsOutcome =
  | { readonly kind: 'reading' }
  | { readonly kind: 'read'; readonly stats: EnsoThreadStats }
  | { readonly kind: 'failed'; readonly problem: string }

/** The stats a thread's route answers, or why not — a 404 is a thread nothing has run in yet. */
async function fetchThreadStats(threadId: string, fetchImpl: FetchLike = fetch): Promise<StatsOutcome> {
  const read = await readSchemaRoute(
    `/api/threads/${encodeURIComponent(threadId)}/stats`,
    EnsoThreadStats,
    'stats',
    fetchImpl,
  )
  if (read.kind === 'absent') return { kind: 'failed', problem: 'nothing has run in this thread yet' }
  if (read.kind === 'failed') return read
  return { kind: 'read', stats: read.payload }
}

// ── formats ──────────────────────────────────────────────────────────────────────────────────

const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Characters, not tokens: `1.2k chars`. */
function charsText(characters: number): string {
  return characters >= 1000 ? `${ONE_DECIMAL.format(characters / 1000)}k chars` : `${characters} chars`
}

function durationText(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${ONE_DECIMAL.format(milliseconds / 1000)} s`
}

const plural = (count: number, word: string): string => `${countText(count)} ${word}${count === 1 ? '' : 's'}`

// ── building blocks ──────────────────────────────────────────────────────────────────────────

function Metric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }): React.ReactNode {
  return (
    <div className="rounded-md border px-2 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={danger ? 'text-base text-destructive' : 'text-base text-foreground'}>{value}</dd>
    </div>
  )
}

/** A section: its heading, and on the right what it ranks by or how to read it. */
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
    <section className="mb-5">
      <header className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">{title}</h3>
        {aside === undefined ? null : <span className="text-muted-foreground">{aside}</span>}
      </header>
      {children}
    </section>
  )
}

function Empty({ children }: { children: string }): React.ReactNode {
  return <p className="text-muted-foreground">{children}</p>
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
 * Tokens per turn, one line per series, each toggled from its legend button. ⓘ No animation on
 * any chart here: the drawer refetches after each turn, and a chart re-drawing from zero every
 * time would replay the thread's history as if it were happening again.
 */
function TokenChart({
  data,
  onTurn,
}: {
  readonly data: readonly TurnPoint[]
  readonly onTurn: OnTurn
}): React.ReactNode {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const series = Object.entries(TOKEN_SERIES)
  const toggle = (key: string): void =>
    setHidden((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  return (
    <>
      <fieldset aria-label="token series shown" className="mb-1 flex gap-3">
        {series.map(([key, { label, color }]) => (
          <button
            key={key}
            type="button"
            aria-pressed={!hidden.has(key)}
            className={hidden.has(key) ? 'text-muted-foreground line-through' : 'text-foreground'}
            onClick={() => toggle(key)}
          >
            <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full" style={{ background: color }} />
            {label}
          </button>
        ))}
      </fieldset>
      <ChartContainer config={TOKEN_SERIES} className="aspect-auto h-36 w-full">
        <LineChart data={[...data]} accessibilityLayer {...turnClick(data, onTurn)}>
          {turnAxes(tokenTick, 40)}
          {series
            .filter(([key]) => !hidden.has(key))
            .map(([key]) => (
              <Line
                key={key}
                dataKey={key}
                type="linear"
                stroke={`var(--color-${key})`}
                strokeWidth={2}
                dot
                isAnimationActive={false}
              />
            ))}
        </LineChart>
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
    <Section title="context" aside={percent === null ? undefined : PERCENT.format(percent / 100)}>
      {percent === null ? null : (
        <meter
          aria-label="context window used"
          min={0}
          max={100}
          value={Math.min(percent, 100)}
          className="mb-2 h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted-foreground/25 [&::-moz-meter-bar]:bg-foreground/60 [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-bar]:bg-transparent [&::-webkit-meter-optimum-value]:bg-foreground/60 [&::-webkit-meter-optimum-value]:bg-none"
        />
      )}
      <dl className="mb-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
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
            <dd className="tabular-nums">{value}</dd>
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
    <li className="mb-1.5">
      <div className="flex justify-between">
        <code>{tool.toolName}</code>
        <b className="font-normal tabular-nums">{metric === 'duration' ? durationText(value) : charsText(value)}</b>
      </div>
      <span aria-hidden="true" className="block h-1 rounded-full bg-muted-foreground/20">
        <span
          className="block h-full rounded-full bg-[var(--chart-1)]"
          style={{ width: `${largest > 0 ? (value / largest) * 100 : 0}%` }}
        />
      </span>
      <small className="text-muted-foreground">
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
      title="cumulative usage by tool"
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
        <ol>
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
  const layout = 'flex w-full items-start justify-between gap-2 pb-1 text-left'
  return (
    <li className="mb-1 border-b border-dashed">
      {onNavigate === undefined ? (
        <div className={layout}>{children}</div>
      ) : (
        <button
          type="button"
          className={`${layout} cursor-pointer rounded-sm hover:bg-muted/50 focus-visible:outline-1 focus-visible:outline-ring`}
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
      title="costliest calls"
      aside={<OptionSelect label="rank tool calls" value={metric} options={CALL_METRICS} onChange={setMetric} />}
    >
      {ranked.length === 0 ? (
        <Empty>{empty[metric]}</Empty>
      ) : (
        <ol>
          {ranked.map((call) => (
            <RankedRow
              key={call.toolCallId}
              target={{ kind: 'tool-call', toolCallId: call.toolCallId }}
              onNavigate={onNavigate}
            >
              <span>
                <code>{call.toolName}</code>
                {call.isError ? <i className="ml-1.5 text-destructive not-italic">failed</i> : null}
                {call.pending ? <i className="ml-1.5 text-muted-foreground not-italic">in progress</i> : null}
                <small className="block text-muted-foreground">
                  turn {call.turn} · {charsText(call.inputChars)} input · {charsText(call.outputChars)} output
                </small>
              </span>
              <b className="shrink-0 font-normal tabular-nums">{callMetricText(call, metric)}</b>
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
    return <p className="p-3 text-muted-foreground text-xs">reading the thread's stats…</p>
  if (outcome.kind === 'failed') return <p className="p-3 text-muted-foreground text-xs">no stats: {outcome.problem}</p>
  const { stats } = outcome
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
    <section aria-label="thread stats" className="p-3 font-mono text-xs">
      <h2 className="pb-2 font-semibold text-foreground">
        session analysis{' '}
        <span className="font-normal text-muted-foreground">
          · {plural(stats.promptStats.length, 'prompt')} analysed · {stats.live ? 'live' : 'from the file'}
        </span>
      </h2>
      {missed === undefined ? null : (
        <p role="status" className="mb-3 text-muted-foreground">
          {missed}
        </p>
      )}
      <dl className="mb-5 grid grid-cols-2 gap-1.5">
        <Metric label="total cost" value={costText(stats.usage.cost)} />
        <Metric label="average cost / turn" value={noTurn ? '—' : costText(headline.averageTurnCost)} />
        <Metric label="turn count" value={countText(headline.turnCount)} />
        <Metric label="average tools / turn" value={noTurn ? '—' : ONE_DECIMAL.format(headline.averageToolsPerTurn)} />
        <Metric label="tool calls" value={countText(headline.toolCalls)} />
        <Metric
          label="failures"
          value={`${countText(headline.failedToolCalls)} · ${PERCENT.format(headline.failureRate)}`}
          danger={headline.failedToolCalls > 0}
        />
      </dl>
      <ContextSection stats={stats} data={data} onTurn={onTurn} />
      {headline.offBranchCost > 0 ? (
        <p className="mb-5" title="compactions, branch summaries, cache warms and abandoned branches">
          <b>{costText(headline.offBranchCost)}</b> not attributed to a turn on this branch.
        </p>
      ) : null}
      <Section title="cost per turn" aside={noTurn ? undefined : `median ${costText(headline.medianTurnCost)}`}>
        {noTurn ? <Empty>costs appear after the first response</Empty> : <CostChart data={data} onTurn={onTurn} />}
      </Section>
      <ToolUsage tools={tools} />
      <CostliestCalls calls={stats.callStats} onNavigate={onNavigate} />
      {tools.length === 0 ? null : (
        <Section title="distribution" aside="calls · failures">
          <ul>
            {tools.map((tool) => (
              <li key={tool.toolName} className="flex justify-between">
                <code>{tool.toolName}</code>
                <span className="tabular-nums">
                  {countText(tool.calls)}
                  {tool.failed > 0 ? <b className="ml-1 text-destructive">· {countText(tool.failed)}</b> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="costliest prompts" aside="cost">
        {costliest.length === 0 ? (
          <Empty>costs appear after the first response</Empty>
        ) : (
          <ol>
            {costliest.map((prompt) => (
              <RankedRow key={prompt.prompt} target={{ kind: 'prompt', prompt: prompt.prompt }} onNavigate={onNavigate}>
                <span className="min-w-0">
                  <strong className="block truncate font-normal text-foreground" title={prompt.text}>
                    {prompt.text || '(before the first prompt)'}
                  </strong>
                  <small className="text-muted-foreground">
                    {plural(prompt.turnCount, 'model call')} · {plural(prompt.toolCalls, 'tool')}
                    {prompt.durationMs === undefined ? null : (
                      <span title="the prompt to the last reply entry, as pi stamped them">
                        {' '}
                        · {durationText(prompt.durationMs)}
                      </span>
                    )}
                  </small>
                </span>
                <b className="shrink-0 font-normal tabular-nums">{costText(prompt.cost)}</b>
              </RankedRow>
            ))}
          </ol>
        )}
      </Section>
      <Section title="latency" aside="from the log">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">prompt → settle</dt>
          <dd className="tabular-nums">{durationsText(stats.latency.prompts, 'not in the log')}</dd>
          <dt className="text-muted-foreground">first token</dt>
          <dd className="tabular-nums">{durationsText(stats.latency.firstDelta, 'not in the log')}</dd>
        </dl>
        <p className="mt-1 text-muted-foreground">
          {stats.logDays.length === 0
            ? 'no day file covers this thread — the log keeps 14 days'
            : `read from ${stats.logDays.join(', ')}`}
        </p>
      </Section>
    </section>
  )
}

/**
 * The drawer wired to its thread: read on open, and again whenever the thread's usage moves —
 * a SUBSCRIPTION, not a render dependency, as the debug drawer reads its chunks. Two reads can be
 * in flight (a turn lands while the first is out); only the latest one issued is shown.
 *
 * `onNavigate` is the pane's (`chat-screen.tsx`): it finds the target in that pane's transcript
 * and says whether it could.
 */
export function ThreadStatsDrawer({ onNavigate }: { readonly onNavigate?: RevealStatsTarget }): React.ReactNode {
  const stores = useThreadStores()
  const [outcome, setOutcome] = useState<StatsOutcome>({ kind: 'reading' })
  const [missed, setMissed] = useState<string | undefined>(undefined)
  useEffect(() => {
    let mounted = true
    const readLatest = latestWins(() => fetchThreadStats(stores.threadId))
    const read = (): void => {
      void readLatest().then((latest) => {
        if (mounted && latest !== undefined) setOutcome(latest)
      })
    }
    read()
    const unsubscribe = stores.usage.subscribe(read)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [stores])
  const navigate =
    onNavigate === undefined || outcome.kind !== 'read'
      ? undefined
      : (target: StatsTarget): void => setMissed(onNavigate(target, outcome.stats) ? undefined : missedText(target))
  return <ThreadStatsView outcome={outcome} onNavigate={navigate} missed={missed} />
}
