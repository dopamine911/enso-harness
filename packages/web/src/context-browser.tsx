import {
  type EnsoContextBody,
  type EnsoContextCategory,
  type EnsoContextElement,
  type EnsoContextImage,
  type EnsoContextMakeup,
  type EnsoContextRequest,
  EnsoContextRequestDetail,
} from '@enso/core'
import { TextPart, type TextPartProps } from '@tanstack/ai-react/ui'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, COMPACT, changeText, estimateText, MakeupBar, PERCENT, timeText } from './context-parts.tsx'
import { MarkdownImage } from './markdown-image.tsx'
import { OptionSelect } from './option-select.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readThreadAnalysis } from './route-read.ts'
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  CONTEXT_CATEGORIES,
  changeOf,
  shareOf,
  totalOf,
} from './thread-context-analysis.ts'
import { toggleMember } from './toggle-member.ts'

/**
 * The Context Browser (#361 phase 3) — dsh-context's "open the box of any request": pick the next
 * request or any past one, and see what it was assembled from — six categories, each expanding
 * into one row per element with its estimate, each row into the element itself: a prompt
 * section, a tool's schema, a message, a reply's parts, a tool result beside its call's arguments.
 *
 * Read per request (`GET /api/threads/:threadId/context/:request`) when one is opened, not with
 * the trend: a request's detail carries its whole text. A row marked `+` entered since the
 * previous request; each category says how many did, and its estimate's change. What the
 * previous request held and this one does not (a compaction's work) is listed apart.
 */

export type ContextBrowserRequest = number | 'next'

/** A row to open on arrival: a request and an element key (or the prefix of an element's keys). */
export interface ContextBrowserFocus {
  readonly request: ContextBrowserRequest
  readonly key: string
}

type DetailOutcome = AnalysisOutcome<EnsoContextRequestDetail>

/** The intrinsic elements `TextPart` renders through ours — a remote image waits for a click. */
const TEXT_PART_COMPONENTS: NonNullable<TextPartProps['components']> = { img: MarkdownImage }

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

