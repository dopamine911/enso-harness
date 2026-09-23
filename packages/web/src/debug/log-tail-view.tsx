import { type EnsoLogLine, type EnsoLogTailFrame, LOG_TAIL_MAX_RECORDS } from '@enso/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FetchLike } from '../browser-logging.ts'
import { TerminalContent } from '../components/ai-elements/terminal.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { ROW_HEIGHT_PX } from './log-row.tsx'
import { type LogTailFilter, type LogTailResume, openLogTailStream } from './log-tail-connection.ts'

/**
 * What the two tail-fed pages — the day's log (`log-tail-screen.tsx`) and one thread's timeline
 * (`thread-timeline-screen.tsx`) — share, held once (#352): the view the frames build, the hook
 * that keeps one tail open and resumable, and the pinned, virtualized list both render into.
 * They were two copies of the same ~100 lines, and two copies of a scroll rule is how one of
 * them learns to yank a reader back to the bottom while the other does not.
 */

/** Rows drawn beyond the viewport, so a fast scroll lands on content rather than on blanks. */
const ROW_OVERSCAN = 16
/**
 * How close to the bottom still counts as "at the newest record". A few pixels of slack: a
 * scroll container rounds, and a reader who is at the bottom has not asked to stop following.
 */
const PINNED_TO_NEWEST_SLACK_PX = 48

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

const EMPTY_LOG_TAIL_VIEW: LogTailView = { day: '', lines: [], matched: 0, malformed: 0, opened: false }

/**
 * The view one frame later. `backlog` REPLACES — it is the file as it stands, and it arrives
 * again when the local-midnight rotation puts a new day under the tail. `records` APPENDS, and
 * its counts add: a capped backlog of 1000 out of 5000 that then grows by 3 is honestly "the
 * last 1003 of 5003".
 */
function applyLogTailFrame(view: LogTailView, frame: EnsoLogTailFrame): LogTailView {
  if (frame.type === 'backlog') {
    return { day: frame.day, lines: frame.lines, matched: frame.matched, malformed: frame.malformed, opened: true }
  }
  // ⚠ BOUNDED, at the same cap the server applies to a frame (PR #336 review): the server caps
  // what it SENDS per frame, and a page that appended every `records` frame forever grew
  // without limit on a `trace` day left open. The oldest rows leave as new ones land, and
  // `matched` keeps counting so the heading reads "the last 2000 of N" honestly.
  const lines = [...view.lines, ...frame.lines]
  return {
    day: frame.day,
    lines: lines.length > LOG_TAIL_MAX_RECORDS ? lines.slice(-LOG_TAIL_MAX_RECORDS) : lines,
    matched: view.matched + frame.matched,
    malformed: view.malformed + frame.malformed,
    opened: true,
  }
}

/**
 * How many records are on screen, in words — and, when the server capped the read, that this
 * is the END of a longer day rather than the whole of a short one. The same honesty the
 * bundle states, because a count that silently means "some of" is a lie a debugging surface
 * cannot afford.
 */
export function describeRecordCount(view: LogTailView): string {
  const shown = view.lines.length
  const counted = view.matched > shown ? `the last ${shown} of ${view.matched} records` : `${shown} records`
  const malformed = view.malformed > 0 ? ` · ${view.malformed} malformed lines — read the file` : ''
  return `${counted}${malformed}`
}

export interface LogTailStream {
  readonly view: LogTailView
  /** What the connection could not deliver, in words; cleared when a connection comes up. */
  readonly problem: string | undefined
  /**
   * Whether the connection has said its last word — a refusal it will not retry, or the page
   * leaving. Until then a page with no frame yet is WAITING; after it, it is not (PR #336
   * review: a refused question used to spin forever beside the alert that refused it).
   */
  readonly settled: boolean
  /**
   * A new question is a new answer: forget the byte this view was resumed from and empty it,
   * so the re-opened connection reads the day's head and its first frame replaces the list.
   * Call it in the same handler that changes the filter.
   */
  readonly restart: () => void
}

export interface LogTailStreamRequest {
  /** The question. Must be stable between renders (state, or memoised): a new object re-opens the tail. */
  readonly filter: LogTailFilter
  /** False holds the tail closed — the day's log page while paused. */
  readonly enabled: boolean
  readonly fetch: FetchLike | undefined
  /** Fired after a frame that carried records — the timeline re-reads the thread's tails then. Stable, or the tail re-opens. */
  readonly onRecords?: (() => void) | undefined
}

