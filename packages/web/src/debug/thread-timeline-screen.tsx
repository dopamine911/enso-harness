import {
  type EnsoEventProvenance,
  type EnsoLogLevelName,
  type EnsoLogLine,
  type EnsoLogTailFrame,
  type EnsoThreadEvent,
  EnsoThreadEvents,
  type EnsoTimelineEntry,
  threadEventColumns,
  threadTimeline,
  timelineJoinKeys,
} from '@enso/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from '../browser-logging.ts'
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '../components/ai-elements/terminal.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Spinner } from '../components/ui/spinner.tsx'
import { urlForThread } from '../thread-url.ts'
import { LogRow, ROW_HEIGHT_PX, timeOfDay } from './log-row.tsx'
import { DEFAULT_LOG_TAIL_FILTER, openLogTailStream } from './log-tail-connection.ts'
import {
  applyLogTailFrame,
  describeRecordCount,
  EMPTY_LOG_TAIL_VIEW,
  LogLevelSelect,
  type LogTailView,
  timelineUrlForThread,
} from './log-tail-screen.tsx'

/**
 * One thread's timeline (#144 slice 3): what the host emitted, what the server sent, and what
 * was logged, as ONE list ordered by time — on the debug page at `debug.html?thread=<id>`.
 *
 * ⚠ OBSERVATION, AND ONLY OBSERVATION, the rule the tail states and this page keeps: it reads
 * two things — `GET /api/threads/:id/events` and the log tail with the thread fixed — writes
 * nothing, makes no record, and offers no stop, abort, prompt or dialog. Nothing here POSTs.
 * The controls change what this reader is asking (the level) and when it asks again (refresh).
 *
 * THE JOIN IS NOT DONE HERE. `threadTimeline` in `@enso/core` is the one ordering of the three
 * inputs, node-free so this page could do it in the browser over two reads it already makes;
 * this file only renders what it returns. A row's source is `emitted` (the host's tail, tagged
 * `host`), `sent` (the wire's, tagged `wire`) or `log` (a record, rendered by the same
 * `LogRow` as the day's tail so a record reads identically on both pages).
 *
 * A RECORD LANDING IS THE SIGNAL THAT SOMETHING HAPPENED. The tails have no push: the events
 * route is fetched on mount, on the refresh button, and again after every log frame that
 * carries lines — the moment the thread did something, its tails are re-read. The route writes
 * no record (it is a read of memory), so re-fetching it puts nothing into the trace it is beside.
 *
 * ⚠ A 404 IS NOT AN ERROR HERE. A stored thread, or a server that restarted, has no live
 * session and so no tails; what remains of such a thread is its log, and the page says so in
 * its header line rather than raising an alert over a list that is exactly right. Any OTHER
 * failure of that route — a 5xx, a payload that misses its schema, a network fault — IS said,
 * verbatim, in an alert: a debugging surface never drops what it could not read.
 *
 * THE LIST IS VIRTUALIZED and AUTO-SCROLL STOPS WHEN THE READER SCROLLS UP, both for the tail's
 * reasons and by the tail's mechanism; a timeline that yanks a reader off the row they are
 * tracing is no better than a log viewer that does.
 */

const EVENTS_ROUTE_PREFIX = '/api/threads/'

/** Rows drawn beyond the viewport, so a fast scroll lands on content rather than on blanks. */
const ROW_OVERSCAN = 16
/**
 * How close to the bottom still counts as "at the newest record". A few pixels of slack: a
 * scroll container rounds, and a reader who is at the bottom has not asked to stop following.
 */
const PINNED_TO_NEWEST_SLACK_PX = 48
/** How much of a tool call id the join column shows. The whole id is the column's tooltip. */
const TOOL_CALL_ID_SHOWN_CHARACTERS = 12

/** The one sentence a thread with no live session gets — in the header line, not an alert. */
export const NO_LIVE_SESSION = 'no live session — the log is what remains'

/** What the events route answered, as the page holds it. */
type TailsState =
  /** Not yet asked, or asked and not yet answered for the first time. */
  | { readonly kind: 'pending' }
  /** The server holds a session for this thread and these are its tails. */
  | { readonly kind: 'live'; readonly events: EnsoThreadEvents }
  /** 404: no live session. The timeline is the log alone. */
  | { readonly kind: 'none' }