function Images({ images }: { images: readonly EnsoContextImage[] }): React.ReactNode {
  if (images.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
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

/** Long text, as it was sent — or rendered as markdown, the reader's choice. */
function TextBlock({ text, muted = false }: { text: string; muted?: boolean }): React.ReactNode {
  const [markdown, setMarkdown] = useState(false)
  const lines = text === '' ? 0 : text.split('\n').length
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b px-2 py-1 text-muted-foreground">
        <span>{lines === 1 ? '1 line' : `${lines} lines`}</span>
        <fieldset aria-label="show the text" className="inline-flex rounded bg-muted p-0.5">
          {(['raw', 'markdown'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={(choice === 'markdown') === markdown}
              className={(choice === 'markdown') === markdown ? 'rounded bg-background px-1.5' : 'px-1.5'}
              onClick={() => setMarkdown(choice === 'markdown')}
            >
              {choice}
            </button>
          ))}
        </fieldset>
      </div>
      {markdown ? (
        <div className="prose prose-sm dark:prose-invert max-w-none p-2">
          <TextPart components={TEXT_PART_COMPONENTS} content={text} />
        </div>
      ) : (
        <pre
          className={`max-h-96 overflow-auto whitespace-pre-wrap break-words p-2 font-mono ${muted ? 'text-muted-foreground' : ''}`}
        >
          {text}
        </pre>
      )}
    </div>
  )
}

function Json({ value }: { value: unknown }): React.ReactNode {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

/** A call's arguments as a table when they are an object of plain values — the way dsh lays them out. */
function Arguments({ value }: { value: unknown }): React.ReactNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return <Json value={value} />
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border p-2">
      {Object.entries(value).map(([name, argument]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words font-mono">
            {typeof argument === 'string' ? argument : JSON.stringify(argument)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Body({ body }: { body: EnsoContextBody }): React.ReactNode {
  switch (body.kind) {
    case 'text':
      return (
        <>
          {body.text === '' ? null : <TextBlock text={body.text} />}
          <Images images={body.images} />
        </>
      )
    case 'tool':
      return (
        <div className="grid gap-2">
          <p className="whitespace-pre-wrap">{body.description}</p>
          <Json value={body.parameters} />
        </div>
      )
    case 'reply':
      return (
        <div className="grid gap-2">
          {keyedByPlace(body.parts, 'part').map(({ item: part, slot }) =>
            part.type === 'toolCall' ? (
              <div key={slot}>
                <p className="mb-1 font-mono">→ {part.name}</p>
                <Arguments value={part.arguments} />
              </div>
            ) : (
              <TextBlock key={slot} text={part.text} muted={part.type === 'thinking'} />
            ),
          )}
        </div>
      )
    case 'toolResult':
      return (
        <div className="grid gap-2">
          <p className="flex items-center gap-2 font-mono">
            ← {body.toolName}
            <span className={body.isError ? 'text-destructive' : 'text-muted-foreground'}>
              {body.isError ? 'error' : 'ok'}
            </span>
          </p>
          {body.arguments === undefined ? (
            <p className="text-muted-foreground">its call is no longer in this context</p>
          ) : (
            <Arguments value={body.arguments} />
          )}
          <TextBlock text={body.text} />
          <Images images={body.images} />
        </div>
      )
  }
}

// ── rows ───────────────────────────────────────────────────────────────────────────────────────

function ElementRow({
  element,
  open,
  onToggle,
  rowRef,
}: {
  element: EnsoContextElement
  open: boolean
  onToggle: () => void
  rowRef: ((node: HTMLLIElement | null) => void) | undefined
}): React.ReactNode {
  return (
    <li ref={rowRef} className="border-t first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted/50"
        onClick={onToggle}
      >
        {open ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {element.entered ? (
            <b className="mr-1 font-normal text-[var(--chart-2)]" title="entered since the previous request">
              +
            </b>
          ) : null}
          {element.label}
        </span>
        {element.at === undefined ? null : <span className="text-muted-foreground">{timeText(element.at)}</span>}
        <span className="w-14 text-right font-mono text-muted-foreground tabular-nums">
          {estimateText(element.tokens)}
        </span>
      </button>
      {open ? (
        <div className="px-2 pb-2 pl-7">
          <Body body={element.body} />
        </div>
      ) : null}
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

/**
 * A category's open state and its open rows, following a focus: a focus that arrives — on mount
 * or later — opens the category and the row, and brings the row into view.
 */
function useFocusedRows(focused: EnsoContextElement | undefined): {
  open: boolean
  setOpen: (update: (wasOpen: boolean) => boolean) => void
  openKeys: ReadonlySet<string>
  toggle: (key: string) => void
  focusRow: React.RefObject<HTMLLIElement | null>
} {
  const [open, setOpen] = useState(focused !== undefined)
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(
    () => new Set(focused === undefined ? [] : [focused.key]),
  )
  const focusRow = useRef<HTMLLIElement | null>(null)
  // ⚠ By KEY, not by element: each read of the detail is a new payload, so the element's identity
  // moves on every usage move — keyed on it, a turn landing re-opened the row the reader had
  // closed and scrolled back to it. A focus is the same focus until its key changes.
  const focusedKey = focused?.key
  useEffect(() => {
    if (focusedKey === undefined) return
    setOpen(true)
    setOpenKeys((keys) => new Set([...keys, focusedKey]))
  }, [focusedKey])
  useEffect(() => {
    if (focusedKey !== undefined) focusRow.current?.scrollIntoView({ block: 'start' })
  }, [focusedKey])
  const toggle = (key: string): void => setOpenKeys((keys) => toggleMember(keys, key))
  return { open, setOpen, openKeys, toggle, focusRow }
}

/** A category's header: its name, its items (and how many entered), its estimate, change and share. */
function CategoryHeader({
  category,
  elements,
  makeup,
  change,
  open,
  onToggle,
}: {
  category: EnsoContextCategory
  elements: readonly EnsoContextElement[]
  makeup: EnsoContextMakeup
  change: number | undefined
  open: boolean
  onToggle: () => void
}): React.ReactNode {
  const entered = elements.filter((element) => element.entered).length
  return (
    <button
      type="button"
      aria-expanded={open}
      disabled={elements.length === 0}
      className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/50 disabled:opacity-50"
      onClick={onToggle}
    >
      {open ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-sm"
        style={{ background: CATEGORY_COLOR[category] }}
      />
      <b className="font-medium">{CATEGORY_LABEL[category]}</b>
      <span className="text-muted-foreground">{elements.length === 1 ? '1 item' : `${elements.length} items`}</span>
      {entered > 0 ? (
        <span className="rounded bg-muted px-1 font-mono" title="entered since the previous request">
          +{entered}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2 font-mono tabular-nums">
        {change === undefined || change === 0 ? null : (
          <span className="rounded bg-muted px-1" title="change from the previous request, estimated">
            {changeText(change)}
          </span>
        )}
        <span>{estimateText(makeup[category])}</span>
        <span className="w-9 text-right text-muted-foreground">
          {PERCENT.format(shareOf(makeup[category], totalOf(makeup)))}
        </span>
      </span>
    </button>
  )
}

function CategoryRow({
  category,
  elements,
  makeup,
  change,
  focusKey,
}: {
  category: EnsoContextCategory
  elements: readonly EnsoContextElement[]
  makeup: EnsoContextMakeup
  change: number | undefined
  focusKey: string | undefined
}): React.ReactNode {
  const focused = focusKey === undefined ? undefined : elements.find((element) => matchesKey(element, focusKey))
  const { open, setOpen, openKeys, toggle, focusRow } = useFocusedRows(focused)
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState<ToolOrder>('context')
  const needle = filter.trim().toLowerCase()
  const shown = ordered(
    needle === '' ? elements : elements.filter((element) => element.label.toLowerCase().includes(needle)),
    order,
  )
  return (
    <li className="rounded-md border">
      <CategoryHeader
        category={category}
        elements={elements}
        makeup={makeup}
        change={change}
        open={open}
        onToggle={() => setOpen((wasOpen) => !wasOpen)}
      />
      {open ? (
        <div className="border-t">
          <div className="flex items-center gap-2 p-2">
            <input
              type="search"
              aria-label={`filter ${CATEGORY_LABEL[category]}`}
              placeholder="filter by name…"
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-0.5"
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
          <ul className="max-h-[32rem] overflow-y-auto">
            {shown.map((element) => (
              <ElementRow
                key={element.key}
                element={element}
                open={openKeys.has(element.key)}
                onToggle={() => toggle(element.key)}
                rowRef={
                  element === focused
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

function requestLabel(request: EnsoContextRequest): string {
  return `turn ${request.turn} · prompt ${request.prompt} · ${timeText(request.at)}`
}

/** The picker's choices: the next request, then every request, newest first. */
function requestOptions(requests: readonly EnsoContextRequest[]): ReadonlyArray<readonly [string, string]> {
  return [
    ['next', 'next request (live)'],
    ...[...requests].reverse().map((candidate) => [String(candidate.turn), requestLabel(candidate)] as const),
  ]
}

/** The opened request's makeup (from the trend's read), the request before's, and the change between. */
function openedMakeup(
  requests: readonly EnsoContextRequest[],
  next: EnsoContextMakeup,
  request: ContextBrowserRequest,
): { makeup: EnsoContextMakeup; before: EnsoContextMakeup | undefined; change: EnsoContextMakeup | undefined } {
  const turnIndex = request === 'next' ? requests.length : requests.findIndex((candidate) => candidate.turn === request)
  const makeup = request === 'next' ? next : (requests[turnIndex]?.estimated ?? next)
  const before = requests[turnIndex - 1]?.estimated
  return { makeup, before, change: before === undefined ? undefined : changeOf(makeup, before) }
}

/** Why no rows show yet: the read failed, or the asked-for request is still being read. */
function DetailStatus({ outcome, waiting }: { outcome: DetailOutcome; waiting: boolean }): React.ReactNode {
  if (outcome.kind === 'failed')
    return <p className="mt-3 text-muted-foreground text-xs">no detail: {outcome.problem}</p>
  return waiting ? <p className="mt-3 text-muted-foreground text-xs">reading the request's context…</p> : null
}

/** A read request's six categories, and what left it since the request before. */
function DetailCategories({
  detail,
  makeup,
  change,
  focusKey,
}: {
  detail: EnsoContextRequestDetail
  makeup: EnsoContextMakeup
  change: EnsoContextMakeup | undefined
  focusKey: string | undefined
}): React.ReactNode {
  return (
    <>
      <ul className="mt-3 grid grid-cols-1 gap-1.5 text-xs">
        {CONTEXT_CATEGORIES.map((category) => (
          <CategoryRow
            key={`${detail.request}-${category}`}
            category={category}
            elements={detail.elements.filter((element) => element.category === category)}
            makeup={makeup}
            change={change?.[category]}
            focusKey={focusKey}
          />
        ))}
      </ul>
      {detail.left.length === 0 ? null : (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {detail.left.length} left since the request before
          </summary>
          <ul className="mt-1 grid gap-0.5 pl-4">
            {detail.left.map((gone) => (
              <li key={gone.key} className="truncate">
                <span
                  aria-hidden="true"
                  className="mr-1 inline-block size-2 rounded-sm"
                  style={{ background: CATEGORY_COLOR[gone.category] }}
                />
                {gone.label}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
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
    (threadId: string): Promise<DetailOutcome> =>
      readThreadAnalysis(threadId, `context/${request}`, EnsoContextRequestDetail),
    [request],
  )
  const outcome = useReadOnUsage<DetailOutcome>(read, ANALYSIS_READING)
  const { makeup, before, change } = openedMakeup(requests, next, request)
  // The payload says which request it is; until the one asked for arrives, the last one shows.
  const detail = outcome.kind === 'read' && outcome.payload.request === request ? outcome.payload : undefined
  return (
    <Card
      title="Context Browser"
      aside={
        <OptionSelect
          label="the request to open"
          value={String(request)}
          options={requestOptions(requests)}
          onChange={(value: string) => onRequest(value === 'next' ? 'next' : Number(value))}
        />
      }
    >
      <p className="mb-2 text-xs">
        <b>{request === 'next' ? 'next request' : `turn ${request}`}</b>
        <span className="text-muted-foreground"> · estimated {estimateText(totalOf(makeup))}</span>
        {before === undefined ? null : <span className="text-muted-foreground"> · against the request before</span>}
      </p>
      <MakeupBar makeup={makeup} scale={totalOf(makeup)} label="the opened request's makeup, estimated" />
      <DetailStatus outcome={outcome} waiting={detail === undefined} />
      {detail === undefined ? null : (
        <DetailCategories
          detail={detail}
          makeup={makeup}
          change={change}
          focusKey={focus?.request === request ? focus.key : undefined}
        />
      )}
    </Card>
  )
}
