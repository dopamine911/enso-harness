import type { EnsoProject, EnsoProjectSettings, EnsoStoredThread } from '@enso/core'
import { LockIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs.tsx'
import type { ListingState } from './listing-store.ts'
import {
  type ProjectRequestOutcome,
  type ProjectThread,
  readProjectSettings,
  threadsOfProject,
} from './project-list.ts'
import { ProjectWorktrees } from './project-worktrees.tsx'
import type { ThreadSummary } from './thread-stores.ts'
import { PROJECT_TABS, type PageRoute, PROJECTS_ROUTE, type ProjectTab } from './thread-url.ts'
import { Age, LiveDot, UNTITLED_THREAD } from './threads-rail.tsx'
import { ProjectStorage } from './trees-settings.tsx'

/**
 * A project's page (#871): `?page=project&project=<id>&tab=threads|worktrees|storage`, opened from
 * a Projects card, the rail's `⋯` and Settings › Storage. Its tabs gather what two dialogs held — the
 * tree settings (`ProjectSettingsDialog`, now the Worktrees tab) and its group of Settings' trees
 * (now the Storage tab) — beside its threads. Over the tabs, what is wrong with the project: its
 * folder is gone (Check again reads the projects again — the server recomputes the status on every
 * list, `projects.ts` `viewOf`), or it is not trusted, so its own files are not read. Under them,
 * its removal, said as the server does it (`project-routes.ts`): the registration goes, its
 * threads' files stay and are served again when the folder is added again.
 */

/** Each tab's name on the page. */
const TAB_LABELS: Readonly<Record<ProjectTab, string>> = {
  threads: 'Threads',
  worktrees: 'Worktree settings',
  storage: 'Storage',
}

/** What the page's actions do: navigation, the projects read again, and the removal. */
export interface ProjectPageActions {
  readonly onOpen: (route: PageRoute) => void
  /** Open one of the project's threads, as the rail opens a row: shown when on this page, else resumed. */
  readonly onOpenThread: (thread: ProjectThread) => void
  /** Read the projects again (Check again): the listing as it now stands. */
  readonly onCheckAgain: () => Promise<ListingState<EnsoProject>>
  /** Forget the registration: the server refuses it for the launch folder and while a thread runs. */
  readonly onRemove: (projectId: string) => void
  /** A thread deleted from the Storage tab: the page leaves it, as the header's Delete does. */
  readonly onDeleted: (threadId: string) => void
}

export interface ProjectPageProps extends ProjectPageActions {
  readonly route: Extract<PageRoute, { kind: 'project' }>
  /** The page's `fetch`; the browser's when absent. */
  readonly fetch?: FetchLike | undefined
  readonly projects: ListingState<EnsoProject>
  readonly pageThreads: readonly ThreadSummary[]
  readonly stored: readonly EnsoStoredThread[]
  /** Why the last removal did not go through, or undefined. */
  readonly notice: string | undefined
}

/** No project has the id the URL names: said, with the way to every project. */
function ProjectNotFound({ asked, onOpen }: { asked: string; onOpen: (route: PageRoute) => void }): React.ReactNode {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="flex w-full max-w-lg flex-col items-start gap-4 rounded-lg border bg-card p-8">
        <SearchXIcon aria-hidden="true" className="size-7 text-muted-foreground" />
        <p className="text-sm">
          {asked === '' ? (
            'This link names no project.'
          ) : (
            <>
              Enso lists no project with the id <code className="font-mono break-all">“{asked}”</code>. It may have been
              removed.
            </>
          )}
        </p>
        <Button type="button" onClick={() => onOpen(PROJECTS_ROUTE)}>
          Open Projects
        </Button>
      </div>
    </div>
  )
}

/** What Check again found: nothing yet, the folder still gone, or the projects not read. The banner goes once it is back. */
type CheckResult =
  | { readonly kind: 'still-missing'; readonly path: string }
  | { readonly kind: 'failed'; readonly reason: string }

