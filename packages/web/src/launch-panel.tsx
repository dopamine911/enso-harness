import type { EnsoProject, EnsoThreadTreeMode } from '@enso/core'
import { FolderIcon, TriangleAlertIcon } from 'lucide-react'
import { useContext, useId } from 'react'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { NotificationLines } from './notifications.tsx'
import { projectList, storedThreads } from './page-listings.ts'
import { LaunchActionsContext } from './pane-context.ts'
import { projectOf, threadsOfProject } from './project-list.ts'
import { threadLineOf } from './project-page.tsx'
import { useProjectSettings } from './project-status.tsx'
import { useStore, useThreadStores } from './store.ts'
import { threadListStore } from './thread-stores.ts'
import { Age, LiveDot } from './threads-rail.tsx'

/**
 * A new thread's launch panel (#877): the main pane before its session starts. "What should pi work
 * on?", where the session will run, why it cannot start there when it cannot, and — under the
 * composer, which is the form (`launch-settings.tsx`) — the project's recent threads, to pick one up
 * instead. Once Start goes through, the transcript takes the panel's place and the SAME composer
 * docks under it: moved, never copied, so its draft and attachments stay (`chat-layout.tsx`).
 */

/** Where a new thread runs, by the project's tree mode — the words of its Worktrees tab (`project-worktrees.tsx`). */
const TREE_WORDS: Readonly<Record<EnsoThreadTreeMode, string>> = {
  worktree: 'runs in its own worktree, not your checkout',
  copy: 'runs in a copy of the project folder',
  off: 'runs in the project folder itself',
}

/** How many of the project's threads the panel offers to pick up. */
const RECENT_THREADS = 3

/**
 * The project the thread runs in, and why a new thread cannot start there (with what to do), or
 * undefined when it can. Nothing is said while the projects are not listed yet: a thread then has no
 * project the page knows, which is not the same as having none.
 */
export function useLaunchProject(): {
  readonly project: EnsoProject | undefined
  readonly blocked: string | undefined
} {
  const stores = useThreadStores()
  const projects = useStore(projectList).rows
  const project = projectOf(projects, stores.projectId)
  if (projects.length === 0) return { project, blocked: undefined }
  if (project === undefined) {
    return {
      project,
      blocked:
        'This thread isn’t in a project the server lists, so there’s no folder for pi to work in. Start a new thread from a project in the rail.',
    }
  }
  if (project.status === 'missing-dir') {
    return {
      project,
      blocked: `The folder ${project.path} is gone, so no new thread can start here. Bring the folder back, or start the thread in another project; this project’s old threads stay readable.`,
    }
  }
  return { project, blocked: undefined }
}

/** The project's name, and where its new threads run — its tree mode, once its settings are read. */
function ProjectLine({ project }: { readonly project: EnsoProject }): React.ReactNode {
  const read = useProjectSettings([project.projectId], undefined).get(project.projectId)
  const tree = read?.kind === 'ok' ? read.value.threads.tree.value : undefined
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      <FolderIcon aria-hidden="true" className="size-4" />
      <span className="font-mono text-foreground" title={project.path}>
        {project.title}
      </span>
      {tree === undefined ? null : <span>· {TREE_WORDS[tree]}</span>}
    </p>
  )
}

/**
 * Above the composer: the question, where the session will run, and why it cannot start there.
 * `titleId` names the panel's region; a generated id, since an off-screen draft's panel stays mounted.
 */
export function LaunchHead({ titleId }: { readonly titleId: string }): React.ReactNode {
  const { project, blocked } = useLaunchProject()
  const actions = useContext(LaunchActionsContext)
  return (
    <div className="mx-auto mt-auto grid w-full max-w-2xl gap-2 px-6 pb-2">
      <h2 id={titleId} className="font-heading text-2xl font-semibold">
        What should pi work on?
      </h2>
      {project === undefined ? null : <ProjectLine project={project} />}
      {blocked === undefined ? null : (
        <Alert variant="destructive" className="mt-2">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>A new thread can’t start here</AlertTitle>
          <AlertDescription className="grid justify-items-start gap-2">
            <span>{blocked}</span>
            {actions === undefined ? null : (
              <Button type="button" variant="outline" size="sm" onClick={actions.manageProjects}>
                Manage projects
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * The thread's notices while its launch panel stands in for the transcript: what the page said on
 * it — a delete that brought it here (#663), a refused `/` command — would otherwise land in a
 * transcript nobody sees until Start.
 */
export function LaunchNotices(): React.ReactNode {
  const lines = useStore(useThreadStores().notifications)
  return <NotificationLines lines={lines} />
}

/**
 * Under the composer: up to three of the project's threads that hold something, most recent first —
 * never this one — each with its state and age, opened as a rail row opens it. Nothing on a pane no
 * page holds, or in a project with no other thread.
 */
export function LaunchRecent(): React.ReactNode {
  const stores = useThreadStores()
  const actions = useContext(LaunchActionsContext)
  const { project } = useLaunchProject()
  const heading = useId()
  const pageThreads = useStore(threadListStore)
  const stored = useStore(storedThreads).rows
  const projects = useStore(projectList).rows
  const recent =
    project === undefined
      ? []
      : threadsOfProject(project.projectId, { projects, pageThreads, stored })
          .filter((thread) => thread.threadId !== stores.threadId)
          .slice(0, RECENT_THREADS)
          .map((thread) => threadLineOf(thread, pageThreads, stored))
  return (
    <div className="mx-auto mb-auto w-full max-w-2xl px-6 pt-4">
      {actions === undefined || recent.length === 0 ? null : (
        <section aria-labelledby={heading} className="grid gap-1">
          <h3 id={heading} className="px-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Or pick up where you left off
          </h3>
          <ul className="grid">
            {recent.map((line) => (
              <li key={line.thread.threadId}>
                <button
                  type="button"
                  onClick={(): void => actions.openThread(line.thread)}
                  className="flex min-h-9 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-popover focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <LiveDot state={line.state} />
                  <span className="min-w-0 flex-1 truncate">{line.title}</span>
                  <span
                    className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
                    title={new Date(line.thread.at).toLocaleString()}
                  >
                    <Age from={new Date(line.thread.at)} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
