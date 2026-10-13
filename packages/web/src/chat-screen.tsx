import { ENSO_NOTICE_SOURCE, type EnsoForkReceipt } from '@enso/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppHeader } from './page-header.tsx'
import { type PageListings, projectList, storedThreads, usePageListings } from './page-listings.ts'
import { mintPageThread, adoptPageThread, isDebugMode } from './page-mode.ts'
import type { ThreadView } from './pane-context.ts'
import { removeProject, threadAfterDelete, threadsOfProject } from './project-list.ts'
import { PageHeader, RoutedPage, type RoutedPageProps } from './routed-page.tsx'
import { createResumeRequests, fetchThreadHistory, storedThreadsNotOnThisPage } from './stored-threads.ts'
import { ThreadNotFound } from './thread-not-found.tsx'
import { ThreadPane } from './thread-pane.tsx'
import { dropThread, getThreadStores, markThreadActive, threadListStore } from './thread-stores.ts'
import {
  type PageRoute,
  type PageUrl,
  PROJECTS_ROUTE,
  projectRoute,
  readPageUrl,
  readThreadUrl,
  showsPage,
  type ThreadUrl,
  urlForPage,
  urlForThread,
  urlOpeningThread,
} from './thread-url.ts'
import { forkParentTitles, ThreadsRail } from './threads-rail.tsx'

/**
 * The page (#90, #142): the header, the threads rail and one mounted pane per live thread, and the
 * navigation that keeps the URL, history and the shown pane in step — and the pages beside the
 * threads (#869), drawn over the panes. Importable with no DOM at module scope: the entry that
 * mounts it is `main.tsx`.
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
  /** A click: a new history entry, so back returns to the thread before it — or to the page (#869) it left. */
  | 'push'
  /** The page's own doing (a fresh thread after a failed boot, a delete): the current entry is rewritten, a page on it kept. */
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

/** What a resume's outcome reaches back into: the navigation count, the shown pane, the move itself, the rail's error and the not-found screen. */
interface ResumeOutcomeTargets {
  readonly epoch: React.RefObject<number>
  readonly activePane: React.RefObject<string | undefined>
  readonly navigate: (threadId: string, how: ThreadNavigation) => void
  readonly setResumeError: (error: string | undefined) => void
  readonly setMissingThread: (threadId: string) => void
}

/** The page's resume coordinator: each outcome lands only if no navigation happened since its request. */
function useResumeRequests({
  epoch,
  activePane,
  navigate,
  setResumeError,
  setMissingThread,
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
        freshIfNothingShown(intent)
        // A rail row, a fork or a project's thread the server no longer holds: the listing was
        // stale. The pane says so (#879), over whatever is behind it. A delete's next thread is
        // the page's own pick, not the reader's: it says the delete on a fresh thread, and the rail why.
        if (intent.notice === undefined) setMissingThread(threadId)
        else setResumeError(`the server holds no session for thread ${threadId}`)
      },
    )
  }, [epoch, activePane, navigate, setResumeError, setMissingThread])
}

/**
 * Back/forward: the URL moved; the page follows it — the page it names (#869), or none, and its
 * thread: one on this page is a switch, one that is not is a resume. Neither writes history again.
 */
