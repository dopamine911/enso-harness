import type { EnsoContextEvent, EnsoContextEventKind, EnsoFileOperation } from '@enso/core'
import {
  ArrowLeftRightIcon,
  CircleXIcon,
  EyeIcon,
  LayersIcon,
  PencilIcon,
  ScissorsIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SquarePlusIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ContextBrowserFocus, ContextBrowserRequest } from './context-browser.tsx'
import { estimateChangeText, timeText } from './context-parts.tsx'
import { cn } from './lib/utils.ts'
import { displayPath, operationsUpTo } from './thread-context-analysis.ts'
import { Card, KindFilters, KindLabel, ROW_BUTTON } from './view-parts.tsx'

/**
 * The Context view's side cards (#361 phase 4), in the design direction's row language —
 * dsh-context's Context Events (when and why the window changed) and File Activity (what pi's file
 * tools did, up to the trend's picked request). Each row names its kind with an icon and a word,
 * says what and when, and puts its figure at the end; each opens the Context Browser — an event at
 * the first request it reached, a file operation at its tool result.
 */

/** Where a card sends the reader: a request of the Context Browser, and an element in it. */
export type OpenInBrowser = (request: ContextBrowserRequest, focus?: ContextBrowserFocus) => void

/** The request a turn names, or the next one when the branch has none that far yet. */
const requestAt = (turn: number, requestCount: number): ContextBrowserRequest => (turn <= requestCount ? turn : 'next')

/** A row's two lines: what it is, then where and when — the design's `.row-main`. */
function RowMain({ title, detail }: { title: string; detail: string }): React.ReactNode {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <b className="truncate text-sm font-medium">{title}</b>
      <small className="truncate font-mono text-xs text-muted-foreground">{detail}</small>
    </span>
  )
}

