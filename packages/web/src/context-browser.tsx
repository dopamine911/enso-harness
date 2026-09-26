import {
  type EnsoContextBody,
  type EnsoContextCategory,
  type EnsoContextElement,
  type EnsoContextImage,
  type EnsoContextMakeup,
  type EnsoContextRequest,
  EnsoContextRequestDetail,
} from '@enso/core'
import { TextPart } from '@tanstack/ai-react/ui'
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, LayersIcon, PanelsTopLeftIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { changeText, estimateText, MakeupBar, PERCENT, Swatch, timeText } from './context-parts.tsx'
import { cn } from './lib/utils.ts'
import { TEXT_PART_COMPONENTS } from './markdown-image.tsx'
import { OptionSelect } from './option-select.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
import { COMPACT } from './stats-table.tsx'
import { CATEGORY_COLOR, CATEGORY_LABEL, CONTEXT_CATEGORIES, shareOf, totalOf } from './thread-context-analysis.ts'
import { toggleMember } from './toggle-member.ts'
import { Card, Choice, SmallButton } from './view-parts.tsx'

/**
 * The Context Browser (#361 phase 3) — dsh-context's "open the box of any request", in the design
 * direction's two columns: pick the next request or any past one (the picker, or a step either
 * way), and see what it was assembled from — six categories, each expanding into one row per
 * element with its estimate — beside the element picked: a prompt section, a tool's schema, a
 * message, a reply's parts, a tool result beside its call's arguments. One column on a narrow view,
 * the element below its list.
 *
 * Read per request (`GET /api/threads/:threadId/context/:request`) when one is opened, not with
 * the trend: a request's detail carries its whole text. A row marked `+ new` entered since the
 * previous request; each category says how many did, and its estimate's change. What the previous
 * request held and this one does not (a compaction's work) is listed apart.
 */

export type ContextBrowserRequest = number | 'next'

type TextView = 'raw' | 'markdown'
const TEXT_VIEWS: ReadonlyArray<readonly [TextView, string]> = [
  ['raw', 'raw'],
  ['markdown', 'markdown'],
]

/** A row to open on arrival: a request and an element key (or the prefix of an element's keys). */
export interface ContextBrowserFocus {
  readonly request: ContextBrowserRequest
  readonly key: string
}

type DetailOutcome = AnalysisOutcome<EnsoContextRequestDetail>

/** An element's key, or one of a message's elements when the key names the message (`entry#0`). */
const matchesKey = (element: EnsoContextElement, key: string): boolean =>
  element.key === key || element.key.startsWith(`${key}:`)

/**
 * Items keyed by their place: a body's parts and images are a fixed list — the element is
 * replaced whole when its request changes — so place is identity here.
 */
function keyedByPlace<Item>(items: readonly Item[], prefix: string): Array<{ item: Item; slot: string }> {
  return items.map((item, place) => ({ item, slot: `${prefix}-${place}` }))
}

// ── an element's body ──────────────────────────────────────────────────────────────────────────

const PRE = 'max-h-96 overflow-auto font-mono text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap'

/** A part of an element, under its name in mono capitals — the design's `.part`. */
function Part({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  )
}

