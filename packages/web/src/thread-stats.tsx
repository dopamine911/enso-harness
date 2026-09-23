import { EnsoThreadStats, type EnsoTurnStats } from '@enso/core'
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { FetchLike } from './browser-logging.ts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.tsx'
import { readSchemaRoute } from './route-read.ts'
import { type Column, costText, countText, durationsText, millisecondsText, StatsTable } from './stats-table.tsx'
import { useThreadStores } from './store.ts'
import { latestWins } from './thread-debug.tsx'

/**
 * The thread's stats drawer (#45 phase 2): per prompt, per turn, per tool — for the thread on
 * screen, beside the transcript, opened from the status bar.
 *
 * Reads `GET /api/threads/:threadId/stats` on open and again whenever the thread's usage moves
 * (`stores.usage`, #45 PR 1): the status bar's `session-usage` is the one signal that a turn,
 * a run or a compaction just landed, so the drawer refetches exactly when there is something new
 * and never on a timer.
 *
 * ⚠ WHAT IS MEASURED, SAID AS SUCH (livecraft's discipline, #45): pi's session total is the
 * cost; what the branch's messages account for is beside it, and the difference is named rather
 * than spread over turns; a tool's duration reports how many of its calls were timed, because the
 * log keeps 14 days and a resumed thread's older calls were never timed here; an empty section
 * says what activity it is waiting for instead of drawing zeros.
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

/** A difference below a hundredth of a cent is float noise, not spend. */
const COST_EPSILON = 0.000_05

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** `2 of 5 (40%)` — the share a failure count is of its calls. */
function shareText(part: number, whole: number): string {
  return whole === 0
    ? countText(part)
    : `${countText(part)} of ${countText(whole)} (${Math.round((part / whole) * 100)}%)`
}

/** The facts the drawer opens with, one per line: label, value, and what the value is. */
function summaryRows(stats: EnsoThreadStats): ReadonlyArray<readonly [string, string, string]> {
  const { usage, turnStats, promptStats, toolStats, latency } = stats
  const turnCosts = turnStats.map((turn) => turn.cost)
  const calls = toolStats.reduce((total, tool) => total + tool.calls, 0)
  const failures = toolStats.reduce((total, tool) => total + tool.failures, 0)
  const offBranch = usage.cost - stats.branchCost
  const rows: Array<readonly [string, string, string]> = [
    ['cost', costText(usage.cost), "pi's session total: every model call on every branch"],
  ]
  if (offBranch >= COST_EPSILON) {
    rows.push([
      'off this branch',
      costText(offBranch),
      'compactions, branch summaries, cache warms and abandoned branches — spent, and on no turn below',
    ])
  }
  rows.push(
    ['prompts', countText(promptStats.length), 'prompts on this branch'],
    [
      'turn count',
      turnStats.length === 0
        ? '0'
        : `${countText(turnStats.length)} · mean ${costText(stats.branchCost / turnStats.length)} · median ${costText(median(turnCosts))}`,
      'model requests on this branch — a turn each — with the cost of each',
    ],
    ['tool calls', countText(calls), 'calls the model made on this branch'],
    ['failed', shareText(failures, calls), 'results pi marked as errors — a guard refusal is one'],
    [
      'prompt → settle',
      durationsText(latency.prompts, 'not in the log'),
      'from the log: runs timed, min/mean/max — the log keeps 14 days',
    ],
    [
      'first token',
      durationsText(latency.firstDelta, 'not in the log'),
      'from the log: time to the first streamed token',
    ],
  )
  return rows
}

const COST_CHART: ChartConfig = { cost: { label: 'cost ($)', color: 'var(--chart-1)' } }
const PROMPT_CHART: ChartConfig = {
  input: { label: 'input', color: 'var(--chart-1)' },
  cacheRead: { label: 'cache read', color: 'var(--chart-2)' },
  cacheWrite: { label: 'cache write', color: 'var(--chart-3)' },
}

/** A chart tooltip's heading: the turn its bar is. */
const turnLabel = (label: unknown): string => `turn ${String(label)}`

/** A cost axis tick: dollars to the tenth of a cent, the scale a turn costs in. */
const dollarTick = (value: number): string => `$${value.toFixed(3)}`

type TurnPoint = EnsoTurnStats & { readonly label: string }

interface TurnChartProps {
  readonly title: string
  /** One bar per key, in order; more than one stacks. Each key is a field of the turn. */
  readonly config: ChartConfig
  readonly data: readonly TurnPoint[]
  readonly tick: (value: number) => string
}

/**
 * One bar chart over the turns. ⓘ `isAnimationActive={false}`: the drawer refetches after each
 * turn, and a chart that re-grew from zero every time would show a thread's history as if it were
 * happening again.
 */