function useFollowUrlHistory(
  navigate: (threadId: string, how: ThreadNavigation) => void,
  resumeFrom: (threadId: string, how: ThreadNavigation, fromUrl?: boolean) => void,
  showPage: (page: PageUrl | undefined) => void,
): void {
  useEffect(() => {
    const onPopState = (): void => {
      showPage(readPageUrl(window.location.search))
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
  }, [navigate, resumeFrom, showPage])
}

/** The rail's project controls: what a refused removal said, and the removal itself. */
interface ProjectEditing {
  readonly projectNotice: string | undefined
  readonly setProjectNotice: (notice: string | undefined) => void
  /** Remove the project: whether the server did — a refusal is the notice. */
  readonly forgetProject: (projectId: string) => Promise<boolean>
}

/**
 * Removing projects (#395 slice 3); adding one is a page (#872). A refused removal is said on the
 * rail, on Projects and on the project's page (#871); a removed project's open threads stay, under
 * "other" — the server ended them, and the rail never drops one.
 */
function useProjectEditing(): ProjectEditing {
  const [projectNotice, setProjectNotice] = useState<string | undefined>(undefined)
  const forgetProject = async (projectId: string): Promise<boolean> => {
    const outcome = await removeProject(projectId)
    setProjectNotice(outcome.kind === 'ok' ? undefined : `could not remove the project: ${outcome.reason}`)
    await Promise.all([projectList.refresh(), storedThreads.refresh()])
    return outcome.kind === 'ok'
  }
  return { projectNotice, setProjectNotice, forgetProject }
}

/** What a thread's departure reaches into: the page's navigation state and its listings. */
interface LeaveThreadTargets {
  readonly epoch: React.RefObject<number>
  readonly activePane: React.RefObject<string | undefined>
  readonly navigate: (threadId: string, how: ThreadNavigation) => void
  readonly resume: (threadId: string, intent: ResumeIntent) => void
  readonly listings: PageListings
}

/**
 * A deleted thread (#571), or a discarded draft (#879), leaves the page: its pane goes, and the
 * listing refreshes so the rail cannot offer it again. On screen still, the page shows its project's
 * most recent other thread (#663), a fresh thread only when the project holds no other, written over
 * its URL so back does not ask for the gone id; `said` is said there. ⚠ Off screen (the user moved
 * while the server worked), nothing moves the user: `said` is said on the thread they are on, and
 * its history entry stays its own.
 */
function useLeaveThread({
  epoch,
  activePane,
  navigate,
  resume,
  listings,
}: LeaveThreadTargets): Pick<PageNavigation, 'leaveDeleted' | 'discardDraft'> {
  const { threads, stored, projects } = listings
  const leave = useCallback(
    (threadId: string, said: string): void => {
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
      // Dropped before a fresh one is minted, so the gone thread is not what pushes another out of the budget.
      dropThread(threadId)
      void storedThreads.refresh()
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
  return {
    leaveDeleted: useCallback((threadId: string): void => leave(threadId, `thread ${threadId} deleted`), [leave]),
    discardDraft: useCallback((threadId: string): void => leave(threadId, 'draft discarded'), [leave]),
  }
}

/** The page's navigation: the shown thread, the page over it, the rail's resume error, and every way either changes. */
interface PageNavigation {
  /** Undefined only while a URL-named thread is being adopted: no pane, nothing active. */
  readonly activeThreadId: string | undefined
  /** The page beside the threads on screen (#869), or undefined: the active thread is. */
  readonly page: PageUrl | undefined
  readonly resumeError: string | undefined
  readonly navigate: (threadId: string, how: ThreadNavigation) => void
  readonly resumeFrom: (threadId: string, how: ThreadNavigation, fromUrl?: boolean) => void
  readonly openFork: (receipt: EnsoForkReceipt) => void
  readonly leaveDeleted: (threadId: string) => void
  /** A draft is discarded (#879): it leaves the page as a deleted thread does. */
  readonly discardDraft: (threadId: string) => void
  /** The thread id the not-found screen names (#879), or undefined: none is shown. */
  readonly missingThread: string | undefined
  /** Show a page, a history entry of its own; the one on screen already is no navigation. */
  readonly openPage: (route: PageRoute) => void
  /** Leave the page for the thread behind it, or a fresh one when none is adopted yet. */
  readonly leavePage: () => void
}

/** What a thread that could not be opened leaves said: the rail's line (#95), or the pane's not-found screen (#879). */
function useOpenFailures(): {
  resumeError: string | undefined
  setResumeError: (error: string | undefined) => void
  missingThread: string | undefined
  setMissingThread: (threadId: string | undefined) => void
} {
  const [resumeError, setResumeError] = useState<string | undefined>(BOOT.kind === 'fresh' ? BOOT.notice : undefined)
  const [missingThread, setMissingThread] = useState<string | undefined>(undefined)
  return { resumeError, setResumeError, missingThread, setMissingThread }
}

/**
 * The page's navigation (#142): the boot's adoption, rail clicks, forks, deletes, and back/forward,
 * each keeping the URL, history and the shown pane in step — and the pages (#869): opening one, and
 * leaving it for a thread.
 *
 * ⚠ A resume's outcome reads two facts from its own request, never from shared state: HOW the
 * request meant to reach history (it rides with the request, `intent`), and WHETHER a navigation
 * happened since (`epoch` counts every navigation, and an outcome from before the current one is
 * dropped whole). New Thread during the boot's "resuming…" therefore wins outright: the URL says the
 * new thread, the pane shows it, and the boot's answer arrives to nobody (#143). Opening a page is
 * a navigation too: a thread asked for before it does not pull the reader off the page when it
 * lands. `activePane` mirrors `activeThreadId` for the same closures.
 */
function usePageNavigation(listings: PageListings): PageNavigation {
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(FIRST_THREAD_ID)
  // Read at mount, not at module scope as the thread is: nothing is minted for a page.
  const [page, setPage] = useState<PageUrl | undefined>(() =>
    typeof window === 'undefined' ? undefined : readPageUrl(window.location.search),
  )
  const { resumeError, setResumeError, missingThread, setMissingThread } = useOpenFailures()
  const epoch = useRef(0)
  const activePane = useRef<string | undefined>(FIRST_THREAD_ID)
  /**
   * Make `threadId` the active pane, and tell history how it happened. History state is `null`: the
   * URL is read back, never the state object. A click leaves the page on screen; the page's own
   * rewrite and back/forward leave it as the URL has it.
   */
  const navigate = useCallback(
    (threadId: string, how: ThreadNavigation): void => {
      epoch.current += 1
      activePane.current = threadId
      // The follow budget needs this too: the visible thread is not a drop candidate, and
      // being looked at is what counts as activity for the one being left behind (#272).
      markThreadActive(threadId)
      setActiveThreadId(threadId)
      setMissingThread(undefined)
      if (how === 'push') setPage(undefined)
      if (how === 'pop' || typeof window === 'undefined') return
      if (how === 'push') window.history.pushState(null, '', urlOpeningThread(window.location.search, threadId))
      else window.history.replaceState(null, '', urlForThread(window.location.search, threadId))
    },
    [setMissingThread],
  )
  const openPage = useCallback(
    (route: PageRoute): void => {
      if (showsPage(window.location.search, route)) return
      epoch.current += 1
      setMissingThread(undefined)
      setPage(route)
      window.history.pushState(null, '', urlForPage(window.location.search, route))
    },
    [setMissingThread],
  )
  const leavePage = useCallback(
    (): void => navigate(activePane.current ?? mintPageThread().threadId, 'push'),
    [navigate],
  )
  const resume = useResumeRequests({ epoch, activePane, navigate, setResumeError, setMissingThread })
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
  const departures = useLeaveThread({ epoch, activePane, navigate, resume, listings })
  // Boot: the URL named a thread — adopt it. Once per page; the coordinator drops a stale answer.
  useEffect(() => {
    // Not state and not a parent: `BOOT` is a module constant read once, `resumeFrom` this component's own request (#747).
    // react-doctor-disable-next-line no-pass-live-state-to-parent
    if (BOOT.kind === 'resume') resumeFrom(BOOT.threadId, 'pop', true)
  }, [resumeFrom])
  useFollowUrlHistory(navigate, resumeFrom, setPage)
  return {
    activeThreadId,
    page,
    resumeError,
    missingThread,
    navigate,
    resumeFrom,
    openFork,
    ...departures,
    openPage,
    leavePage,
  }
}

/**
 * A Projects card's **Open threads** (#870): the project's most recently active thread — shown at
 * once when it is on this page, resumed when stored — or, when it has none, a new thread in it.
 * Either way the page is left, as a rail click leaves it. A gone folder with no thread offers none.
 */
function openProjectThreads(projectId: string, listings: PageListings, navigation: PageNavigation): void {
  const { threads, stored, projects } = listings
  const latest = threadsOfProject(projectId, { projects: projects.rows, pageThreads: threads, stored: stored.rows })[0]
  if (latest === undefined) navigation.navigate(mintPageThread(projectId).threadId, 'push')
  else if (latest.onPage) navigation.navigate(latest.threadId, 'push')
  else navigation.resumeFrom(latest.threadId, 'push')
}

/**
 * What a project's page does (#871): a thread of its list opens as a rail row does — shown when on
 * this page, else resumed; Check again reads the projects and answers them as they now stand; a
 * removal that went through leaves the page for Projects, where the project is gone too.
 */
function projectPageActions(
  navigation: PageNavigation,
  forgetProject: (projectId: string) => Promise<boolean>,
): RoutedPageProps['projectPageActions'] {
  return {
    onOpenThread: (thread) =>
      thread.onPage ? navigation.navigate(thread.threadId, 'push') : navigation.resumeFrom(thread.threadId, 'push'),
    onCheckAgain: async () => {
      await projectList.refresh()
      return projectList.get()
    },
    onRemove: (projectId) =>
      void forgetProject(projectId).then((removed) => {
        if (removed) navigation.openPage(PROJECTS_ROUTE)
      }),
  }
}

/** The page (#90): header, the sessions rail, one mounted pane per live thread, and a page over them (#869). */
export function ChatScreen(): React.ReactNode {
  const listings = usePageListings()
  const { threads, stored, projects } = listings
  const navigation = usePageNavigation(listings)
  const { activeThreadId, page, resumeError, missingThread, navigate, resumeFrom, openFork, openPage } = navigation
  const pageThreadIds = new Set(threads.map((thread) => thread.threadId))
  const editing = useProjectEditing()
  const { projectNotice, setProjectNotice, forgetProject } = editing
  // The debug column (#86): a right-hand pane, so it never takes height from the conversation it
  // explains. Opt-in by `?debug`, open by default when it is, and collapsible from the header.
  const [debugOpen, setDebugOpen] = useState(isDebugMode)
  const [view, setView] = useState<ThreadView>('chat')
  const rail = useNarrowRail()
  const active = threads.find((thread) => thread.threadId === activeThreadId)
  const newThread = (projectId: string | undefined): void => navigate(mintPageThread(projectId).threadId, 'push')
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {page === undefined ? (
        <AppHeader
          active={active}
          activeThreadId={activeThreadId}
          notFound={missingThread !== undefined}
          rail={rail}
          view={view}
          onView={setView}
          debug={isDebugMode ? { open: debugOpen, toggle: () => setDebugOpen((open) => !open) } : undefined}
          onDeleted={navigation.leaveDeleted}
          onDiscardDraft={navigation.discardDraft}
          stored={stored.rows}
        />
      ) : (
        <PageHeader page={page} projects={projects.rows} rail={rail} onOpen={openPage} />
      )}
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
          onNew={rail.leave(newThread)}
          onRemoveProject={(projectId: string) => void forgetProject(projectId)}
          onProjectSettings={rail.leave((projectId: string) => openPage(projectRoute(projectId, 'worktrees')))}
          // On Projects and a project's page, a refused removal is said on the page it was asked from: once.
          projectNotice={page?.kind === 'projects' || page?.kind === 'project' ? undefined : projectNotice}
          onPage={rail.leave(openPage)}
          page={page?.kind === 'not-found' ? page.within : page?.kind}
          shownNarrow={rail.open}
        />
        <div className={rail.paneClass}>
          {threads.map((thread) => (
            <ThreadPane
              key={thread.threadId}
              threadId={thread.threadId}
              active={page === undefined && missingThread === undefined && thread.threadId === activeThreadId}
              debugOpen={isDebugMode && debugOpen}
              view={view}
              onView={setView}
              onForked={openFork}
            />
          ))}
          {page === undefined && missingThread !== undefined ? (
            <ThreadNotFound
              threadId={missingThread}
              onNew={() => newThread(active?.projectId)}
              onSearch={() => {
                // The rail has no search yet (#875 adds it): the not-found screen's way into the
                // threads is the rail itself — shown on a narrow screen, its first thread focused.
                if (!rail.open) rail.toggle()
                requestAnimationFrame(() =>
                  (
                    document.querySelector<HTMLElement>('#threads-rail ol button') ??
                    document.querySelector<HTMLElement>('#threads-rail button')
                  )?.focus(),
                )
              }}
            />
          ) : null}
          <RoutedPage
            page={page}
            onOpen={openPage}
            onLeave={navigation.leavePage}
            threadId={activeThreadId}
            projects={projects}
            stored={stored}
            pageThreads={threads}
            onDeleted={navigation.leaveDeleted}
            projectActions={{
              onOpenThreads: (projectId) => openProjectThreads(projectId, listings, navigation),
              onSettings: (projectId) => openPage(projectRoute(projectId, 'worktrees')),
              onRemove: (projectId) => void forgetProject(projectId),
            }}
            projectPageActions={projectPageActions(navigation, forgetProject)}
            projectNotice={projectNotice}
            onProjectAdded={(project) => {
              setProjectNotice(undefined)
              // The listing first: the project's page is headed by the project the listing names.
              void Promise.all([projectList.refresh(), storedThreads.refresh()]).then(() =>
                openPage(projectRoute(project.projectId)),
              )
            }}
          />
        </div>
      </div>
    </div>
  )
}
