import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  FolderPlusIcon,
  GitForkIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from 'lucide-react'
import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './components/ui/input-group.tsx'
import { cn } from './lib/utils.ts'
import { pageClock } from './page-clock.ts'
import { type ProjectThreadsContext, projectOf, threadsOfProject } from './project-list.ts'
import { NOT_IN_A_PROJECT, ProjectSwitcher, type SwitcherChoice } from './project-switcher.tsx'
import {
  type HiddenSignal,
  hiddenSignal,
  matchingThreads,
  RAIL_DAY_LABELS,
  type RailDayGroup,
  type RailRow,
  sectionLayout,
  startOfLocalDay,
} from './rail-layout.ts'
import { useStore } from './store.ts'
import type { ThreadSummary } from './thread-stores.ts'
import { ADD_PROJECT_ROUTE, type PageRoute, PROJECTS_ROUTE, SETTINGS_ROUTE } from './thread-url.ts'

/**
 * The threads rail (#90 PR 3, #395): which conversation am I in, in which project, what else is
 * there, how do I start another.
 *
 * deepseek-harness's left rail is the reference — workspaces as sections, each with its sessions,
 * a title and a relative age per row, and a new-session button per workspace.
 *
 * One section per project (#395), the launch directory first, each an accordion (#876): the current
 * project's open — the project of the thread on screen, or behind the page — the others closed,
 * until the reader opens or closes one; a closed one says how many of its threads wait on you, or
 * else run. Under each: the threads this page
 * has open — they die with the page — then pi's session files in that project this page has not
 * got open (#95); a click resumes one, with its history and its mode, under the same id — the
 * thread id IS pi's session id. A thread RUNNING elsewhere (a run in flight, a dialog parked) is
 * shown with a running dot and still resumable: under the follow transport a resume follows the run
 * (#114). Idle is resumable too, even when this server still holds it — a reload must get its own
 * thread back. A section's `+` starts a thread IN that project; the rail's New
 * Thread starts in the current project. A fork (#433) says which thread it
 * came from under its title, by that thread's title — the listing's `parentThreadId`. At its foot,
 * the links to the pages (#869, #870): Projects and Settings, each marked as the current page while
 * it is on screen.
 *
 * At its top, the project switcher (#876, `project-switcher.tsx`): choosing a project opens its
 * latest thread, which makes it current. Under it New Thread, then a search (#875) that keeps the
 * threads whose title holds what is typed, across every project, opening the sections that hold
 * one, current or not. Inside a section the threads are under Today, Yesterday and Earlier by last
 * activity, and the ones that share a title fold into one row with a count (`rail-layout.ts`).
 *
 * Presentational: the lists, the active id, and the callbacks arrive as props, so a static
 * render pins the wording and the active marker without any chat. Three inputs are NOT props:
 * the clock (#278) — an age that only moves when the page happens to re-render is a stale
 * reading that looks live, so each age subscribes to `pageClock`, which a static render does
 * not — and which sections and folds the reader opened or closed, and what they searched for: the reader's own state.
 */

/** `now`, `12s`, `3m`, `2h`, `6d` — deepseek's form, one unit, no "ago". */
export function relativeAge(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One row's age, live (#278). Its own component because the clock's tick re-renders
 * whatever read the clock: this label moves every five seconds and the rail, the panes and
 * the transcript above it do not re-render at all. Under a static render nothing subscribes
 * and the age is computed once, against the clock's load time.
 */
export function Age({ from }: { from: Date }): React.ReactNode {
  const now = useStore(pageClock)
  return <>{relativeAge(from, now)}</>
}

/** What an untitled thread reads as — a thread that has not been asked anything yet. */
export const UNTITLED_THREAD = 'new thread'

/** How many stored threads a section shows before "show more" — deepseek's five. */
export const STORED_ROWS_SHOWN = 5

/** Where the rail keeps which project sections the reader opened or closed (#876) — the browser's, per project, across reloads. */
const SECTIONS_KEY = 'enso.rail.sections'

/** The key of the section of threads in no listed project. */
const UNLISTED = 'unlisted'

/** A section's key: its project's id, or the threads in none. */
const sectionKey = (group: ProjectGroup): string => group.project?.projectId ?? UNLISTED

/** The reader's choice per section: open (`true`) or closed. A section with none follows whether its project is current. */
type SectionChoices = Readonly<Record<string, boolean>>

function readSectionChoices(): SectionChoices {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(SECTIONS_KEY) ?? '{}')
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored).filter((choice): choice is [string, boolean] => typeof choice[1] === 'boolean'),
    )
  } catch {
    return {}
  }
}

/** Which sections are open, and the reader opening or closing one. */
interface SectionOpening {
  readonly isOpen: (key: string, current: boolean) => boolean
  readonly toggle: (key: string, open: boolean) => void
}

