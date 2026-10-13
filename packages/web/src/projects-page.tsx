import type { EnsoProject, EnsoProjectSettings, EnsoStoredThread, EnsoThreadTreeMode } from '@enso/core'
import { Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx'
import { cn } from './lib/utils.ts'
import type { ListingState } from './listing-store.ts'
import {
  type ProjectRequestOutcome,
  type ProjectThread,
  readProjectSettings,
  threadsOfProject,
} from './project-list.ts'
import type { ThreadSummary } from './thread-stores.ts'
import { Age } from './threads-rail.tsx'
import { ProjectOnDisk, type TreesRead, useTreesListing } from './trees-settings.tsx'

/**
 * The Projects page (#870): every project as a card — its name and what it is (current, started
 * here, not trusted, folder missing), its path, its threads and when one was last active, what it
 * takes on disk, and how its new threads' trees are made — with the way into its threads, its
 * settings, and, for any but the launch folder, its removal. No route of its own: the projects
 * from `GET /api/projects`, the threads from the lists the page already holds, the size from `GET
 * /api/trees` (summed as Settings › Storage sums it, `projectDiskUsage`), and trust and tree mode
 * from each project's `GET /api/projects/:id/settings`.
 */

/** A project's tree mode, as its card says what its new threads get. */
const TREE_MODE_FACTS: Readonly<Record<EnsoThreadTreeMode, string>> = {
  worktree: 'each thread gets a worktree',
  copy: 'each thread gets a copy',
  off: 'threads run in the folder itself',
}

/** A project's settings as read: its answer, or the server's reason; absent while the read is out. */
type SettingsReads = ReadonlyMap<string, ProjectRequestOutcome<EnsoProjectSettings>>

/**
 * Each project's `GET /api/projects/:id/settings`, read when the page mounts and again when the
 * projects listed change (one added or removed). A read that could not reach the server is said as
 * a refusal with its reason, never as an untrusted project.
 */
function useProjectSettings(projectIds: readonly string[], fetchNow: FetchLike): SettingsReads {
  const key = projectIds.join('\n')
  const [reads, setReads] = useState<SettingsReads>(new Map())
  useEffect(() => {
    let current = true
    const ids = key === '' ? [] : key.split('\n')
    const readOne = async (projectId: string): Promise<[string, ProjectRequestOutcome<EnsoProjectSettings>]> => {
      try {
        return [projectId, await readProjectSettings(projectId, fetchNow)]
      } catch (error) {
        return [projectId, { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }]
      }
    }
    void Promise.all(ids.map(readOne)).then((answers) => {
      if (current) setReads(new Map(answers))
    })
    return (): void => {
      current = false
    }
  }, [key, fetchNow])
  return reads
}

const BADGE = 'inline-flex items-center gap-1 rounded-full border px-2 font-mono text-xs'

/** What a project is, beside its name: current, started here, folder missing, not trusted. */
function ProjectBadges({
  project,
  current,
  trusted,
}: {
  project: EnsoProject
  current: boolean
  /** Undefined until its settings are read, or when they could not be: no badge is guessed. */
  trusted: boolean | undefined
}): React.ReactNode {
  return (
    <>
      {current ? (
        <span className={cn(BADGE, 'border-primary text-primary')} title="the project of the thread behind this page">
          current
        </span>
      ) : null}
      {project.launch ? (
        <span className={cn(BADGE, 'text-foreground')} title="The folder Enso was started in">
          started here
        </span>
      ) : null}
      {project.status === 'missing-dir' ? (
        <span className={cn(BADGE, 'border-destructive text-destructive')} title={`${project.path} no longer exists`}>
          <TriangleAlertIcon aria-hidden="true" className="size-3" />
          folder missing
        </span>
      ) : null}
      {trusted === false ? (
        <span className={cn(BADGE, 'border-dashed')} title="Enso doesn’t read this project’s own settings files">
          not trusted
        </span>
      ) : null}
    </>
  )
}

/** The card's size: the one sum Storage says too, or that it is still measured, or why it could not be. */
function SizeFact({ trees, projectId }: { trees: TreesRead; projectId: string }): React.ReactNode {
  if (trees.kind === 'loading') return <span>measuring size…</span>
  if (trees.kind === 'failed') return <span title={trees.reason}>size not read: {trees.reason}</span>
  return <ProjectOnDisk listing={trees.listing} projectId={projectId} />
}

/** How the project's new threads' trees are made, or why its settings could not be read. */
function TreeModeFact({
  settings,
}: {
  settings: ProjectRequestOutcome<EnsoProjectSettings> | undefined
}): React.ReactNode {
  if (settings === undefined) return null
  if (settings.kind === 'refused') return <span title={settings.reason}>settings not read: {settings.reason}</span>
  return <span>{TREE_MODE_FACTS[settings.value.threads.tree.value]}</span>
}

/** What a card's buttons do to its project. */
export interface ProjectCardActions {
  /** Go to the project's threads: its most recent one, or a new one when it has none. */
  readonly onOpenThreads: (projectId: string) => void
  /** Open the project's settings (#754). */
  readonly onSettings: (projectId: string) => void
  /** Forget the registration; its folder and threads stay. Never offered for the launch folder. */
  readonly onRemove: (projectId: string) => void
}

/** Remove, behind the same menu item the rail's `⋯` holds: one click opens it, the item confirms it. */
function RemoveProject({
  project,
  onRemove,
}: {
  project: EnsoProject
  onRemove: (projectId: string) => void
}): React.ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon" variant="ghost" aria-label={`remove ${project.title}`}>
          <Trash2Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onRemove(project.projectId)}>
          Remove project — its threads stay on disk
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One project's card. */
function ProjectCard({
  project,
  current,
  threads,
  trees,
  settings,
  actions,
}: {
  project: EnsoProject
  current: boolean
  threads: readonly ProjectThread[]
  trees: TreesRead
  settings: ProjectRequestOutcome<EnsoProjectSettings> | undefined
  actions: ProjectCardActions
}): React.ReactNode {
  const latest = threads[0]
  // A gone folder with no thread has nothing to open, and no new thread can start there.
  const nothingToOpen = latest === undefined && project.status === 'missing-dir'
  const nameId = `project-${project.projectId}`
  return (
    <li
      aria-labelledby={nameId}
      className={cn(
        'flex flex-col gap-4 rounded-lg border bg-card px-6 py-4 sm:flex-row sm:items-center',
        current ? 'border-muted-foreground/60' : undefined,
      )}
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={nameId} className="font-heading text-base font-semibold">
            {project.title}
          </h2>
          <ProjectBadges
            project={project}
            current={current}
            trusted={settings?.kind === 'ok' ? settings.value.trusted : undefined}
          />
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground" title={project.path}>
          {project.path}
        </span>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground [&>span]:whitespace-nowrap">
          <span>
            <strong className="font-semibold text-foreground">{threads.length}</strong>{' '}
            {threads.length === 1 ? 'thread' : 'threads'}
          </span>
          {latest === undefined ? null : (
            <span title={new Date(latest.at).toLocaleString()}>
              last active{' '}
              <strong className="font-semibold text-foreground">
                <Age from={new Date(latest.at)} />
              </strong>
            </span>
          )}
          <SizeFact trees={trees} projectId={project.projectId} />
          <TreeModeFact settings={settings} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={nothingToOpen}
          title={nothingToOpen ? `${project.path} no longer exists, and no thread was kept` : undefined}
          onClick={() => actions.onOpenThreads(project.projectId)}
        >
          Open threads
        </Button>
        <Button type="button" variant="outline" onClick={() => actions.onSettings(project.projectId)}>
          Settings
        </Button>
        {project.launch ? null : <RemoveProject project={project} onRemove={actions.onRemove} />}
      </div>
    </li>
  )
}

