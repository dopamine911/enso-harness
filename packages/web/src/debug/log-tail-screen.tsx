import { ENSO_LOG_LEVEL_NAMES, type EnsoLogLevelName, type EnsoLogLine, type EnsoLogTailFrame } from '@enso/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Input } from '../components/ui/input.tsx'
import { Spinner } from '../components/ui/spinner.tsx'
import { urlForThread } from '../thread-url.ts'
import { LogRow, ROW_HEIGHT_PX } from './log-row.tsx'
import { DEFAULT_LOG_TAIL_FILTER, type LogTailFilter, openLogTailStream } from './log-tail-connection.ts'

/**
 * The debug log page (#144 slice 2): the day's records, as the file has them, in a browser.
 *
 * ⚠ OBSERVATION, AND ONLY OBSERVATION. A debugging surface reads, writes nothing, makes no
 * records and offers no control — so there is no stop, no abort, no prompt and no dialog on
 * this page, and nothing on it POSTs. The two controls that exist change what this reader is
 * ASKING (the filter) and whether this page is still listening (follow/pause); neither reaches
 * the server's behaviour. `bun run logs` is the same question at a terminal; this is the same
 * question with thread ids that are links.
 *
 * THE FILTER IS THE QUESTION, so changing it starts the answer over: the connection re-opens
 * at the day's head and the first frame REPLACES the list. Appending one question's records to
 * another's would produce a list that answers neither.
 *
 * THE LIST IS VIRTUALIZED (`@tanstack/react-virtual`). A `trace` day is tens of thousands of
 * records; the server caps what it sends and this draws only the rows on screen, so the page
 * that exists to diagnose a slow system is not the slow thing in it.
 *
 * ⚠ AUTO-SCROLL STOPS WHEN THE READER SCROLLS UP, and that is the rule rather than a nicety: a
 * log viewer that yanks you back to the newest row while you are reading an older one is
 * useless for the only thing it is for. The view follows the newest record while it is pinned
 * to the bottom, and the moment a reader scrolls away from the bottom it stays where they put
 * it until they come back.
 *
 * A THREAD ID HERE DRILLS DOWN, IT DOES NOT LEAVE. Within the observation surface a thread id
 * leads to that thread's timeline on this same page (`/debug?thread=<id>`, #144 slice 3) —
 * the tail is the day, the timeline is one thread of it, and a reader narrows without changing
 * surfaces. Leaving the surface for the chat page is ONE deliberate link, in the timeline's
 * header, so no row on the observation surface is a click away from the surface that prompts
 * pi. The row itself renders one way on both pages (`log-row.tsx`); only where its id leads
 * differs.
 */

/** Rows drawn beyond the viewport, so a fast scroll lands on content rather than on blanks. */
const ROW_OVERSCAN = 16
/**
 * How close to the bottom still counts as "at the newest record". A few pixels of slack: a
 * scroll container rounds, and a reader who is at the bottom has not asked to stop following.
 */
const PINNED_TO_NEWEST_SLACK_PX = 48

/** The writers that appear in the file, as the placeholder offers them — not a closed list. */
const PROCESS_PLACEHOLDER = 'server, web, pi, browser'

/** What a tail-fed page is currently showing, as the frames have built it. */
export interface LogTailView {
  /** The local day the file under the tail is named for; empty before the first frame. */
  readonly day: string
  readonly lines: readonly EnsoLogLine[]
  /** How many records matched the question, cap included — `matched > lines.length` is the cap. */
  readonly matched: number
  readonly malformed: number
  /** Whether any frame has arrived: "nothing yet" and "nothing matched" are different answers. */
  readonly opened: boolean
}

export const EMPTY_LOG_TAIL_VIEW: LogTailView = { day: '', lines: [], matched: 0, malformed: 0, opened: false }

/**
 * The view one frame later. `backlog` REPLACES — it is the file as it stands, and it arrives
 * again when the local-midnight rotation puts a new day under the tail. `records` APPENDS, and
 * its counts add: a capped backlog of 1000 out of 5000 that then grows by 3 is honestly "the
 * last 1003 of 5003".
 */