/**
 * The sections' accordion (#876): the reader's choice for a project, kept across reloads, over the
 * default — open while it is current. A project the reader ARRIVES in (a thread of it opened, or it
 * chosen in the switcher) opens: what was chosen for it before is dropped, so it closes again once
 * they leave it, unless they open it. Where a reload lands is no arrival — `arrived` is undefined
 * until the page knows the projects and the thread on screen — so a current project the reader
 * closed stays closed.
 */
function useSectionOpening(arrived: string | undefined): SectionOpening {
  const [choices, setChoices] = useState(readSectionChoices)
  const [seen, setSeen] = useState(arrived)
  // Adjusted while rendering, React's way to reset state on a changed input: no effect, no extra paint.
  if (arrived !== undefined && arrived !== seen) {
    setSeen(arrived)
    if (seen !== undefined && Object.hasOwn(choices, arrived)) {
      setChoices(Object.fromEntries(Object.entries(choices).filter(([key]) => key !== arrived)))
    }
  }
  useEffect(() => {
    globalThis.localStorage?.setItem(SECTIONS_KEY, JSON.stringify(choices))
  }, [choices])
  return {
    isOpen: (key, current) => choices[key] ?? current,
    toggle: (key, open) => setChoices({ ...choices, [key]: !open }),
  }
}

export interface ThreadsRailProps {
  /** The server's projects, the launch directory first; empty until the page has them. */
  readonly projects: readonly EnsoProject[]
  readonly threads: readonly ThreadSummary[]
  /** Undefined while a URL-named thread is still being adopted (#142): nothing is highlighted. */
  readonly activeThreadId: string | undefined

  /** Stored threads not open on this page, newest first — already filtered by the caller. */
  readonly earlier: readonly EnsoStoredThread[]
  /** Why a list could not be fetched, or undefined. Shown above the sections. */
  readonly earlierError: string | undefined
  /**
   * Why a thread could not be opened — the URL's, a row's, a fork's (#378) — said as that, never as
   * a list that failed. Absent, or undefined, is nothing to say.
   */
  readonly openError?: string | undefined
  readonly onSelect: (threadId: string) => void
  readonly onResume: (threadId: string) => void
  /** Start a thread in this project; `undefined` when the page knows no project yet (the server's launch directory). */
  readonly onNew: (projectId: string | undefined) => void
  /** Make a project current from the switcher (#876): open its latest thread, or a new one in it when it has none. */
  readonly onOpenProject: (projectId: string) => void
  /** The page's `fetch`, for the switcher's trust reads; the browser's when absent. */
  readonly fetch?: FetchLike | undefined
  /** Forget a registered project; its threads stay on disk. Never offered for the launch directory. */
  readonly onRemoveProject: (projectId: string) => void
  /** Open a project's page at its Worktrees tab (#754, a page since #871): how its new threads' trees are made. Offered for every project, the launch one too. */
  readonly onProjectSettings: (projectId: string) => void
  /** Why the last remove did not go through, or undefined. Shown above the sections. */
  readonly projectNotice: string | undefined
  /** Open a page (#869, #870, #872): Projects or Settings by the link at the rail's foot that names it, Add project by its button. */
  readonly onPage: (route: PageRoute) => void
  /**
   * The page on screen (#869), whose link is marked as the current page; while one is, no thread row
   * is — the thread is behind the page. Absent, or undefined, is a thread on screen.
   */
  readonly page?: PageRoute['kind'] | undefined
  /**
   * On a narrow screen the rail is a page of its own, shown by the header's threads button (the
   * design's rail under 760px, #407): hidden unless this is true. A wide screen always shows it.
   */
  readonly shownNarrow?: boolean
  /**
   * The forks' parents (#433): a thread id → the title of the thread it was forked from — see
   * `forkParentTitles`. A row in it says so under its title; none when absent.
   */
  readonly forkParents?: ReadonlyMap<string, string>
}

/** What a fork's parent reads as when the page lists no thread under its id — another project's, say. */
export const UNLISTED_PARENT = 'a thread not listed here'

/**
 * Each fork's parent as the rail names it (#433): the stored listing says which thread a fork came
 * from, by id; the name is that thread's title, from the listing or from this page's open threads
 * (a thread opened here may carry a title the listing has not caught up with).
 */
export function forkParentTitles(
  stored: readonly EnsoStoredThread[],
  pageThreads: readonly ThreadSummary[],
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>()
  for (const thread of stored) titles.set(thread.threadId, thread.name ?? thread.title ?? UNTITLED_THREAD)
  for (const thread of pageThreads) {
    const title = thread.name ?? thread.title
    if (title !== undefined) titles.set(thread.threadId, title)
  }
  const parents = new Map<string, string>()
  for (const thread of stored) {
    if (thread.parentThreadId !== undefined) {
      parents.set(thread.threadId, titles.get(thread.parentThreadId) ?? UNLISTED_PARENT)
    }
  }
  return parents
}

