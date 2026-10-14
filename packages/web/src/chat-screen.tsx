import { ENSO_NOTICE_SOURCE, type EnsoForkReceipt, type EnsoThreadHistory } from '@enso/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePageChecks } from './live-view-check.ts'
import { PageFaultBanner, PaneBoundary } from './page-fault.tsx'
import { AppHeader, type HeaderPanes, PANES_FULL } from './page-header.tsx'
import { type PageListings, projectList, storedThreads, usePageListings } from './page-listings.ts'
import { mintPageThread, adoptPageThread, isDebugMode } from './page-mode.ts'
import { CloseDebugContext, type LaunchActions, type ThreadView } from './pane-context.ts'
import {
  besideRows,
  closePane,
  focusedThread,
  focusPane,
  MAX_PANES,
  NO_PANES,
  openBeside,
  openInFocused,
  type PaneLayout,
  paneLayoutOf,
  replacePane,
  sideBySide,
  singlePane,
  usePanesThatFit,
} from './pane-layout.ts'
import { projectOf, removeProject, threadAfterDelete, threadsOfProject } from './project-list.ts'
import { PageHeader, RoutedPage, type RoutedPageProps } from './routed-page.tsx'
import { createResumeRequests, fetchThreadHistory, storedThreadsNotOnThisPage } from './stored-threads.ts'
import { ThreadNotFound } from './thread-not-found.tsx'
import { type PanePlace, ThreadPane } from './thread-pane.tsx'
import { PaneTabs } from './thread-panes.tsx'
import { discardEmptyDraft, dropThread, getThreadStores, markThreadActive, threadListStore } from './thread-stores.ts'
import {
  type PageRoute,
  type PageUrl,
  PROJECTS_ROUTE,
  projectRoute,
  readPageUrl,
  readPaneLayout,
  readThreadUrl,
  showsPage,
  type ThreadUrl,
  urlForPage,
  urlForPanes,
  urlOpeningPanes,
} from './thread-url.ts'
import { forkParentTitles, RAIL_SEARCH_ID, ThreadsRail } from './threads-rail.tsx'

/**
 * The page (#90, #142): the header, the threads rail and one mounted pane per live thread, and the
 * navigation that keeps the URL, history and the panes on screen in step — up to three of them side
 * by side, from any projects (#938) — and the pages beside the threads (#869), drawn over the panes.
 * Importable with no DOM at module scope: the entry that mounts it is `main.tsx`.
 */

/**
 * The URL names the thread (#142), and the panes beside it (#938). A page that names one adopts it
 * — and every pane it names — from `/history` before showing anything; a page that names none, or
 * names something that is not a thread id, mints a fresh one as every page load did before (#86) —
 * and writes its id to the URL at once, so a reload from the first prompt on shows this thread, not
 * another fresh one.
 */
const BOOT: ThreadUrl = typeof window === 'undefined' ? { kind: 'fresh' } : readThreadUrl(window.location.search)
const FIRST_THREAD_ID: string | undefined = BOOT.kind === 'fresh' ? mintPageThread().threadId : undefined
const FIRST_LAYOUT: PaneLayout = FIRST_THREAD_ID === undefined ? NO_PANES : singlePane(FIRST_THREAD_ID)
// The boot thread is on screen before any navigation happens, so the store has to be told
// here too — otherwise the first pane is evictable until the user clicks something.
markThreadActive(FIRST_THREAD_ID)
if (FIRST_THREAD_ID !== undefined && typeof window !== 'undefined') {
  window.history.replaceState(null, '', urlForPanes(window.location.search, FIRST_LAYOUT))
}

/** How the panes came to change — what, if anything, is written to history. */
type ThreadNavigation =
  /** A click: a new history entry, so back returns to the panes before it — or to the page (#869) it left. */
  | 'push'
  /** The page's own doing (a fresh thread after a failed boot, a delete, a focus): the current entry is rewritten, a page on it kept. */
  | 'replace'
  /** Back or forward: history already moved; the page follows it. */
  | 'pop'

/**
 * A narrow screen draws the rail OVER the thread, a drawer behind a scrim — the design's rail under
 * 768px (#407, #417); choosing a thread from the rail closes it, and so does the scrim. `leave` wraps
 * a rail action so it also closes the rail.
 */
interface NarrowRail {
  readonly open: boolean
  readonly toggle: () => void
  readonly close: () => void
  readonly leave: <Args extends unknown[]>(act: (...args: Args) => void) => (...args: Args) => void
}

function useNarrowRail(): NarrowRail {
  const [open, setOpen] = useState(false)
  return {
    open,
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false),
    leave:
      (act) =>
      (...args) => {
        setOpen(false)
        act(...args)
      },
  }
}

/** Whether the page has `threadId` open — a pane of it can be shown. */
function onThisPage(threadId: string | undefined): boolean {
  return threadId !== undefined && threadListStore.get().some((thread) => thread.threadId === threadId)
}

