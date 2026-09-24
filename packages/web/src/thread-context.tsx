import {
  type EnsoContextCategory,
  type EnsoContextMakeup,
  type EnsoContextRequest,
  EnsoThreadContext,
} from '@enso/core'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, type MouseHandlerDataParam, ReferenceLine, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
import { countText } from './stats-table.tsx'
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  CONTEXT_CATEGORIES,
  changeOf,
  lastRequestPerPrompt,
  shareOf,
  type TrendGranularity,
  type TrendMode,
  totalOf,
} from './thread-context-analysis.ts'

/**
 * The Context view (#361) — dsh-context's Context tab over pi: what the next request is made of
 * (Current Context), and every request's makeup with its brief (Context Trend). Reads
 * `GET /api/threads/:threadId/context` on open and whenever the thread's usage moves.
 *
 * ⚠ ESTIMATES, SAID AS SUCH. Every category figure is pi's estimate (characters over four) and is
 * written `≈`; the provider's count for a request, and pi's context meter, are written plain and
 * named as the provider's. They disagree, and the view shows both rather than choosing.
 */

export type ContextOutcome = AnalysisOutcome<EnsoThreadContext>

/** The thread's context (stable, module-level: `useReadOnUsage` subscribes with it). */
const readThreadContext = (threadId: string): Promise<ContextOutcome> =>
  readThreadAnalysis(threadId, 'context', EnsoThreadContext)

// ── formats ──────────────────────────────────────────────────────────────────────────────────

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 })

/** An estimate: `≈15.9k`. */
const estimateText = (tokens: number): string => `≈${COMPACT.format(tokens)}`

/** A signed change: `+1.2k`, `−5k`, `±0`. */
function changeText(tokens: number): string {
  if (tokens === 0) return '±0'
  return tokens > 0 ? `+${COMPACT.format(tokens)}` : `−${COMPACT.format(-tokens)}`
}

function timeText(at: string): string {
  const moment = new Date(at)
  return Number.isNaN(moment.getTime()) ? '' : moment.toLocaleTimeString([], { hour12: false })
}

// ── building blocks ──────────────────────────────────────────────────────────────────────────