/** No thread on the rail is a fork — the rail's default, and the context's outside one. */
const NO_FORKS: ReadonlyMap<string, string> = new Map()
const ForkParentsContext = createContext<ReadonlyMap<string, string>>(NO_FORKS)

/** A row's title, and — for a fork — the thread it came from, under it (#433); the whole title as its hover when the row reads a shorter one. */
function RowTitle({
  threadId,
  title,
  full,
}: {
  threadId: string
  title: string | undefined
  full: string | undefined
}): React.ReactNode {
  const parent = useContext(ForkParentsContext).get(threadId)
  return (
    <span className="grid min-w-0 flex-1">
      <span className={cn('truncate', title === undefined ? 'italic' : '')} title={full === title ? undefined : full}>
        {title ?? UNTITLED_THREAD}
      </span>
      {parent === undefined ? null : (
        <span className="truncate text-xs text-muted-foreground">
          <GitForkIcon aria-hidden="true" className="mr-1 inline size-3" />
          {`forked from ${parent}`}
        </span>
      )}
    </span>
  )
}

/** One section of the rail: a project, or — `project: undefined` — the threads no listed project holds. */
export interface ProjectGroup {
  readonly project: EnsoProject | undefined
  readonly threads: readonly ThreadSummary[]
  readonly earlier: readonly EnsoStoredThread[]
}

/**
 * The rail's sections: one per project, in the server's order, each with the page's threads in it
 * and the stored ones. A page thread with no project is the launch directory's — that is where the
 * server built it. Anything whose project is not listed (removed, or the list not loaded yet) is
 * gathered at the end rather than dropped: an open thread must never vanish from the rail.
 */
export function groupByProject(
  projects: readonly EnsoProject[],
  threads: readonly ThreadSummary[],
  earlier: readonly EnsoStoredThread[],
): ProjectGroup[] {
  const keyOf = (projectId: string | undefined): string | undefined => projectOf(projects, projectId)?.projectId
  const groups: ProjectGroup[] = projects.map((project) => ({
    project,
    threads: threads.filter((thread) => keyOf(thread.projectId) === project.projectId),
    earlier: earlier.filter((thread) => keyOf(thread.projectId) === project.projectId),
  }))
  const unlisted: ProjectGroup = {
    project: undefined,
    threads: threads.filter((thread) => keyOf(thread.projectId) === undefined),
    earlier: earlier.filter((thread) => keyOf(thread.projectId) === undefined),
  }
  return unlisted.threads.length > 0 || unlisted.earlier.length > 0 || projects.length === 0
    ? [...groups, unlisted]
    : groups
}

/**
 * About how much of a title the rail shows at its width: two titles that share this start read
 * the same there (#670), and a screen reader names their rows the same.
 */
const RAIL_TITLE_SHOWN = 32

/**
 * Where `left` parts from `right`, as a place to start reading `left` from: the word before the
 * first one they differ in, so the tail keeps a word of context ("…Approach B: …", not "…B: …").
 * `left.length` when `left` is `right` or starts it — nothing of `left` tells it apart.
 */
function partingAt(left: string, right: string): number {
  let length = 0
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1
  if (length === left.length || length === right.length) return length
  const differingWord = left.lastIndexOf(' ', length - 1) + 1
  return differingWord === 0 ? 0 : left.lastIndexOf(' ', differingWord - 2) + 1
}

/**
 * A title as the rail reads it: itself, or — when another row's starts the same and goes on
 * differently — `…` and its words from where they part. A row whose title is another's whole (a
 * fork's and its parent's) is no contrast: the fork line under it says which is which.
 */
function lookalikeLabel(
  row: { readonly threadId: string; readonly title: string },
  titled: ReadonlyArray<{ readonly threadId: string; readonly title: string }>,
): string {
  const head = row.title.slice(0, RAIL_TITLE_SHOWN)
  const parting = titled
    .filter((peer) => peer.threadId !== row.threadId && peer.title.slice(0, RAIL_TITLE_SHOWN) === head)
    .map((peer) => partingAt(row.title, peer.title))
    .filter((at) => at < row.title.length)
  const from = parting.length === 0 ? 0 : Math.max(...parting)
  // Parting at the start (a shared run with no space to cut at) cuts nothing; and a
  // page title cut at its cap ends in `…`, which alone tells nothing apart.
  const tail = row.title.slice(from).trim()
  return from === 0 || tail === '' || tail === '…' ? row.title : `…${tail}`
}

/**
 * What each row of a section reads as (#670): the name a person gave it, else its first prompt —
 * and where two prompts in the section start alike, the words past their shared start, so the
 * rows are told apart without opening them (the arena's two approaches read the same at the
 * rail's width). Two threads with the same whole prompt — a fork and its parent — keep it; the
 * fork says whose it is under its title, and either can be renamed.
 */
