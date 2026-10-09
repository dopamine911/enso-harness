import { ENSO_NOTICE_SOURCE, type EnsoForkReceipt } from '@enso/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AddProjectDialog } from './add-project.tsx'
import { AppHeader } from './page-header.tsx'
import { type PageListings, projectList, storedThreads, usePageListings } from './page-listings.ts'
import { mintPageThread, adoptPageThread, isDebugMode } from './page-mode.ts'
import type { ThreadView } from './pane-context.ts'
import { removeProject, threadAfterDelete } from './project-list.ts'
import { ProjectSettingsDialog } from './project-settings-dialog.tsx'
import { createResumeRequests, fetchThreadHistory, storedThreadsNotOnThisPage } from './stored-threads.ts'
import { ThreadPane } from './thread-pane.tsx'
import { dropThread, getThreadStores, markThreadActive, threadListStore } from './thread-stores.ts'
import { readThreadUrl, type ThreadUrl, urlForThread } from './thread-url.ts'
import { forkParentTitles, ThreadsRail } from './threads-rail.tsx'

/**
 * The page (#90, #142): the header, the threads rail and one mounted pane per live thread, and the
 * navigation that keeps the URL, history and the shown pane in step. Importable with no DOM at
 * module scope: the entry that mounts it is `main.tsx`.
 */

/**
 * The URL names the thread (#142). A page that names one adopts it from `/history` before
 * showing a pane; a page that names none, or names something that is not a thread id,
 * mints a fresh one as every page load did before (#86) — and writes its id to the URL at
 * once, so a reload from the first prompt on shows this thread, not another fresh one.
 */
const BOOT: ThreadUrl = typeof window === 'undefined' ? { kind: 'fresh' } : readThreadUrl(window.location.search)
const FIRST_THREAD_ID: string | undefined = BOOT.kind === 'fresh' ? mintPageThread().threadId : undefined
// The boot thread is on screen before any navigation happens, so the store has to be told
// here too — otherwise the first pane is evictable until the user clicks something.
markThreadActive(FIRST_THREAD_ID)
if (FIRST_THREAD_ID !== undefined && typeof window !== 'undefined') {
  window.history.replaceState(null, '', urlForThread(window.location.search, FIRST_THREAD_ID))
}

/** How the active thread came to change — what, if anything, is written to history. */
type ThreadNavigation =
  /** A click: a new history entry, so back returns to the thread before it. */
  | 'push'
  /** The page's own doing (a fresh thread after a failed boot): the current entry is rewritten. */
  | 'replace'
  /** Back or forward: history already moved; the page follows it. */
  | 'pop'

/**
 * A narrow screen shows the rail OR the thread — the design's rail under 760px (#407); choosing a
 * thread from the rail goes back to it. `leave` wraps a rail action so it also closes the rail.
 */
function useNarrowRail(): {
  open: boolean
  toggle: () => void
  leave: <Arg>(act: (arg: Arg) => void) => (arg: Arg) => void
  paneClass: string
} {
  const [open, setOpen] = useState(false)
  return {
    open,
    toggle: () => setOpen((current) => !current),
    leave: (act) => (arg) => {
      setOpen(false)
      act(arg)
    },
    // `relative`: every pane is `absolute inset-0` in this box, shown or not (#370).
    paneClass: open ? 'relative flex min-w-0 flex-1 max-md:hidden' : 'relative flex min-w-0 flex-1',
  }
}

/** How a resume's request means to reach history, and the navigation it was issued under. */
interface ResumeIntent {
  how: ThreadNavigation
  epoch: number
  prefill?: string
  fromUrl?: boolean
  /** Said on the thread once it is adopted — a delete's, when the page went to this thread (#663). */
  notice?: string
}

/** What a resume's outcome reaches back into: the navigation count, the shown pane, the move itself, and the rail's error. */
interface ResumeOutcomeTargets {
  readonly epoch: React.RefObject<number>
  readonly activePane: React.RefObject<string | undefined>
  readonly navigate: (threadId: string, how: ThreadNavigation) => void
  readonly setResumeError: (error: string | undefined) => void
}