function Images({ images }: { images: readonly EnsoContextImage[] }): React.ReactNode {
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {keyedByPlace(images, 'image').map(({ item: image, slot }) => (
        <figure key={slot} className="rounded-md border p-1 text-xs">
          {image.data === undefined ? (
            <div className="flex size-24 items-center justify-center text-muted-foreground">too large to preview</div>
          ) : (
            <img
              alt="in the context"
              className="max-h-40 max-w-60"
              src={`data:${image.mimeType};base64,${image.data}`}
            />
          )}
          <figcaption className="mt-1 text-muted-foreground">
            {image.mimeType} · {COMPACT.format(image.bytes)} bytes
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

/** Long text, as it was sent — or rendered as markdown, the reader's choice in the element's head. */
function TextBlock({ text, view, muted = false }: { text: string; view: TextView; muted?: boolean }): React.ReactNode {
  if (view === 'markdown') {
    return (
      <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-heading">
        <TextPart components={TEXT_PART_COMPONENTS} content={text} />
      </div>
    )
  }
  return <pre className={cn(PRE, muted ? 'text-muted-foreground' : '')}>{text}</pre>
}

function Json({ value }: { value: unknown }): React.ReactNode {
  return <pre className={PRE}>{JSON.stringify(value, null, 2)}</pre>
}

/** A call's arguments as a table when they are an object of plain values — the way dsh lays them out. */
function Arguments({ value }: { value: unknown }): React.ReactNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return <Json value={value} />
  return (
    <dl className="grid grid-cols-label-value gap-x-3 gap-y-1 text-sm">
      {Object.entries(value).map(([name, argument]) => (
        <div key={name} className="contents">
          <dt className="font-mono text-muted-foreground">{name}</dt>
          <dd className="min-w-0 font-mono wrap-anywhere whitespace-pre-wrap">
            {typeof argument === 'string' ? argument : JSON.stringify(argument)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Whether a body holds text the raw / markdown choice applies to. */
function hasText(body: EnsoContextBody): boolean {
  if (body.kind === 'text' || body.kind === 'toolResult') return body.text !== ''
  if (body.kind === 'reply') return body.parts.some((part) => part.type !== 'toolCall')
  return false
}

function Body({ body, view }: { body: EnsoContextBody; view: TextView }): React.ReactNode {
  switch (body.kind) {
    case 'text':
      return (
        <>
          {body.text === '' ? null : <TextBlock text={body.text} view={view} />}
          <Images images={body.images} />
        </>
      )
    case 'tool':
      return (
        <>
          <Part label="description">
            <p className="text-sm whitespace-pre-wrap">{body.description}</p>
          </Part>
          <Part label="parameters">
            <Json value={body.parameters} />
          </Part>
        </>
      )
    case 'reply':
      return keyedByPlace(body.parts, 'part').map(({ item: part, slot }) =>
        part.type === 'toolCall' ? (
          <Part key={slot} label={`tool call · ${part.name}`}>
            <Arguments value={part.arguments} />
          </Part>
        ) : (
          <Part key={slot} label={part.type}>
            <TextBlock text={part.text} view={view} muted={part.type === 'thinking'} />
          </Part>
        ),
      )
    case 'toolResult':
      return (
        <>
          <Part label={`arguments · ${body.toolName}`}>
            {body.arguments === undefined ? (
              <p className="text-sm text-muted-foreground">its call is no longer in this context</p>
            ) : (
              <Arguments value={body.arguments} />
            )}
          </Part>
          {/* An image-only result (a read of a PNG) has no text: its images are all it holds. */}
          <Part label={body.isError ? 'result · error' : 'result · ok'}>
            <ResultText text={body.text} isError={body.isError} view={view} />
            <Images images={body.images} />
          </Part>
        </>
      )
  }
}

/** A tool result's text: in the refusal colour when it failed (a guard's reason is a sentence to read, not markdown). */
function ResultText({ text, isError, view }: { text: string; isError: boolean; view: TextView }): React.ReactNode {
  if (text === '') return null
  if (isError) return <pre className={cn(PRE, 'text-refuse')}>{text}</pre>
  return <TextBlock text={text} view={view} />
}

/** The element picked, beside the list — the design's `.el-view`; what to do when there is none. */
function ElementView({
  element,
  picked,
}: {
  element: EnsoContextElement | undefined
  /** Whether a pick is held — one this request does not hold says so. */
  picked: boolean
}): React.ReactNode {
  const [view, setView] = useState<TextView>('raw')
  const frame = 'grid min-w-0 grid-cols-1 content-start rounded-lg border bg-background @5xl:sticky @5xl:top-4'
  if (element === undefined) {
    return (
      <aside aria-label="element" className={frame}>
        <div className="grid justify-items-start gap-2 px-4 py-5 text-sm text-muted-foreground">
          <PanelsTopLeftIcon aria-hidden="true" className="size-4" />
          <span>
            Pick an element to see exactly what the model received: a prompt section, a tool’s schema, a message, a
            reply’s parts, or a tool result beside its call’s arguments.
          </span>
          {picked ? (
            <span>The element you had open isn’t in this request. It entered later or left earlier.</span>
          ) : null}
        </div>
      </aside>
    )
  }
  return (
    <aside aria-label="element" className={frame}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b p-3">
        <h3 className="min-w-0 flex-1 font-heading text-base font-semibold wrap-anywhere">{element.label}</h3>
        {hasText(element.body) ? (
          <Choice label="show the text" value={view} options={TEXT_VIEWS} onChange={setView} />
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 font-mono text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Swatch category={element.category} className="size-2" />
          {CATEGORY_LABEL[element.category]}
        </span>
        <span>{estimateText(element.tokens)}</span>
        <span>{element.at === undefined ? 'not stamped by pi' : `stored ${timeText(element.at)}`}</span>
        {element.entered ? <NewBadge>+ new in this request</NewBadge> : null}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-3 p-3">
        <Body body={element.body} view={view} />
      </div>
    </aside>
  )
}

/** "Entered since the previous request" — the design's `.new-badge`, outlined in the evidence colour. */
function NewBadge({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-sm border border-evidence px-1.5 font-mono text-xs leading-normal font-semibold text-foreground"
      title="entered since the previous request"
    >
      {children}
    </span>
  )
}

// ── rows ───────────────────────────────────────────────────────────────────────────────────────

function ElementRow({
  element,
  picked,
  onPick,
  rowRef,
}: {
  element: EnsoContextElement
  picked: boolean
  onPick: () => void
  rowRef: ((node: HTMLLIElement | null) => void) | undefined
}): React.ReactNode {
  return (
    <li ref={rowRef}>
      <button
        type="button"
        aria-pressed={picked}
        className="flex min-h-10 w-full items-center gap-3 py-1 pr-3 pl-12 text-left text-sm transition-colors hover:bg-popover aria-pressed:bg-accent"
        onClick={onPick}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{element.label}</span>
          {element.entered ? <NewBadge>+ new</NewBadge> : null}
        </span>
        <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {estimateText(element.tokens)}
        </span>
      </button>
    </li>
  )
}

type ToolOrder = 'context' | 'size' | 'name'
const TOOL_ORDERS: ReadonlyArray<readonly [ToolOrder, string]> = [
  ['context', 'as sent'],
  ['size', 'by size'],
  ['name', 'by name'],
]

function ordered(elements: readonly EnsoContextElement[], order: ToolOrder): EnsoContextElement[] {
  if (order === 'size') return [...elements].sort((first, second) => second.tokens - first.tokens)
  if (order === 'name') return [...elements].sort((first, second) => first.label.localeCompare(second.label))
  return [...elements]
}

/** A category long enough to need finding in: past this many rows it offers a filter and an order. */
const FINDABLE_ROWS = 8

/** One category of the opened request: its elements, the makeup they are a share of, and whether it is open. */
interface CategoryShape {
  readonly category: EnsoContextCategory
  readonly elements: readonly EnsoContextElement[]
  readonly makeup: EnsoContextMakeup
  /** Its estimate's change from the request before; none for the first. */
  readonly change: number | undefined
  readonly open: boolean
  readonly onToggle: () => void
}

/** A category's header: its name, its elements (and how many entered), its estimate, share and change. */
function CategoryHeader({ category, elements, makeup, change, open, onToggle }: CategoryShape): React.ReactNode {
  const entered = elements.filter((element) => element.entered).length
  const share = shareOf(makeup[category], totalOf(makeup))
  const details = [
    elements.length === 1 ? '1 element' : `${elements.length} elements`,
    ...(entered > 0 ? [`${entered} new`] : []),
    ...(change === undefined || change === 0 ? [] : [changeText(change)]),
  ]
  return (
    <button
      type="button"
      aria-expanded={open}
      disabled={elements.length === 0}
      className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-popover disabled:opacity-55 disabled:hover:bg-transparent"
      onClick={onToggle}
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open ? 'rotate-90' : '')}
      />
      <Swatch category={category} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <b className="text-sm font-semibold">{CATEGORY_LABEL[category]}</b>
        <small className="font-mono text-xs text-muted-foreground">{details.join(' · ')}</small>
      </span>
      <span className="grid justify-items-end gap-1 font-mono text-xs whitespace-nowrap tabular-nums">
        <span>
          {estimateText(makeup[category])} · {PERCENT.format(share)}
        </span>
        <span aria-hidden="true" className="block h-1 w-18 overflow-hidden rounded-full bg-popover">
          <span className="block h-full" style={{ width: `${share * 100}%`, background: CATEGORY_COLOR[category] }} />
        </span>
      </span>
    </button>
  )
}

function CategoryRow({
  pickedKey,
  onPick,
  focusedKey,
  focusRow,
  ...shape
}: CategoryShape & {
  pickedKey: string | undefined
  onPick: (key: string) => void
  /** The element a focus names, whose row the browser brings into view. */
  focusedKey: string | undefined
  focusRow: React.RefObject<HTMLLIElement | null>
}): React.ReactNode {
  const { category, elements, open } = shape
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState<ToolOrder>('context')
  const needle = filter.trim().toLowerCase()
  const shown = ordered(
    needle === '' ? elements : elements.filter((element) => element.label.toLowerCase().includes(needle)),
    order,
  )
  return (
    <li className="overflow-hidden rounded-lg border bg-background">
      <CategoryHeader {...shape} />
      {open ? (
        <div className="border-t pb-2">
          {elements.length > FINDABLE_ROWS ? (
            <div className="flex items-center gap-2 px-3 pt-2">
              <input
                type="search"
                aria-label={`filter ${CATEGORY_LABEL[category]}`}
                placeholder="filter by name…"
                className="min-h-8 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs"
                value={filter}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
              />
              <OptionSelect
                label={`order ${CATEGORY_LABEL[category]}`}
                value={order}
                options={TOOL_ORDERS}
                onChange={setOrder}
              />
            </div>
          ) : null}
          <ul className="max-h-128 overflow-y-auto">
            {shown.map((element) => (
              <ElementRow
                key={element.key}
                element={element}
                picked={element.key === pickedKey}
                onPick={() => onPick(element.key)}
                rowRef={
                  element.key === focusedKey
                    ? (node: HTMLLIElement | null): void => {
                        focusRow.current = node
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

// ── the card ───────────────────────────────────────────────────────────────────────────────────

/** The picker's choices: the next request, then every request, newest first. */
function requestOptions(
  requests: readonly EnsoContextRequest[],
  next: EnsoContextMakeup,
): ReadonlyArray<readonly [string, string]> {
  return [
    ['next', `Next request · ${estimateText(totalOf(next))}`],
    ...[...requests]
      .reverse()
      .map(
        (candidate) =>
          [
            String(candidate.turn),
            `Request ${candidate.turn} · prompt ${candidate.prompt} · ${estimateText(totalOf(candidate.estimated))}${candidate.compaction === undefined ? '' : ' · compacted'}`,
          ] as const,
      ),
  ]
}

/**
 * The opened request's place, makeup (from the trend's read), the request before's, and its
 * record — or, for a turn the branch does not hold (every picker draws from these requests, and a
 * branch only grows, so this is a guard), no makeup: none is shown rather than the next request's
 * under this one's name.
 */
function openedRequest(
  requests: readonly EnsoContextRequest[],
  next: EnsoContextMakeup,
  request: ContextBrowserRequest,
): {
  index: number
  makeup: EnsoContextMakeup | undefined
  before: EnsoContextRequest | undefined
  record: EnsoContextRequest | undefined
} {
  if (request === 'next') return { index: requests.length, makeup: next, before: requests.at(-1), record: undefined }
  const index = requests.findIndex((candidate) => candidate.turn === request)
  const record = requests[index]
  return { index, makeup: record?.estimated, before: record === undefined ? undefined : requests[index - 1], record }
}

/** A request one step from `index` — `next` past the last one. */
function stepped(requests: readonly EnsoContextRequest[], index: number): ContextBrowserRequest | undefined {
  if (index < 0) return undefined
  if (index >= requests.length) return index === requests.length ? 'next' : undefined
  return requests[index]?.turn
}

/** The provider's count for the opened request — or why there is none. */
function ProviderCount({ record }: { record: EnsoContextRequest | undefined }): React.ReactNode {
  if (record === undefined) return <span>not sent yet</span>
  if (record.actual.prompt === 0) return <span>no count from the provider</span>
  return (
    <span>
      provider prompt <b className="font-medium text-foreground">{COMPACT.format(record.actual.prompt)}</b>
    </span>
  )
}

/** Why no rows show yet: the read failed, or the asked-for request is still being read. */
function DetailStatus({ outcome, waiting }: { outcome: DetailOutcome; waiting: boolean }): React.ReactNode {
  if (outcome.kind === 'failed') return <p className="text-sm text-muted-foreground">no detail: {outcome.problem}</p>
  return waiting ? <p className="text-sm text-muted-foreground">reading the request's context…</p> : null
}

/** What the previous request held that this one does not — the design's dashed `.left-list`. */
function LeftList({
  left,
  before,
}: {
  left: EnsoContextRequestDetail['left']
  before: number | undefined
}): React.ReactNode {
  if (left.length === 0) return null
  return (
    <div className="grid gap-2 rounded-lg border border-dashed border-border-strong p-3">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <LayersIcon aria-hidden="true" className="size-4" />
        Left since {before === undefined ? 'the request before' : `request ${before}`} · {left.length}{' '}
        {left.length === 1 ? 'element' : 'elements'}
      </h4>
      <ul className="grid gap-0.5 text-sm text-muted-foreground">
        {left.map((gone) => (
          <li key={gone.key} className="flex min-w-0 items-center gap-2">
            <Swatch category={gone.category} className="size-2" />
            <span className="truncate">{gone.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The pick and the open categories, following a focus: a focus that arrives — on mount or later —
 * picks its element, opens its category and brings its row into view, once. ⚠ By KEY, not by
 * element: each read of the detail is a new payload, so the element's identity moves on every usage
 * move — keyed on it, a turn landing re-opened the category the reader had closed and scrolled
 * back to the row.
 */
type BrowserPick = {
  pickedKey: string | undefined
  setPickedKey: (key: string) => void
  openCategories: ReadonlySet<EnsoContextCategory>
  toggleCategory: (category: EnsoContextCategory) => void
  focusRow: React.RefObject<HTMLLIElement | null>
}

function useBrowserPick(focused: EnsoContextElement | undefined): BrowserPick {
  const [pickedKey, setPickedKey] = useState<string | undefined>(focused?.key)
  const [openCategories, setOpenCategories] = useState<ReadonlySet<EnsoContextCategory>>(
    () => new Set(focused === undefined ? [] : [focused.category]),
  )
  const focusRow = useRef<HTMLLIElement | null>(null)
  const focusedKey = focused?.key
  const focusedCategory = focused?.category
  useEffect(() => {
    if (focusedKey === undefined || focusedCategory === undefined) return
    setPickedKey(focusedKey)
    setOpenCategories((open) => new Set([...open, focusedCategory]))
  }, [focusedKey, focusedCategory])
  // The row is in the DOM only once its category is open, which a focus arriving on a closed
  // category makes true a render LATER — so the scroll waits for the row, once per focus: a
  // category the reader closes and reopens is not a new focus.
  const scrolledFor = useRef<string | undefined>(undefined)
  const open = focusedCategory !== undefined && openCategories.has(focusedCategory)
  useEffect(() => {
    if (focusedKey === undefined || scrolledFor.current === focusedKey || !open) return
    const row = focusRow.current
    if (row === null) return
    row.scrollIntoView({ block: 'nearest' })
    scrolledFor.current = focusedKey
  }, [focusedKey, open])
  const toggleCategory = (category: EnsoContextCategory): void =>
    setOpenCategories((current) => toggleMember(current, category))
  return { pickedKey, setPickedKey, openCategories, toggleCategory, focusRow }
}

/** A read request's six categories and what left it, beside the element picked. */
function DetailColumns({
  detail,
  makeup,
  before,
  focused,
  pick,
}: {
  detail: EnsoContextRequestDetail
  makeup: EnsoContextMakeup
  before: EnsoContextRequest | undefined
  focused: EnsoContextElement | undefined
  pick: BrowserPick
}): React.ReactNode {
  const { pickedKey, setPickedKey, openCategories, toggleCategory, focusRow } = pick
  const picked = pickedKey === undefined ? undefined : detail.elements.find((element) => element.key === pickedKey)
  return (
    <div className="grid min-w-0 items-start gap-4 @5xl:grid-cols-2">
      <div className="grid min-w-0 gap-3">
        <ul className="grid gap-2">
          {CONTEXT_CATEGORIES.map((category) => (
            <CategoryRow
              key={category}
              category={category}
              elements={detail.elements.filter((element) => element.category === category)}
              makeup={makeup}
              change={before === undefined ? undefined : makeup[category] - before.estimated[category]}
              open={openCategories.has(category)}
              onToggle={() => toggleCategory(category)}
              pickedKey={pickedKey}
              onPick={setPickedKey}
              focusedKey={focused?.key}
              focusRow={focusRow}
            />
          ))}
        </ul>
        <LeftList left={detail.left} before={before?.turn} />
      </div>
      <ElementView element={picked} picked={pickedKey !== undefined} />
    </div>
  )
}

export function ContextBrowser({
  requests,
  next,
  request,
  onRequest,
  focus,
}: {
  requests: readonly EnsoContextRequest[]
  next: EnsoContextMakeup
  request: ContextBrowserRequest
  onRequest: (request: ContextBrowserRequest) => void
  focus: ContextBrowserFocus | undefined
}): React.ReactNode {
  const read = useCallback(
    (threadId: string, fetchImpl: FetchLike): Promise<DetailOutcome> =>
      readThreadAnalysis(threadId, `context/${request}`, EnsoContextRequestDetail, fetchImpl),
    [request],
  )
  const outcome = useReadOnUsage<DetailOutcome>(read, ANALYSIS_READING)
  const { index, makeup, before, record } = openedRequest(requests, next, request)
  // The payload says which request it is: until the one asked for arrives, none shows — the
  // status says it is reading.
  const detail = outcome.kind === 'read' && outcome.payload.request === request ? outcome.payload : undefined
  // The pick and the open categories live here, not in the columns: those unmount while a request
  // is read, and the reader's place must survive a step through requests (the design's "the element
  // you had open isn't in this request").
  const focusKey = focus?.request === request ? focus.key : undefined
  const focused =
    focusKey === undefined || detail === undefined
      ? undefined
      : detail.elements.find((element) => matchesKey(element, focusKey))
  const pick = useBrowserPick(focused)
  const earlier = stepped(requests, index - 1)
  const later = request === 'next' ? undefined : stepped(requests, index + 1)
  return (
    <Card
      title="Context Browser"
      sub="open the box of any request"
      tools={
        <>
          <SmallButton
            aria-label="earlier request"
            disabled={earlier === undefined}
            onClick={() => {
              if (earlier !== undefined) onRequest(earlier)
            }}
          >
            <ArrowLeftIcon aria-hidden="true" />
          </SmallButton>
          <OptionSelect
            label="the request to open"
            value={String(request)}
            options={requestOptions(requests, next)}
            onChange={(value: string) => onRequest(value === 'next' ? 'next' : Number(value))}
            className="min-h-8 max-w-full rounded-md border bg-background px-2 text-sm text-foreground"
          />
          <SmallButton
            aria-label="later request"
            disabled={later === undefined}
            onClick={() => {
              if (later !== undefined) onRequest(later)
            }}
          >
            <ArrowRightIcon aria-hidden="true" />
          </SmallButton>
        </>
      }
    >
      {makeup === undefined ? (
        <p className="text-sm text-muted-foreground">request {request} is not on this branch</p>
      ) : (
        <OpenedRequest
          request={request}
          makeup={makeup}
          before={before}
          record={record}
          detail={detail}
          outcome={outcome}
          focused={focused}
          pick={pick}
        />
      )}
    </Card>
  )
}

/** The opened request's summary, its makeup, and its categories beside the element picked. */
function OpenedRequest({
  request,
  makeup,
  before,
  record,
  detail,
  outcome,
  focused,
  pick,
}: {
  request: ContextBrowserRequest
  makeup: EnsoContextMakeup
  before: EnsoContextRequest | undefined
  record: EnsoContextRequest | undefined
  detail: EnsoContextRequestDetail | undefined
  outcome: DetailOutcome
  focused: EnsoContextElement | undefined
  pick: BrowserPick
}): React.ReactNode {
  const figure = 'font-medium text-foreground'
  return (
    <>
      <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
        <span>
          {request === 'next' ? 'next request' : `request ${request}`} · estimate{' '}
          <b className={figure}>{estimateText(totalOf(makeup))}</b>
        </span>
        {detail === undefined ? null : (
          <>
            <span>
              <b className={figure}>{detail.elements.length}</b> elements
            </span>
            <span>
              <b className={figure}>{detail.elements.filter((element) => element.entered).length}</b> entered since{' '}
              {before === undefined ? 'the start' : `request ${before.turn}`}
            </span>
          </>
        )}
        <ProviderCount record={record} />
      </p>
      <MakeupBar makeup={makeup} scale={totalOf(makeup)} label="the opened request's makeup, estimated" />
      <DetailStatus outcome={outcome} waiting={detail === undefined} />
      {detail === undefined ? null : (
        <DetailColumns detail={detail} makeup={makeup} before={before} focused={focused} pick={pick} />
      )}
    </>
  )
}