/** One log tail, open while `enabled`, resumed across re-opens from the last byte a frame reached. */
export function useLogTailStream({ filter, enabled, fetch, onRecords }: LogTailStreamRequest): LogTailStream {
  const [view, setView] = useState<LogTailView>(EMPTY_LOG_TAIL_VIEW)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [settled, setSettled] = useState(false)
  /**
   * Where the next connection continues from. A REF, not state: it changes on every frame
   * and nothing renders it, and as state it would re-open the connection it came from.
   */
  const resumeFrom = useRef<LogTailResume | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return undefined
    const controller = new AbortController()
    setSettled(false)
    void openLogTailStream({
      filter,
      from: resumeFrom.current,
      fetch,
      signal: controller.signal,
      // A connection that came up is the recovery: whatever the last alert said is over. On
      // OPEN, not on every frame — clearing per frame raced a bad frame and a good one in the
      // same chunk into one render that showed no alert at all (PR #336 review, round two).
      onOpen: () => setProblem(undefined),
      onFrame: (frame: EnsoLogTailFrame) => {
        resumeFrom.current = { day: frame.day, offset: frame.offset }
        setView((current: LogTailView) => applyLogTailFrame(current, frame))
        if (frame.lines.length > 0) onRecords?.()
      },
      onError: setProblem,
    }).then(() => {
      if (!controller.signal.aborted) setSettled(true)
    })
    return () => controller.abort()
  }, [filter, enabled, fetch, onRecords])

  const restart = useCallback((): void => {
    resumeFrom.current = undefined
    setView(EMPTY_LOG_TAIL_VIEW)
    setProblem(undefined)
  }, [])

  return { view, problem, settled, restart }
}

/** A problem a page could not get past, said verbatim under its name — a debugging surface never drops one. */
export function ProblemAlert({ title, problem }: { title: string; problem: string | undefined }): React.ReactNode {
  if (problem === undefined) return null
  return (
    <div className="px-4 pt-1">
      <Alert variant="destructive">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{problem}</AlertDescription>
      </Alert>
    </div>
  )
}

/** A link in a debug page's header actions. */
export function ActionLink({
  href,
  download = false,
  children,
}: {
  href: string
  download?: boolean
  children: React.ReactNode
}): React.ReactNode {
  return (
    <a
      className="px-2 text-primary text-xs underline-offset-2 hover:underline"
      href={href}
      download={download ? true : undefined}
    >
      {children}
    </a>
  )
}

export interface PinnedTailProps<Item> {
  readonly items: readonly Item[]
  /** The line above the list: what is on screen, in words. */
  readonly heading: string
  /** The list's accessible name — which list this is when both pages are open. */
  readonly label: string
  /** Rendered between the heading line and the list: the page's alerts. */
  readonly notices?: React.ReactNode
  readonly renderItem: (item: Item) => React.ReactNode
}

/**
 * The list both pages render: virtualized (`@tanstack/react-virtual`), so a `trace` day draws
 * only the rows on screen, and PINNED to the newest row until the reader scrolls away.
 *
 * ⚠ AUTO-SCROLL STOPS WHEN THE READER SCROLLS UP, and that is the rule rather than a nicety: a
 * view that yanks you back to the newest row while you are reading an older one is useless for
 * the only thing it is for. It follows the newest item while pinned to the bottom, and the
 * moment a reader scrolls away it stays where they put it until they come back.
 *
 * A new question starts pinned again: the page REMOUNTS this with a `key` naming the question,
 * which is also what drops the old scroll position with the old list.
 */
export function PinnedTail<Item>({
  items,
  heading,
  label,
  notices,
  renderItem,
}: PinnedTailProps<Item>): React.ReactNode {
  const [pinnedToNewest, setPinnedToNewest] = useState(true)
  const scrollElement = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
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

  const newestRow = items.length - 1
  useEffect(() => {
    if (!pinnedToNewest || newestRow < 0) return
    virtualizer.scrollToIndex(newestRow)
  }, [pinnedToNewest, newestRow, virtualizer])

  return (
    <>
      <div className="flex items-center gap-3 border-b px-4 py-1 font-mono text-muted-foreground text-xs">
        <span>{heading}</span>
        {pinnedToNewest ? null : <span>paused at your scroll position — scroll to the bottom to follow again</span>}
      </div>
      {notices}
      <TerminalContent
        ref={scrollElement}
        onScroll={handleScroll}
        // `log` is the role for a live, append-ordered record view, and it is the one that
        // takes a name — a bare scrolling div does not, so the label had no role to attach to.
        role="log"
        aria-label={label}
        className="text-xs"
      >
        <ol style={{ position: 'relative', height: virtualizer.getTotalSize(), width: '100%' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index]
            if (item === undefined) return null
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
                {renderItem(item)}
              </li>
            )
          })}
        </ol>
      </TerminalContent>
    </>
  )
}