/** The folder is gone: no new thread can start here. Check again reads the projects again; Remove forgets it. */
function MissingFolderBanner({
  removal,
  onCheckAgain,
}: {
  removal: Removal
  onCheckAgain: () => Promise<ListingState<EnsoProject>>
}): React.ReactNode {
  const { project } = removal
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckResult | undefined>(undefined)
  const check = async (): Promise<void> => {
    setChecking(true)
    const listed = await onCheckAgain()
    setChecking(false)
    const now = listed.rows.find((row) => row.projectId === project.projectId)
    if (listed.error !== undefined) setResult({ kind: 'failed', reason: listed.error })
    else if (now?.status === 'missing-dir') setResult({ kind: 'still-missing', path: now.path })
    else setResult(undefined)
  }
  return (
    <section
      aria-labelledby="missing-folder-title"
      className="grid gap-2 rounded-lg border border-destructive/60 bg-card px-4 py-3"
    >
      <h2 id="missing-folder-title" className="flex items-center gap-2 font-semibold text-destructive">
        <TriangleAlertIcon aria-hidden="true" className="size-4" />
        The folder is missing
      </h2>
      <p className="text-sm text-muted-foreground">
        <span className="font-mono break-all">{project.path}</span> isn’t on disk any more. Its threads stay readable,
        but no new thread can start here until the folder is back.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
        {project.launch ? null : <RemoveConfirm removal={removal} label="Remove from Enso" />}
      </div>
      {/* Said where it was asked and kept until the next check: never a toast that leaves before it is read. */}
      <p role="status" className="text-sm">
        {result?.kind === 'still-missing' ? `Still missing: ${result.path}` : null}
        {result?.kind === 'failed' ? `Could not check: ${result.reason}` : null}
      </p>
    </section>
  )
}

/**
 * Not trusted yet: what isn't read. Trusting it from here is #873's; until then the banner only
 * says so, with the files by name.
 */
function UntrustedBanner({ settings }: { settings: EnsoProjectSettings }): React.ReactNode {
  return (
    <section aria-labelledby="untrusted-title" className="grid gap-2 rounded-lg border border-dashed bg-card px-4 py-3">
      <h2 id="untrusted-title" className="flex items-center gap-2 font-semibold">
        <LockIcon aria-hidden="true" className="size-4" />
        Not trusted yet
      </h2>
      <p className="text-sm text-muted-foreground">
        Enso isn’t reading this project’s own files ({settings.files.shared}, {settings.files.local}), so only your
        settings and Enso’s defaults apply: the setup commands and files to copy they list aren’t used.
      </p>
    </section>
  )
}

/** The project's trust, read once the page opens: `GET /api/projects/:id/settings`. Undefined while it is out. */
function useProjectSettings(
  projectId: string,
  fetchImpl: FetchLike | undefined,
): ProjectRequestOutcome<EnsoProjectSettings> | undefined {
  const [read, setRead] = useState<ProjectRequestOutcome<EnsoProjectSettings> | undefined>(undefined)
  useEffect(() => {
    let current = true
    setRead(undefined)
    void readProjectSettings(projectId, fetchImpl)
      .catch((error: unknown) => ({ kind: 'refused' as const, reason: String(error) }))
      .then((outcome) => {
        if (current) setRead(outcome)
      })
    return (): void => {
      current = false
    }
  }, [projectId, fetchImpl])
  return read
}

/** One of the project's threads as the Threads tab lists it: what the rail and the stored listing know of it. */
interface ThreadLine {
  readonly thread: ProjectThread
  readonly title: string
  readonly state: 'waiting' | 'running' | 'idle'
  readonly model: string | undefined
  readonly modelFull: string | undefined
}