/** A row's figures at its end — the design's `.row-end`. */
function RowEnd({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <span className="grid shrink-0 justify-items-end gap-0.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  )
}

// ── Context Events ─────────────────────────────────────────────────────────────────────────────

const EVENT_ICON: Readonly<Record<EnsoContextEventKind, React.ReactNode>> = {
  inject: <SquarePlusIcon aria-hidden="true" />,
  compact: <LayersIcon aria-hidden="true" />,
  prune: <ScissorsIcon aria-hidden="true" />,
  switch: <ArrowLeftRightIcon aria-hidden="true" />,
  mode: <SlidersHorizontalIcon aria-hidden="true" />,
}

/** A compaction or a prune reshapes the window: its word reads in the text colour, the rest muted. */
const RESHAPES: ReadonlySet<EnsoContextEventKind> = new Set(['compact', 'prune'])

/** An event's signed change to the estimate: growth in the text colour, a reclaim in the allowed colour. */
function EventChange({ tokens }: { tokens: number }): React.ReactNode {
  if (tokens === 0) return <span>{estimateChangeText(tokens)}</span>
  return <span className={tokens > 0 ? 'text-foreground' : 'text-ok'}>{estimateChangeText(tokens)}</span>
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
    <Card title="Context Events" sub="when and why the window changed">
      <KindFilters label="event kinds shown" icons={EVENT_ICON} count={countOf} hidden={hidden} setHidden={setHidden} />
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {events.length === 0
            ? 'nothing has changed the context but the conversation itself'
            : 'no event of the kinds shown'}
        </p>
      ) : (
        <ol className="-mx-2">
          {shown.map((event) => (
            <li key={event.key}>
              <button
                type="button"
                className={ROW_BUTTON}
                title="open the first request it reached"
                onClick={() => onOpen(requestAt(event.turn, requestCount))}
              >
                <KindLabel className={RESHAPES.has(event.kind) ? 'text-foreground' : ''}>
                  {EVENT_ICON[event.kind]}
                  {event.kind}
                </KindLabel>
                <RowMain
                  title={event.label}
                  detail={`${event.turn <= requestCount ? `reached request ${event.turn}` : 'reaches the next request'} · ${timeText(event.at)}`}
                />
                <RowEnd>
                  <EventChange tokens={event.tokens} />
                </RowEnd>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

// ── File Activity ──────────────────────────────────────────────────────────────────────────────

type FileKind = EnsoFileOperation['kind']

const FILE_ICON: Readonly<Record<FileKind, React.ReactNode>> = {
  read: <EyeIcon aria-hidden="true" />,
  write: <PencilIcon aria-hidden="true" />,
  search: <SearchIcon aria-hidden="true" />,
}

/** What an operation did, at its row's end: a write's footprint, a search's hits, a read's range. */
function Footprint({ operation }: { operation: EnsoFileOperation }): React.ReactNode {
  if (operation.kind === 'write') {
    return (
      <span>
        <span className="text-ok">+{operation.added}</span> <span className="text-refuse">−{operation.removed}</span>
      </span>
    )
  }
  if (operation.kind === 'search') return <span>{operation.hits === 1 ? '1 hit' : `${operation.hits} hits`}</span>
  if (operation.image) return <span>image</span>
  // A read's subject is its range as the call asked it (`lines 1-80`); none is the whole file.
  return <span>{operation.subject === '' ? 'whole file' : operation.subject}</span>
}

/** One operation's row; it opens its tool result in the browser, in the request after its turn. */
function OperationRow({
  operation,
  cwd,
  requestCount,
  onOpen,
}: {
  operation: EnsoFileOperation
  cwd: string | undefined
  requestCount: number
  onOpen: OpenInBrowser
}): React.ReactNode {
  const { resultKey } = operation
  const target = requestAt(operation.turn + 1, requestCount)
  const path = displayPath(operation.path, cwd)
  const name = path.slice(path.lastIndexOf('/') + 1) || path
  const pattern = operation.kind === 'search' && operation.subject !== '' ? ` · “${operation.subject}”` : ''
  return (
    <li>
      <button
        type="button"
        disabled={resultKey === undefined}
        className={ROW_BUTTON}
        title={resultKey === undefined ? 'its result has not landed' : 'open its tool result in the Context Browser'}
        onClick={() => {
          if (resultKey !== undefined) onOpen(target, { request: target, key: resultKey })
        }}
      >
        <KindLabel className={operation.isError ? 'text-refuse' : ''}>
          {operation.isError ? <CircleXIcon aria-hidden="true" /> : FILE_ICON[operation.kind]}
          {operation.isError ? 'failed' : operation.kind}
        </KindLabel>
        <RowMain title={name} detail={`${path}${pattern}`} />
        <RowEnd>
          <Footprint operation={operation} />
          <span>
            turn {operation.turn} · {operation.tool}
          </span>
        </RowEnd>
      </button>
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
  const [hidden, setHidden] = useState<ReadonlySet<FileKind>>(() => new Set())
  const [needle, setNeedle] = useState('')
  const upTo = operationsUpTo(operations, upToTurn)
  const countOf = (kind: FileKind): number => upTo.filter((operation) => operation.kind === kind).length
  const wanted = needle.trim().toLowerCase()
  const shown = upTo.filter(
    (operation) =>
      !hidden.has(operation.kind) && (wanted === '' || displayPath(operation.path, cwd).toLowerCase().includes(wanted)),
  )
  return (
    <Card
      title="File Activity"
      sub={`pi’s file tools; bash names no file · ${upToTurn === undefined ? 'every request' : `up to turn ${upToTurn}`}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KindFilters
          label="file operations shown"
          icons={FILE_ICON}
          count={countOf}
          hidden={hidden}
          setHidden={setHidden}
        />
        {upTo.length > 0 ? (
          <input
            type="search"
            aria-label="filter files by path"
            placeholder="filter by path…"
            className={cn('min-h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs')}
            value={needle}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNeedle(event.target.value)}
          />
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {operations.length === 0
            ? 'no file tool has run in this thread — read, write, edit, grep, find, ls'
            : 'no file operation of the kinds shown'}
        </p>
      ) : (
        <ol className="-mx-2">
          {shown.map((operation) => (
            <OperationRow
              key={operation.key}
              operation={operation}
              cwd={cwd}
              requestCount={requestCount}
              onOpen={onOpen}
            />
          ))}
        </ol>
      )}
    </Card>
  )
}