function Card({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-foreground text-sm">{title}</h2>
        {aside === undefined ? null : <div className="text-muted-foreground text-xs">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/**
 * The six categories as one bar. `scale` is what the full width means — the model's window for
 * the Current Context, the request's own total in the trend's detail; what the makeup leaves of
 * it is hatched (dsh's free headroom).
 */
function MakeupBar({
  makeup,
  scale,
  label,
}: {
  makeup: EnsoContextMakeup
  scale: number
  label: string
}): React.ReactNode {
  const total = totalOf(makeup)
  const width = Math.max(scale, total)
  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-3 w-full overflow-hidden rounded-sm bg-[repeating-linear-gradient(135deg,var(--muted)_0_4px,transparent_4px_8px)]"
    >
      {CONTEXT_CATEGORIES.map((category) => (
        <span
          key={category}
          className="h-full"
          style={{ width: `${shareOf(makeup[category], width) * 100}%`, background: CATEGORY_COLOR[category] }}
        />
      ))}
    </div>
  )
}

/** Each category's estimate and share of the makeup, dsh's legend row. */
function MakeupLegend({
  makeup,
  change,
}: {
  makeup: EnsoContextMakeup
  change?: EnsoContextMakeup | undefined
}): React.ReactNode {
  const total = totalOf(makeup)
  return (
    <dl className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-4 gap-y-1 text-xs">
      {CONTEXT_CATEGORIES.map((category) => (
        <div key={category} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-sm"
            style={{ background: CATEGORY_COLOR[category] }}
          />
          <dt className="min-w-0 flex-1 truncate text-muted-foreground">{CATEGORY_LABEL[category]}</dt>
          {change === undefined || change[category] === 0 ? null : (
            <span className="font-mono text-muted-foreground tabular-nums">{changeText(change[category])}</span>
          )}
          <dd className="font-mono tabular-nums">{estimateText(makeup[category])}</dd>
          <span className="w-9 text-right font-mono text-muted-foreground tabular-nums">
            {PERCENT.format(shareOf(makeup[category], total))}
          </span>
        </div>
      ))}
    </dl>
  )
}

// ── Current Context ──────────────────────────────────────────────────────────────────────────

function CurrentContext({ context }: { context: EnsoThreadContext }): React.ReactNode {
  const total = totalOf(context.next)
  const window = context.usage?.window ?? null
  const meter = context.usage?.tokens ?? null
  return (
    <Card title="Current Context" aside="what the next request is made of — pi's estimate, by category">
      <p className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          <b className="font-mono text-lg">{estimateText(total)}</b>
          {window === null ? null : <span className="text-muted-foreground"> / {COMPACT.format(window)} window</span>}
        </span>
        {window === null ? (
          <span className="text-muted-foreground">the model's window is known once the thread is live</span>
        ) : (
          <span className="text-muted-foreground">
            {PERCENT.format(shareOf(total, window))} of the window, estimated
          </span>
        )}
        {meter === null ? null : (
          <span className="text-muted-foreground" title="pi's context meter: the provider's count for the last request">
            last request, by the provider: <b className="font-mono text-foreground">{countText(meter)}</b>
          </span>
        )}
      </p>
      <MakeupBar
        makeup={context.next}
        scale={window ?? total}
        label={`next request ${estimateText(total)} tokens, estimated`}
      />
      <MakeupLegend makeup={context.next} />
    </Card>
  )
}

// ── Context Trend ────────────────────────────────────────────────────────────────────────────

const SERIES: ChartConfig = Object.fromEntries(
  CONTEXT_CATEGORIES.map((category) => [
    category,
    { label: CATEGORY_LABEL[category], color: CATEGORY_COLOR[category] },
  ]),
)

type TrendPoint = Record<EnsoContextCategory, number> & { readonly label: string; readonly request: EnsoContextRequest }

/** A bar's label: `T12` for a turn, `P3` for a prompt — dsh's step and turn, named ours. */
function barLabel(request: EnsoContextRequest, granularity: TrendGranularity): string {
  return granularity === 'turn' ? `T${request.turn}` : `P${request.prompt}`
}

function trendPoints(
  bars: readonly EnsoContextRequest[],
  granularity: TrendGranularity,
  mode: TrendMode,
): TrendPoint[] {
  return bars.map((request, index) => {
    const values = mode === 'total' ? request.estimated : changeOf(request.estimated, bars[index - 1]?.estimated)
    return { ...values, label: barLabel(request, granularity), request }
  })
}

/** Two-way choice as pressed buttons, dsh's `Step | Turn` and `Total | Delta` pills. */
function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: ReadonlyArray<readonly [Value, string]>
  onChange: (value: Value) => void
}): React.ReactNode {
  return (
    <fieldset aria-label={label} className="inline-flex rounded-md bg-muted p-0.5 text-xs">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          className={
            option === value ? 'rounded bg-background px-2 py-0.5 text-foreground' : 'px-2 py-0.5 text-muted-foreground'
          }
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  )
}

const GRANULARITIES: ReadonlyArray<readonly [TrendGranularity, string]> = [
  ['turn', 'turn'],
  ['prompt', 'prompt'],
]
const MODES: ReadonlyArray<readonly [TrendMode, string]> = [
  ['total', 'total'],
  ['delta', 'delta'],
]

/** A row of the brief: its name, then its content. */
function BriefRow({ name, children }: { name: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex gap-3 rounded-md border px-2 py-1">
      <dt className="w-16 shrink-0 text-muted-foreground">{name}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  )
}