function TurnChart({ title, config, data, tick }: TurnChartProps): React.ReactNode {
  const series = Object.keys(config)
  const stacked = series.length > 1
  return (
    <>
      <h3 className="pb-1 font-semibold text-foreground text-xs">{title}</h3>
      <ChartContainer config={config} className="mb-4 aspect-auto h-32 w-full">
        <BarChart data={[...data]} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={8} />
          <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={tick} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={turnLabel} />} />
          {series.map((key, position) => (
            <Bar
              key={key}
              dataKey={key}
              fill={`var(--color-${key})`}
              {...(stacked ? { stackId: 'turn' } : {})}
              radius={position === series.length - 1 ? [2, 2, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </>
  )
}

/**
 * Per turn: its cost, and the prompt it sent — input plus cache read plus cache write, the size
 * of the context the model saw — which is where a climbing context shows before the meter fills.
 */
function TurnCharts({ turnStats }: { readonly turnStats: readonly EnsoTurnStats[] }): React.ReactNode {
  if (turnStats.length === 0) {
    return (
      <p className="mb-4 text-muted-foreground text-xs">
        no model request on this branch yet — the charts start with the first answer
      </p>
    )
  }
  const data = turnStats.map((turn) => ({ ...turn, label: String(turn.turn) }))
  return (
    <>
      <TurnChart title="cost per turn" config={COST_CHART} data={data} tick={dollarTick} />
      <TurnChart title="prompt tokens per turn" config={PROMPT_CHART} data={data} tick={countText} />
    </>
  )
}

/** The prompts that cost the most, at most this many. */
const COSTLIEST_PROMPTS = 5

const PROMPT_COLUMNS: readonly Column[] = [
  { heading: '#', numeric: true },
  { heading: 'prompt' },
  { heading: 'turn count', numeric: true },
  { heading: 'tools', numeric: true },
  { heading: 'failed', numeric: true },
  { heading: 'cost', numeric: true },
]

const TOOL_COLUMNS: readonly Column[] = [
  { heading: 'tool' },
  { heading: 'calls', numeric: true },
  { heading: 'failed', numeric: true },
  { heading: 'in chars', numeric: true },
  { heading: 'out chars', numeric: true },
  { heading: 'timed', numeric: true },
  { heading: 'mean ms', numeric: true },
]

/** Pure view — everything it shows arrives as props, so a static render pins the wording. */
export function ThreadStatsView({ outcome }: { readonly outcome: StatsOutcome }): React.ReactNode {
  if (outcome.kind === 'reading')
    return <p className="p-3 text-muted-foreground text-xs">reading the thread's stats…</p>
  if (outcome.kind === 'failed') return <p className="p-3 text-muted-foreground text-xs">no stats: {outcome.problem}</p>
  const { stats } = outcome
  const costliest = [...stats.promptStats].sort((first, second) => second.cost - first.cost).slice(0, COSTLIEST_PROMPTS)
  return (
    <section aria-label="thread stats" className="p-3 font-mono text-xs">
      <h2 className="pb-2 font-semibold text-foreground">
        thread stats{' '}
        <span className="font-normal text-muted-foreground">· {stats.live ? 'live' : 'from the file'}</span>
      </h2>
      <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
        {summaryRows(stats).map(([label, value, meaning]) => (
          <div key={label} className="contents" title={meaning}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <TurnCharts turnStats={stats.turnStats} />
      <StatsTable
        caption="costliest prompts"
        columns={PROMPT_COLUMNS}
        empty="no prompt on this branch yet"
        rows={costliest.map((prompt) => ({
          key: String(prompt.prompt),
          cells: [
            String(prompt.prompt),
            <span key="prompt" className="block max-w-[9rem] truncate" title={prompt.text}>
              {prompt.text || '(before the first prompt)'}
            </span>,
            countText(prompt.turnCount),
            countText(prompt.toolCalls),
            countText(prompt.failedToolCalls),
            costText(prompt.cost),
          ],
        }))}
      />
      <StatsTable
        caption="tools"
        columns={TOOL_COLUMNS}
        empty="no tool called on this branch yet"
        rows={stats.toolStats.map((tool) => ({
          key: tool.toolName,
          cells: [
            tool.toolName,
            countText(tool.calls),
            countText(tool.failures),
            countText(tool.inputChars),
            countText(tool.outputChars),
            `${countText(tool.durations.count)}/${countText(tool.calls)}`,
            tool.durations.count === 0 ? '—' : millisecondsText(tool.durations.meanMs),
          ],
        }))}
      />
      <p className="text-muted-foreground">
        durations from the log{' '}
        {stats.logDays.length === 0 ? '(no day file covers this thread)' : `(${stats.logDays.join(', ')})`}
      </p>
    </section>
  )
}

/**
 * The drawer wired to its thread: read on open, and again whenever the thread's usage moves —
 * a SUBSCRIPTION, not a render dependency, as the debug drawer reads its chunks. Two reads can be
 * in flight (a turn lands while the first is out); only the latest one issued is shown.
 */
export function ThreadStatsDrawer(): React.ReactNode {
  const stores = useThreadStores()
  const [outcome, setOutcome] = useState<StatsOutcome>({ kind: 'reading' })
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
  return <ThreadStatsView outcome={outcome} />
}
