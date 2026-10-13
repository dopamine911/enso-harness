import type { EnsoProject, EnsoThreadTreeMode } from '@enso/core'
import { FolderIcon, TriangleAlertIcon } from 'lucide-react'
import { useContext, useId } from 'react'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { isModeLine } from './mode-lines.ts'
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

/**
 * A refusal on the launch panel — this one, and Start's (`LaunchNotes`) — the prototype's `.alert`
 * (#417): ringed and faintly tinted in the refusal's colour, its title in it, its words in the text's.
 */
export const REFUSAL_ALERT =
  'gap-1 rounded-sm border-refuse bg-refuse/8 p-3 text-refuse *:data-[slot=alert-description]:text-foreground *:data-[slot=alert-title]:font-semibold'

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
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <FolderIcon aria-hidden="true" className="size-4" />
      <span className="font-mono text-xs text-foreground" title={project.path}>
        {project.title}
      </span>
      {tree === undefined ? null : <span>· {TREE_WORDS[tree]}</span>}
    </p>
  )
}

/**
 * Above the composer: the question, where the session will run, and why it cannot start there —
 * the prototype's `.launch-head` and `.launch-blocked` (#417), in the launch column's width.
 * `titleId` names the panel's region; a generated id, since an off-screen draft's panel stays mounted.
 */
export function LaunchHead({ titleId }: { readonly titleId: string }): React.ReactNode {
  const { project, blocked } = useLaunchProject()
  const actions = useContext(LaunchActionsContext)
  return (
    <div className="mx-auto grid w-full max-w-launch gap-6">
      <div className="grid gap-2">
        <h2 id={titleId} className="font-heading text-figure leading-tight font-semibold">
          What should pi work on?
        </h2>
        {project === undefined ? null : <ProjectLine project={project} />}
      </div>
      {blocked === undefined ? null : (
        <Alert className={REFUSAL_ALERT}>
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
 * transcript nobody sees until Start. Not its mode lines (#417): the Mode chip says the mode the
 * session starts in, and each setting is said once; the transcript still shows them after Start.
 */
export function LaunchNotices(): React.ReactNode {
  const lines = useStore(useThreadStores().notifications)
  return <NotificationLines lines={lines.filter((line) => !isModeLine(line.message))} />
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
    <div className="mx-auto w-full max-w-launch">
      {actions === undefined || recent.length === 0 ? null : (
        <section aria-labelledby={heading} className="grid gap-2">
          <h3 id={heading} className="font-mono text-meta font-normal tracking-wider text-muted-foreground uppercase">
            Or pick up where you left off
          </h3>
          <ul className="grid gap-0.5">
            {recent.map((line) => (
              <li key={line.thread.threadId}>
                <button
                  type="button"
                  onClick={(): void => actions.openThread(line.thread)}
                  className="flex min-h-10 w-full items-center gap-3 rounded-sm px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-card focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <LiveDot state={line.state} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{line.title}</span>
                  <span
                    className="shrink-0 font-mono text-meta whitespace-nowrap tabular-nums"
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