export function applyLogTailFrame(view: LogTailView, frame: EnsoLogTailFrame): LogTailView {
  if (frame.type === 'backlog') {
    return { day: frame.day, lines: frame.lines, matched: frame.matched, malformed: frame.malformed, opened: true }
  }
  return {
    day: frame.day,
    lines: [...view.lines, ...frame.lines],
    matched: view.matched + frame.matched,
    malformed: view.malformed + frame.malformed,
    opened: true,
  }
}

/**
 * How many records are on screen, in words — and, when the server capped the read, that this
 * is the END of a longer day rather than the whole of a short one. The same honesty the
 * bundle states, because a count that silently means "some of" is a lie a debugging surface
 * cannot afford. Shared with the timeline, whose log count is under the same cap.
 */
export function describeRecordCount(view: LogTailView): string {
  const shown = view.lines.length
  const counted = view.matched > shown ? `the last ${shown} of ${view.matched} records` : `${shown} records`
  const malformed = view.malformed > 0 ? ` · ${view.malformed} malformed lines — read the file` : ''
  return `${counted}${malformed}`
}

/** What is on screen, in words: the day, then the count. */
function describeView(view: LogTailView): string {
  if (!view.opened) return 'waiting for the first frame'
  return `${view.day} · ${describeRecordCount(view)}`
}

/**
 * This page's own URL for a thread's timeline (#144 slice 3). Built by `thread-url.ts`'s
 * helper rather than by concatenating `?thread=`, so the file that OWNS the query parameter
 * is the only one that spells it — and an empty search is passed on purpose: the tail's own
 * query (`?log=debug`) is not the timeline's question. The timeline uses it too: a thread id
 * in a timeline row is the same drill-down, to the same place.
 */
export function timelineUrlForThread(threadId: string): string {
  return `/debug${urlForThread('', threadId)}`
}

export interface LogLevelSelectProps {
  /** The control's `id`, so the page's `<label>` can point at it. */
  readonly controlId: string
  readonly level: EnsoLogLevelName
  readonly onLevel: (level: EnsoLogLevelName) => void
}

/**
 * The level, as a control. Native `<select>` for the closed vocabulary — the same reasoning
 * the permission-mode control gives: keyboard- and screen-reader-complete without a
 * dependency. Shared with the timeline: one question, one control.
 */
export function LogLevelSelect({ controlId, level, onLevel }: LogLevelSelectProps): React.ReactNode {
  return (
    <select
      id={controlId}
      className="rounded-md border bg-background px-1.5 py-0.5 text-foreground text-xs"
      value={level}
      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
        const chosen = ENSO_LOG_LEVEL_NAMES.find((levelName) => levelName === event.target.value)
        if (chosen !== undefined) onLevel(chosen)
      }}
    >
      {ENSO_LOG_LEVEL_NAMES.map((levelName) => (
        <option key={levelName} value={levelName}>
          {levelName}
        </option>
      ))}
    </select>
  )
}

interface LogTailControlsProps {
  readonly filter: LogTailFilter
  readonly following: boolean
  readonly onFilter: (change: Partial<LogTailFilter>) => void
  readonly onFollowing: (following: boolean) => void
}

/**
 * The question, as controls. A text input for the open vocabularies — the same reasoning the
 * level select gives.
 *
 * ⓘ `process` is a TEXT field, not a select over `server`/`web`/`pi`: shipped browser records
 * are written as a fourth writer, and a control that cannot name a writer the file contains
 * would hide records that exist.
 */
function LogTailControls({ filter, following, onFilter, onFollowing }: LogTailControlsProps): React.ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-muted-foreground text-xs" htmlFor="log-tail-level">
        <span>level</span>
        <LogLevelSelect
          controlId="log-tail-level"
          level={filter.level}
          onLevel={(level: EnsoLogLevelName) => onFilter({ level })}
        />
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground text-xs" htmlFor="log-tail-thread">
        <span>thread</span>
        <Input
          id="log-tail-thread"
          className="w-44"
          placeholder="an id, or a prefix"
          value={filter.thread}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onFilter({ thread: event.target.value })}
        />
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground text-xs" htmlFor="log-tail-process">
        <span>process</span>
        <Input
          id="log-tail-process"
          className="w-44"
          placeholder={PROCESS_PLACEHOLDER}
          value={filter.process}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onFilter({ process: event.target.value })}
        />
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground text-xs" htmlFor="log-tail-since">
        <span>since</span>
        <Input
          id="log-tail-since"
          className="w-44"
          placeholder="30s, 10m, 2h, 1d"
          value={filter.since}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onFilter({ since: event.target.value })}
        />
      </label>
      <Button variant="outline" size="sm" onClick={() => onFollowing(!following)}>
        {following ? 'pause' : 'follow'}
      </Button>
    </div>
  )
}