function RequestDetail({
  request,
  previous,
}: {
  request: EnsoContextRequest
  previous: EnsoContextRequest | undefined
}): React.ReactNode {
  const estimated = totalOf(request.estimated)
  const { actual, brief } = request
  const cached = shareOf(actual.cacheRead, actual.prompt)
  return (
    <div className="mt-3 border-t pt-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-sm">
          turn {request.turn} · prompt {request.prompt}
        </b>
        <span className="text-muted-foreground">
          {timeText(request.at)} · {request.model}
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5 font-mono">
          <span className="rounded bg-muted px-1.5 py-0.5" title="pi's estimate of what the request was assembled from">
            estimated {estimateText(estimated)}
          </span>
          {actual.prompt === 0 ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">no count from the provider</span>
          ) : (
            <>
              <span
                className="rounded bg-muted px-1.5 py-0.5"
                title="the provider's count: input, cache read and cache write"
              >
                actual prompt {COMPACT.format(actual.prompt)}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5">output {COMPACT.format(actual.output)}</span>
              <span className="rounded bg-muted px-1.5 py-0.5">cache {PERCENT.format(cached)}</span>
            </>
          )}
        </span>
      </div>
      {request.compaction === undefined ? null : (
        <p className="mb-2 text-muted-foreground">
          ✂ compacted before this request — pi counted {COMPACT.format(request.compaction.tokensBefore)} tokens in the
          context it replaced
        </p>
      )}
      <dl className="mb-3 grid grid-cols-1 gap-1">
        <BriefRow name="prompt">{brief.prompt === '' ? '(before the first prompt)' : brief.prompt}</BriefRow>
        <BriefRow name="in">
          {brief.added.length === 0
            ? 'nothing new since the previous request'
            : brief.added.map((addition) => (
                <span key={`${addition.category}-${addition.label}`} className="mr-3">
                  <span
                    aria-hidden="true"
                    className="mr-1 inline-block size-2 rounded-sm"
                    style={{ background: CATEGORY_COLOR[addition.category] }}
                  />
                  {addition.label}
                </span>
              ))}
          {brief.moreAdded > 0 ? <span className="text-muted-foreground">and {brief.moreAdded} more</span> : null}
        </BriefRow>
        <BriefRow name="reply">
          {brief.reply}
          {brief.toolCalls.length === 0 ? null : (
            <span className="text-muted-foreground">
              {brief.reply === '' ? '' : ' · '}calls {brief.toolCalls.join(', ')}
            </span>
          )}
        </BriefRow>
      </dl>
      <MakeupBar makeup={request.estimated} scale={estimated} label={`turn ${request.turn}'s makeup, estimated`} />
      <MakeupLegend
        makeup={request.estimated}
        change={previous === undefined ? undefined : changeOf(request.estimated, previous.estimated)}
      />
    </div>
  )
}

/** The narrowest a bar may draw: past this many bars, the chart scrolls sideways (dsh does). */
const BAR_MIN_PX = 10