/** A thread's line: its title as the rail names it, its state, and the model its file last records. */
function lineOf(
  thread: ProjectThread,
  pageThreads: readonly ThreadSummary[],
  stored: readonly EnsoStoredThread[],
): ThreadLine {
  const live = pageThreads.find((candidate) => candidate.threadId === thread.threadId)
  const kept = stored.find((candidate) => candidate.threadId === thread.threadId)
  const title = live?.name ?? live?.title ?? kept?.name ?? kept?.title ?? UNTITLED_THREAD
  let state: ThreadLine['state'] = 'idle'
  if (live?.waiting === true) state = 'waiting'
  else if (live?.busy === true || kept?.busy === true) state = 'running'
  const model = kept?.model
  return {
    thread,
    title,
    state,
    model: model?.modelId,
    modelFull: model === undefined ? undefined : `${model.provider}/${model.modelId}`,
  }
}

/** The Threads tab: the project's threads, most recent first, each opened as a rail row opens. */
function ThreadsTab({
  project,
  pageThreads,
  stored,
  onOpenThread,
}: {
  project: EnsoProject
  pageThreads: readonly ThreadSummary[]
  stored: readonly EnsoStoredThread[]
  onOpenThread: (thread: ProjectThread) => void
}): React.ReactNode {
  const context = { projects: [project], pageThreads, stored }
  const lines = threadsOfProject(project.projectId, context).map((thread) => lineOf(thread, pageThreads, stored))
  if (lines.length === 0) {
    return (
      <div className="grid gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-sm">
        <strong>No threads yet</strong>
        <span className="text-muted-foreground">
          {project.status === 'missing-dir'
            ? 'No thread can start here until the folder is back.'
            : 'Start one with New thread in the rail.'}
        </span>
      </div>
    )
  }
  return (
    <ul aria-label={`threads in ${project.title}`} className="grid">
      {lines.map((line) => (
        <li key={line.thread.threadId}>
          <button
            type="button"
            onClick={() => onOpenThread(line.thread)}
            className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-popover focus-visible:outline-2 focus-visible:outline-ring"
          >
            <LiveDot state={line.state} />
            <span className="min-w-0 flex-1 truncate">{line.title}</span>
            <span className="font-mono text-xs text-muted-foreground" title={line.modelFull}>
              {line.model ?? 'no model recorded'}
            </span>
            <span
              className="w-10 text-right font-mono text-xs text-muted-foreground"
              title={new Date(line.thread.at).toLocaleString()}
            >
              <Age from={new Date(line.thread.at)} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * What removing does, as the server does it (`project-routes.ts`, `projects.ts`): the registration
 * goes; the folder and the threads' files stay, unlisted and unopenable until the folder is added
 * again; refused while one of its threads runs. Pinned against the server in `server-handler.test.ts`.
 */
function removalWords(threadCount: number): string {
  const kept = 'Stops listing this project. Its folder and files aren’t touched.'
  if (threadCount === 0) return kept
  const threads =
    threadCount === 1 ? 'Its 1 thread stays on disk, but isn’t' : `Its ${threadCount} threads stay on disk, but aren’t`
  return `${kept} ${threads} listed or opened until you add this folder again. Enso won’t remove it while one of its threads is running.`
}

/** A removal: what it does, confirmed in a dialog that says it again before anything is sent. */
interface Removal {
  readonly project: EnsoProject
  readonly words: string
  readonly onRemove: (projectId: string) => void
}

/** The button that asks to remove the project, and the confirmation it opens. */
function RemoveConfirm({ removal, label }: { removal: Removal; label: string }): React.ReactNode {
  const { project, words, onRemove } = removal
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="justify-self-start">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {project.title} from Enso?</DialogTitle>
          <DialogDescription>{words}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button type="button" variant="destructive" onClick={() => onRemove(project.projectId)}>
              Remove project
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The Remove card, or for the launch folder why there is none. */
function RemoveCard({ removal }: { removal: Removal }): React.ReactNode {
  if (removal.project.launch)
    return (
      <p className="text-sm text-muted-foreground">This is the folder Enso was started in, so it can’t be removed.</p>
    )
  return (
    <section aria-labelledby="remove-title" className="grid gap-2 rounded-lg border bg-card px-4 py-3">
      <h2 id="remove-title" className="font-semibold">
        Remove from Enso
      </h2>
      <p className="text-sm text-muted-foreground">{removal.words}</p>
      <RemoveConfirm removal={removal} label="Remove project…" />
    </section>
  )
}

/** Over the tabs: a refused removal, the missing folder, and what isn't read while it is untrusted. */
function ProjectBanners({
  removal,
  settings,
  notice,
  onCheckAgain,
}: {
  removal: Removal
  settings: ProjectRequestOutcome<EnsoProjectSettings> | undefined
  notice: string | undefined
  onCheckAgain: () => Promise<ListingState<EnsoProject>>
}): React.ReactNode {
  return (
    <>
      {notice === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      )}
      {removal.project.status === 'missing-dir' ? (
        <MissingFolderBanner removal={removal} onCheckAgain={onCheckAgain} />
      ) : null}
      {settings?.kind === 'ok' && !settings.value.trusted ? <UntrustedBanner settings={settings.value} /> : null}
      {settings?.kind === 'refused' ? (
        <p role="alert" className="text-sm text-destructive">
          trust not read: {settings.reason}
        </p>
      ) : null}
    </>
  )
}

/** The tabs, at the route's: each a navigation of its own, so back returns to the tab before. */
function ProjectTabs({ project, props }: { project: EnsoProject; props: ProjectPageProps }): React.ReactNode {
  const { route, fetch: fetchImpl, pageThreads, stored, onOpen } = props
  return (
    <Tabs
      value={route.tab}
      onValueChange={(tab: string) => {
        const picked = PROJECT_TABS.find((known) => known === tab)
        if (picked !== undefined) onOpen({ ...route, tab: picked })
      }}
    >
      <TabsList variant="line" aria-label="Project sections">
        {PROJECT_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab}>
            {TAB_LABELS[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="threads" className="pt-3">
        <ThreadsTab project={project} pageThreads={pageThreads} stored={stored} onOpenThread={props.onOpenThread} />
      </TabsContent>
      <TabsContent value="worktrees" className="pt-3">
        <ProjectWorktrees projectId={project.projectId} fetch={fetchImpl} />
      </TabsContent>
      <TabsContent value="storage" className="pt-3">
        <ProjectStorage fetch={fetchImpl} project={project} stored={stored} onDeleted={props.onDeleted} />
      </TabsContent>
    </Tabs>
  )
}

/** The page for a project the listing has: banners, tabs, and the Remove card. */
function ProjectBody({ project, props }: { project: EnsoProject; props: ProjectPageProps }): React.ReactNode {
  const { fetch: fetchImpl, pageThreads, stored } = props
  const settings = useProjectSettings(project.projectId, fetchImpl)
  const threadCount = threadsOfProject(project.projectId, { projects: [project], pageThreads, stored }).length
  const removal: Removal = { project, words: removalWords(threadCount), onRemove: props.onRemove }
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 md:p-6">
      <ProjectBanners removal={removal} settings={settings} notice={props.notice} onCheckAgain={props.onCheckAgain} />
      <ProjectTabs project={project} props={props} />
      <RemoveCard removal={removal} />
    </div>
  )
}

/** The project the route names, once the projects are listed; not found when they are and it isn't among them. */
export function ProjectPage(props: ProjectPageProps): React.ReactNode {
  const { route, projects, onOpen } = props
  const project = projects.rows.find((row) => row.projectId === route.projectId)
  if (project !== undefined) return <ProjectBody key={project.projectId} project={project} props={props} />
  // The launch folder is always listed: no rows and no error is a listing not read yet.
  if (projects.rows.length === 0 && projects.error === undefined)
    return <p className="p-6 text-sm text-muted-foreground">Reading the projects…</p>
  return (
    <>
      {projects.error === undefined ? null : (
        <p role="alert" className="px-6 pt-6 text-sm text-destructive">
          projects not listed: {projects.error}
        </p>
      )}
      <ProjectNotFound asked={route.projectId} onOpen={onOpen} />
    </>
  )
}
