import { ENSO_NOTICE_SOURCE, type EnsoStoredThread } from '@enso/core'
import { ChartColumnIcon, FileDiffIcon, LayersIcon, MenuIcon, MessagesSquareIcon } from 'lucide-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { Button } from './components/ui/button.tsx'
import { DeleteThread } from './delete-thread-dialog.tsx'
import { EnsoSmile } from './enso-mark.tsx'
import { storedThreads } from './page-listings.ts'
import { isFixtureMode, isDebugMode } from './page-mode.ts'
import type { ThreadView } from './pane-context.ts'
import { PromptManagerDialog } from './prompt-manager.tsx'
import { RenameThread } from './rename-thread.tsx'
import { useStore } from './store.ts'
import { getThreadStores, nameThreadSummary, type ThreadSummary } from './thread-stores.ts'
import { UNTITLED_THREAD } from './threads-rail.tsx'

/**
 * The page's header (#90): the active thread's title and its Rename and Delete, the view tabs (#361),
 * the prompt manager, and `?debug`'s switch. A page beside the threads (#869) has its own
 * (`routed-page.tsx`).
 */

/** A tab's value back to a view: the only strings the tab list hands over are these. */
const THREAD_VIEWS: Readonly<Record<string, ThreadView>> = {
  chat: 'chat',
  context: 'context',
  stats: 'stats',
  changes: 'changes',
}

interface PaneSwitchProps {
  readonly open: boolean
  /** The pane's element id — what `aria-controls` names. */
  readonly pane: string
  /** What the switch says while the pane is closed, then while it is open. */
  readonly labels: readonly [string, string]
  readonly title: string
  readonly onToggle: () => void
  /** An icon ahead of the label. */
  readonly children?: React.ReactNode
}

/** A header switch for a right-hand pane — the `?debug` column (#86): its state said, its pane named. */
function PaneSwitch({ open, pane, labels, title, onToggle, children }: PaneSwitchProps): React.ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      variant={open ? 'secondary' : 'outline'}
      aria-expanded={open}
      aria-controls={pane}
      title={title}
      onClick={onToggle}
    >
      {children}
      {open ? labels[1] : labels[0]}
    </Button>
  )
}

/**
 * A question from pi waits in the transcript while another view is shown (#362): the Chat
 * tab says so, and the status bar beside it. Nothing moves the reader — they switch when ready;
 * the run waits for the answer either way.
 */
function QuestionWaiting({ threadId }: { threadId: string }): React.ReactNode {
  const pending = useStore(getThreadStores(threadId).dialog)
  if (pending === undefined) return null
  return (
    <>
      <span aria-hidden="true" className="size-2 rounded-full bg-human signal:shadow-glow-human" />
      <span className="sr-only">, a question is waiting</span>
    </>
  )
}

/**
 * The header's prompt manager, on the thread on screen (#470). ⚠ The thread id and the fetch come
 * from ONE source, the thread's own stores: that fetch names the thread's project (#395), so the
 * project library listed is the thread's own even before the server has built it. While the page
 * is still resuming a thread (`active` not yet in the list) the manager is given no thread at all,
 * so nothing is asked about it without its project.
 */
export function HeaderPromptManager({ active }: { active: ThreadSummary | undefined }): React.ReactNode {
  if (active === undefined) return <PromptManagerDialog threadId={undefined} />
  return <PromptManagerDialog threadId={active.threadId} fetch={getThreadStores(active.threadId).fetch} />
}

/**
 * The page's header: the threads button (narrow screens), the mark, where you are — the active
 * thread's title, the same one the rail shows — and its Delete, then the view tabs, the prompt
 * manager and `?debug`'s switch.
 */
export function AppHeader({
  active,
  activeThreadId,
  rail,
  view,
  onView,
  debugOpen,
  onToggleDebug,
  onDeleted,
  stored,
}: {
  active: ThreadSummary | undefined
  activeThreadId: string | undefined
  rail: { open: boolean; toggle: () => void }
  view: ThreadView
  onView: (view: ThreadView) => void
  debugOpen: boolean
  onToggleDebug: () => void
  /** The server deleted this thread (#571): the page leaves it. */
  onDeleted: (threadId: string) => void
  /** The server's stored-thread listing (#95): a thread in it has a session file. */
  stored: readonly EnsoStoredThread[]
}): React.ReactNode {
  return (
    <header className="flex min-h-14 items-center gap-3 border-b bg-sidebar px-3 py-2">
      <RailToggle open={rail.open} onToggle={rail.toggle} />
      <EnsoSmile className="size-7.5" />
      <div className="grid min-w-0 flex-1">
        <h1 className="font-heading text-xs font-semibold tracking-wider text-muted-foreground uppercase max-sm:sr-only">
          Enso · pi runtime
        </h1>
        <span className="truncate font-heading text-base font-semibold" title={activeThreadId ?? ''}>
          {active?.name ?? active?.title ?? (activeThreadId === undefined ? 'resuming…' : UNTITLED_THREAD)}
        </span>
      </div>
      {active === undefined ? null : <ThreadControls active={active} onDeleted={onDeleted} stored={stored} />}
      {isFixtureMode ? (
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">fixture</span>
      ) : null}
      <ViewTabs view={view} onView={onView} threadId={active?.threadId} />
      <HeaderPromptManager active={active} />
      {isDebugMode ? (
        <PaneSwitch
          open={debugOpen}
          pane="thread-debug-pane"
          labels={['show debug', 'hide debug']}
          title="what the page believes beside what pi's session holds"
          onToggle={onToggleDebug}
        />
      ) : null}
    </header>
  )
}