export function railLabels(group: ProjectGroup): ReadonlyMap<string, string | undefined> {
  const rows = [...group.threads, ...group.earlier].map((thread) => ({
    threadId: thread.threadId,
    name: thread.name,
    title: thread.title,
  }))
  const titled = rows.flatMap((row) =>
    row.name === undefined && row.title !== undefined ? [{ threadId: row.threadId, title: row.title }] : [],
  )
  return new Map(
    rows.map((row) => [
      row.threadId,
      row.name ??
        (row.title === undefined ? undefined : lookalikeLabel({ threadId: row.threadId, title: row.title }, titled)),
    ]),
  )
}

/** A live state's dot: violet while pi waits on you, the evidence colour while it runs. */
const DOT: Readonly<Record<HiddenSignal['state'], string>> = {
  waiting: 'bg-human signal:shadow-glow-human',
  running: 'bg-evidence signal:shadow-glow-evidence',
}

const STATE_WORDS: Readonly<Record<HiddenSignal['state'], string>> = {
  waiting: 'waiting on you',
  running: 'running',
}

/**
 * A thread's live state, as the status bar's dot at rail size: violet while pi waits on you,
 * solid in the running colour while a run is in flight (Signal lights both), hollow when an
 * open thread is idle. A stored thread says only that it is running. ⚠ No pulse (#739): an
 * animation runs the compositor for as long as pi works, once per running thread in the rail.
 */
export function LiveDot({ state }: { state: 'waiting' | 'running' | 'idle' }): React.ReactNode {
  if (state === 'idle') {
    return <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-muted-foreground" />
  }
  return (
    <span className={cn('size-2 shrink-0 rounded-full', DOT[state])}>
      <span className="sr-only">{STATE_WORDS[state]}</span>
    </span>
  )
}

/** A closed project's signal (#876): the dot of what its hidden threads say, and how many say it — "2 waiting on you". */
function SectionSignal({ signal }: { signal: HiddenSignal }): React.ReactNode {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-foreground tabular-nums">
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT[signal.state])} />
      <span aria-hidden="true">{signal.count}</span>
      <span className="sr-only">{`${signal.count} ${STATE_WORDS[signal.state]}`}</span>
    </span>
  )
}

function liveState(thread: ThreadSummary): 'waiting' | 'running' | 'idle' {
  if (thread.waiting) return 'waiting'
  return thread.busy ? 'running' : 'idle'
}

const ROW = 'flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-popover'

function ThreadRow({
  thread,
  label,
  active,
  onSelect,
}: {
  thread: ThreadSummary
  /** What the row reads as — `railLabels`. */
  label: string | undefined
  active: boolean
  onSelect: (threadId: string) => void
}): React.ReactNode {
  return (
    <li>
      <button
        type="button"
        data-thread-id={thread.threadId}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(thread.threadId)}
        className={cn(ROW, active ? 'bg-accent text-foreground hover:bg-accent' : 'text-foreground')}
      >
        <LiveDot state={liveState(thread)} />
        <RowTitle threadId={thread.threadId} title={label} full={thread.name ?? thread.title} />
        <span
          className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
          title={thread.lastActivityAt.toLocaleString()}
        >
          <Age from={thread.lastActivityAt} />
        </span>
      </button>
    </li>
  )
}

/**
 * One stored thread's row: title, age, and — when it is running — a running dot. Running is
 * shown, not locked (#114): under the follow transport (#112) a resume MOUNTS the thread
 * and follows it, so a page that reloaded under pi's open question comes back to the card
 * from here. Before #113 a run belonged to the tab's HTTP response and a second page could
 * not join it, which is what the old `disabled` protected.
 */
function EarlierThreadRow({
  thread,
  label,
  onResume,
}: {
  thread: EnsoStoredThread
  /** What the row reads as — `railLabels`. */
  label: string | undefined
  onResume: (threadId: string) => void
}): React.ReactNode {
  const at = new Date(thread.lastActivityAt)
  return (
    <li>
      <button
        type="button"
        data-thread-id={thread.threadId}
        title={thread.busy ? 'running — resume to follow it' : `not open here — resume it (${at.toLocaleString()})`}
        onClick={() => onResume(thread.threadId)}
        className={cn(ROW, 'text-muted-foreground hover:text-foreground')}
      >
        {thread.busy ? <LiveDot state="running" /> : null}
        <RowTitle threadId={thread.threadId} title={label} full={thread.name ?? thread.title} />
        <span className="shrink-0 font-mono text-xs tabular-nums">
          <Age from={at} />
        </span>
      </button>
    </li>
  )
}

