import { ENSO_LOG_LEVEL_NAMES, type EnsoLogLevelName, type EnsoLogLine } from '@enso/core'
import { useCallback, useMemo, useState } from 'react'
import type { FetchLike } from '../browser-logging.ts'
import {
  Terminal,
  TerminalActions,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '../components/ai-elements/terminal.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Spinner } from '../components/ui/spinner.tsx'
import { OptionSelect } from '../option-select.tsx'
import { urlForThread } from '../thread-url.ts'
import { LogRow } from './log-row.tsx'
import { DEFAULT_LOG_TAIL_FILTER, type LogTailFilter } from './log-tail-connection.ts'
import {
  ActionLink,
  describeRecordCount,
  type LogTailView,
  PinnedTail,
  ProblemAlert,
  useLogTailStream,
} from './log-tail-view.tsx'

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
 * THE LIST IS VIRTUALIZED AND BOUNDED, AND AUTO-SCROLL STOPS WHEN THE READER SCROLLS UP. A
 * `trace` day is tens of thousands of records; the server caps each frame it sends, the view
 * keeps no more than that same cap across every frame, and the virtualizer draws only the rows
 * on screen — so the page that exists to diagnose a slow system is not the slow thing in it.
 * Both rules live in `log-tail-view.tsx`, shared with the timeline, so the two pages cannot
 * drift apart on either.
 *
 * A THREAD ID HERE DRILLS DOWN, IT DOES NOT LEAVE. Within the observation surface a thread id
 * leads to that thread's timeline on this same page (`/debug?thread=<id>`, #144 slice 3) —
 * the tail is the day, the timeline is one thread of it, and a reader narrows without changing
 * surfaces. Leaving the surface for the chat page is ONE deliberate link, in the timeline's
 * header, so no row on the observation surface is a click away from the surface that prompts
 * pi. The row itself renders one way on both pages (`log-row.tsx`); only where its id leads
 * differs.
 */

/** The writers that appear in the file, as the placeholder offers them — not a closed list. */
const PROCESS_PLACEHOLDER = 'server, web, pi, browser'

/** What is on screen, in words: the day, then the count — or that nothing is, and why that is not a wait. */
function describeView(view: LogTailView, settled: boolean): string {
  if (!view.opened) return settled ? 'nothing is being read' : 'waiting for the first frame'
  return `${view.day} · ${describeRecordCount(view)}`
}

/**
 * The bundle's URL — the day's, or one thread's — for the hand-over row of #144's table. A
 * plain link to `GET /api/logs/bundle`: the browser saves the attachment, nothing is POSTed,
 * and the route writes no record. The bundle and this page read the same file, so what a
 * reader hands over is what they were looking at.
 */
export function bundleUrl(threadId?: string): string {
  return threadId === undefined ? '/api/logs/bundle' : `/api/logs/bundle?thread=${encodeURIComponent(threadId)}`
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

/** Every level, shown as it is named. */
const LEVEL_OPTIONS: ReadonlyArray<readonly [EnsoLogLevelName, string]> = ENSO_LOG_LEVEL_NAMES.map(
  (levelName) => [levelName, levelName] as const,
)

/** The level, as a control — `OptionSelect`, shared with the timeline: one question, one control. */
export function LogLevelSelect({ controlId, level, onLevel }: LogLevelSelectProps): React.ReactNode {
  return <OptionSelect id={controlId} value={level} options={LEVEL_OPTIONS} onChange={onLevel} />
}

interface LogTailControlsProps {
  readonly filter: LogTailFilter
  readonly following: boolean
  readonly onFilter: (change: Partial<LogTailFilter>) => void
  readonly onFollowing: (following: boolean) => void
}

/** One free-text question in the controls row: a label, and the input it names. */
function FilterField({
  field,
  placeholder,
  value,
  onFilter,
}: {
  field: 'thread' | 'process' | 'since'
  placeholder: string
  value: string
  onFilter: (change: Partial<LogTailFilter>) => void
}): React.ReactNode {
  const controlId = `log-tail-${field}`
  return (
    <label className="flex items-center gap-1.5 text-muted-foreground text-xs" htmlFor={controlId}>
      <span>{field}</span>
      <Input
        id={controlId}
        className="w-44"
        placeholder={placeholder}
        value={value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onFilter({ [field]: event.target.value })}
      />
    </label>
  )
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
      <FilterField field="thread" placeholder="an id, or a prefix" value={filter.thread} onFilter={onFilter} />
      <FilterField field="process" placeholder={PROCESS_PLACEHOLDER} value={filter.process} onFilter={onFilter} />
      <FilterField field="since" placeholder="30s, 10m, 2h, 1d" value={filter.since} onFilter={onFilter} />
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
  const { view, problem, settled, restart } = useLogTailStream({ filter, enabled: following, fetch: pageFetch })

  const changeFilter = useCallback(
    (change: Partial<LogTailFilter>): void => {
      restart()
      setFilter((current: LogTailFilter) => ({ ...current, ...change }))
    },
    [restart],
  )

  const heading = useMemo(() => describeView(view, settled), [view, settled])

  return (
    <Terminal className="h-dvh" isStreaming={following && !view.opened && !settled}>
      <TerminalHeader>
        <TerminalTitle>enso · logs</TerminalTitle>
        <LogTailControls filter={filter} following={following} onFilter={changeFilter} onFollowing={setFollowing} />
        <TerminalActions>
          <ActionLink href="/debug?stats">the day's stats</ActionLink>
          <ActionLink href={bundleUrl()} download>
            download the day's bundle
          </ActionLink>
          <TerminalStatus>
            <Spinner />
          </TerminalStatus>
        </TerminalActions>
      </TerminalHeader>
      <PinnedTail
        // A new question starts pinned to the newest row again (`PinnedTail`).
        key={`${filter.level}\u0000${filter.thread}\u0000${filter.process}\u0000${filter.since}`}
        items={view.lines}
        heading={heading}
        label="log records"
        notices={<ProblemAlert title="the tail" problem={problem} />}
        renderItem={(line: EnsoLogLine) => <LogRow line={line} threadHref={timelineUrlForThread} />}
      />
    </Terminal>
  )
}