function ContextTrend({ requests }: { requests: readonly EnsoContextRequest[] }): React.ReactNode {
  const [granularity, setGranularity] = useState<TrendGranularity>('turn')
  const [mode, setMode] = useState<TrendMode>('total')
  // The picked request by its turn — stable across a refresh and a change of granularity. None: the latest.
  const [pickedTurn, setPickedTurn] = useState<number | undefined>(undefined)
  const bars = granularity === 'turn' ? [...requests] : lastRequestPerPrompt(requests)
  const points = trendPoints(bars, granularity, mode)
  const pickedIndex = (() => {
    if (pickedTurn === undefined) return bars.length - 1
    const picked = requests.find((request) => request.turn === pickedTurn)
    const index = bars.findIndex((bar) =>
      granularity === 'turn' ? bar.turn === pickedTurn : bar.prompt === picked?.prompt,
    )
    return index === -1 ? bars.length - 1 : index
  })()
  const picked = bars[pickedIndex]
  const pick = (index: number): void => {
    const bar = bars[index]
    if (bar !== undefined) setPickedTurn(bar.turn)
  }
  const compacted = points.filter((point) => {
    const first = point.request
    return granularity === 'turn'
      ? first.compaction !== undefined
      : requests.some((request) => request.prompt === first.prompt && request.compaction !== undefined)
  })
  return (
    <Card
      title="Context Trend"
      aside={
        <span className="flex items-center gap-2">
          <span>✂ marks a compaction</span>
          <Choice label="bar per" value={granularity} options={GRANULARITIES} onChange={setGranularity} />
          <Choice label="bar shows" value={mode} options={MODES} onChange={setMode} />
        </span>
      }
    >
      {requests.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          a bar appears for each model request, once the first one has run
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <ChartContainer
              config={SERIES}
              className="aspect-auto h-56"
              style={{ minWidth: `${points.length * BAR_MIN_PX}px`, width: '100%' }}
            >
              <BarChart
                data={points}
                stackOffset={mode === 'delta' ? 'sign' : 'none'}
                className="cursor-pointer"
                onClick={(state: MouseHandlerDataParam): void => {
                  const index = state.activeTooltipIndex
                  if (index !== undefined && index !== null) pick(Number(index))
                }}
                accessibilityLayer
              >
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={12} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tickFormatter={(value: number) => COMPACT.format(value)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                {mode === 'delta' ? <ReferenceLine y={0} stroke="var(--border)" /> : null}
                {compacted.map((point) => (
                  <ReferenceLine
                    key={point.label}
                    x={point.label}
                    stroke="var(--muted-foreground)"
                    strokeDasharray="3 3"
                    label={{ value: '✂', position: 'top', fill: 'var(--muted-foreground)' }}
                  />
                ))}
                {CONTEXT_CATEGORIES.map((category) => (
                  <Bar
                    key={category}
                    dataKey={category}
                    stackId="context"
                    fill={CATEGORY_COLOR[category]}
                    isAnimationActive={false}
                  >
                    {points.map((point, index) => (
                      <Cell key={point.label} fillOpacity={index === pickedIndex ? 1 : 0.55} />
                    ))}
                  </Bar>
                ))}
              </BarChart>
            </ChartContainer>
          </div>
          <div className="mt-2 flex items-center justify-end gap-1 text-muted-foreground text-xs">
            <button
              type="button"
              aria-label="previous bar"
              disabled={pickedIndex <= 0}
              className="rounded p-1 hover:bg-muted disabled:opacity-40"
              onClick={() => pick(pickedIndex - 1)}
            >
              <ChevronLeftIcon className="size-4" />
            </button>
            <span className="font-mono tabular-nums">
              {pickedIndex + 1} / {bars.length}
            </span>
            <button
              type="button"
              aria-label="next bar"
              disabled={pickedIndex >= bars.length - 1}
              className="rounded p-1 hover:bg-muted disabled:opacity-40"
              onClick={() => pick(pickedIndex + 1)}
            >
              <ChevronRightIcon className="size-4" />
            </button>
          </div>
          {picked === undefined ? null : <RequestDetail request={picked} previous={bars[pickedIndex - 1]} />}
        </>
      )}
    </Card>
  )
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────

/** Pure view — the data arrives as props; the trend's choices are its own state. */
export function ThreadContextView({ outcome }: { readonly outcome: ContextOutcome }): React.ReactNode {
  if (outcome.kind === 'reading')
    return <p className="p-4 text-muted-foreground text-xs">reading the thread's context…</p>
  if (outcome.kind === 'failed')
    return <p className="p-4 text-muted-foreground text-xs">no context: {outcome.problem}</p>
  const context = outcome.payload
  return (
    <div className="grid grid-cols-1 gap-4 p-4">
      <p className="text-muted-foreground text-xs">
        {context.live ? 'live' : 'from the file'} · {countText(context.requests.length)} model requests · every category
        is pi's estimate (≈); the provider's own counts are named as such
      </p>
      <CurrentContext context={context} />
      <ContextTrend requests={context.requests} />
    </div>
  )
}

/** The Context view wired to its thread: read on open and whenever the thread's usage moves. */
export function ThreadContextDrawer(): React.ReactNode {
  return <ThreadContextView outcome={useReadOnUsage<ContextOutcome>(readThreadContext, ANALYSIS_READING)} />
}