/** The page's resume coordinator: each outcome lands only if no navigation happened since its request. */
function useResumeRequests({
  epoch,
  activePane,
  navigate,
  setResumeError,
}: ResumeOutcomeTargets): (threadId: string, intent: ResumeIntent) => void {
  return useMemo(() => {
    /**
     * The thread a resume leaves on screen, with the intent's notice said on it: the adopted thread,
     * or the fresh one a failure leaves — a delete whose next thread could not be resumed still says
     * the delete (#721).
     */
    const showing = (threadId: string, intent: ResumeIntent): string => {
      if (intent.notice !== undefined) {
        getThreadStores(threadId).notifications.push(intent.notice, 'info', 'run', ENSO_NOTICE_SOURCE)
      }
      return threadId
    }
    // The page must show SOMETHING: a resume that failed with no pane behind it (the boot's, a rail
    // click while the boot was still out, or a delete's next thread) leaves a fresh thread, said
    // (the error is on the rail), and the URL rewritten so a reload does not ask again.
    const freshIfNothingShown = (intent: ResumeIntent): void => {
      if (activePane.current === undefined) navigate(showing(mintPageThread().threadId, intent), 'replace')
    }
    // `prefill` rides with a fork's open (#433): the new thread's composer opens holding it.
    // `fromUrl`: the id is the URL's (the boot, back/forward), not a row or a fork (#378).
    return createResumeRequests<ResumeIntent>(
      fetchThreadHistory,
      (history, intent) => {
        if (intent.epoch !== epoch.current) return // a navigation happened since — superseded
        setResumeError(undefined)
        navigate(showing(adoptPageThread(history, intent.prefill).threadId, intent), intent.how)
      },
      (message, intent) => {
        if (intent.epoch !== epoch.current) return
        setResumeError(message)
        freshIfNothingShown(intent)
      },
      (threadId, intent) => {
        if (intent.epoch !== epoch.current) return
        // ⚠ #378: the server holds nothing under the URL's own id — the page wrote it before the
        // first prompt, and the server restarted or dropped the empty thread since. Not an error:
        // the thread is started under the id the URL already names. A 403 (a file outside the
        // projects) is a failure above, never this.
        if (intent.fromUrl === true) {
          setResumeError(undefined)
          navigate(mintPageThread(undefined, threadId).threadId, intent.how)
          return
        }
        // A rail row or a fork the server no longer holds: the listing was stale. Said.
        setResumeError(`the server holds no session for thread ${threadId}`)
        freshIfNothingShown(intent)
      },
    )
  }, [epoch, activePane, navigate, setResumeError])
}

/**
 * Back/forward: the URL moved; the page follows it — a thread on this page is a switch, one
 * that is not is a resume. Neither writes history again.
 */
