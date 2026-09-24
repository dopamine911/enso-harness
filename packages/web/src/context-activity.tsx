import type { EnsoContextEvent, EnsoContextEventKind, EnsoFileOperation } from '@enso/core'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { ContextBrowserFocus, ContextBrowserRequest } from './context-browser.tsx'
import { Card, Choice, changeText, timeText } from './context-parts.tsx'
import { OptionSelect } from './option-select.tsx'
import { displayPath, type FileSummary, filesUpTo } from './thread-context-analysis.ts'
import { toggleMember } from './toggle-member.ts'

/**
 * The Context view's last two cards (#361 phase 4) — dsh-context's Context Events (when and why
 * the window changed) and File Activity (what the agent did to files, up to the trend's picked
 * request). Both lead into the Context Browser: an event opens the first request it reached, a
 * file operation opens its tool result there.
 */

/** Where a card sends the reader: a request of the Context Browser, and an element in it. */
export type OpenInBrowser = (request: ContextBrowserRequest, focus?: ContextBrowserFocus) => void

/** The request a turn names, or the next one when the branch has none that far yet. */
const requestAt = (turn: number, requestCount: number): ContextBrowserRequest => (turn <= requestCount ? turn : 'next')

// ── Context Events ─────────────────────────────────────────────────────────────────────────────

const EVENT_KINDS: ReadonlyArray<readonly [EnsoContextEventKind, string]> = [
  ['inject', 'inject'],
  ['compact', 'compact'],
  ['prune', 'prune'],
  ['switch', 'switch'],
  ['mode', 'mode'],
]

/** A signed estimate as the card colours it: growth warm, a reclaim cool — dsh's +orange / −green. */
function DeltaText({ tokens }: { tokens: number }): React.ReactNode {
  if (tokens === 0) return null
  return (
    <span className={`font-mono tabular-nums ${tokens > 0 ? 'text-[var(--chart-6)]' : 'text-[var(--chart-2)]'}`}>
      {changeText(tokens)}
    </span>
  )
}