/** A section's name, and the full path as its hover — two projects can share a directory name. */
function sectionTitle(project: EnsoProject | undefined, anyProjects: boolean): { name: string; hover: string } {
  if (project !== undefined) return { name: project.title, hover: project.path }
  return anyProjects
    ? { name: NOT_IN_A_PROJECT, hover: 'threads in a project this server no longer lists' }
    : { name: 'threads', hover: 'the projects are not listed yet' }
}

/** What a section's header does to its project: start a thread, open its page (#754), forget it. */
interface ProjectActions {
  readonly onNew: (projectId: string) => void
  readonly onRemove: (projectId: string) => void
  readonly onSettings: (projectId: string) => void
}

/** The section's header: open or close it, see where it is, start a thread in it, open its menu. */
function SectionHeader({
  group,
  name,
  hover,
  folded,
  onFold,
  actions: { onNew, onRemove, onSettings },
}: {
  group: ProjectGroup
  name: string
  hover: string
  folded: boolean
  onFold: () => void
  actions: ProjectActions
}): React.ReactNode {
  const { project } = group
  const missing = project?.status === 'missing-dir'
  const hidden = folded ? hiddenSignal(group) : undefined
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-expanded={!folded}
        title={hover}
        onClick={onFold}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-xs font-semibold tracking-wide text-muted-foreground hover:bg-popover hover:text-foreground"
      >
        {folded ? <ChevronRightIcon className="size-3 shrink-0" /> : <ChevronDownIcon className="size-3 shrink-0" />}
        <span className="min-w-0 truncate">{name}</span>
        {missing ? <span className="shrink-0 text-destructive">missing</span> : null}
        {hidden === undefined ? null : <SectionSignal signal={hidden} />}
      </button>
      {project === undefined ? null : (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label={`new thread in ${name}`}
          title={missing ? `${project.path} no longer exists` : `new thread in ${project.path}`}
          disabled={missing}
          onClick={() => onNew(project.projectId)}
        >
          <PlusIcon />
        </Button>
      )}
      {/* #754: every project has a page, the launch one too; only a registered one can be removed. */}
      {project === undefined ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={`more for ${name}`}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onSettings(project.projectId)}>Project settings…</DropdownMenuItem>
            {project.launch ? null : (
              <DropdownMenuItem onSelect={() => onRemove(project.projectId)}>
                Remove project — its threads stay on disk
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

/** What a section's rows read as and do: open a thread of this page, resume a stored one. */
interface RowActions {
  /** What each row reads as — `railLabels`. */
  readonly labels: ReadonlyMap<string, string | undefined>
  readonly activeThreadId: string | undefined
  readonly onSelect: (threadId: string) => void
  readonly onResume: (threadId: string) => void
}

function RailRowItem({ row, actions }: { row: RailRow; actions: RowActions }): React.ReactNode {
  if (row.kind === 'open') {
    return (
      <ThreadRow
        thread={row.thread}
        label={actions.labels.get(row.thread.threadId)}
        active={row.thread.threadId === actions.activeThreadId}
        onSelect={actions.onSelect}
      />
    )
  }
  if (row.kind === 'stored') {
    return (
      <EarlierThreadRow
        thread={row.thread}
        label={actions.labels.get(row.thread.threadId)}
        onResume={actions.onResume}
      />
    )
  }
  return <FoldRow fold={row} actions={actions} />
}

/**
 * Threads that share a title, folded into one row with a count (#875), that expands in place. It
 * opens on its own when it holds the thread on screen; collapsed, it says a question waiting on
 * you or a run in flight among its threads, so neither is ever hidden in it.
 */
function FoldRow({
  fold,
  actions,
}: {
  fold: Extract<RailRow, { kind: 'fold' }>
  actions: RowActions
}): React.ReactNode {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined)
  const open = chosen ?? fold.threads.some((thread) => thread.threadId === actions.activeThreadId)
  const hidden = open ? undefined : hiddenSignal(fold)?.state
  const count = fold.threads.length + fold.earlier.length
  const first = fold.threads[0] ?? fold.earlier[0]
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        title={fold.title}
        onClick={() => setChosen(!open)}
        className={cn(ROW, 'text-foreground')}
      >
        <ChevronRightIcon aria-hidden="true" className={cn('size-3 shrink-0', open ? 'rotate-90' : '')} />
        <span className="min-w-0 flex-1 truncate">
          {(first === undefined ? undefined : actions.labels.get(first.threadId)) ?? fold.title}
        </span>
        {hidden === undefined ? null : <LiveDot state={hidden} />}
        <span className="shrink-0 rounded-full border px-1.5 font-mono text-xs tabular-nums">
          <span aria-hidden="true">×{count}</span>
          <span className="sr-only">{`${count} threads`}</span>
        </span>
      </button>
      {open ? (
        <ol aria-label={`${count} threads titled ${fold.title}`} className="ml-3 flex flex-col gap-px border-l pl-1">
          {fold.threads.map((thread) => (
            <RailRowItem key={thread.threadId} row={{ kind: 'open', thread }} actions={actions} />
          ))}
          {fold.earlier.map((thread) => (
            <RailRowItem key={thread.threadId} row={{ kind: 'stored', thread }} actions={actions} />
          ))}
        </ol>
      ) : null}
    </li>
  )
}

/** One day group of a section (#875): its label, and its rows under it. */
function DayGroup({ group, actions }: { group: RailDayGroup; actions: RowActions }): React.ReactNode {
  const labelId = useId()
  return (
    <div className="flex flex-col gap-px">
      <span id={labelId} className="px-2 pt-1 font-mono text-xs tracking-wider text-muted-foreground uppercase">
        {RAIL_DAY_LABELS[group.day]}
      </span>
      <ol aria-labelledby={labelId} className="flex flex-col gap-px">
        {group.rows.map((row) => (
          <RailRowItem key={row.kind === 'fold' ? row.key : row.thread.threadId} row={row} actions={actions} />
        ))}
      </ol>
    </div>
  )
}

/**
 * A section's rows: its day groups, the page's open threads before its stored ones in each — five
 * rows of stored threads until asked for more; every match while searching.
 */
function SectionRows({
  group,
  today,
  searching,
  actions,
}: {
  group: ProjectGroup
  today: Date
  searching: boolean
  actions: RowActions
}): React.ReactNode {
  const [allStored, setAllStored] = useState(false)
  const layout = sectionLayout(group, today, allStored || searching ? undefined : STORED_ROWS_SHOWN)
  return (
    <>
      {layout.days.map((day) => (
        <DayGroup key={day.day} group={day} actions={actions} />
      ))}
      {group.threads.length === 0 && group.earlier.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground italic">no threads yet</p>
      ) : null}
      {!searching && (layout.hidden > 0 || allStored) ? (
        <button
          type="button"
          onClick={() => setAllStored((was) => !was)}
          className="self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-popover hover:text-foreground"
        >
          {allStored ? 'show less' : `show ${layout.hidden} more`}
        </button>
      ) : null}
    </>
  )
}

