import { type EnsoContextCategory, type EnsoContextRequest, EnsoThreadContext } from '@enso/core'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, type MouseHandlerDataParam, ReferenceLine, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.tsx'
import { ContextEvents, FileActivity } from './context-activity.tsx'
import { ContextBrowser, type ContextBrowserFocus, type ContextBrowserRequest } from './context-browser.tsx'
import { Card, COMPACT, estimateText, MakeupBar, MakeupLegend, PERCENT, timeText } from './context-parts.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
import { countText } from './stats-table.tsx'
import { useStore, useThreadStores } from './store.ts'
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
  onOpen,
}: {
  request: EnsoContextRequest
  previous: EnsoContextRequest | undefined
  /** Opens an element of this request in the Context Browser. */
  onOpen: (key: string) => void
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
                <button
                  key={addition.key}
                  type="button"
                  className="mr-3 underline-offset-2 hover:underline"
                  title="open it in the Context Browser"
                  onClick={() => onOpen(addition.key)}
                >
                  <span
                    aria-hidden="true"
                    className="mr-1 inline-block size-2 rounded-sm"
                    style={{ background: CATEGORY_COLOR[addition.category] }}
                  />
                  {addition.label}
                </button>
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

function ContextTrend({
  requests,
  onPick,
  onOpen,
}: {
  requests: readonly EnsoContextRequest[]
  /** The picked bar's request, for the Context Browser to follow. */
  onPick: (turn: number) => void
  onOpen: (turn: number, key: string) => void
}): React.ReactNode {
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
    if (bar === undefined) return
    setPickedTurn(bar.turn)
    onPick(bar.turn)
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
          {picked === undefined ? null : (
            <RequestDetail
              request={picked}
              previous={bars[pickedIndex - 1]}
              onOpen={(key: string) => onOpen(picked.turn, key)}
            />
          )}
        </>
      )}
    </Card>
  )
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────

/**
 * The cards, and what joins them: the Context Browser opens the request the trend's bar picks
 * (dsh's linkage), File Activity counts up to it, and a brief's line, an event or a file
 * operation opens its request — and its element — in the browser.
 */
function ContextCards({ context }: { context: EnsoThreadContext }): React.ReactNode {
  const stores = useThreadStores()
  const cwd = useStore(stores.cwd)
  const [browserRequest, setBrowserRequest] = useState<ContextBrowserRequest>('next')
  const [trendTurn, setTrendTurn] = useState<number | undefined>(undefined)
  const [focus, setFocus] = useState<ContextBrowserFocus | undefined>(undefined)
  const browser = useRef<HTMLDivElement | null>(null)
  const openInBrowser = (request: ContextBrowserRequest, focusOn?: ContextBrowserFocus): void => {
    setBrowserRequest(request)
    setFocus(focusOn)
    browser.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const requestCount = context.requests.length
  return (
    <div className="grid grid-cols-1 gap-4 p-4">
      <p className="text-muted-foreground text-xs">
        {context.live ? 'live' : 'from the file'} · {countText(requestCount)} model requests · every category is pi's
        estimate (≈); the provider's own counts are named as such
      </p>
      <CurrentContext context={context} />
      <ContextTrend
        requests={context.requests}
        onPick={(turn: number) => {
          setTrendTurn(turn)
          setBrowserRequest(turn)
        }}
        onOpen={(turn: number, key: string) => {
          setBrowserRequest(turn)
          setFocus({ request: turn, key })
        }}
      />
      <div ref={browser} className="min-w-0">
        <ContextBrowser
          requests={context.requests}
          next={context.next}
          request={browserRequest}
          onRequest={setBrowserRequest}
          focus={focus}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ContextEvents events={context.events} requestCount={requestCount} onOpen={openInBrowser} />
        <FileActivity
          operations={context.files}
          upToTurn={trendTurn}
          cwd={cwd}
          requestCount={requestCount}
          onOpen={openInBrowser}
        />
      </div>
    </div>
  )
}

/** Pure view — the data arrives as props; the cards' choices are their own state. */
export function ThreadContextView({ outcome }: { readonly outcome: ContextOutcome }): React.ReactNode {
  if (outcome.kind === 'reading')
    return <p className="p-4 text-muted-foreground text-xs">reading the thread's context…</p>
  if (outcome.kind === 'failed')
    return <p className="p-4 text-muted-foreground text-xs">no context: {outcome.problem}</p>
  return <ContextCards context={outcome.payload} />
}

/** The Context view wired to its thread: read on open and whenever the thread's usage moves. */
export function ThreadContextDrawer(): React.ReactNode {
  return <ThreadContextView outcome={useReadOnUsage<ContextOutcome>(readThreadContext, ANALYSIS_READING)} />
}