export function ContextEvents({
  events,
  requestCount,
  onOpen,
}: {
  events: readonly EnsoContextEvent[]
  requestCount: number
  onOpen: OpenInBrowser
}): React.ReactNode {
  const [hidden, setHidden] = useState<ReadonlySet<EnsoContextEventKind>>(() => new Set())
  const shown = [...events].reverse().filter((event) => !hidden.has(event.kind))
  const countOf = (kind: EnsoContextEventKind): number => events.filter((event) => event.kind === kind).length
  return (
    <Card
      title="Context Events"
      aside={
        <fieldset aria-label="event kinds shown" className="inline-flex gap-1">
          {EVENT_KINDS.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              aria-pressed={!hidden.has(kind)}
              className={`rounded px-1.5 py-0.5 ${hidden.has(kind) ? 'text-muted-foreground line-through' : 'bg-muted text-foreground'}`}
              onClick={() => setHidden((current) => toggleMember(current, kind))}
            >
              {label} {countOf(kind)}
            </button>
          ))}
        </fieldset>
      }
    >
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {events.length === 0
            ? 'nothing has changed the context but the conversation itself'
            : 'no event of the kinds shown'}
        </p>
      ) : (
        <ol className="grid grid-cols-1 gap-0.5 text-xs">
          {shown.map((event) => (
            <li key={event.key}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/50"
                title="open the first request it reached"
                onClick={() => onOpen(requestAt(event.turn, requestCount))}
              >
                <span className="w-14 shrink-0 rounded bg-muted px-1 text-center">{event.kind}</span>
                <span className="min-w-0 flex-1 truncate">{event.label}</span>
                <span className="text-muted-foreground">
                  {event.turn <= requestCount ? `turn ${event.turn}` : 'next request'}
                </span>
                <DeltaText tokens={event.tokens} />
                <span className="text-muted-foreground">{timeText(event.at)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

// ── File Activity ──────────────────────────────────────────────────────────────────────────────

type FileFilter = 'all' | 'read' | 'written' | 'searched' | 'images'
type FileOrder = 'active' | 'latest' | 'path'

const FILE_ORDERS: ReadonlyArray<readonly [FileOrder, string]> = [
  ['active', 'most active'],
  ['latest', 'latest'],
  ['path', 'by path'],
]

const MATCHES_FILTER: Readonly<Record<FileFilter, (summary: FileSummary) => boolean>> = {
  all: () => true,
  read: (summary: FileSummary): boolean => summary.reads > 0,
  written: (summary: FileSummary): boolean => summary.writes > 0,
  searched: (summary: FileSummary): boolean => summary.searches > 0,
  images: (summary: FileSummary): boolean => summary.images > 0,
}

function sortedFiles(files: readonly FileSummary[], order: FileOrder): FileSummary[] {
  const activity = (summary: FileSummary): number => summary.operations.length
  if (order === 'path') return [...files].sort((first, second) => first.path.localeCompare(second.path))
  if (order === 'latest') return [...files].sort((first, second) => second.lastAt.localeCompare(first.lastAt))
  return [...files].sort(
    (first, second) => activity(second) - activity(first) || second.lastAt.localeCompare(first.lastAt),
  )
}

/** A path's directory muted and its name bold, as dsh draws it. */
function PathText({ path }: { path: string }): React.ReactNode {
  const slash = path.lastIndexOf('/')
  return (
    <span className="min-w-0 flex-1 truncate font-mono">
      <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>
      <b className="font-semibold">{path.slice(slash + 1)}</b>
    </span>
  )
}

interface OperationRowProps {
  readonly operation: EnsoFileOperation
  readonly requestCount: number
  readonly onOpen: OpenInBrowser
}

/** One operation's line in an opened file row; it opens its tool result in the browser. */
function OperationRow(props: OperationRowProps): React.ReactNode {
  const { operation, requestCount, onOpen } = props
  const { resultKey } = operation
  const target = requestAt(operation.turn + 1, requestCount)
  return (
    <li>
      <button
        type="button"
        disabled={resultKey === undefined}
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/50 disabled:opacity-60"
        title={resultKey === undefined ? 'its result has not landed' : 'open its tool result in the Context Browser'}
        onClick={() => {
          if (resultKey !== undefined) onOpen(target, { request: target, key: resultKey })
        }}
      >
        <span className="w-14 shrink-0">{operation.kind}</span>
        <span className="font-mono text-muted-foreground">{operation.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{operation.subject}</span>
        {operation.kind === 'write' ? (
          <span className="font-mono tabular-nums">
            +{operation.added} −{operation.removed}
          </span>
        ) : null}
        {operation.hits > 0 ? <span className="font-mono tabular-nums">{operation.hits} hits</span> : null}
        {operation.isError ? <span className="text-destructive">error</span> : null}
        <span className="text-muted-foreground">turn {operation.turn}</span>
        <span className="text-muted-foreground">{timeText(operation.at)}</span>
      </button>
    </li>
  )
}

function FileRow({
  summary,
  cwd,
  requestCount,
  onOpen,
}: {
  summary: FileSummary
  cwd: string | undefined
  requestCount: number
  onOpen: OpenInBrowser
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <li className="border-t first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-1 py-1 text-left hover:bg-muted/50"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {open ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
        <PathText path={displayPath(summary.path, cwd)} />
        {summary.reads > 0 ? <span className="rounded bg-muted px-1 font-mono">read {summary.reads}</span> : null}
        {summary.writes > 0 ? (
          <span className="rounded bg-muted px-1 font-mono text-[var(--chart-2)]">
            +{summary.added} −{summary.removed}
          </span>
        ) : null}
        {summary.searches > 0 ? (
          <span className="rounded bg-muted px-1 font-mono text-[var(--chart-3)]">searched {summary.searches}</span>
        ) : null}
        <span className="text-muted-foreground">{timeText(summary.lastAt)}</span>
      </button>
      {open ? (
        <ol className="pb-1 pl-6">
          {summary.operations.map((operation) => (
            <OperationRow key={operation.key} operation={operation} requestCount={requestCount} onOpen={onOpen} />
          ))}
        </ol>
      ) : null}
    </li>
  )
}

export function FileActivity({
  operations,
  upToTurn,
  cwd,
  requestCount,
  onOpen,
}: {
  operations: readonly EnsoFileOperation[]
  /** The trend's picked request; every operation when none is picked. */
  upToTurn: number | undefined
  cwd: string | undefined
  requestCount: number
  onOpen: OpenInBrowser
}): React.ReactNode {
  const [filter, setFilter] = useState<FileFilter>('all')
  const [order, setOrder] = useState<FileOrder>('active')
  const [needle, setNeedle] = useState('')
  const files = filesUpTo(operations, upToTurn)
  const counted = (kind: FileFilter): number => files.filter(MATCHES_FILTER[kind]).length
  const shown = sortedFiles(
    files.filter(
      (summary) =>
        MATCHES_FILTER[filter](summary) &&
        displayPath(summary.path, cwd).toLowerCase().includes(needle.trim().toLowerCase()),
    ),
    order,
  )
  const filters: ReadonlyArray<readonly [FileFilter, string]> = [
    ['all', `all ${counted('all')}`],
    ['read', `read ${counted('read')}`],
    ['written', `written ${counted('written')}`],
    ['searched', `searched ${counted('searched')}`],
    ['images', `images ${counted('images')}`],
  ]
  return (
    <Card
      title="File Activity"
      aside={
        upToTurn === undefined
          ? 'every request · follows the trend’s pick'
          : `up to turn ${upToTurn} · follows the trend’s pick`
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Choice label="files shown" value={filter} options={filters} onChange={setFilter} />
        <input
          type="search"
          aria-label="filter files by path"
          placeholder="filter by path…"
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-0.5"
          value={needle}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNeedle(event.target.value)}
        />
        <OptionSelect label="order files" value={order} options={FILE_ORDERS} onChange={setOrder} />
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {operations.length === 0
            ? 'no file tool has run in this thread — read, write, edit, grep, find, ls'
            : 'no file matches'}
        </p>
      ) : (
        <ul className="text-xs">
          {shown.map((summary) => (
            <FileRow key={summary.path} summary={summary} cwd={cwd} requestCount={requestCount} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </Card>
  )
}