/** One answer of the events route, in the three ways it can go — a failure is words, never a throw. */
type EventsOutcome = Exclude<TailsState, { kind: 'pending' }> | { readonly kind: 'failed'; readonly problem: string }

/** The browser's own `fetch`, as a stable value: an inline closure would re-open the tail on every render. */
const browserFetch: FetchLike = (input: string, init?: RequestInit) => fetch(input, init)

/**
 * The tails, or why not. A non-2xx other than 404 is reported with its status and body
 * VERBATIM: the reader is debugging, and the body is the server's own words about what went
 * wrong. A payload that misses its schema is reported too — never quietly rendered as nothing.
 */
async function fetchThreadEvents(threadId: string, fetchImpl: FetchLike): Promise<EventsOutcome> {
  try {
    const response = await fetchImpl(`${EVENTS_ROUTE_PREFIX}${encodeURIComponent(threadId)}/events`)
    if (response.status === 404) return { kind: 'none' }
    if (!response.ok) return { kind: 'failed', problem: `${response.status} ${await response.text()}`.trim() }
    const payload: unknown = await response.json()
    if (!Check(EnsoThreadEvents, payload)) {
      return { kind: 'failed', problem: "the server's events payload did not match its schema" }
    }
    return { kind: 'live', events: payload }
  } catch (error) {
    return { kind: 'failed', problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Provenance → how the row reads it. Colour AND the word, never colour alone: the column's
 * text already says `dropped`, and the class only makes it the thing a scanning eye lands on.
 * `dropped` is the ordering bug the tails exist to show; `held`/`replayed` are the buffer at
 * work (#69) and worth a glance; `live` and `sent` are the ordinary case.
 */
const PROVENANCE_CLASS: Readonly<Record<EnsoEventProvenance, string>> = {
  live: 'w-24 shrink-0 text-muted-foreground',
  held: 'w-24 shrink-0 text-primary',
  replayed: 'w-24 shrink-0 text-primary',
  dropped: 'w-24 shrink-0 font-semibold text-destructive',
  sent: 'w-24 shrink-0 text-muted-foreground',
}

/** One event of either tail as a row: local clock, which tail, how it got there, what it was. */
function EventRow({ source, event }: { source: 'emitted' | 'sent'; event: EnsoThreadEvent }): React.ReactNode {
  const columns = threadEventColumns(event)
  return (
    <div
      className="flex items-center gap-2 px-4 font-mono text-xs"
      title={`${columns.provenance} ${columns.subject}`}
      style={{ height: ROW_HEIGHT_PX }}
    >
      <span className="shrink-0 text-muted-foreground tabular-nums">{timeOfDay(event.at)}</span>
      <span className="w-12 shrink-0 text-foreground">{source === 'emitted' ? 'host' : 'wire'}</span>
      <span className={PROVENANCE_CLASS[event.provenance]}>{columns.provenance}</span>
      <span className="min-w-0 flex-1 truncate">{columns.subject}</span>
    </div>
  )
}

/**
 * The join column beside a log row: `gen 2 · seq 17 · call_…`, each key present only when the
 * record carries it. Only a log row has these (the header of `thread-timeline.ts` says why),
 * so the column is the way a reader follows one generation down the list by eye.
 */
function joinKeysText(line: EnsoLogLine): { readonly shown: string; readonly full: string } {
  const keys = timelineJoinKeys(line)
  const shown: string[] = []
  const full: string[] = []
  if (keys.generation !== undefined) {
    shown.push(`gen ${keys.generation}`)
    full.push(`generation ${keys.generation}`)
  }
  if (keys.seq !== undefined) {
    shown.push(`seq ${keys.seq}`)
    full.push(`seq ${keys.seq}`)
  }
  if (keys.toolCallId !== undefined) {
    const clipped = keys.toolCallId.length > TOOL_CALL_ID_SHOWN_CHARACTERS
    shown.push(clipped ? `${keys.toolCallId.slice(0, TOOL_CALL_ID_SHOWN_CHARACTERS)}…` : keys.toolCallId)
    full.push(`toolCallId ${keys.toolCallId}`)
  }
  return { shown: shown.join(' · '), full: full.join(' · ') }
}

/** A log record as the tail renders it, with the join column after it. */
function LogEntryRow({
  line,
  threadHref,
}: {
  line: EnsoLogLine
  threadHref: (threadId: string) => string
}): React.ReactNode {
  const joins = joinKeysText(line)
  return (
    <div className="flex items-center" style={{ height: ROW_HEIGHT_PX }}>
      <div className="min-w-0 flex-1">
        <LogRow line={line} threadHref={threadHref} />
      </div>
      {joins.shown === '' ? null : (
        <span className="shrink-0 pr-4 font-mono text-muted-foreground text-xs" title={joins.full}>
          {joins.shown}
        </span>
      )}
    </div>
  )
}

/** One row of the timeline, by its source. */
function TimelineRow({
  timelineEntry,
  threadHref,
}: {
  timelineEntry: EnsoTimelineEntry
  threadHref: (threadId: string) => string
}): React.ReactNode {
  if (timelineEntry.source === 'log') return <LogEntryRow line={timelineEntry.line} threadHref={threadHref} />
  return <EventRow source={timelineEntry.source} event={timelineEntry.event} />
}

/** The chat page's URL for a thread (#142) — `thread-url.ts` spells the parameter, this page only asks. */
function chatUrlForThread(threadId: string): string {
  return `/${urlForThread('', threadId)}`
}

/**
 * The header line, in words: which thread, how many rows, from where — the log count under
 * the tail's cap honesty — and, when the server holds no session, that this is the log alone.
 */
function describeTimeline(threadId: string, rows: number, tails: TailsState, view: LogTailView): string {
  const events = tails.kind === 'live' ? tails.events : undefined
  const logCount = view.opened ? describeRecordCount(view) : 'waiting for the first frame'
  const summary =
    `thread ${threadId} · ${rows} rows · host ${events?.emitted.length ?? 0} · wire ${events?.sent.length ?? 0}` +
    ` · log ${logCount}`
  return tails.kind === 'none' ? `${summary} · ${NO_LIVE_SESSION}` : summary
}

export interface ThreadTimelineScreenProps {
  readonly threadId: string
  /** Test seam (#118's convention) — the browser's own otherwise. */
  readonly fetch?: FetchLike
}

/** The page. */
export function ThreadTimelineScreen({ threadId, fetch: pageFetch }: ThreadTimelineScreenProps): React.ReactNode {
  const fetchImpl = pageFetch ?? browserFetch
  const [level, setLevel] = useState<EnsoLogLevelName>(DEFAULT_LOG_TAIL_FILTER.level)
  const [view, setView] = useState<LogTailView>(EMPTY_LOG_TAIL_VIEW)
  const [tails, setTails] = useState<TailsState>({ kind: 'pending' })
  const [tailsProblem, setTailsProblem] = useState<string | undefined>(undefined)
  const [logProblem, setLogProblem] = useState<string | undefined>(undefined)
  const [pinnedToNewest, setPinnedToNewest] = useState(true)
  const scrollElement = useRef<HTMLDivElement>(null)
  /**
   * The byte the next connection continues from. A REF, not state: it changes on every frame
   * and nothing renders it, and as state it would re-open the connection it came from.
   */
  const resumeFrom = useRef<number | undefined>(undefined)
  /**
   * Only the LATEST request's outcome may be applied: a refresh fired by a frame can overtake
   * the one the button fired, and the older answer must not land on top of the newer one.
   * Bumped on unmount too, so an answer that arrives after the page has gone sets nothing.
   */
  const latestRequest = useRef(0)

  const refreshEvents = useCallback(async (): Promise<void> => {
    latestRequest.current += 1
    const ticket = latestRequest.current
    const outcome = await fetchThreadEvents(threadId, fetchImpl)
    if (ticket !== latestRequest.current) return
    if (outcome.kind === 'failed') {
      setTailsProblem(outcome.problem)
      return
    }
    setTailsProblem(undefined)
    setTails(outcome)
  }, [threadId, fetchImpl])

  useEffect(() => {
    void refreshEvents()
    return () => {
      latestRequest.current += 1
    }
  }, [refreshEvents])

  useEffect(() => {
    const controller = new AbortController()
    void openLogTailStream({
      filter: { level, thread: threadId, process: '', since: '' },
      from: resumeFrom.current,
      fetch: fetchImpl,
      signal: controller.signal,
      onFrame: (frame: EnsoLogTailFrame) => {
        resumeFrom.current = frame.offset
        setView((current: LogTailView) => applyLogTailFrame(current, frame))
        if (frame.lines.length > 0) void refreshEvents()
      },
      onError: setLogProblem,
    })
    return () => controller.abort()
  }, [level, threadId, fetchImpl, refreshEvents])

  const changeLevel = useCallback((next: EnsoLogLevelName): void => {
    // A new question is a new answer: forget the byte this view was resumed from, so the
    // re-opened connection reads the day's head and its first frame replaces the list.
    resumeFrom.current = undefined
    setView(EMPTY_LOG_TAIL_VIEW)
    setLogProblem(undefined)
    setPinnedToNewest(true)
    setLevel(next)
  }, [])

  const entries = useMemo(
    () => threadTimeline(tails.kind === 'live' ? tails.events : undefined, view.lines),
    [tails, view.lines],
  )

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: ROW_OVERSCAN,
  })

  const handleScroll = useCallback((): void => {
    const element = scrollElement.current
    if (element === null) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    setPinnedToNewest(distanceFromBottom <= PINNED_TO_NEWEST_SLACK_PX)
  }, [])

  const newestRow = entries.length - 1
  useEffect(() => {
    if (!pinnedToNewest || newestRow < 0) return
    virtualizer.scrollToIndex(newestRow)
  }, [pinnedToNewest, newestRow, virtualizer])

  const rows = virtualizer.getVirtualItems()
  const heading = useMemo(
    () => describeTimeline(threadId, entries.length, tails, view),
    [threadId, entries.length, tails, view],
  )

  return (
    <Terminal className="h-dvh" isStreaming={!view.opened || tails.kind === 'pending'}>
      <TerminalHeader>
        <TerminalTitle>enso · thread</TerminalTitle>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-muted-foreground text-xs" htmlFor="thread-timeline-level">
            <span>level</span>
            <LogLevelSelect controlId="thread-timeline-level" level={level} onLevel={changeLevel} />
          </label>
          <Button variant="outline" size="sm" onClick={() => void refreshEvents()}>
            refresh
          </Button>
        </div>
        <TerminalActions>
          <a className="px-2 text-primary text-xs underline-offset-2 hover:underline" href={chatUrlForThread(threadId)}>
            open in chat
          </a>
          <a className="px-2 text-primary text-xs underline-offset-2 hover:underline" href="/debug">
            the day's log
          </a>
          <a className="px-2 text-primary text-xs underline-offset-2 hover:underline" href="/debug?stats">
            the day's stats
          </a>
          <TerminalStatus>
            <Spinner />
          </TerminalStatus>
        </TerminalActions>
      </TerminalHeader>
      <div className="flex items-center gap-3 border-b px-4 py-1 font-mono text-muted-foreground text-xs">
        <span>{heading}</span>
        {pinnedToNewest ? null : <span>paused at your scroll position — scroll to the bottom to follow again</span>}
      </div>
      {tailsProblem === undefined ? null : (
        <div className="px-4 pt-1">
          <Alert variant="destructive">
            <AlertTitle>the tails</AlertTitle>
            <AlertDescription>{tailsProblem}</AlertDescription>
          </Alert>
        </div>
      )}
      {logProblem === undefined ? null : (
        <div className="px-4 pt-1">
          <Alert variant="destructive">
            <AlertTitle>the tail</AlertTitle>
            <AlertDescription>{logProblem}</AlertDescription>
          </Alert>
        </div>
      )}
      <TerminalContent
        ref={scrollElement}
        onScroll={handleScroll}
        // `log` is the role for a live, append-ordered record view — the same reasoning the
        // tail gives; the name says which list this is when both pages are open.
        role="log"
        aria-label="thread timeline"
        className="text-xs"
      >
        <ol style={{ position: 'relative', height: virtualizer.getTotalSize(), width: '100%' }}>
          {rows.map((row) => {
            const timelineEntry = entries[row.index]
            if (timelineEntry === undefined) return null
            return (
              <li
                key={row.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <TimelineRow timelineEntry={timelineEntry} threadHref={timelineUrlForThread} />
              </li>
            )
          })}
        </ol>
      </TerminalContent>
    </Terminal>
  )
}
