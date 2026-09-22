import { ENSO_LOG_LEVEL_NAMES, type EnsoLogLine, type EnsoLogTailFrame, logLineText } from '@enso/core'
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
 */

/** A row is one line — fixed height, so no row has to be measured to place the next one. */
const ROW_HEIGHT_PX = 22
/** Rows drawn beyond the viewport, so a fast scroll lands on content rather than on blanks. */
const ROW_OVERSCAN = 16
/**
 * How close to the bottom still counts as "at the newest record". A few pixels of slack: a
 * scroll container rounds, and a reader who is at the bottom has not asked to stop following.
 */
const PINNED_TO_NEWEST_SLACK_PX = 48
/** How much of a thread id a row shows. The whole id is the link and the row's tooltip. */
const THREAD_ID_SHOWN_CHARACTERS = 8

/** The writers that appear in the file, as the placeholder offers them — not a closed list. */
const PROCESS_PLACEHOLDER = 'server, web, pi, browser'

/** Tier → how the row reads it. Colour AND the word, never colour alone. */
const LEVEL_CLASS: Readonly<Record<EnsoLogLine['level'], string>> = {
  TRACE: 'w-12 shrink-0 text-muted-foreground',
  DEBUG: 'w-12 shrink-0 text-muted-foreground',
  INFO: 'w-12 shrink-0 text-foreground',
  WARN: 'w-12 shrink-0 font-semibold text-primary',
  ERROR: 'w-12 shrink-0 font-semibold text-destructive',
  FATAL: 'w-12 shrink-0 font-semibold text-destructive',
}

/** What this page is currently showing, as the frames have built it. */
interface LogTailView {
  /** The local day the file under the tail is named for; empty before the first frame. */
  readonly day: string
  readonly lines: readonly EnsoLogLine[]
  /** How many records matched the question, cap included — `matched > lines.length` is the cap. */
  readonly matched: number
  readonly malformed: number
  /** Whether any frame has arrived: "nothing yet" and "nothing matched" are different answers. */
  readonly opened: boolean
}

const EMPTY_VIEW: LogTailView = { day: '', lines: [], matched: 0, malformed: 0, opened: false }

/**
 * The view one frame later. `backlog` REPLACES — it is the file as it stands, and it arrives
 * again when the local-midnight rotation puts a new day under the tail. `records` APPENDS, and
 * its counts add: a capped backlog of 1000 out of 5000 that then grows by 3 is honestly "the
 * last 1003 of 5003".
 */