/**
 * The page. `fetch` is the test seam (#118's convention) — the browser's own otherwise.
 */
export function LogTailScreen({ fetch: pageFetch }: { fetch?: FetchLike } = {}): React.ReactNode {
  const [filter, setFilter] = useState<LogTailFilter>(DEFAULT_LOG_TAIL_FILTER)
  const [following, setFollowing] = useState(true)
  const [view, setView] = useState<LogTailView>(EMPTY_LOG_TAIL_VIEW)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [pinnedToNewest, setPinnedToNewest] = useState(true)
  const scrollElement = useRef<HTMLDivElement>(null)
  /**
   * The byte the next connection continues from. A REF, not state: it changes on every frame
   * and nothing renders it, and as state it would re-open the connection it came from.
   */
  const resumeFrom = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!following) return undefined
    const controller = new AbortController()
    void openLogTailStream({
      filter,
      from: resumeFrom.current,
      fetch: pageFetch,
      signal: controller.signal,
      onFrame: (frame: EnsoLogTailFrame) => {
        resumeFrom.current = frame.offset
        setView((current: LogTailView) => applyLogTailFrame(current, frame))
      },
      onError: setProblem,
    })
    return () => controller.abort()
  }, [filter, following, pageFetch])

  const changeFilter = useCallback((change: Partial<LogTailFilter>): void => {
    // A new question is a new answer: forget the byte this view was resumed from, so the
    // re-opened connection reads the day's head and its first frame replaces the list.
    resumeFrom.current = undefined
    setView(EMPTY_LOG_TAIL_VIEW)
    setProblem(undefined)
    setPinnedToNewest(true)
    setFilter((current: LogTailFilter) => ({ ...current, ...change }))
  }, [])

  const virtualizer = useVirtualizer({
    count: view.lines.length,
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

  const newestRow = view.lines.length - 1
  useEffect(() => {
    if (!pinnedToNewest || newestRow < 0) return
    virtualizer.scrollToIndex(newestRow)
  }, [pinnedToNewest, newestRow, virtualizer])

  const rows = virtualizer.getVirtualItems()
  const heading = useMemo(() => describeView(view), [view])

  return (
    <Terminal className="h-dvh" isStreaming={following && !view.opened}>
      <TerminalHeader>
        <TerminalTitle>enso · logs</TerminalTitle>
        <LogTailControls filter={filter} following={following} onFilter={changeFilter} onFollowing={setFollowing} />
        <TerminalActions>
          <TerminalStatus>
            <Spinner />
          </TerminalStatus>
        </TerminalActions>
      </TerminalHeader>
      <div className="flex items-center gap-3 border-b px-4 py-1 font-mono text-muted-foreground text-xs">
        <span>{heading}</span>
        {pinnedToNewest ? null : <span>paused at your scroll position — scroll to the bottom to follow again</span>}
      </div>
      {problem === undefined ? null : (
        <div className="px-4 pt-1">
          <Alert variant="destructive">
            <AlertTitle>the tail</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        </div>
      )}
      <TerminalContent
        ref={scrollElement}
        onScroll={handleScroll}
        // `log` is the role for a live, append-ordered record view, and it is the one that
        // takes a name — a bare scrolling div does not, so the label had no role to attach to.
        role="log"
        aria-label="log records"
        className="text-xs"
      >
        <ol style={{ position: 'relative', height: virtualizer.getTotalSize(), width: '100%' }}>
          {rows.map((row) => {
            const line = view.lines[row.index]
            if (line === undefined) return null
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
                <LogRow line={line} threadHref={timelineUrlForThread} />
              </li>
            )
          })}
        </ol>
      </TerminalContent>
    </Terminal>
  )
}