function useFollowUrlHistory(
  navigate: (threadId: string, how: ThreadNavigation) => void,
  resumeFrom: (threadId: string, how: ThreadNavigation, fromUrl?: boolean) => void,
): void {
  useEffect(() => {
    const onPopState = (): void => {
      const named = readThreadUrl(window.location.search)
      if (named.kind !== 'resume') return
      if (threadListStore.get().some((thread) => thread.threadId === named.threadId)) {
        navigate(named.threadId, 'pop')
        return
      }
      resumeFrom(named.threadId, 'pop', true)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [navigate, resumeFrom])
}

/** The rail's project controls: whether the add dialog is open, which project's page is, what a refused removal said, and the removal itself. */
interface ProjectEditing {
  readonly addingProject: boolean
  readonly setAddingProject: (adding: boolean) => void
  /** The project whose page (#754) is open, or undefined. */
  readonly settingsProjectId: string | undefined
  readonly setSettingsProjectId: (projectId: string | undefined) => void
  readonly projectNotice: string | undefined
  readonly setProjectNotice: (notice: string | undefined) => void
  readonly forgetProject: (projectId: string) => Promise<void>
}

/**
 * Adding and removing projects (#395 slice 3), and opening one's page (#754). A refused removal is
 * said on the rail; a removed project's open threads stay, under "other" — the server ended them,
 * and the rail never drops one.
 */
function useProjectEditing(): ProjectEditing {
  const [addingProject, setAddingProject] = useState(false)
  const [settingsProjectId, setSettingsProjectId] = useState<string | undefined>(undefined)
  const [projectNotice, setProjectNotice] = useState<string | undefined>(undefined)
  const forgetProject = async (projectId: string): Promise<void> => {
    const outcome = await removeProject(projectId)
    setProjectNotice(outcome.kind === 'ok' ? undefined : `could not remove the project: ${outcome.reason}`)
    await Promise.all([projectList.refresh(), storedThreads.refresh()])
  }
  return {
    addingProject,
    setAddingProject,
    settingsProjectId,
    setSettingsProjectId,
    projectNotice,
    setProjectNotice,
    forgetProject,
  }
}

/** What a deleted thread's departure reaches into: the page's navigation state and its listings. */
interface LeaveDeletedTargets {
  readonly epoch: React.RefObject<number>
  readonly activePane: React.RefObject<string | undefined>
  readonly navigate: (threadId: string, how: ThreadNavigation) => void
  readonly resume: (threadId: string, intent: ResumeIntent) => void
  readonly listings: PageListings
}

/**
 * A deleted thread (#571) leaves the page: its pane goes, and the listing refreshes so the rail
 * cannot offer it again. On screen still, the page shows its project's most recent other thread
 * (#663), a fresh thread only when the project holds no other, written over its URL so back does
 * not ask for the deleted id. ⚠ Off screen (the user moved while the server worked), nothing moves
 * the user: the answer is said on the thread they are on, and its history entry stays its own.
 */
function useLeaveDeleted({
  epoch,
  activePane,
  navigate,
  resume,
  listings,
}: LeaveDeletedTargets): (threadId: string) => void {
  const { threads, stored, projects } = listings
  return useCallback(
    (threadId: string): void => {
      // Off screen while the server worked, its stores may already be gone: the follow budget drops
      // idle threads. Only the one on screen is read, and that one the budget never drops.
      const wasShown = activePane.current === threadId
      const next = wasShown
        ? threadAfterDelete(threadId, getThreadStores(threadId).projectId, {
            projects: projects.rows,
            pageThreads: threads,
            stored: stored.rows,
          })
        : undefined
      const projectId = wasShown ? getThreadStores(threadId).projectId : undefined
      // Dropped before a fresh one is minted, so the deleted thread is not what pushes another out of the budget.
      dropThread(threadId)
      void storedThreads.refresh()
      const said = `thread ${threadId} deleted`
      // A stored thread is resumed, its history read first: the notice rides with the resume and is
      // said on the thread once it is adopted (#721). Nothing is on screen meanwhile, so a resume
      // that fails leaves a fresh thread, as one with no pane behind it does.
      if (next !== undefined && !next.onPage) {
        activePane.current = undefined
        resume(next.threadId, { how: 'replace', epoch: epoch.current, notice: said })
        return
      }
      const shown = wasShown ? (next?.threadId ?? mintPageThread(projectId).threadId) : activePane.current
      if (shown === undefined) return
      if (wasShown) navigate(shown, 'replace')
      getThreadStores(shown).notifications.push(said, 'info', 'run', ENSO_NOTICE_SOURCE)
    },
    [epoch, activePane, navigate, resume, projects.rows, threads, stored.rows],
  )
}

/** The page's navigation: the shown thread, the rail's resume error, and every way the shown thread changes. */
interface PageNavigation {
  /** Undefined only while a URL-named thread is being adopted: no pane, nothing active. */
  readonly activeThreadId: string | undefined
  readonly resumeError: string | undefined
  readonly navigate: (threadId: string, how: ThreadNavigation) => void
  readonly resumeFrom: (threadId: string, how: ThreadNavigation, fromUrl?: boolean) => void
  readonly openFork: (receipt: EnsoForkReceipt) => void
  readonly leaveDeleted: (threadId: string) => void
}

/**
 * The page's navigation (#142): the boot's adoption, rail clicks, forks, deletes, and back/forward,
 * each keeping the URL, history and the shown pane in step.
 *
 * ⚠ A resume's outcome reads two facts from its own request, never from shared state: HOW the
 * request meant to reach history (it rides with the request, `intent`), and WHETHER a navigation
 * happened since (`epoch` counts every navigation, and an outcome from before the current one is
 * dropped whole). New Thread during the boot's "resuming…" therefore wins outright: the URL says the
 * new thread, the pane shows it, and the boot's answer arrives to nobody (#143). `activePane`
 * mirrors `activeThreadId` for the same closures.
 */
function usePageNavigation(listings: PageListings): PageNavigation {
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(FIRST_THREAD_ID)
  const [resumeError, setResumeError] = useState<string | undefined>(BOOT.kind === 'fresh' ? BOOT.notice : undefined)
  const epoch = useRef(0)
  const activePane = useRef<string | undefined>(FIRST_THREAD_ID)
  /** Make `threadId` the active pane, and tell history how it happened. History state is `null`: the URL is read back, never the state object. */
  const navigate = useCallback((threadId: string, how: ThreadNavigation): void => {
    epoch.current += 1
    activePane.current = threadId
    // The follow budget needs this too: the visible thread is not a drop candidate, and
    // being looked at is what counts as activity for the one being left behind (#272).
    markThreadActive(threadId)
    setActiveThreadId(threadId)
    if (how === 'pop' || typeof window === 'undefined') return
    const url = urlForThread(window.location.search, threadId)
    if (how === 'push') window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
  }, [])
  const resume = useResumeRequests({ epoch, activePane, navigate, setResumeError })
  const resumeFrom = useCallback(
    (threadId: string, how: ThreadNavigation, fromUrl = false): void =>
      resume(threadId, { how, epoch: epoch.current, fromUrl }),
    [resume],
  )
  // A fork (#433) opens the way a rail resume does, its composer holding the forked prompt's
  // words; the listing refreshes so the rail shows the fork and whose it is.
  const openFork = useCallback(
    (receipt: EnsoForkReceipt): void => {
      void storedThreads.refresh()
      resume(receipt.threadId, { how: 'push', epoch: epoch.current, prefill: receipt.prefill })
    },
    [resume],
  )
  const leaveDeleted = useLeaveDeleted({ epoch, activePane, navigate, resume, listings })
  // Boot: the URL named a thread — adopt it. Once per page; the coordinator drops a stale answer.
  useEffect(() => {
    // Not state and not a parent: `BOOT` is a module constant read once, `resumeFrom` this component's own request (#747).
    // react-doctor-disable-next-line no-pass-live-state-to-parent
    if (BOOT.kind === 'resume') resumeFrom(BOOT.threadId, 'pop', true)
  }, [resumeFrom])
  useFollowUrlHistory(navigate, resumeFrom)
  return { activeThreadId, resumeError, navigate, resumeFrom, openFork, leaveDeleted }
}

/** The page (#90): header, the sessions rail, and one mounted pane per live thread. */
export function ChatScreen(): React.ReactNode {
  const listings = usePageListings()
  const { threads, stored, projects } = listings
  const { activeThreadId, resumeError, navigate, resumeFrom, openFork, leaveDeleted } = usePageNavigation(listings)
  const pageThreadIds = new Set(threads.map((thread) => thread.threadId))
  const editing = useProjectEditing()
  const { addingProject, setAddingProject, projectNotice, setProjectNotice, forgetProject } = editing
  // The debug column (#86) is a right-hand pane, so it never takes height from the conversation it
  // explains. Opt-in by `?debug`, open by default when it is, and collapsible from the header.
  const [debugOpen, setDebugOpen] = useState(isDebugMode)
  const [view, setView] = useState<ThreadView>('chat')
  const rail = useNarrowRail()
  const active = threads.find((thread) => thread.threadId === activeThreadId)
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <AppHeader
        active={active}
        activeThreadId={activeThreadId}
        rail={rail}
        view={view}
        onView={setView}
        debugOpen={debugOpen}
        onToggleDebug={() => setDebugOpen((open) => !open)}
        onDeleted={leaveDeleted}
        stored={stored.rows}
      />
      <div className="flex min-h-0 flex-1">
        <ThreadsRail
          projects={projects.rows}
          threads={threads}
          activeThreadId={activeThreadId}
          earlier={storedThreadsNotOnThisPage(stored.rows, pageThreadIds)}
          forkParents={forkParentTitles(stored.rows, threads)}
          earlierError={stored.error ?? projects.error}
          openError={resumeError}
          onSelect={rail.leave((threadId: string) => navigate(threadId, 'push'))}
          onResume={rail.leave((threadId: string) => resumeFrom(threadId, 'push'))}
          onNew={rail.leave((projectId: string | undefined) => navigate(mintPageThread(projectId).threadId, 'push'))}
          onAddProject={() => setAddingProject(true)}
          onRemoveProject={(projectId: string) => void forgetProject(projectId)}
          onProjectSettings={editing.setSettingsProjectId}
          projectNotice={projectNotice}
          shownNarrow={rail.open}
        />
        <AddProjectDialog
          open={addingProject}
          onClose={() => setAddingProject(false)}
          onAdded={() => {
            setProjectNotice(undefined)
            void projectList.refresh()
            void storedThreads.refresh()
          }}
        />
        <ProjectSettingsDialog
          project={projects.rows.find((project) => project.projectId === editing.settingsProjectId)}
          onClose={() => editing.setSettingsProjectId(undefined)}
        />
        <div className={rail.paneClass}>
          {threads.map((thread) => (
            <ThreadPane
              key={thread.threadId}
              threadId={thread.threadId}
              active={thread.threadId === activeThreadId}
              debugOpen={isDebugMode && debugOpen}
              view={view}
              onView={setView}
              onForked={openFork}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