/**
 * A project's section, open as the accordion has it (#876). Searching (#875) shows only its matches
 * and opens it whatever the accordion says, which is kept for after; closed during a search, it
 * stays closed until the query changes.
 */
function ProjectSection({
  group,
  open,
  onToggle,
  query,
  anyProjects,
  today,
  rows,
  actions,
}: {
  group: ProjectGroup
  open: boolean
  onToggle: () => void
  query: string
  anyProjects: boolean
  today: Date
  rows: Omit<RowActions, 'labels'>
  actions: ProjectActions
}): React.ReactNode {
  const [closedUnder, setClosedUnder] = useState<string | undefined>(undefined)
  const searching = query.trim() !== ''
  const shown = searching ? closedUnder !== query : open
  const matching = matchingThreads(group, query)
  const { name, hover } = sectionTitle(group.project, anyProjects)
  return (
    <section aria-label={name} className="flex flex-col gap-1">
      <SectionHeader
        group={matching}
        name={name}
        hover={hover}
        folded={!shown}
        onFold={searching ? () => setClosedUnder(closedUnder === query ? undefined : query) : onToggle}
        actions={actions}
      />
      {shown ? (
        <SectionRows
          group={matching}
          today={today}
          searching={searching}
          // Labelled against the whole section, so a search never changes what a row reads as.
          actions={{ ...rows, labels: railLabels(group) }}
        />
      ) : null}
    </section>
  )
}

/** The rail's search box (#875): its id, so the not-found screen's **Search threads** can focus it. */
export const RAIL_SEARCH_ID = 'threads-rail-search'

/** The rail's search (#875): what is typed, the box it is typed in, and emptying it with focus kept in the box. */
interface RailSearchState {
  readonly query: string
  readonly setQuery: (query: string) => void
  readonly field: React.RefObject<HTMLInputElement | null>
  readonly clear: () => void
}

function useRailSearch(): RailSearchState {
  const [query, setQuery] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const clear = (): void => {
    setQuery('')
    field.current?.focus()
  }
  return { query, setQuery, field, clear }
}

/** The search box: what is typed filters the rail; Escape or the clear button empties it. */
function RailSearch({ search: { query, setQuery, field, clear } }: { search: RailSearchState }): React.ReactNode {
  return (
    <InputGroup className="h-9 bg-card">
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        ref={field}
        id={RAIL_SEARCH_ID}
        type="search"
        aria-label="Search threads"
        placeholder="Search threads"
        autoComplete="off"
        value={query}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key !== 'Escape' || query === '') return
          event.preventDefault()
          setQuery('')
        }}
        // The browser's own clear button would be a second one beside ours.
        className="text-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {query === '' ? null : (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="clear search" onClick={clear}>
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}

/** Local midnight today, as a number so the rail re-renders when the day turns and not at every tick of the clock. */
const localMidnight = (): number => startOfLocalDay(pageClock.get()).getTime()