export interface ProjectsPageProps extends ProjectCardActions {
  /** The page's `fetch`; the browser's when absent. */
  readonly fetch?: FetchLike | undefined
  readonly projects: ListingState<EnsoProject>
  readonly pageThreads: readonly ThreadSummary[]
  readonly stored: readonly EnsoStoredThread[]
  /** The project of the thread behind the page, marked current; undefined when none is known. */
  readonly currentProjectId: string | undefined
  /** Why the last remove did not go through, or undefined. */
  readonly notice: string | undefined
}

/** Every project, the launch folder first, each as a card; the lede over them and the note under. */
export function ProjectsPage({
  fetch: fetchImpl,
  projects,
  pageThreads,
  stored,
  currentProjectId,
  notice,
  ...actions
}: ProjectsPageProps): React.ReactNode {
  const { read: trees, fetchNow } = useTreesListing(fetchImpl)
  // The server lists the launch folder first; the page holds to that whatever order arrives.
  const ordered = projects.rows.toSorted((left, right) => Number(right.launch) - Number(left.launch))
  const settings = useProjectSettings(
    ordered.map((project) => project.projectId),
    fetchNow,
  )
  const context = { projects: projects.rows, pageThreads, stored }
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 md:p-6">
      <p className="text-muted-foreground">
        Each project is a folder on this machine. A thread in a project works in a tree of that folder, so your checkout
        stays as you left it until you bring the work back.
      </p>
      {notice === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      )}
      {projects.error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          projects not listed: {projects.error}
        </p>
      )}
      <ul aria-label="Projects" className="grid gap-3">
        {ordered.map((project) => (
          <ProjectCard
            key={project.projectId}
            project={project}
            current={project.projectId === currentProjectId}
            threads={threadsOfProject(project.projectId, context)}
            trees={trees}
            settings={settings.get(project.projectId)}
            actions={actions}
          />
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        The folder Enso was started in is always first and can’t be removed. Removing a project never touches its
        folder.
      </p>
    </div>
  )
}