/**
 * The header's Rename (#670) and Delete (#571), offered once the server holds the thread: listed
 * among its stored sessions (a fork, written by its route before any prompt), adopted from a stored
 * branch, or prompted here (its title is that prompt's). A thread minted and never prompted is this
 * page's only.
 */
function ThreadControls({
  active,
  onDeleted,
  stored,
}: {
  active: ThreadSummary
  onDeleted: (threadId: string) => void
  stored: readonly EnsoStoredThread[]
}): React.ReactNode {
  const stores = getThreadStores(active.threadId)
  const onServer =
    active.title !== undefined || stores.history.length > 0 || stored.some((row) => row.threadId === active.threadId)
  if (!onServer) return null
  return (
    <>
      <RenameThread
        key={`rename-${active.threadId}`}
        target={stores}
        current={active.name ?? active.title}
        onRenamed={(name): void => {
          nameThreadSummary(active.threadId, name)
          void storedThreads.refresh()
        }}
      />
      <DeleteThread
        key={active.threadId}
        target={stores}
        onDeleted={onDeleted}
        onRefused={(reason): void =>
          stores.notifications.push(
            `thread ${active.threadId}: delete refused: ${reason}`,
            'warning',
            'run',
            ENSO_NOTICE_SOURCE,
          )
        }
        stored={stored}
      />
    </>
  )
}

/** The header's threads button: on a narrow screen, the rail is a page of its own (#407). */
export function RailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): React.ReactNode {
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="size-11 md:hidden"
      aria-label={open ? 'hide threads' : 'show threads'}
      aria-expanded={open}
      aria-controls="threads-rail"
      onClick={onToggle}
    >
      <MenuIcon />
    </Button>
  )
}

const VIEW_TAB =
  'inline-flex h-10 items-center gap-2 rounded-md border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-popover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:border-primary aria-selected:bg-popover aria-selected:text-foreground signal:aria-selected:border-transparent signal:aria-selected:ring-1 signal:aria-selected:ring-border-strong signal:aria-selected:ring-inset ink:aria-selected:border-foreground ink:aria-selected:bg-transparent [&_svg]:size-4'

/**
 * The page's views as tabs (#361): Radix's tab list, for its keyboard (arrows move between tabs)
 * and its roles — the primitive, styled here to the design direction's tab (a raised selected tab
 * with an underline in the primary; Signal rings it instead, Ink underlines in ink). The panels
 * are the active pane's own (`ChatLayout`), so each trigger names its panel by id rather than
 * through Radix's `TabsContent`, which would unmount the transcript.
 */
function ViewTabs({
  view,
  onView,
  threadId,
}: {
  view: ThreadView
  onView: (view: ThreadView) => void
  /** The thread on screen, whose waiting question the Chat tab shows; none while resuming. */
  threadId: string | undefined
}): React.ReactNode {
  // Only the shown view's panel is in the page, so only its tab names one (#362): a
  // reference to a panel that is not there is one a screen reader cannot follow.
  const controls = (tab: ThreadView): string | undefined => (tab === view ? `thread-view-${tab}` : undefined)
  return (
    <TabsPrimitive.Root
      value={view}
      onValueChange={(value: string): void => {
        const chosen = THREAD_VIEWS[value]
        if (chosen !== undefined) onView(chosen)
      }}
    >
      <TabsPrimitive.List aria-label="what the thread view shows" className="flex gap-1">
        <TabsPrimitive.Trigger
          value="chat"
          id="thread-view-chat-tab"
          aria-controls={controls('chat')}
          className={VIEW_TAB}
        >
          <MessagesSquareIcon aria-hidden="true" />
          <span className="max-sm:sr-only">Chat</span>
          {view === 'chat' || threadId === undefined ? null : <QuestionWaiting threadId={threadId} />}
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="context"
          id="thread-view-context-tab"
          aria-controls={controls('context')}
          title="what each model request was made of, and how the context grew"
          className={VIEW_TAB}
        >
          <LayersIcon aria-hidden="true" />
          <span className="max-sm:sr-only">Context</span>
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="stats"
          id="thread-view-stats-tab"
          aria-controls={controls('stats')}
          title="per prompt, turn and tool: what this thread spent, and on what"
          className={VIEW_TAB}
        >
          <ChartColumnIcon aria-hidden="true" />
          <span className="max-sm:sr-only">Stats</span>
        </TabsPrimitive.Trigger>
        <TabsPrimitive.Trigger
          value="changes"
          id="thread-view-changes-tab"
          aria-controls={controls('changes')}
          title="every file that differs from the last push, and its diff side by side"
          className={VIEW_TAB}
        >
          <FileDiffIcon aria-hidden="true" />
          <span className="max-sm:sr-only">Diff</span>
        </TabsPrimitive.Trigger>
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}
