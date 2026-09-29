import { type EnsoContextMakeup, type EnsoContextRequest, EnsoThreadContext } from '@enso/core'
import { InfoIcon, LayersIcon, PanelsTopLeftIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx'
import { ContextEvents, FileActivity } from './context-activity.tsx'
import { ContextBrowser, type ContextBrowserFocus, type ContextBrowserRequest } from './context-browser.tsx'
import { ThreadSystemPromptContext, useCategoryLabel } from './context-labels.tsx'
import {
  changeText,
  estimateChangeText,
  estimateText,
  MakeupBar,
  MakeupLegend,
  PERCENT,
  Swatch,
  timeText,
} from './context-parts.tsx'
import { cn } from './lib/utils.ts'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
import { COMPACT, countText } from './stats-table.tsx'
import { useStore, useThreadStores } from './store.ts'
import {
  CATEGORY_COLOR,
  CONTEXT_CATEGORIES,
  changeOf,
  lastRequestPerPrompt,
  shareOf,
  type TrendGranularity,
  type TrendMode,
  totalOf,
} from './thread-context-analysis.ts'
import { Card, Choice, SmallButton } from './view-parts.tsx'

/**
 * The Context view (#361) — dsh-context's Context tab over pi, in the design direction's layout
 * (`Enso-Design-Direction`, the Context view): Now (what the next request is made of, beside the
 * provider's count for the last one), Trend (every request's makeup, and the picked one's brief),
 * then the Context Browser with Context Events and File Activity beside it on a wide view. Reads
 * `GET /api/threads/:threadId/context` on open and whenever the thread's usage moves.
 *
 * ⚠ ESTIMATES, SAID AS SUCH. Every category figure is pi's estimate (characters over four) and is
 * written `≈`, as is every change between two estimates; the provider's count for a request is
 * written plain and named as the provider's. pi's live context meter is both — the provider's
 * count for the last response plus pi's estimate of what has landed since (`getContextUsage`) — so
 * it is written `≈` and named as pi's. They disagree, and the view shows both rather than choosing.
 */

export type ContextOutcome = AnalysisOutcome<EnsoThreadContext>

/** The thread's context (stable, module-level: `useReadOnUsage` subscribes with it). */
const readThreadContext = (threadId: string, fetchImpl: FetchLike): Promise<ContextOutcome> =>
  readThreadAnalysis(threadId, 'context', EnsoThreadContext, fetchImpl)

/** Opens a request in the Context Browser — the Now card's and the brief's button. */
type OpenRequest = (request: ContextBrowserRequest) => void

// ── Now ──────────────────────────────────────────────────────────────────────────────────────

/** A big figure and what it is of — the design's `.meter-figure`. */
function Figure({ value, of, estimate = false }: { value: string; of?: string; estimate?: boolean }): React.ReactNode {
  return (
    <p className="flex flex-wrap items-baseline gap-2">
      <b
        className={cn(
          'font-heading text-3xl leading-tight font-semibold whitespace-nowrap',
          estimate ? 'font-mono' : '',
        )}
      >
        {value}
      </b>
      {of === undefined ? null : (
        <span className="font-mono text-sm whitespace-nowrap text-muted-foreground">{of}</span>
      )}
    </p>
  )
}

/** The latest request the provider counted — an errored request has no count, so it is passed over. */
const lastCounted = (requests: readonly EnsoContextRequest[]): EnsoContextRequest | undefined =>
  requests.findLast((request) => request.actual.prompt > 0)

/**
 * The live meter — pi's context meter: the provider's count for the last response plus pi's
 * estimate of what has landed since, against the model's window — or, for a thread read from its
 * file (no window without a live model), the provider's count for the latest request it counted,
 * named. Headed and written by which it is: an estimate carries `≈`, a provider count does not.
 */
function ContextMeter({ context }: { context: EnsoThreadContext }): React.ReactNode {
  const { usage } = context
  const last = context.requests.at(-1)
  const caption = 'text-xs text-muted-foreground'
  if (usage !== null && usage.tokens !== null && usage.percent !== null) {
    return (
      <div className="grid content-start gap-2">
        <span className={caption}>pi’s context meter</span>
        <Figure
          estimate
          value={estimateText(usage.tokens)}
          of={`of ${COMPACT.format(usage.window)} · ${PERCENT.format(usage.percent / 100)}`}
        />
        <meter
          aria-label="context window used"
          min={0}
          max={usage.window}
          value={Math.min(usage.tokens, usage.window)}
          className="h-2 w-full appearance-none overflow-hidden rounded-full bg-popover [&::-moz-meter-bar]:bg-foreground [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-transparent [&::-webkit-meter-bar]:bg-none [&::-webkit-meter-optimum-value]:bg-foreground [&::-webkit-meter-optimum-value]:bg-none"
        />
        <span className={caption}>
          The provider’s count for the last response, plus pi’s estimate of what has landed since — against{' '}
          {last === undefined ? 'the model’s' : `${last.model}’s`} window.
        </span>
      </div>
    )
  }
  const heading = <span className={caption}>provider count</span>
  const counted = lastCounted(context.requests)
  return (
    <div className="grid content-start gap-2">
      {heading}
      {counted === undefined ? (
        <Figure value="—" />
      ) : (
        <Figure value={COMPACT.format(counted.actual.prompt)} of={`request ${counted.turn}`} />
      )}
      <span className={caption}>
        {meterCaption(usage !== null && usage.tokens === null, counted !== undefined)}
        {usage === null ? ' · the model’s window is known once the thread is live' : ''}
      </span>
    </div>
  )
}

/** What the meter's figure is, when it is not the live meter. */
function meterCaption(compacted: boolean, counted: boolean): string {
  if (compacted) return 'unknown after a compaction until the model’s next response reports it'
  return counted ? 'the latest request the provider counted' : 'the provider has counted no request yet'
}

/** What the next request would be assembled from: pi's estimate, its change, the bar and legend. */
function NextEstimate({ context }: { context: EnsoThreadContext }): React.ReactNode {
  const total = totalOf(context.next)
  const last = context.requests.at(-1)
  const window = context.usage?.window ?? null
  // The window the estimate is past, when it is: said in the text and marked on the bar.
  const overWindow = window !== null && total > window ? window : undefined
  return (
    <div className="grid content-start gap-2">
      <span className="text-xs text-muted-foreground">next request · pi’s estimate (characters ÷ 4)</span>
      <Figure
        estimate
        value={estimateText(total)}
        of={
          last === undefined
            ? 'not sent yet'
            : `${estimateChangeText(total - totalOf(last.estimated))} since request ${last.turn}`
        }
      />
      <MakeupBar
        makeup={context.next}
        scale={window ?? total}
        label={`next request ${estimateText(total)} tokens, estimated${overWindow === undefined ? '' : `, over the ${COMPACT.format(overWindow)} window`}`}
      />
      <MakeupLegend makeup={context.next} />
      {window === null ? null : (
        <span className={cn('text-xs', overWindow === undefined ? 'text-muted-foreground' : 'text-refuse')}>
          {PERCENT.format(shareOf(total, window))} of the {COMPACT.format(window)} window, estimated
          {overWindow === undefined ? '' : ' — over it'}
        </span>
      )}
    </div>
  )
}

/** The two numbers for the last request, side by side — pi's estimate and the provider's count. */
function Disagreement({ request }: { request: EnsoContextRequest }): React.ReactNode {
  const estimated = totalOf(request.estimated)
  return (
    <p className="flex items-start gap-2 rounded-md bg-popover px-3 py-2 text-sm text-muted-foreground">
      <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong className="font-semibold text-foreground">Two numbers, both shown.</strong> For request {request.turn}{' '}
        pi estimated {estimateText(estimated)}; the provider counted {COMPACT.format(request.actual.prompt)} (
        {changeText(request.actual.prompt - estimated)}). Enso doesn’t choose between them.
      </span>
    </p>
  )
}

function CurrentContext({ context, onOpen }: { context: EnsoThreadContext; onOpen?: OpenRequest }): React.ReactNode {
  const counted = lastCounted(context.requests)
  return (
    <Card
      title="Now"
      sub="what the next request is made of"
      tools={
        onOpen === undefined ? undefined : (
          <SmallButton onClick={() => onOpen('next')}>
            <PanelsTopLeftIcon aria-hidden="true" />
            Open next request
          </SmallButton>
        )
      }
    >
      <div className="grid gap-4 @3xl:grid-cols-5">
        <div className="@3xl:col-span-2">
          <ContextMeter context={context} />
        </div>
        <div className="min-w-0 @3xl:col-span-3">
          <NextEstimate context={context} />
        </div>
      </div>
      {counted === undefined ? null : <Disagreement request={counted} />}
    </Card>
  )
}

// ── Trend ────────────────────────────────────────────────────────────────────────────────────

const GRANULARITIES: ReadonlyArray<readonly [TrendGranularity, string]> = [
  ['turn', 'Requests'],
  ['prompt', 'Prompts'],
]
const MODES: ReadonlyArray<readonly [TrendMode, string]> = [
  ['total', 'Total'],
  ['delta', 'Change'],
]

/** A granularity's bars: one per request, or each prompt's last. */
const barsOf = (requests: readonly EnsoContextRequest[], granularity: TrendGranularity): EnsoContextRequest[] =>
  granularity === 'turn' ? [...requests] : lastRequestPerPrompt(requests)

/** The bar a picked turn falls in — its own, or its prompt's; the latest when none is picked or it is gone. */
function pickedBarIndex(
  requests: readonly EnsoContextRequest[],
  granularity: TrendGranularity,
  pickedTurn: number | undefined,
): number {
  const bars = barsOf(requests, granularity)
  if (pickedTurn === undefined) return bars.length - 1
  const picked = requests.find((request) => request.turn === pickedTurn)
  const index = bars.findIndex((bar) =>
    granularity === 'turn' ? bar.turn === pickedTurn : bar.prompt === picked?.prompt,
  )
  return index === -1 ? bars.length - 1 : index
}

/** Whether a bar marks a compaction: its own request's, or — per prompt — any of its prompt's. */
function compactedBar(
  bar: EnsoContextRequest,
  requests: readonly EnsoContextRequest[],
  granularity: TrendGranularity,
): boolean {
  return granularity === 'turn'
    ? bar.compaction !== undefined
    : requests.some((request) => request.prompt === bar.prompt && request.compaction !== undefined)
}

/** A bar's value per category: the whole makeup, or its signed change from the bar before. */
function barValues(bars: readonly EnsoContextRequest[], mode: TrendMode): EnsoContextMakeup[] {
  return bars.map((bar, index) =>
    mode === 'total' ? bar.estimated : changeOf(bar.estimated, bars[index - 1]?.estimated),
  )
}

/** What a bar's height is a share of: the tallest stack above the line, or below it. */
function scaleOf(values: readonly EnsoContextMakeup[]): number {
  let scale = 1
  for (const makeup of values) {
    let above = 0
    let below = 0
    for (const category of CONTEXT_CATEGORIES) {
      if (makeup[category] > 0) above += makeup[category]
      else below -= makeup[category]
    }
    scale = Math.max(scale, above, below)
  }
  return scale
}

/** Axis labels, thinned so they stay legible on a long thread: every one up to twenty bars. */
const AXIS_LABELS = 20

/**
 * The bars — the design's `.trend-plot`: each a button (a keyboard reaches every request), its
 * segments stacked in context order with the system prompt at the base; in Change mode, what left
 * hangs below the line. A compaction flags its bar.
 */
interface TrendPlotProps {
  readonly bars: readonly EnsoContextRequest[]
  readonly requests: readonly EnsoContextRequest[]
  readonly granularity: TrendGranularity
  readonly mode: TrendMode
  readonly pickedIndex: number
  readonly onPick: (index: number) => void
}

function TrendPlot(props: TrendPlotProps): React.ReactNode {
  const { bars, requests, granularity, mode, pickedIndex, onPick } = props
  const categoryOf = useCategoryLabel()
  const values = barValues(bars, mode)
  const scale = scaleOf(values)
  const every = Math.ceil(bars.length / AXIS_LABELS)
  const labelOf = (bar: EnsoContextRequest): string => (granularity === 'turn' ? String(bar.turn) : `p${bar.prompt}`)
  const segment = (category: (typeof CONTEXT_CATEGORIES)[number], tokens: number, below: boolean): React.ReactNode => (
    <span
      key={category}
      className={cn('block w-full shrink-0', below ? 'opacity-75' : '')}
      style={{ height: `${(Math.abs(tokens) / scale) * 100}%`, background: CATEGORY_COLOR[category] }}
    />
  )
  const figure = mode === 'total' ? estimateText : estimateChangeText
  return (
    <div className="flex gap-2">
      <TrendScale scale={scale} mode={mode} />
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="pt-4.5">
          <div
            className={cn(
              'relative flex h-40 items-stretch gap-0.75',
              mode === 'total' ? 'border-b border-border-strong' : '',
            )}
          >
            {/* Guides at the scale's top and its middle, behind the bars. */}
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed" />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed"
            />
            {bars.map((bar, index) => {
              const makeup = values[index] ?? bar.estimated
              const total = CONTEXT_CATEGORIES.reduce((sum, category) => sum + makeup[category], 0)
              const compacted = compactedBar(bar, requests, granularity)
              const label = `request ${bar.turn}, prompt ${bar.prompt}, ${figure(total)}${compacted ? ', compaction' : ''}`
              // The hover names every category's figure: the bar alone says only proportions.
              const detail = CONTEXT_CATEGORIES.map((category) => `${categoryOf(category)} ${figure(makeup[category])}`)
              return (
                <button
                  key={bar.turn}
                  type="button"
                  aria-pressed={index === pickedIndex}
                  aria-label={label}
                  title={[label, ...detail].join('\n')}
                  className="relative flex max-w-16 min-w-2.5 flex-1 flex-col rounded-xs transition-colors hover:bg-popover aria-pressed:bg-accent aria-pressed:ring-1 aria-pressed:ring-foreground"
                  onClick={() => onPick(index)}
                >
                  {compacted ? (
                    <LayersIcon aria-hidden="true" className="absolute -top-4.5 left-1/2 size-4 -translate-x-1/2" />
                  ) : null}
                  <span className="flex min-h-0 flex-1 flex-col justify-end">
                    {[...CONTEXT_CATEGORIES]
                      .reverse()
                      .map((category) => (makeup[category] > 0 ? segment(category, makeup[category], false) : null))}
                  </span>
                  {mode === 'delta' ? (
                    <span className="flex min-h-0 flex-1 flex-col justify-start border-t border-border-strong">
                      {CONTEXT_CATEGORIES.map((category) =>
                        makeup[category] < 0 ? segment(category, makeup[category], true) : null,
                      )}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
        <div aria-hidden="true" className="flex gap-0.75 pt-1 font-mono text-xs text-muted-foreground">
          {bars.map((bar, index) => (
            <span key={bar.turn} className="max-w-16 min-w-2.5 flex-1 text-center">
              {index % every === 0 ? labelOf(bar) : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The trend's scale, beside the bars (#407): what the top guide is worth, its middle, and the
 * base — zero in Total; in Change, the line is zero and the extremes are signed.
 */
function TrendScale({ scale, mode }: { scale: number; mode: TrendMode }): React.ReactNode {
  const marks =
    mode === 'total'
      ? [estimateText(scale), estimateText(scale / 2), '0']
      : [estimateChangeText(scale), '±0', estimateChangeText(-scale)]
  return (
    <div aria-hidden="true" className="shrink-0 pt-4.5 font-mono text-xs text-muted-foreground">
      <div className="relative h-40 w-14">
        <span className="absolute top-0 right-0 -translate-y-1/2">{marks[0]}</span>
        <span className="absolute top-1/2 right-0 -translate-y-1/2">{marks[1]}</span>
        <span className="absolute right-0 bottom-0 translate-y-1/2">{marks[2]}</span>
      </div>
    </div>
  )
}

/** One row of the brief: its name in mono capitals, then its content — the design's `.brief-rows`. */
function BriefRow({ name, children }: { name: string; children: React.ReactNode }): React.ReactNode {
  return (
    <>
      <dt className="font-mono text-xs leading-6 font-semibold tracking-wide text-muted-foreground uppercase">
        {name}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** A brief row's list — or, when it has nothing, the muted word for that. */
function Listed({
  items,
  none,
  children,
}: {
  items: readonly unknown[]
  none: string
  children: React.ReactNode
}): React.ReactNode {
  return items.length === 0 ? <None>{none}</None> : children
}

/** The muted word a brief row says when it has nothing. */
function None({ children }: { children: string }): React.ReactNode {
  return <span className="text-xs text-muted-foreground">{children}</span>
}

/** A brief row's text — or, when it is empty, the word for that. */
function Said({ text, none }: { text: string; none: string }): React.ReactNode {
  return text === '' ? <None>{none}</None> : text
}

/** The picked request's brief — the design's `.brief`: what was asked, what entered, the reply, the tools, the counts. */
function RequestBrief({
  request,
  onOpenRequest,
  onOpenElement,
}: {
  request: EnsoContextRequest
  onOpenRequest: () => void
  /** Opens an element of this request in the Context Browser. */
  onOpenElement: (key: string) => void
}): React.ReactNode {
  const { actual, brief } = request
  const muted = 'text-xs text-muted-foreground'
  return (
    <article className="grid gap-3 rounded-lg border bg-background p-3">
      {/* A pick is confirmed in one line, not by re-reading the brief: the region below changes
          with the request, and nothing else in the article is live. */}
      <p aria-live="polite" className="sr-only">
        Request {request.turn}, prompt {request.prompt}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-heading text-base font-semibold ink:italic">Request {request.turn}</h3>
        <span className="text-xs text-muted-foreground">
          prompt {request.prompt} · {timeText(request.at)} · {request.model}
        </span>
        {request.compaction === undefined ? null : (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-popover px-2 py-0.5 text-xs"
            title="pi's count of the context the compaction replaced"
          >
            <LayersIcon aria-hidden="true" className="size-4" />
            compacted from {COMPACT.format(request.compaction.tokensBefore)}
          </span>
        )}
        <SmallButton className="ml-auto" onClick={onOpenRequest}>
          <PanelsTopLeftIcon aria-hidden="true" />
          Open in browser
        </SmallButton>
      </div>
      <dl className="grid grid-cols-label-value gap-x-3 gap-y-2 text-sm">
        <BriefRow name="Prompt">
          <Said text={brief.prompt} none="before the first prompt" />
        </BriefRow>
        <BriefRow name="In">
          <Listed items={brief.added} none="nothing new since the previous request">
            <ul className="grid gap-0.5">
              {brief.added.map((addition) => (
                <li key={addition.key} className="min-w-0">
                  <button
                    type="button"
                    className="flex max-w-full items-center gap-2 text-left underline-offset-2 hover:underline"
                    title="open it in the Context Browser"
                    onClick={() => onOpenElement(addition.key)}
                  >
                    <Swatch category={addition.category} className="size-2" />
                    <span className="truncate">{addition.label}</span>
                  </button>
                </li>
              ))}
              {brief.moreAdded > 0 ? <li className={muted}>+ {brief.moreAdded} more</li> : null}
            </ul>
          </Listed>
        </BriefRow>
        <BriefRow name="Reply">
          <Said text={brief.reply} none="no text" />
        </BriefRow>
        <BriefRow name="Tools">
          <Listed items={brief.toolCalls} none="none">
            <span className="flex flex-wrap gap-1">
              {brief.toolCalls.map((toolName, place) => (
                // A reply can call one tool twice; its place in the reply tells the two apart.
                <code key={`${toolName}-${String(place)}`} className="rounded-sm bg-popover px-1.5 font-mono text-xs">
                  {toolName}
                </code>
              ))}
            </span>
          </Listed>
        </BriefRow>
      </dl>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span title="pi's estimate of what the request was assembled from">
          estimate <b className="font-mono font-medium text-foreground">{estimateText(totalOf(request.estimated))}</b>
        </span>
        {actual.prompt === 0 ? (
          <span>no count from the provider</span>
        ) : (
          <>
            <span title="the provider's count: input, cache read and cache write">
              provider prompt <b className="font-mono font-medium text-foreground">{COMPACT.format(actual.prompt)}</b>
            </span>
            <span>
              cache read <b className="font-mono font-medium text-foreground">{COMPACT.format(actual.cacheRead)}</b> (
              {PERCENT.format(shareOf(actual.cacheRead, actual.prompt))})
            </span>
            <span>
              output <b className="font-mono font-medium text-foreground">{COMPACT.format(actual.output)}</b>
            </span>
          </>
        )}
      </p>
    </article>
  )
}

function ContextTrend({
  requests,
  onPick,
  onOpen,
}: {
  requests: readonly EnsoContextRequest[]
  /** The picked bar's request, for the Context Browser and File Activity to follow. */
  onPick: (turn: number) => void
  onOpen: (request: ContextBrowserRequest, focus?: ContextBrowserFocus) => void
}): React.ReactNode {
  const [granularity, setGranularity] = useState<TrendGranularity>('turn')
  const [mode, setMode] = useState<TrendMode>('total')
  // The picked request by its turn — stable across a refresh and a change of granularity. None: the latest.
  const [pickedTurn, setPickedTurn] = useState<number | undefined>(undefined)
  const bars = barsOf(requests, granularity)
  const pickedIndex = pickedBarIndex(requests, granularity, pickedTurn)
  const picked = bars[pickedIndex]
  const pick = (index: number): void => {
    const bar = bars[index]
    if (bar === undefined) return
    setPickedTurn(bar.turn)
    onPick(bar.turn)
  }
  // A picked turn lands in its prompt's bar — that prompt's LAST request — so a change of
  // granularity can move the request shown; the page follows it (#362 review), or the browser and
  // File Activity would stay on the turn the bar no longer is.
  const changeGranularity = (next: TrendGranularity): void => {
    setGranularity(next)
    if (pickedTurn === undefined) return
    const bar = barsOf(requests, next)[pickedBarIndex(requests, next, pickedTurn)]
    if (bar !== undefined) onPick(bar.turn)
  }
  return (
    <Card
      title="Trend"
      sub={`${granularity === 'turn' ? 'every model request' : 'each prompt’s last request'} · ${mode === 'total' ? 'whole makeup' : 'change from the bar before'}`}
      tools={
        <>
          <Choice label="bar per" value={granularity} options={GRANULARITIES} onChange={changeGranularity} />
          <Choice label="bar shows" value={mode} options={MODES} onChange={setMode} />
        </>
      }
    >
      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          a bar appears for each model request, once the first one has run
        </p>
      ) : (
        <>
          <div className="grid gap-2">
            <TrendPlot
              bars={bars}
              requests={requests}
              granularity={granularity}
              mode={mode}
              pickedIndex={pickedIndex}
              onPick={pick}
            />
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LayersIcon aria-hidden="true" className="size-4" />
                compaction
              </span>
              <span>Bars stack in context order, system prompt at the base.</span>
              {mode === 'delta' ? <span>Below the line: what left.</span> : null}
              <span className="ml-auto font-mono tabular-nums">
                {pickedIndex + 1} / {bars.length}
              </span>
            </p>
          </div>
          {picked === undefined ? null : (
            <RequestBrief
              request={picked}
              onOpenRequest={() => onOpen(picked.turn)}
              onOpenElement={(key: string) => onOpen(picked.turn, { request: picked.turn, key })}
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
 * (dsh's linkage), File Activity counts up to it, and the Now card's button, a brief's line, an
 * event or a file operation opens its request — and its element — in the browser. On a wide view
 * (the design's `ctx-grid`, a container query) the browser takes two columns and Events and Files
 * stack in the third.
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
    <div className="@container grid grid-cols-1 gap-4 p-4">
      <CurrentContext context={context} onOpen={openInBrowser} />
      <ContextTrend
        requests={context.requests}
        onPick={(turn: number) => {
          setTrendTurn(turn)
          setBrowserRequest(turn)
        }}
        onOpen={openInBrowser}
      />
      <div className="grid grid-cols-1 items-start gap-4 @5xl:grid-cols-3">
        <div ref={browser} className="min-w-0 scroll-mt-4 @5xl:col-span-2">
          <ContextBrowser
            requests={context.requests}
            next={context.next}
            request={browserRequest}
            onRequest={setBrowserRequest}
            focus={focus}
          />
        </div>
        <div className="grid min-w-0 gap-4">
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
      <p className="text-xs text-muted-foreground">
        {context.live ? 'Live' : 'Read from the file'} · {countText(requestCount)} model requests. Estimates are pi’s,
        written ≈; provider counts are plain.
      </p>
    </div>
  )
}

/** What a read of the context shows before it has one: reading, or why there is none. */
function whenRead(outcome: ContextOutcome, show: (context: EnsoThreadContext) => React.ReactNode): React.ReactNode {
  if (outcome.kind === 'reading')
    return <p className="p-4 text-xs text-muted-foreground">reading the thread's context…</p>
  if (outcome.kind === 'failed')
    return <p className="p-4 text-xs text-muted-foreground">no context: {outcome.problem}</p>
  return (
    <ThreadSystemPromptContext.Provider value={outcome.payload.systemPrompt}>
      {show(outcome.payload)}
    </ThreadSystemPromptContext.Provider>
  )
}

/** Pure view — the data arrives as props; the cards' choices are their own state. */
export function ThreadContextView({ outcome }: { readonly outcome: ContextOutcome }): React.ReactNode {
  return whenRead(outcome, (context: EnsoThreadContext) => <ContextCards context={context} />)
}

/** The Context view wired to its thread: read on open and whenever the thread's usage moves. */
export function ThreadContextDrawer(): React.ReactNode {
  return <ThreadContextView outcome={useReadOnUsage<ContextOutcome>(readThreadContext, ANALYSIS_READING)} />
}

/** `/context`'s two cards: what the next request holds, and every request's elements. */
function ContextComposition({ context }: { context: EnsoThreadContext }): React.ReactNode {
  const [browserRequest, setBrowserRequest] = useState<ContextBrowserRequest>('next')
  return (
    <div className="@container grid min-w-0 grid-cols-1 gap-4">
      <CurrentContext context={context} />
      <ContextBrowser
        requests={context.requests}
        next={context.next}
        request={browserRequest}
        onRequest={setBrowserRequest}
        focus={undefined}
      />
    </div>
  )
}

/** The dialog's body: mounted only while the dialog is open, so the read happens then. */
function ContextDialogBody(): React.ReactNode {
  const outcome = useReadOnUsage<ContextOutcome>(readThreadContext, ANALYSIS_READING)
  return whenRead(outcome, (context: EnsoThreadContext) => <ContextComposition context={context} />)
}

/**
 * `/context` (#361 phase 5): the composition and the browser over the chat, where the question
 * was asked — the Context tab holds the rest (trend, events, files). Same reads, same cards; the
 * dialog adds nothing of its own.
 */
export function ThreadContextDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean): void => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-h-dialog overflow-y-auto sm:max-w-context-dialog">
        <DialogHeader>
          <DialogTitle>Context</DialogTitle>
          <DialogDescription>
            what the next request is made of, and every request's elements · the Context tab has the rest
          </DialogDescription>
        </DialogHeader>
        <ContextDialogBody />
      </DialogContent>
    </Dialog>
  )
}
