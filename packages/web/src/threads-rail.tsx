import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon, FolderPlusIcon, GitForkIcon, PlusIcon } from 'lucide-react'
import { createContext, useContext, useMemo, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx'
import { cn } from './lib/utils.ts'
import { pageClock } from './page-clock.ts'
import { projectOf } from './project-list.ts'
import { useStore } from './store.ts'
import type { ThreadSummary } from './thread-stores.ts'

/**
 * The threads rail (#90 PR 3, #395): which conversation am I in, in which project, what else is
 * there, how do I start another.
 *
 * deepseek-harness's left rail is the reference — workspaces as sections, each with its sessions,
 * a title and a relative age per row, and a new-session button per workspace.
 *
 * One section per project (#395), the launch directory first. Under each: the threads this page
 * has open — they die with the page — then pi's session files in that project this page has not
 * got open (#95); a click resumes one, with its history and its mode, under the same id — the
 * thread id IS pi's session id. A thread RUNNING elsewhere (a run in flight, a dialog parked) is
 * shown with a running dot and still resumable: under the follow transport a resume follows the run
 * (#114). Idle is resumable too, even when this server still holds it — a reload must get its own
 * thread back. A section's `+` starts a thread IN that project; the header's New
 * Thread starts one in the project of the thread on screen. A fork (#433) says which thread it
 * came from under its title, by that thread's title — the listing's `parentThreadId`.
 *
 * Presentational: the lists, the active id, and the callbacks arrive as props, so a static
 * render pins the wording and the active marker without any chat. Two inputs are NOT props:
 * the clock (#278) — an age that only moves when the page happens to re-render is a stale
 * reading that looks live, so each age subscribes to `pageClock`, which a static render does
 * not — and which sections the reader folded, the reader's own state.
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
function Age({ from }: { from: Date }): React.ReactNode {
  const now = useStore(pageClock)
  return <>{relativeAge(from, now)}</>
}

/** What an untitled thread reads as — a thread that has not been asked anything yet. */
export const UNTITLED_THREAD = 'new thread'

/** How many stored threads a section shows before "show more" — deepseek's five. */
export const STORED_ROWS_SHOWN = 5

/** Where the rail keeps which sections the reader folded — the browser's, per project, across reloads. */
const FOLDED_KEY = 'enso.rail.folded'

function readFolded(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

/** A section's fold, remembered by its key (the project id) — a reload keeps the rail as it was left. */
function useFolded(key: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => readFolded().has(key))
  const toggle = (): void => {
    const next = new Set(readFolded())
    if (folded) next.delete(key)
    else next.add(key)
    globalThis.localStorage?.setItem(FOLDED_KEY, JSON.stringify([...next]))
    setFolded(!folded)
  }
  return [folded, toggle]
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
  /** Open the Add project dialog (#395 slice 3). */
  readonly onAddProject: () => void
  /** Forget a registered project; its threads stay on disk. Never offered for the launch directory. */
  readonly onRemoveProject: (projectId: string) => void
  /** Open a project's page (#754): how its new threads' trees are made. Offered for every project, the launch one too. */
  readonly onProjectSettings: (projectId: string) => void
  /** Why the last add or remove did not go through, or undefined. Shown above the sections. */
  readonly projectNotice: string | undefined
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

/**
 * A thread's live state, as the status bar's dot at rail size: violet while pi waits on you,
 * solid in the running colour while a run is in flight (Signal lights both), hollow when an
 * open thread is idle. A stored thread says only that it is running. ⚠ No pulse (#739): an
 * animation runs the compositor for as long as pi works, once per running thread in the rail.
 */
function LiveDot({ state }: { state: 'waiting' | 'running' | 'idle' }): React.ReactNode {
  if (state === 'waiting') {
    return (
      <span className="size-2 shrink-0 rounded-full bg-human signal:shadow-glow-human">
        <span className="sr-only">waiting on you</span>
      </span>
    )
  }
  if (state === 'running') {
    return (
      <span className="size-2 shrink-0 rounded-full bg-evidence signal:shadow-glow-evidence">
        <span className="sr-only">running</span>
      </span>
    )
  }
  return <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-muted-foreground" />
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
    ? { name: 'other', hover: 'threads in a project this server no longer lists' }
    : { name: 'threads', hover: 'the projects are not listed yet' }
}

/**
 * What a folded section's header says for the rows it hides: a question waiting on you first (only
 * an open thread can hold one, and it is busy too), else a run in flight — the order `liveState` uses.
 */
function hiddenState(group: ProjectGroup): 'waiting' | 'running' | undefined {
  if (group.threads.some((thread) => thread.waiting)) return 'waiting'
  if (group.threads.some((thread) => thread.busy) || group.earlier.some((thread) => thread.busy)) return 'running'
  return undefined
}

/** What a section's header does to its project: start a thread, open its page (#754), forget it. */
interface ProjectActions {
  readonly onNew: (projectId: string) => void
  readonly onRemove: (projectId: string) => void
  readonly onSettings: (projectId: string) => void
}

/** The section's header: fold it, see where it is, start a thread in it, open its menu. */
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
  const hidden = folded ? hiddenState(group) : undefined
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
        {hidden === undefined ? null : <LiveDot state={hidden} />}
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

/** A section's rows: the page's open threads, then its stored ones — five until asked for more. */
function SectionRows({
  group,
  name,
  activeThreadId,
  onSelect,
  onResume,
}: {
  group: ProjectGroup
  name: string
  activeThreadId: string | undefined
  onSelect: (threadId: string) => void
  onResume: (threadId: string) => void
}): React.ReactNode {
  const [allStored, setAllStored] = useState(false)
  const shownStored = allStored ? group.earlier : group.earlier.slice(0, STORED_ROWS_SHOWN)
  const hidden = group.earlier.length - shownStored.length
  const labels = useMemo(() => railLabels(group), [group])
  return (
    <>
      {group.threads.length > 0 ? (
        <ol aria-label={`open threads in ${name}`} className="flex flex-col gap-px">
          {group.threads.map((thread) => (
            <ThreadRow
              key={thread.threadId}
              thread={thread}
              label={labels.get(thread.threadId)}
              active={thread.threadId === activeThreadId}
              onSelect={onSelect}
            />
          ))}
        </ol>
      ) : null}
      {shownStored.length > 0 ? (
        <ol aria-label={`earlier threads in ${name}`} className="flex flex-col gap-px">
          {shownStored.map((thread) => (
            <EarlierThreadRow
              key={thread.threadId}
              thread={thread}
              label={labels.get(thread.threadId)}
              onResume={onResume}
            />
          ))}
        </ol>
      ) : null}
      {group.threads.length === 0 && group.earlier.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground italic">no threads yet</p>
      ) : null}
      {hidden > 0 || allStored ? (
        <button
          type="button"
          onClick={() => setAllStored((was) => !was)}
          className="self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-popover hover:text-foreground"
        >
          {allStored ? 'show less' : `show ${hidden} more`}
        </button>
      ) : null}
    </>
  )
}

function ProjectSection({
  group,
  anyProjects,
  activeThreadId,
  onSelect,
  onResume,
  actions,
}: {
  group: ProjectGroup
  anyProjects: boolean
  activeThreadId: string | undefined
  onSelect: (threadId: string) => void
  onResume: (threadId: string) => void
  actions: ProjectActions
}): React.ReactNode {
  const [folded, toggleFolded] = useFolded(group.project?.projectId ?? 'unlisted')
  const { name, hover } = sectionTitle(group.project, anyProjects)
  return (
    <section aria-label={name} className="flex flex-col gap-1">
      <SectionHeader group={group} name={name} hover={hover} folded={folded} onFold={toggleFolded} actions={actions} />
      {folded ? null : (
        <SectionRows
          group={group}
          name={name}
          activeThreadId={activeThreadId}
          onSelect={onSelect}
          onResume={onResume}
        />
      )}
    </section>
  )
}

export function ThreadsRail({
  projects,
  threads,
  activeThreadId,
  earlier,
  earlierError,
  openError,
  onSelect,
  onResume,
  onNew,
  onAddProject,
  onRemoveProject,
  onProjectSettings,
  projectNotice,
  shownNarrow = false,
  forkParents = NO_FORKS,
}: ThreadsRailProps): React.ReactNode {
  const groups = groupByProject(projects, threads, earlier)
  // New Thread starts where the reader is: the project of the thread on screen.
  const activeProject = groups.find((group) => group.threads.some((thread) => thread.threadId === activeThreadId))
  const actions: ProjectActions = { onNew, onRemove: onRemoveProject, onSettings: onProjectSettings }
  return (
    <ForkParentsContext.Provider value={forkParents}>
      <nav
        id="threads-rail"
        aria-label="threads"
        className={cn(
          'shrink-0 flex-col gap-4 overflow-y-auto bg-sidebar p-3 md:flex md:w-62 md:border-r',
          shownNarrow ? 'flex w-full' : 'hidden',
        )}
      >
        <Button type="button" className="h-10 w-full" onClick={() => onNew(activeProject?.project?.projectId)}>
          <PlusIcon />
          New Thread
        </Button>
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
        {groups.map((group) => (
          <ProjectSection
            key={group.project?.projectId ?? 'unlisted'}
            group={group}
            anyProjects={projects.length > 0}
            activeThreadId={activeThreadId}
            onSelect={onSelect}
            onResume={onResume}
            actions={actions}
          />
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="justify-start text-muted-foreground"
          onClick={onAddProject}
        >
          <FolderPlusIcon />
          Add project
        </Button>
      </nav>
    </ForkParentsContext.Provider>
  )
}