/** How a resume's request means to reach history and the panes, and the navigation count it was issued at. */
interface ResumeIntent {
  how: ThreadNavigation
  epoch: number
  prefill?: string
  fromUrl?: boolean | undefined
  /** Said on the thread once it is adopted — a delete's, when the page went to this thread (#663). */
  notice?: string
  /** Opened in a pane beside the focused one (#938), not in its place. */
  beside?: boolean
}

/** Shows `threadId` in the focused pane — or beside it (#938) — and tells history how. */
type Navigate = (threadId: string, how: ThreadNavigation, beside?: boolean) => void

/** What a resume's outcome reaches back into: the navigation count, the move itself, the rail's error and the not-found screen. */
interface ResumeOutcomeTargets {
  readonly epoch: React.RefObject<number>
  /** Whether no thread is on screen: the focused pane's thread is not (yet, or any more) on this page. */
  readonly nothingShown: () => boolean
  readonly navigate: Navigate
  readonly setResumeError: (error: string | undefined) => void
  readonly setMissingThread: (threadId: string) => void
}

/** The page's resume coordinator: each outcome lands only if no navigation, and no request, happened since its own. */
function useResumeRequests({
  epoch,
  nothingShown,
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
      if (nothingShown()) navigate(showing(mintPageThread().threadId, intent), 'replace')
    }
    // `prefill` rides with a fork's open (#433): the new thread's composer opens holding it.
    // `fromUrl`: the id is the URL's (the boot, back/forward), not a row or a fork (#378).
    return createResumeRequests<ResumeIntent>(
      fetchThreadHistory,
      (history, intent) => {
        if (intent.epoch !== epoch.current) return // a navigation happened since — superseded
        setResumeError(undefined)
        navigate(showing(adoptPageThread(history, intent.prefill).threadId, intent), intent.how, intent.beside)
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
  }, [epoch, nothingShown, navigate, setResumeError, setMissingThread])
}

/** What `/history` said of one pane the URL names: its branch, nothing under the id, or why it could not be read. */
type PaneHistory =
  | { readonly kind: 'held' }
  | { readonly kind: 'history'; readonly history: EnsoThreadHistory }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly message: string }

