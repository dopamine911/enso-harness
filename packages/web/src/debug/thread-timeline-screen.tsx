import {
  type EnsoEventProvenance,
  type EnsoLogLevelName,
  type EnsoLogLine,
  type EnsoThreadEvent,
  EnsoThreadEvents,
  type EnsoTimelineEntry,
  threadEventColumns,
  threadTimeline,
  timelineJoinKeys,
} from '@enso/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FetchLike } from '../browser-logging.ts'
import {
  Terminal,
  TerminalActions,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '../components/ai-elements/terminal.tsx'
import { Button } from '../components/ui/button.tsx'
import { Spinner } from '../components/ui/spinner.tsx'
import { readSchemaRoute } from '../route-read.ts'
import { urlForThread } from '../thread-url.ts'
import { LogRow, ROW_HEIGHT_PX, timeOfDay } from './log-row.tsx'
import { DEFAULT_LOG_TAIL_FILTER, type LogTailFilter } from './log-tail-connection.ts'
import { bundleUrl, LogLevelSelect, timelineUrlForThread } from './log-tail-screen.tsx'
import {
  ActionLink,
  describeRecordCount,
  type LogTailView,
  PinnedTail,
  ProblemAlert,
  useLogTailStream,
} from './log-tail-view.tsx'

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
 * THE LIST IS VIRTUALIZED and AUTO-SCROLL STOPS WHEN THE READER SCROLLS UP — the same
 * `PinnedTail` the day's log renders (`log-tail-view.tsx`), so the two pages cannot drift apart
 * on either rule; a timeline that yanks a reader off the row they are tracing is no better
 * than a log viewer that does.
 */

const EVENTS_ROUTE_PREFIX = '/api/threads/'

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
  /** The route could not be read — the alert says why. Not pending: nothing is being waited for. */
  | { readonly kind: 'unread' }

/** One answer of the events route, in the three ways it can go — a failure is words, never a throw. */
type EventsOutcome = Exclude<TailsState, { kind: 'pending' }> | { readonly kind: 'failed'; readonly problem: string }

/** The browser's own `fetch`, as a stable value: an inline closure would re-open the tail on every render. */
const browserFetch: FetchLike = (input: string, init?: RequestInit) => fetch(input, init)

/** The tails, or why not — the read itself, and what each failure says, is `route-read.ts`'s. */
async function fetchThreadEvents(threadId: string, fetchImpl: FetchLike): Promise<EventsOutcome> {
  const read = await readSchemaRoute(
    `${EVENTS_ROUTE_PREFIX}${encodeURIComponent(threadId)}/events`,
    EnsoThreadEvents,
    'events',
    fetchImpl,
  )
  if (read.kind === 'absent') return { kind: 'none' }
  if (read.kind === 'failed') return read
  return { kind: 'live', events: read.payload }
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

/** The log half of the header: the count under the cap's honesty, a wait, or — after a refusal — neither. */
function describeLogSide(view: LogTailView, logSettled: boolean): string {
  if (view.opened) return describeRecordCount(view)
  // A refused log connection is not a wait (PR #336 review, round two: the spinner stopped
  // but the heading still said "waiting" beside the alert that refused it).
  return logSettled ? 'nothing is being read' : 'waiting for the first frame'
}

/**
 * The header line, in words: which thread, how many rows, from where — the log side as
 * `describeLogSide` says it — and, when the server holds no session, that this is the log alone.
 */
function describeTimeline(threadId: string, rows: number, tails: TailsState, logSide: string): string {
  const events = tails.kind === 'live' ? tails.events : undefined
  const summary =
    `thread ${threadId} · ${rows} rows · host ${events?.emitted.length ?? 0} · wire ${events?.sent.length ?? 0}` +
    ` · log ${logSide}`
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
  const [tails, setTails] = useState<TailsState>({ kind: 'pending' })
  const [tailsProblem, setTailsProblem] = useState<string | undefined>(undefined)
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
      // A failed read is an answer too: the tails are not pending, they are absent for now.
      setTails((current: TailsState) => (current.kind === 'pending' ? { kind: 'unread' } : current))
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

  // A record landing is the signal the thread did something: re-read its tails then.
  const onRecords = useCallback((): void => void refreshEvents(), [refreshEvents])
  const filter = useMemo((): LogTailFilter => ({ level, thread: threadId, process: '', since: '' }), [level, threadId])
  const log = useLogTailStream({ filter, enabled: true, fetch: fetchImpl, onRecords })
  const { restart } = log

  const changeLevel = useCallback(
    (next: EnsoLogLevelName): void => {
      restart()
      setLevel(next)
    },
    [restart],
  )

  const entries = useMemo(
    () => threadTimeline(tails.kind === 'live' ? tails.events : undefined, log.view.lines),
    [tails, log.view.lines],
  )
  const heading = useMemo(
    () => describeTimeline(threadId, entries.length, tails, describeLogSide(log.view, log.settled)),
    [threadId, entries.length, tails, log.view, log.settled],
  )

  return (
    <Terminal className="h-dvh" isStreaming={!(log.view.opened || log.settled) || tails.kind === 'pending'}>
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
          <ActionLink href={chatUrlForThread(threadId)}>open in chat</ActionLink>
          <ActionLink href="/debug">the day's log</ActionLink>
          <ActionLink href={bundleUrl(threadId)} download>
            download this thread's bundle
          </ActionLink>
          <ActionLink href="/debug?stats">the day's stats</ActionLink>
          <TerminalStatus>
            <Spinner />
          </TerminalStatus>
        </TerminalActions>
      </TerminalHeader>
      <PinnedTail
        // A new level is a new question: it starts pinned to the newest row again (`PinnedTail`).
        key={level}
        items={entries}
        heading={heading}
        label="thread timeline"
        notices={
          <>
            <ProblemAlert title="the tails" problem={tailsProblem} />
            <ProblemAlert title="the tail" problem={log.problem} />
          </>
        }
        renderItem={(timelineEntry: EnsoTimelineEntry) => (
          <TimelineRow timelineEntry={timelineEntry} threadHref={timelineUrlForThread} />
        )}
      />
    </Terminal>
  )
}