function applyFrame(view: LogTailView, frame: EnsoLogTailFrame): LogTailView {
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
 * What is on screen, in words: the day, how many records, and — when the server capped the
 * read — that this is the END of a longer day rather than the whole of a short one. The same
 * honesty the bundle states, because a count that silently means "some of" is a lie a
 * debugging surface cannot afford.
 */
function describeView(view: LogTailView): string {
  if (!view.opened) return 'waiting for the first frame'
  const shown = view.lines.length
  const counted = view.matched > shown ? `the last ${shown} of ${view.matched} records` : `${shown} records`
  const malformed = view.malformed > 0 ? ` · ${view.malformed} malformed lines — read the file` : ''
  return `${view.day} · ${counted}${malformed}`
}

/**
 * The record's clock, time of day only: a page of ISO strings is 24 characters of the same
 * date per row. LOCAL, because the day the file is named for is local — a row stamped in one
 * zone under a heading in another is how a reader mis-reads an incident.
 */
function timeOfDay(line: EnsoLogLine): string {
  const at = new Date(line['@timestamp'])
  if (Number.isNaN(at.getTime())) return line['@timestamp']
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  const seconds = String(at.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}.${String(at.getMilliseconds()).padStart(3, '0')}`
}

/**
 * The properties the message did not already say. A record's value is worth a row's width
 * only once: `run {generation} acquired` has spelled `generation`, and repeating it crowds out
 * the ones nothing has mentioned. Matched by NAME against the template on disk, so nothing is
 * hidden by having the same value as something else.
 */
function unsaidProperties(line: EnsoLogLine): Array<[string, unknown]> {
  const template = line.message ?? ''
  // `threadId` is the row's link, so it is already shown — as the one property this page
  // renders as something you can click (#142).
  return Object.entries(line.properties ?? {}).filter(
    ([name]) => name !== 'threadId' && !template.includes(`{${name}}`),
  )
}

/** A property as a row reads it: a string as itself, anything else as the JSON it is on disk. */
function propertyText(name: string, value: unknown): string {
  return `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`
}

/**
 * The chat page's URL for a thread (#142). Built by `thread-url.ts`'s own helper rather than
 * by concatenating `?thread=`, so the page that OWNS the query parameter is the only file that
 * spells it — and an empty search is passed on purpose: this page's own query (`?log=debug`)
 * is not the chat page's business.
 */
function chatUrlForThread(threadId: string): string {
  return `/${urlForThread('', threadId)}`
}

/** One record, one line. The full message and the full thread id are the row's `title`. */
function LogRow({ line }: { line: EnsoLogLine }): React.ReactNode {
  const message = logLineText(line)
  const properties = line.properties ?? {}
  const threadId = typeof properties.threadId === 'string' ? properties.threadId : undefined
  const unsaid = unsaidProperties(line)
  return (
    <div className="flex items-center gap-2 px-4 font-mono text-xs" title={message} style={{ height: ROW_HEIGHT_PX }}>
      <span className="shrink-0 text-muted-foreground tabular-nums">{timeOfDay(line)}</span>
      <span className={LEVEL_CLASS[line.level]}>{line.level.toLowerCase()}</span>
      <span className="w-40 shrink-0 truncate text-muted-foreground">{line.logger.replace(/^enso\.?/, '')}</span>
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {unsaid.length === 0 ? null : (
        <span className="min-w-0 max-w-80 shrink-0 truncate text-muted-foreground">
          {unsaid.map(([name, value]) => propertyText(name, value)).join(' ')}
        </span>
      )}
      {threadId === undefined ? null : (
        <a
          className="shrink-0 text-primary underline-offset-2 hover:underline"
          href={chatUrlForThread(threadId)}
          title={threadId}
        >
          {threadId.slice(0, THREAD_ID_SHOWN_CHARACTERS)}
          {threadId.length > THREAD_ID_SHOWN_CHARACTERS ? '…' : ''}
        </a>
      )}
    </div>
  )
}

interface LogTailControlsProps {
  readonly filter: LogTailFilter
  readonly following: boolean
  readonly onFilter: (change: Partial<LogTailFilter>) => void
  readonly onFollowing: (following: boolean) => void
}

/**
 * The question, as controls. Native `<select>` for the closed vocabulary and a text input for
 * the open ones — the same reasoning the permission-mode control gives: keyboard- and
 * screen-reader-complete without a dependency.
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
        <select
          id="log-tail-level"
          className="rounded-md border bg-background px-1.5 py-0.5 text-foreground text-xs"
          value={filter.level}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
            const level = ENSO_LOG_LEVEL_NAMES.find((levelName) => levelName === event.target.value)
            if (level !== undefined) onFilter({ level })
          }}
        >
          {ENSO_LOG_LEVEL_NAMES.map((levelName) => (
            <option key={levelName} value={levelName}>
              {levelName}
            </option>
          ))}
        </select>
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
  const [view, setView] = useState<LogTailView>(EMPTY_VIEW)
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
        setView((current: LogTailView) => applyFrame(current, frame))
      },
      onError: setProblem,
    })
    return () => controller.abort()
  }, [filter, following, pageFetch])

  const changeFilter = useCallback((change: Partial<LogTailFilter>): void => {
    // A new question is a new answer: forget the byte this view was resumed from, so the
    // re-opened connection reads the day's head and its first frame replaces the list.
    resumeFrom.current = undefined
    setView(EMPTY_VIEW)
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
                <LogRow line={line} />
              </li>
            )
          })}
        </ol>
      </TerminalContent>
    </Terminal>
  )
}