/** One pane's thread as the URL names it: already on this page, or read from `/history`. */
async function readPaneHistory(threadId: string): Promise<PaneHistory> {
  if (onThisPage(threadId)) return { kind: 'held' }
  try {
    const history = await fetchThreadHistory(threadId)
    return history === undefined ? { kind: 'absent' } : { kind: 'history', history }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The pane's thread on this page once its history is in: adopted, or — the URL's own id with nothing
 * under it (#378) — started under that id; undefined when it could not be read, and the rail says why.
 */
function adoptPane(threadId: string, read: PaneHistory, failed: (message: string) => void): string | undefined {
  if (read.kind === 'held') return threadId
  if (read.kind === 'history') return adoptPageThread(read.history).threadId
  if (read.kind === 'absent') return mintPageThread(undefined, threadId).threadId
  failed(read.message)
  return undefined
}

/**
 * The panes a URL names, shown (#938): the boot's, and back/forward's to panes the page no longer
 * holds. Every pane's history is read first, together; the layout lands whole, or not at all when a
 * navigation or another request came since. A pane that could not be read is left out, its reason on
 * the rail; none left and nothing on screen, a fresh thread.
 */
function useRestorePanes({
  epoch,
  nothingShown,
  navigate,
  setResumeError,
  show,
}: Omit<ResumeOutcomeTargets, 'setMissingThread'> & {
  readonly show: (layout: PaneLayout, how: ThreadNavigation) => void
}): (wanted: PaneLayout, how: ThreadNavigation) => void {
  return useCallback(
    (wanted: PaneLayout, how: ThreadNavigation): void => {
      epoch.current += 1
      const issued = epoch.current
      void Promise.all(wanted.threadIds.map(readPaneHistory)).then((reads) => {
        if (issued !== epoch.current) return
        let failure: string | undefined
        const kept = wanted.threadIds.flatMap((threadId, index) => {
          const read = reads[index]
          const shown = read === undefined ? undefined : adoptPane(threadId, read, (message) => (failure = message))
          return shown === undefined ? [] : [shown]
        })
        setResumeError(failure)
        const first = kept[0]
        if (first === undefined) {
          if (nothingShown()) navigate(mintPageThread().threadId, 'replace')
          return
        }
        const focused = focusedThread(wanted) ?? first
        show(paneLayoutOf(kept, kept.includes(focused) ? focused : first), how)
      })
    },
    [epoch, nothingShown, navigate, setResumeError, show],
  )
}

/**
 * Back/forward: the URL moved; the page follows it — the page it names (#869), or none, and its
 * panes (#938): all on this page is a switch, any that is not is a restore. Neither writes history again.
 */
function useFollowUrlHistory(
  show: (layout: PaneLayout, how: ThreadNavigation) => void,
  restore: (wanted: PaneLayout, how: ThreadNavigation) => void,
  showPage: (page: PageUrl | undefined) => void,
): void {
  useEffect(() => {
    const onPopState = (): void => {
      showPage(readPageUrl(window.location.search))
      const named = readThreadUrl(window.location.search)
      if (named.kind !== 'resume') return
      const wanted = readPaneLayout(window.location.search, named.threadId)
      if (wanted.threadIds.every(onThisPage)) show(wanted, 'pop')
      else restore(wanted, 'pop')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [show, restore, showPage])
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

/** Say `notice` on the focused pane's thread — what the page did, where the reader is. */
function sayOnFocused(layout: PaneLayout, notice: string): void {
  const focused = focusedThread(layout)
  if (onThisPage(focused) && focused !== undefined) {
    getThreadStores(focused).notifications.push(notice, 'info', 'run', ENSO_NOTICE_SOURCE)
  }
}

/** What a thread's departure reaches into: the page's panes, how they change, and its listings. */
interface LeaveThreadTargets {
  readonly layout: React.RefObject<PaneLayout>
  readonly show: (layout: PaneLayout, how: ThreadNavigation) => void
  readonly resume: (threadId: string, intent: Omit<ResumeIntent, 'epoch'>) => void
  readonly listings: PageListings
}

/**
 * A deleted thread (#571), or a discarded draft (#879), leaves the page: its pane goes, and the
 * listing refreshes so the rail cannot offer it again. Focused, its pane shows its project's most
 * recent other thread (#663), a fresh thread only when the project holds no other, written over its
 * URL so back does not ask for the gone id; `said` is said there. Beside the focused pane (#938),
 * its pane closes. ⚠ Off screen (the user moved while the server worked), nothing moves the user:
 * `said` is said on the thread they are on, and its history entry stays its own.
 */
function useLeaveThread({
  layout,
  show,
  resume,
  listings,
}: LeaveThreadTargets): Pick<PageNavigation, 'leaveDeleted' | 'discardDraft'> {
  const { threads, stored, projects } = listings
  const leave = useCallback(
    (threadId: string, said: string): void => {
      const panes = layout.current
      const at = panes.threadIds.indexOf(threadId)
      // Off screen while the server worked, its stores may already be gone: the follow budget drops
      // idle threads. Only one in a pane is read, and those the budget never drops.
      const focused = at !== -1 && at === panes.focused
      const projectId = focused ? getThreadStores(threadId).projectId : undefined
      const next = focused
        ? threadAfterDelete(threadId, projectId, { projects: projects.rows, pageThreads: threads, stored: stored.rows })
        : undefined
      // Dropped before a fresh one is minted, so the gone thread is not what pushes another out of the budget.
      dropThread(threadId)
      void storedThreads.refresh()
      if (at !== -1 && !focused) {
        show(closePane(panes, at), 'replace')
        sayOnFocused(layout.current, said)
        return
      }
      // A stored thread is resumed, its history read first: the notice rides with the resume and is
      // said on the thread once it is adopted (#721). The focused pane's thread is gone meanwhile, so
      // a resume that fails leaves a fresh thread, as one with nothing on screen does.
      if (next !== undefined && !next.onPage) {
        resume(next.threadId, { how: 'replace', notice: said })
        return
      }
      if (!focused) {
        sayOnFocused(panes, said)
        return
      }
      const shown = next?.threadId ?? mintPageThread(projectId).threadId
      show(replacePane(panes, threadId, shown), 'replace')
      getThreadStores(shown).notifications.push(said, 'info', 'run', ENSO_NOTICE_SOURCE)
    },
    [layout, show, resume, projects.rows, threads, stored.rows],
  )
  return {
    leaveDeleted: useCallback((threadId: string): void => leave(threadId, `thread ${threadId} deleted`), [leave]),
    discardDraft: useCallback((threadId: string): void => leave(threadId, 'draft discarded'), [leave]),
  }
}

/** The page's navigation: the panes, the page over them, the rail's resume error, and every way any changes. */
interface PageNavigation {
  /** The panes on the page (#938); none only while the URL's threads are being adopted. */
  readonly layout: PaneLayout
  /** Each pane's view by its thread (#938); a thread with none shows the chat. */
  readonly views: Readonly<Record<string, ThreadView>>
  readonly setView: (view: ThreadView, threadId: string) => void
  /** The page beside the threads on screen (#869), or undefined: the panes are. */
  readonly page: PageUrl | undefined
  readonly resumeError: string | undefined
  readonly navigate: Navigate
  readonly resumeFrom: (threadId: string, how: ThreadNavigation, fromUrl?: boolean) => void
  /** Open a thread beside the focused pane (#938) — on this page, or resumed first. */
  readonly openBeside: (threadId: string, onPage: boolean) => void
  /** Start a thread in `projectId` in a pane beside the focused one (#938): the split menu's New thread. */
  readonly newBeside: (projectId: string) => void
  /** Focus the pane at `index`, and its prompt when `prompt` (#938). */
  readonly focusPane: (index: number, prompt: boolean) => void
  /** Close the pane at `index` (#938). */
  readonly closePane: (index: number) => void
  readonly openFork: (receipt: EnsoForkReceipt) => void
  readonly leaveDeleted: (threadId: string) => void
  /** A draft is discarded (#879): it leaves the page as a deleted thread does. */
  readonly discardDraft: (threadId: string) => void
  /** The thread id the not-found screen names (#879), or undefined: none is shown. */
  readonly missingThread: string | undefined
  /** Show a page, a history entry of its own; the one on screen already is no navigation. */
  readonly openPage: (route: PageRoute) => void
  /** Leave the page for the panes behind it, or a fresh thread when none is adopted yet. */
  readonly leavePage: () => void
  /** What a draft's launch panel does on this page (#877). */
  readonly launchActions: LaunchActions
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
 * A thread put in the focused pane's place keeps the pane's view (#361: switching thread keeps
 * it); a pane opened beside starts on the chat (#938).
 */
function viewsAfter(
  views: Readonly<Record<string, ThreadView>>,
  before: PaneLayout,
  after: PaneLayout,
): Readonly<Record<string, ThreadView>> {
  const left = focusedThread(before)
  const arrived = focusedThread(after)
  if (left === undefined || arrived === undefined || arrived === left || before.threadIds.includes(arrived))
    return views
  if (before.threadIds.length !== after.threadIds.length || views[arrived] !== undefined) return views
  const kept = views[left]
  return kept === undefined ? views : { ...views, [arrived]: kept }
}

/** The page's panes, the views each shows (#938), and the ways they change, each written to history. */
interface Panes {
  readonly layout: PaneLayout
  readonly layoutRef: React.RefObject<PaneLayout>
  readonly epoch: React.RefObject<number>
  readonly views: Readonly<Record<string, ThreadView>>
  readonly setView: (view: ThreadView, threadId: string) => void
  /** Show `layout`: the one way the panes change. */
  readonly show: (layout: PaneLayout, how: ThreadNavigation) => void
  readonly navigate: Navigate
  /** Whether no thread is on screen: the focused pane's thread is not (yet, or any more) on this page. */
  readonly nothingShown: () => boolean
}

function usePanes(
  setPage: (page: PageUrl | undefined) => void,
  setMissingThread: (threadId: undefined) => void,
): Panes {
  const [layout, setLayout] = useState<PaneLayout>(FIRST_LAYOUT)
  const [views, setViews] = useState<Readonly<Record<string, ThreadView>>>({})
  const epoch = useRef(0)
  const layoutRef = useRef<PaneLayout>(FIRST_LAYOUT)
  /**
   * Show `next`, and tell history how it happened. History state is `null`: the URL is read back,
   * never the state object. A click leaves the page on screen; the page's own rewrite and
   * back/forward leave it as the URL has it. A thread that left every pane, if it is a draft with
   * nothing typed in it, goes (#875).
   */
  const show = useCallback(
    (next: PaneLayout, how: ThreadNavigation): void => {
      epoch.current += 1
      const before = layoutRef.current
      const staying = new Set(next.threadIds)
      for (const leaving of before.threadIds) {
        if (!staying.has(leaving)) discardEmptyDraft(leaving, storedThreads.get().rows)
      }
      layoutRef.current = next
      // The follow budget needs this too: a thread in a pane is not a drop candidate, and being
      // looked at is what counts as activity for the ones being left behind (#272, #938).
      const focused = focusedThread(next)
      markThreadActive(
        focused,
        next.threadIds.filter((threadId) => threadId !== focused),
      )
      setLayout(next)
      setViews((current) => viewsAfter(current, before, next))
      setMissingThread(undefined)
      if (how === 'push') setPage(undefined)
      if (how === 'pop' || typeof window === 'undefined') return
      if (how === 'push') window.history.pushState(null, '', urlOpeningPanes(window.location.search, next))
      else window.history.replaceState(null, '', urlForPanes(window.location.search, next))
    },
    [setPage, setMissingThread],
  )
  const setView = useCallback(
    (view: ThreadView, threadId: string): void => setViews((current) => ({ ...current, [threadId]: view })),
    [],
  )
  const navigate = useCallback<Navigate>(
    (threadId, how, beside = false): void => {
      const panes = layoutRef.current
      show((beside ? openBeside(panes, threadId) : undefined) ?? openInFocused(panes, threadId), how)
    },
    [show],
  )
  const nothingShown = useCallback((): boolean => !onThisPage(focusedThread(layoutRef.current)), [])
  return { layout, layoutRef, epoch, views, setView, show, navigate, nothingShown }
}

/**
 * The pages (#869): open one — a history entry of its own, and a navigation, so a thread asked for
 * before it does not pull the reader off it — and leave it for the panes behind it, or a fresh
 * thread when none is adopted yet.
 */
function usePageRoutes(
  { layoutRef, epoch, show, navigate }: Panes,
  setPage: (page: PageUrl | undefined) => void,
  setMissingThread: (threadId: undefined) => void,
): Pick<PageNavigation, 'openPage' | 'leavePage'> {
  const openPage = useCallback(
    (route: PageRoute): void => {
      if (showsPage(window.location.search, route)) return
      epoch.current += 1
      setMissingThread(undefined)
      setPage(route)
      window.history.pushState(null, '', urlForPage(window.location.search, route))
    },
    [epoch, setPage, setMissingThread],
  )
  const leavePage = useCallback((): void => {
    const panes = layoutRef.current
    if (panes.threadIds.length === 0) navigate(mintPageThread().threadId, 'push')
    else show(panes, 'push')
  }, [layoutRef, navigate, show])
  return { openPage, leavePage }
}

/** Put focus in the composer of `threadId`'s pane, once the pane it moved to is laid out (#938). */
function focusPrompt(threadId: string | undefined): void {
  if (threadId === undefined) return
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>(`[data-pane-thread="${threadId}"] [data-composer] textarea`)?.focus(),
  )
}

/**
 * The page's navigation (#142): the boot's adoption, rail clicks, forks, deletes, and back/forward,
 * each keeping the URL, history and the panes in step — the panes beside each other (#938): opening
 * one beside, focusing one, closing one — and the pages (#869): opening one, and leaving it for the
 * panes.
 *
 * ⚠ A resume's outcome reads two facts from its own request, never from shared state: HOW the
 * request meant to reach history (it rides with the request, `intent`), and WHETHER a navigation or
 * a later request happened since (`epoch` counts both, and an outcome from before the current one
 * is dropped whole). New thread during the boot's "resuming…" therefore wins outright: the URL says
 * the new thread, the pane shows it, and the boot's answer arrives to nobody (#143). Opening a page
 * is a navigation too: a thread asked for before it does not pull the reader off the page when it
 * lands. `layoutRef` mirrors `layout` for the same closures.
 */
function usePageNavigation(listings: PageListings): PageNavigation {
  // Read at mount, not at module scope as the thread is: nothing is minted for a page.
  const [page, setPage] = useState<PageUrl | undefined>(() =>
    typeof window === 'undefined' ? undefined : readPageUrl(window.location.search),
  )
  const { resumeError, setResumeError, missingThread, setMissingThread } = useOpenFailures()
  const panes = usePanes(setPage, setMissingThread)
  const { layout, layoutRef, epoch, views, setView, show, navigate, nothingShown } = panes
  const { openPage, leavePage } = usePageRoutes(panes, setPage, setMissingThread)
  const request = useResumeRequests({ epoch, nothingShown, navigate, setResumeError, setMissingThread })
  // Every request counts as a navigation for the ones before it: the latest asked for wins.
  const resume = useCallback(
    (threadId: string, intent: Omit<ResumeIntent, 'epoch'>): void => {
      epoch.current += 1
      request(threadId, { ...intent, epoch: epoch.current })
    },
    [epoch, request],
  )
  const resumeFrom = useCallback(
    (threadId: string, how: ThreadNavigation, fromUrl?: boolean): void => resume(threadId, { how, fromUrl }),
    [resume],
  )
  const beside = useBeside({ layoutRef, show, navigate, resume })
  // A fork (#433) opens the way a rail resume does, its composer holding the forked prompt's
  // words; the listing refreshes so the rail shows the fork and whose it is.
  const openFork = useCallback(
    (receipt: EnsoForkReceipt): void => {
      void storedThreads.refresh()
      resume(receipt.threadId, { how: 'push', prefill: receipt.prefill })
    },
    [resume],
  )
  const departures = useLeaveThread({ layout: layoutRef, show, resume, listings })
  const restore = useRestorePanes({ epoch, nothingShown, navigate, setResumeError, show })
  // Boot: the URL named a thread — adopt it, and the panes it names beside it. Once per page; a
  // later navigation or request drops a stale answer.
  useEffect(() => {
    // Not state and not a parent: `BOOT` is a module constant read once, `restore` this component's own request (#747).
    // react-doctor-disable-next-line no-pass-live-state-to-parent
    if (BOOT.kind === 'resume') restore(readPaneLayout(window.location.search, BOOT.threadId), 'pop')
  }, [restore])
  useFollowUrlHistory(show, restore, setPage)
  const launchActions = useLaunchActions(navigate, resumeFrom, openPage)
  return {
    layout,
    views,
    setView,
    page,
    resumeError,
    missingThread,
    navigate,
    resumeFrom,
    ...beside,
    openFork,
    ...departures,
    openPage,
    leavePage,
    launchActions,
  }
}

/**
 * The panes' own moves (#938): open a thread beside the focused pane — one this page holds at once,
 * a stored one once its history is in — focus a pane (its prompt too, from the keyboard and its
 * composer's stand-in), close one. Opening beside with every pane taken opens nothing and says why,
 * on the thread on screen. A focus rewrites the history entry it is on; the others push one.
 */
function useBeside({
  layoutRef,
  show,
  navigate,
  resume,
}: {
  readonly layoutRef: React.RefObject<PaneLayout>
  readonly show: (layout: PaneLayout, how: ThreadNavigation) => void
  readonly navigate: Navigate
  readonly resume: (threadId: string, intent: Omit<ResumeIntent, 'epoch'>) => void
}): Pick<PageNavigation, 'openBeside' | 'newBeside' | 'focusPane' | 'closePane'> {
  return useMemo(
    () => ({
      openBeside: (threadId: string, onPage: boolean): void => {
        if (openBeside(layoutRef.current, threadId) === undefined) {
          sayOnFocused(layoutRef.current, PANES_FULL)
          return
        }
        if (onPage) navigate(threadId, 'push', true)
        else resume(threadId, { how: 'push', beside: true })
      },
      newBeside: (projectId: string): void => {
        if (layoutRef.current.threadIds.length >= MAX_PANES) {
          sayOnFocused(layoutRef.current, PANES_FULL)
          return
        }
        navigate(mintPageThread(projectId).threadId, 'push', true)
      },
      focusPane: (index: number, prompt: boolean): void => {
        const next = focusPane(layoutRef.current, index)
        show(next, 'replace')
        if (prompt) focusPrompt(focusedThread(next))
      },
      closePane: (index: number): void => show(closePane(layoutRef.current, index), 'push'),
    }),
    [layoutRef, show, navigate, resume],
  )
}

/**
 * A Projects card's **Open threads** (#870), and a project chosen in the rail's switcher (#876),
 * which makes it current: the project's most recently active thread — shown at once when it is on
 * this page, resumed when stored — or, when it has none, a new thread in it. Either way the page is
 * left, as a rail click leaves it. A gone folder with no thread offers none.
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

/** A draft's launch panel's page actions (#877): a recent thread opens as a rail row does; Manage projects opens Projects. */
function useLaunchActions(
  navigate: PageNavigation['navigate'],
  resumeFrom: PageNavigation['resumeFrom'],
  openPage: PageNavigation['openPage'],
): LaunchActions {
  return useMemo<LaunchActions>(
    () => ({
      openThread: (thread) => (thread.onPage ? navigate(thread.threadId, 'push') : resumeFrom(thread.threadId, 'push')),
      manageProjects: () => openPage(PROJECTS_ROUTE),
    }),
    [navigate, resumeFrom, openPage],
  )
}

/**
 * The rail as the page wires it: the listings, every row's way into a thread or a page — each closing
 * the rail drawn over the thread on a narrow screen (#407, #417) — its open-beside (#938), and the
 * project controls.
 */
function PageRail({
  listings,
  navigation,
  rail,
  editing: { projectNotice, forgetProject },
  onNew,
}: {
  listings: PageListings
  navigation: PageNavigation
  rail: NarrowRail
  editing: ProjectEditing
  onNew: (projectId: string | undefined) => void
}): React.ReactNode {
  const { threads, stored, projects } = listings
  const { layout, page, resumeError, navigate, resumeFrom, openPage } = navigation
  const pageThreadIds = new Set(threads.map((thread) => thread.threadId))
  return (
    <ThreadsRail
      projects={projects.rows}
      threads={threads}
      activeThreadId={focusedThread(layout)}
      earlier={storedThreadsNotOnThisPage(stored.rows, pageThreadIds)}
      forkParents={forkParentTitles(stored.rows, threads)}
      earlierError={stored.error ?? projects.error}
      openError={resumeError}
      onSelect={rail.leave((threadId: string) => navigate(threadId, 'push'))}
      onResume={rail.leave((threadId: string) => resumeFrom(threadId, 'push'))}
      panes={layout.threadIds}
      onBeside={rail.leave(navigation.openBeside)}
      onNew={rail.leave(onNew)}
      onOpenProject={rail.leave((projectId: string) => openProjectThreads(projectId, listings, navigation))}
      onRemoveProject={(projectId: string) => void forgetProject(projectId)}
      onProjectSettings={rail.leave((projectId: string) => openPage(projectRoute(projectId, 'worktrees')))}
      // On Projects and a project's page, a refused removal is said on the page it was asked from: once.
      projectNotice={page?.kind === 'projects' || page?.kind === 'project' ? undefined : projectNotice}
      onPage={rail.leave(openPage)}
      page={page?.kind === 'not-found' ? page.within : page?.kind}
      shownNarrow={rail.open}
    />
  )
}

/**
 * Alt+1/2/3 focuses a pane and its prompt (#938) — Ctrl+number is the browser's own tab switch and
 * cannot be taken. Not while a page is over the panes.
 */
function usePaneKeys(navigation: PageNavigation): void {
  const { page, layout, focusPane: focusAt } = navigation
  const panes = page === undefined ? layout.threadIds.length : 0
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const digit = /^Digit([1-3])$/.exec(event.code)?.[1]
      if (digit === undefined || !event.altKey || event.ctrlKey || event.metaKey) return
      const index = Number(digit) - 1
      if (index >= panes) return
      event.preventDefault()
      focusAt(index, true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [panes, focusAt])
}

/** The header's part in the panes (#938): the focused pane's number and close while several are open, and the split button's offer. */
function headerPanes(navigation: PageNavigation, listings: PageListings, narrow: boolean): HeaderPanes {
  const { layout } = navigation
  const { threads, stored, projects } = listings
  const several = layout.threadIds.length > 1
  const focused = focusedThread(layout)
  const project = projectOf(projects.rows, threads.find((thread) => thread.threadId === focused)?.projectId)
  return {
    number: several ? layout.focused + 1 : undefined,
    narrow,
    onClose: several ? (): void => navigation.closePane(layout.focused) : undefined,
    split: {
      full: layout.threadIds.length >= MAX_PANES,
      rows: () => besideRows({ projects: projects.rows, pageThreads: threads, stored: stored.rows }, layout.threadIds),
      newIn:
        project === undefined || project.status === 'missing-dir'
          ? undefined
          : { projectId: project.projectId, title: project.title },
      onOpen: (row) => navigation.openBeside(row.threadId, row.onPage),
      onNew: navigation.newBeside,
    },
  }
}

/**
 * The page's header over a thread (#90): the focused pane's — drawn at its top (#938), or heading
 * the column while no pane of a thread is on screen — with the view the focused pane shows.
 */
function ThreadHeader({
  navigation,
  listings,
  rail,
  debug,
  narrow,
}: {
  navigation: PageNavigation
  listings: PageListings
  rail: NarrowRail
  debug: { readonly open: boolean; readonly toggle: () => void } | undefined
  narrow: boolean
}): React.ReactNode {
  const { layout, views, setView, missingThread } = navigation
  const focusedId = focusedThread(layout)
  const view = (focusedId === undefined ? undefined : views[focusedId]) ?? 'chat'
  return (
    <AppHeader
      active={listings.threads.find((thread) => thread.threadId === focusedId)}
      activeThreadId={focusedId}
      notFound={missingThread !== undefined}
      rail={rail}
      view={view}
      onView={(chosen): void => {
        if (focusedId !== undefined) setView(chosen, focusedId)
      }}
      debug={debug}
      onDeleted={navigation.leaveDeleted}
      onDiscardDraft={navigation.discardDraft}
      stored={listings.stored.rows}
      panes={headerPanes(navigation, listings, narrow)}
    />
  )
}

/**
 * One mounted pane per live thread (#90): those in the layout placed — side by side, or the focused
 * one alone (#938) — while no page or not-found screen is over them, every other off screen.
 */
function ThreadPanes({
  navigation,
  threads,
  shown,
  sideBySide: inRow,
  header,
  debugOpen,
}: {
  navigation: PageNavigation
  threads: PageListings['threads']
  shown: boolean
  sideBySide: boolean
  header: React.ReactNode
  debugOpen: boolean
}): React.ReactNode {
  const { layout, views, setView, openFork, launchActions, focusPane: focusAt, closePane: closeAt } = navigation
  return threads.map((thread) => {
    const index = shown ? layout.threadIds.indexOf(thread.threadId) : -1
    const place: PanePlace | undefined =
      index === -1
        ? undefined
        : {
            index,
            count: layout.threadIds.length,
            sideBySide: inRow,
            onFocus: (prompt) => focusAt(index, prompt),
            onClose: () => closeAt(index),
          }
    return (
      <ThreadPane
        key={thread.threadId}
        threadId={thread.threadId}
        active={index !== -1 && index === layout.focused}
        place={place}
        header={inRow ? header : undefined}
        debugOpen={debugOpen}
        view={views[thread.threadId] ?? 'chat'}
        onView={setView}
        onForked={openFork}
        launchActions={launchActions}
      />
    )
  })
}

/**
 * What heads the main column: a page's header (#869); else, too narrow for the panes side by side
 * (#938), their tabs, one pane on screen at a time — then the thread's header, unless the panes are
 * side by side and the focused one carries it at its top. One element in one place while they are
 * not: switching threads keeps it, and what has focus in it.
 */
function ColumnTop({
  navigation,
  projects,
  rail,
  header,
  headed,
  tabs,
  onNewThread,
}: {
  navigation: PageNavigation
  projects: PageListings['projects']['rows']
  rail: NarrowRail
  header: React.ReactNode
  /** The panes are side by side, and the focused one is on screen to carry the header. */
  headed: boolean
  /** The panes are on screen, but not side by side. */
  tabs: boolean
  onNewThread: (projectId: string | undefined) => void
}): React.ReactNode {
  const { page, layout, openPage, focusPane: focusAt, closePane: closeAt } = navigation
  if (page !== undefined) {
    return <PageHeader page={page} projects={projects} rail={rail} onOpen={openPage} onNewThread={onNewThread} />
  }
  return (
    <>
      {tabs && layout.threadIds.length > 1 ? (
        <PaneTabs layout={layout} onFocus={(index) => focusAt(index, false)} onClose={closeAt} />
      ) : null}
      {headed ? null : header}
    </>
  )
}

/** The `?debug` column (#86): its switch for the header, its close for the column, and whether it is open. */
interface DebugColumn {
  readonly switch: { readonly open: boolean; readonly toggle: () => void } | undefined
  readonly close: (() => void) | undefined
  readonly open: boolean
}

/**
 * The debug column (#86): a right-hand pane, so it never takes height from the conversation it
 * explains. Opt-in by `?debug`, open by default when it is, and collapsible from the header.
 */
function useDebugColumn(): DebugColumn {
  const [open, setOpen] = useState(isDebugMode)
  // One function for the pane's lifetime: it is the close context's value, read by every pane.
  const close = useCallback((): void => setOpen(false), [])
  if (!isDebugMode) return { switch: undefined, close: undefined, open: false }
  return { switch: { open, toggle: () => setOpen((shown) => !shown) }, close, open }
}

/**
 * The not-found screen (#879) over the panes, for the thread a row named that the server no longer
 * holds: a new thread in the focused pane's project, or the rail's search (#875) — shown on a narrow
 * screen, its box focused.
 */
function MissingThread({
  navigation,
  rail,
  projectId,
  onNew,
}: {
  navigation: PageNavigation
  rail: NarrowRail
  projectId: string | undefined
  onNew: (projectId: string | undefined) => void
}): React.ReactNode {
  const { page, missingThread } = navigation
  if (page !== undefined || missingThread === undefined) return null
  return (
    <ThreadNotFound
      threadId={missingThread}
      onNew={() => onNew(projectId)}
      onSearch={() => {
        if (!rail.open) rail.toggle()
        requestAnimationFrame(() => document.getElementById(RAIL_SEARCH_ID)?.focus())
      }}
    />
  )
}

/** The page (#90): header, the sessions rail, one mounted pane per live thread — up to three on screen (#938) — and a page over them (#869). */
export function ChatScreen(): React.ReactNode {
  const listings = usePageListings()
  const { threads, stored, projects } = listings
  const navigation = usePageNavigation(listings)
  const { layout, page, missingThread, navigate, openPage } = navigation
  const editing = useProjectEditing()
  const { projectNotice, setProjectNotice, forgetProject } = editing
  const debug = useDebugColumn()
  const rail = useNarrowRail()
  const fit = usePanesThatFit()
  usePaneKeys(navigation)
  const focusedId = focusedThread(layout)
  const active = threads.find((thread) => thread.threadId === focusedId)
  const newThread = (projectId: string | undefined): void => navigate(mintPageThread(projectId).threadId, 'push')
  // The page against the server (#919, #914): a thread it moved on and this page did not, and a
  // thread's live view lost — when the server answers again, or gives up answering, Reload.
  usePageChecks()
  // The panes are on screen unless a page, or the not-found screen, is over them.
  const panesShown = page === undefined && missingThread === undefined
  const inRow = panesShown && sideBySide(layout, fit)
  const header = (
    <ThreadHeader navigation={navigation} listings={listings} rail={rail} debug={debug.switch} narrow={inRow} />
  )
  return (
    // The rail runs the window's full height, its brand at its top; the header sits over the main
    // column only (#417) — a thread's, at the top of its pane (#938), or a page's (#869) in its place.
    <div className="flex h-dvh bg-background text-foreground">
      {/* Its own boundary (#919): a rail that fails to draw leaves the thread and its composer. */}
      <PaneBoundary pane="rail">
        <PageRail listings={listings} navigation={navigation} rail={rail} editing={editing} onNew={newThread} />
      </PaneBoundary>
      {/* The drawer's scrim (#417): the thread under the rail, dimmed; a click on it closes the rail. */}
      {rail.open ? (
        <div aria-hidden="true" className="fixed inset-0 z-30 bg-scrim md:hidden" onClick={rail.close} />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The page may be out of date (#919): one banner over whatever the column shows. */}
        <PageFaultBanner />
        <ColumnTop
          navigation={navigation}
          projects={projects.rows}
          rail={rail}
          header={header}
          headed={active !== undefined && inRow}
          tabs={panesShown && !inRow}
          onNewThread={newThread}
        />
        {/* `relative`: a pane off screen — and the one on screen alone — is `absolute inset-0` in this
            box (#370); side by side, the panes are its flex items (#938). */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {/* The debug pane's own ✕ (#417) closes it, as the thread menu's Hide does. */}
          <CloseDebugContext.Provider value={debug.close}>
            <ThreadPanes
              navigation={navigation}
              threads={threads}
              shown={panesShown}
              sideBySide={inRow}
              header={header}
              debugOpen={debug.open}
            />
          </CloseDebugContext.Provider>
          <MissingThread navigation={navigation} rail={rail} projectId={active?.projectId} onNew={newThread} />
          <RoutedPage
            page={page}
            onOpen={openPage}
            onLeave={navigation.leavePage}
            threadId={focusedId}
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