/** One link at the rail's foot: a page, marked as the current page while it is on screen. */
function RailLink({
  current,
  onOpen,
  children,
}: {
  current: boolean
  onOpen: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-current={current ? 'page' : undefined}
      className={cn(
        'h-9 w-full justify-start',
        current ? 'bg-accent text-foreground hover:bg-accent' : 'text-muted-foreground',
      )}
      onClick={onOpen}
    >
      {children}
    </Button>
  )
}

/** The rail's foot (#869, #870): its links to the pages, the one on screen marked as the current page. */
function RailFoot({
  page,
  onPage,
}: {
  page: PageRoute['kind'] | undefined
  onPage: (route: PageRoute) => void
}): React.ReactNode {
  return (
    <div className="grid gap-1 border-t p-3">
      {/* A project's page and Add project are among the Projects (#871, #872): its link stays marked there. */}
      <RailLink
        current={page === 'projects' || page === 'project' || page === 'add-project'}
        onOpen={() => onPage(PROJECTS_ROUTE)}
      >
        <FolderIcon />
        Projects
      </RailLink>
      <RailLink current={page === 'settings'} onOpen={() => onPage(SETTINGS_ROUTE)}>
        <Settings2Icon />
        Settings
      </RailLink>
    </div>
  )
}

/** What went wrong, above the sections: a list that could not be fetched, a thread that would not open, a refused add or remove. */
function RailAlerts({
  earlierError,
  openError,
  projectNotice,
}: Pick<ThreadsRailProps, 'earlierError' | 'openError' | 'projectNotice'>): React.ReactNode {
  return (
    <>
      {earlierError !== undefined ? (
        <div role="alert" className="px-2 text-xs text-destructive">
          could not list threads: {earlierError}
        </div>
      ) : null}
      {openError !== undefined ? (
        <div role="alert" className="px-2 text-xs text-destructive">
          could not open the thread: {openError}
        </div>
      ) : null}
      {projectNotice !== undefined ? (
        <div role="alert" className="px-2 text-xs text-destructive">
          {projectNotice}
        </div>
      ) : null}
    </>
  )
}

/**
 * The rail's sections under its search (#875): every project's, or while searching only those with
 * a match — and when none has one, a line that says so with a way back. Each open or closed as the
 * accordion has it (#876): the current one open unless the reader closed it.
 */
function RailSections({
  groups,
  currentKey,
  opening,
  search: { query, clear },
  anyProjects,
  rows,
  actions,
}: {
  groups: readonly ProjectGroup[]
  currentKey: string | undefined
  opening: SectionOpening
  search: RailSearchState
  anyProjects: boolean
  rows: Omit<RowActions, 'labels'>
  actions: ProjectActions
}): React.ReactNode {
  const today = new Date(useSyncExternalStore(pageClock.subscribe, localMidnight, localMidnight))
  const searching = query.trim() !== ''
  const shown = searching
    ? groups.filter((group) => {
        const matching = matchingThreads(group, query)
        return matching.threads.length > 0 || matching.earlier.length > 0
      })
    : groups
  if (searching && shown.length === 0) {
    return (
      <div role="status" className="flex flex-col items-start gap-2 px-2 py-4 text-sm text-muted-foreground">
        <span>{`No threads match “${query.trim()}”.`}</span>
        <button type="button" className="text-primary underline underline-offset-3" onClick={clear}>
          Clear search
        </button>
      </div>
    )
  }
  return shown.map((group) => {
    const key = sectionKey(group)
    const open = opening.isOpen(key, key === currentKey)
    return (
      <ProjectSection
        key={key}
        group={group}
        open={open}
        onToggle={() => opening.toggle(key, open)}
        query={query}
        anyProjects={anyProjects}
        today={today}
        rows={rows}
        actions={actions}
      />
    )
  })
}

/**
 * What the switcher offers (#876): every project — one whose folder is gone and that holds no thread
 * has nothing to open — and, when any thread is in no listed project, those, with their count.
 */
function switcherChoices(groups: readonly ProjectGroup[], context: ProjectThreadsContext): SwitcherChoice[] {
  return groups.flatMap((group): SwitcherChoice[] => {
    const threadCount = group.threads.length + group.earlier.length
    const { project } = group
    if (project === undefined) {
      return context.projects.length === 0 || threadCount === 0
        ? []
        : [{ key: UNLISTED, project, threadCount, unavailable: false }]
    }
    const unavailable = project.status === 'missing-dir' && threadsOfProject(project.projectId, context).length === 0
    return [{ key: project.projectId, project, threadCount, unavailable }]
  })
}

/** The most recently active of a section's threads — what choosing it in the switcher opens. */
function latestOf(group: ProjectGroup | undefined): { threadId: string; onPage: boolean } | undefined {
  const candidates = [
    ...(group?.threads ?? []).map((thread) => ({
      threadId: thread.threadId,
      onPage: true,
      at: thread.lastActivityAt.getTime(),
    })),
    ...(group?.earlier ?? []).map((thread) => ({
      threadId: thread.threadId,
      onPage: false,
      at: Date.parse(thread.lastActivityAt),
    })),
  ]
  return candidates.toSorted((left, right) => right.at - left.at)[0]
}

/**
 * A project chosen in the switcher (#876) opens its latest thread, or a new one in it, through the
 * page — which makes it current; the threads in no project, their latest, here.
 */
function chooseProject(
  key: string,
  groups: readonly ProjectGroup[],
  { onOpenProject, onSelect, onResume }: Pick<ThreadsRailProps, 'onOpenProject' | 'onSelect' | 'onResume'>,
): void {
  if (key !== UNLISTED) {
    onOpenProject(key)
    return
  }
  const latest = latestOf(groups.find((group) => group.project === undefined))
  if (latest === undefined) return
  if (latest.onPage) onSelect(latest.threadId)
  else onResume(latest.threadId)
}

/**
 * The current project (#876) — the thread on screen's, or behind the page; the first listed (the
 * launch folder) while none is known — and the accordion that keeps it open. Until the projects
 * are listed every thread is in no project: no arrival is read from that.
 */
function useCurrentProject(
  groups: readonly ProjectGroup[],
  activeThreadId: string | undefined,
  listed: boolean,
): { currentGroup: ProjectGroup | undefined; currentKey: string | undefined; opening: SectionOpening } {
  const activeGroup = groups.find((group) => group.threads.some((thread) => thread.threadId === activeThreadId))
  const currentGroup = activeGroup ?? groups[0]
  const opening = useSectionOpening(activeGroup === undefined || !listed ? undefined : sectionKey(activeGroup))
  return { currentGroup, currentKey: currentGroup === undefined ? undefined : sectionKey(currentGroup), opening }
}

/** The rail's top: the project switcher (#876), New Thread in the current project, and the search (#875). */
function RailTop({
  groups,
  current,
  search,
  props: { projects, threads, earlier, onNew, onOpenProject, onSelect, onResume, onPage, fetch: fetchImpl },
}: {
  groups: readonly ProjectGroup[]
  current: { group: ProjectGroup | undefined; key: string | undefined }
  search: RailSearchState
  props: ThreadsRailProps
}): React.ReactNode {
  return (
    <div className="grid gap-2 p-3 pb-1">
      <ProjectSwitcher
        choices={switcherChoices(groups, { projects, pageThreads: threads, stored: earlier })}
        currentKey={current.key}
        onChoose={(key) => chooseProject(key, groups, { onOpenProject, onSelect, onResume })}
        onPage={onPage}
        fetch={fetchImpl}
      />
      <Button type="button" className="h-10 w-full" onClick={() => onNew(current.group?.project?.projectId)}>
        <PlusIcon />
        New Thread
      </Button>
      <RailSearch search={search} />
    </div>
  )
}

export function ThreadsRail(props: ThreadsRailProps): React.ReactNode {
  const {
    projects,
    threads,
    activeThreadId,
    earlier,
    earlierError,
    openError,
    onSelect,
    onResume,
    onNew,
    onRemoveProject,
    onProjectSettings,
    projectNotice,
    onPage,
    page,
    shownNarrow = false,
    forkParents = NO_FORKS,
  } = props
  const groups = groupByProject(projects, threads, earlier)
  const search = useRailSearch()
  const { currentGroup, currentKey, opening } = useCurrentProject(groups, activeThreadId, projects.length > 0)
  return (
    <ForkParentsContext.Provider value={forkParents}>
      <nav
        id="threads-rail"
        aria-label="threads"
        className={cn(
          'shrink-0 flex-col bg-sidebar md:flex md:w-62 md:border-r',
          shownNarrow ? 'flex w-full' : 'hidden',
        )}
      >
        <RailTop groups={groups} current={{ group: currentGroup, key: currentKey }} search={search} props={props} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 pt-2">
          <RailAlerts earlierError={earlierError} openError={openError} projectNotice={projectNotice} />
          <RailSections
            groups={groups}
            currentKey={currentKey}
            opening={opening}
            search={search}
            anyProjects={projects.length > 0}
            rows={{ activeThreadId: page === undefined ? activeThreadId : undefined, onSelect, onResume }}
            actions={{ onNew, onRemove: onRemoveProject, onSettings: onProjectSettings }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="justify-start text-muted-foreground"
            onClick={() => onPage(ADD_PROJECT_ROUTE)}
          >
            <FolderPlusIcon />
            Add project
          </Button>
        </div>
        <RailFoot page={page} onPage={onPage} />
      </nav>
    </ForkParentsContext.Provider>
  )
}
