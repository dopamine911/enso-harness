import {
  ENSO_NOTICE_SOURCE,
  type EnsoModelState,
  type EnsoRecordedModel,
  type EnsoStoredThread,
  THREAD_NAME_MAX_LENGTH,
} from '@enso/core'
import {
  BugIcon,
  ChartColumnIcon,
  EllipsisIcon,
  FileDiffIcon,
  GitForkIcon,
  LayersIcon,
  MenuIcon,
  MessagesSquareIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { useRef, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx'
import { DeleteThread } from './delete-thread-dialog.tsx'
import { paneForkOf } from './fork-thread.ts'
import { InlineRename, renameThread } from './inline-rename.tsx'
import { cn } from './lib/utils.ts'
import { MENU_CONTENT, MENU_ITEM } from './menu-chrome.ts'
import { storedThreads, useThreadProject } from './page-listings.ts'
import { isFixtureMode } from './page-mode.ts'
import type { ThreadView } from './pane-context.ts'
import { PromptManagerDialog } from './prompt-manager.tsx'
import { useStore } from './store.ts'
import { getThreadStores, nameThreadSummary, type ThreadSummary, threadStarted } from './thread-stores.ts'
import { UNTITLED_THREAD } from './threads-rail.tsx'

/**
 * The page's header (#90): the active thread's title — renamed in place (#879) — with what it runs
 * with under it, the view tabs (#361), the prompt manager, and the thread menu (#879): Rename, Fork
 * thread, `?debug`'s pane, and Delete thread… or Discard draft. A page beside the threads (#869) has
 * its own (`routed-page.tsx`).
 */

/** A tab's value back to a view: the only strings the tab list hands over are these. */
const THREAD_VIEWS: Readonly<Record<string, ThreadView>> = {
  chat: 'chat',
  context: 'context',
  stats: 'stats',
  changes: 'changes',
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

/** What the header is told: the thread on screen, or the not-found screen in its place, and what its controls do. */
export interface AppHeaderProps {
  readonly active: ThreadSummary | undefined
  readonly activeThreadId: string | undefined
  /** The pane shows the not-found screen (#879): no thread is on screen, so none is offered actions. */
  readonly notFound: boolean
  readonly rail: { open: boolean; toggle: () => void }
  readonly view: ThreadView
  readonly onView: (view: ThreadView) => void
  /** `?debug`'s column (#86): open or not, and the menu's Show/Hide; undefined on a page without `?debug`. */
  readonly debug: { readonly open: boolean; readonly toggle: () => void } | undefined
  /** The server deleted this thread (#571): the page leaves it. */
  readonly onDeleted: (threadId: string) => void
  /** A draft is discarded (#879): the page leaves it, and nothing is asked of the server. */
  readonly onDiscardDraft: (threadId: string) => void
  /** The server's stored-thread listing (#95): a thread in it has a session file. */
  readonly stored: readonly EnsoStoredThread[]
}

/**
 * The page's header, over the main column only — the brand is the rail's (#417): the threads
 * button (narrow screens), where you are — the active thread's title, the same one the rail shows,
 * and what it runs with — then the view tabs, the prompt manager and the thread menu.
 */
export function AppHeader(props: AppHeaderProps): React.ReactNode {
  const { active, notFound, rail, view, onView, stored } = props
  /** The thread whose title is a field (#879); another thread on screen ends it, so coming back shows the title. */
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const started = active !== undefined && threadStarted(active, stored)
  const shown = notFound ? undefined : active
  // Adjusted while rendering, React's way to reset state on a changed input: no effect, no extra paint.
  if (renaming !== undefined && renaming !== shown?.threadId) setRenaming(undefined)
  const rename: TitleRename = {
    on: renaming !== undefined && renaming === shown?.threadId,
    start: (): void => setRenaming(shown?.threadId),
    done: (): void => setRenaming(undefined),
  }
  return (
    <header className={HEADER}>
      <RailToggle open={rail.open} onToggle={rail.toggle} />
      <h1 className="sr-only">Enso · pi runtime</h1>
      <div className="grid min-w-0 flex-1">
        <ThreadTitle {...props} started={started} rename={rename} />
      </div>
      {isFixtureMode ? <span className={BADGE}>fixture</span> : null}
      {notFound ? null : (
        <ViewTabs view={view} onView={onView} threadId={active?.threadId} draft={active !== undefined && !started} />
      )}
      <HeaderPromptManager active={shown} />
      {shown === undefined ? null : (
        <ThreadMenu key={shown.threadId} {...props} active={shown} started={started} onRename={rename.start} />
      )}
    </header>
  )
}

/** The title's rename in place (#879): whether the field is up, and what opens and closes it. */
interface TitleRename {
  readonly on: boolean
  readonly start: () => void
  readonly done: () => void
}

/**
 * Where you are: the thread's title — a button that renames it in place (#879), or the field doing
 * it — and under it what the thread runs with. A draft says it is not started; the not-found screen
 * says the thread is not there.
 */
function ThreadTitle({
  active,
  activeThreadId,
  notFound,
  started,
  rename,
}: AppHeaderProps & { started: boolean; rename: TitleRename }): React.ReactNode {
  if (notFound) return <span className={TITLE}>Thread not found</span>
  if (active === undefined)
    return (
      <span className={TITLE} title={activeThreadId ?? ''}>
        {activeThreadId === undefined ? 'resuming…' : UNTITLED_THREAD}
      </span>
    )
  const title = active.name ?? active.title ?? UNTITLED_THREAD
  if (!started)
    return (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <span className={TITLE} title={active.threadId}>
            {title}
          </span>
          <span className={BADGE}>not started</span>
        </span>
        <ThreadSubtitle threadId={active.threadId} />
      </>
    )
  if (rename.on)
    return (
      <InlineRename
        label="thread name"
        hint="Enter to save · Escape to cancel"
        maxLength={THREAD_NAME_MAX_LENGTH}
        current={active.name ?? active.title}
        save={async (name) => {
          const outcome = await renameThread(getThreadStores(active.threadId), name)
          if (outcome.kind === 'renamed') {
            nameThreadSummary(active.threadId, outcome.name)
            void storedThreads.refresh()
          }
          return outcome
        }}
        onDone={rename.done}
      />
    )
  return (
    <>
      <button
        type="button"
        title={`rename this thread · ${active.threadId}`}
        className="group flex max-w-full min-w-0 items-center gap-2 justify-self-start rounded-xs text-left focus-visible:outline-2 focus-visible:outline-ring"
        onClick={rename.start}
      >
        <span className={TITLE}>{title}</span>
        <PencilIcon aria-hidden="true" className={TITLE_PENCIL} />
        <span className="sr-only">, rename</span>
      </button>
      <ThreadSubtitle threadId={active.threadId} />
    </>
  )
}

const TITLE = 'truncate font-heading text-base leading-snug font-semibold'

/** The pencil a renameable title shows on hover and keyboard focus (#879, #939): its button is the `group`. */
export const TITLE_PENCIL =
  'size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100'

/**
 * A thread header's, and a page header's (`routed-page.tsx`), box: the same height and padding, so
 * moving between a thread and a page doesn't jump (#417).
 */
export const HEADER = 'flex min-h-15 shrink-0 items-center gap-4 border-b px-6 py-2 max-md:gap-2 max-md:px-3'

/** A small mono pill: a draft's "not started", fixture mode's mark. */
const BADGE =
  'inline-flex shrink-0 items-center rounded-full border border-border-strong px-2 py-px font-mono text-meta font-medium text-muted-foreground'

/**
 * What the thread runs with, under its title (#879): its project · model · effort. The model and
 * effort are the live session's; a cold thread's are what its branch recorded (#434), marked so; a
 * half nothing has said is left out, never guessed.
 */
function ThreadSubtitle({ threadId }: { threadId: string }): React.ReactNode {
  const stores = getThreadStores(threadId)
  const project = useThreadProject(stores.projectId)
  const live = useStore(stores.model)
  const recorded = useStore(stores.model.recorded)
  const parts = [...(project === undefined ? [] : [project.title]), ...runsWith(live, recorded)]
  if (parts.length === 0) return null
  return <span className="truncate text-xs text-muted-foreground">{parts.join(' · ')}</span>
}

/** The model and effort a subtitle names: the live state's, else the recorded ones, else none. */
function runsWith(live: EnsoModelState | null, recorded: EnsoRecordedModel | null): string[] {
  if (live !== null) return live.model === null ? [live.thinkingLevel] : [live.model.name, live.thinkingLevel]
  if (recorded === null) return []
  const parts = recorded.model === null ? [] : [`${recorded.model.modelId} (recorded)`]
  return recorded.thinkingLevel === null ? parts : [...parts, recorded.thinkingLevel]
}

/**
 * The thread menu (#879): everything the header's buttons did, in one place. **Rename** turns the
 * title into a field; **Fork thread** is the palette's `/fork` (#433), at the last prompt;
 * **Show/Hide debug pane** where `?debug` offered its switch; **Delete thread…** opens the delete
 * preview with its holds-work refusal and **Delete anyway** (#571). A draft — never started, so
 * nothing on the server — has nothing to rename or fork, and is **discarded** instead: the page
 * leaves it, nothing is asked of the server.
 *
 * Controlled, so opening it renders it again: the pane offers its fork from an effect, after the
 * header's first render. Not modal: a modal menu traps focus while it closes, and Rename's field,
 * focused as it mounts, would lose its focus to the menu's way out.
 */
function ThreadMenu({
  active,
  started,
  debug,
  onRename,
  onDeleted,
  onDiscardDraft,
  stored,
}: AppHeaderProps & { active: ThreadSummary; started: boolean; onRename: () => void }): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** Rename takes focus into the field: the menu must not hand it back to its button as it closes. */
  const keepFocus = useRef(false)
  const stores = getThreadStores(active.threadId)
  const fork = started ? paneForkOf(stores) : undefined
  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="thread actions"
            title="thread actions"
            className={ICON_BUTTON}
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={cn(MENU_CONTENT, 'w-56')}
          onCloseAutoFocus={(event): void => {
            if (!keepFocus.current) return
            event.preventDefault()
            keepFocus.current = false
          }}
        >
          <DropdownMenuItem
            className={MENU_ITEM}
            disabled={!started}
            onSelect={(): void => {
              keepFocus.current = true
              onRename()
            }}
          >
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM}
            disabled={fork === undefined}
            onSelect={(): void => fork?.(undefined)}
          >
            <GitForkIcon />
            Fork thread
          </DropdownMenuItem>
          {debug === undefined ? null : (
            <DropdownMenuItem className={MENU_ITEM} onSelect={debug.toggle}>
              <BugIcon />
              {debug.open ? 'Hide debug pane' : 'Show debug pane'}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {started ? (
            <DropdownMenuItem className={MENU_ITEM} variant="destructive" onSelect={(): void => setDeleting(true)}>
              <Trash2Icon />
              Delete thread…
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className={MENU_ITEM}
              variant="destructive"
              onSelect={(): void => onDiscardDraft(active.threadId)}
            >
              <Trash2Icon />
              Discard draft
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {started ? (
        <DeleteThread
          target={stores}
          open={deleting}
          onOpenChange={setDeleting}
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
      ) : null}
    </>
  )
}

/** The prototype's `.icon-button` (#417): 40px, muted until hovered or open. */
export const ICON_BUTTON =
  'size-10 rounded-sm text-muted-foreground hover:bg-card hover:text-foreground aria-expanded:bg-card aria-expanded:text-foreground [&_svg]:size-5'

/** The header's threads button: on a narrow screen, the rail is a drawer over the thread (#407, #417). */
export function RailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): React.ReactNode {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(ICON_BUTTON, 'md:hidden')}
      aria-label={open ? 'hide threads' : 'show threads'}
      aria-expanded={open}
      aria-controls="threads-rail"
      onClick={onToggle}
    >
      <MenuIcon />
    </Button>
  )
}

/**
 * A view tab, the prototype's (#417): a segment of the group, the selected one on the accent. Ink
 * keeps its own voice — underlined in ink, on no fill. Icons only under 1024px.
 */
const VIEW_TAB =
  'inline-flex min-h-8.5 items-center gap-2 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 disabled:hover:text-muted-foreground aria-selected:bg-accent aria-selected:text-foreground ink:rounded-none ink:border-b-2 ink:border-transparent ink:aria-selected:border-foreground ink:aria-selected:bg-transparent max-md:min-h-10 max-md:min-w-10 max-md:justify-center max-md:px-2 [&_svg]:size-4'

/** A draft's hover on the views it cannot show yet (#879). */
const NOT_STARTED_VIEW = 'available once the thread starts'

/**
 * The page's views as tabs (#361): Radix's tab list, for its keyboard (arrows move between tabs)
 * and its roles — the primitive, styled here as the prototype's segmented group (#417). The panels
 * are the active pane's own (`ChatLayout`), so each trigger names its panel by id rather than
 * through Radix's `TabsContent`, which would unmount the transcript. A draft (#879) has run nothing,
 * so its Context, Stats and Diff are disabled; Chat stays, the way back from a view shown before.
 */
function ViewTabs({
  view,
  onView,
  threadId,
  draft,
}: {
  view: ThreadView
  onView: (view: ThreadView) => void
  /** The thread on screen, whose waiting question the Chat tab shows; none while resuming. */
  threadId: string | undefined
  draft: boolean
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
      <TabsPrimitive.List
        aria-label="what the thread view shows"
        className="flex shrink-0 gap-0.5 rounded-lg border bg-card p-0.75 max-md:p-0.5"
      >
        <TabsPrimitive.Trigger
          value="chat"
          id="thread-view-chat-tab"
          aria-controls={controls('chat')}
          className={VIEW_TAB}
        >
          <MessagesSquareIcon aria-hidden="true" />
          <span className="max-lg:sr-only">Chat</span>
          {view === 'chat' || threadId === undefined ? null : <QuestionWaiting threadId={threadId} />}
        </TabsPrimitive.Trigger>
        {RUN_VIEWS.map(({ view: tab, label, hover, Icon }) => (
          <TabsPrimitive.Trigger
            key={tab}
            value={tab}
            id={`thread-view-${tab}-tab`}
            aria-controls={controls(tab)}
            disabled={draft}
            title={draft ? NOT_STARTED_VIEW : hover}
            className={VIEW_TAB}
          >
            <Icon aria-hidden="true" />
            <span className="max-lg:sr-only">{label}</span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}

/** The views of what a thread ran, after Chat: a draft has none to show (#879). */
const RUN_VIEWS = [
  {
    view: 'context',
    label: 'Context',
    hover: 'what each model request was made of, and how the context grew',
    Icon: LayersIcon,
  },
  {
    view: 'stats',
    label: 'Stats',
    hover: 'per prompt, turn and tool: what this thread spent, and on what',
    Icon: ChartColumnIcon,
  },
  {
    view: 'changes',
    label: 'Diff',
    hover: 'every file that differs from the last push, and its diff side by side',
    Icon: FileDiffIcon,
  },
] as const satisfies readonly { view: ThreadView; label: string; hover: string; Icon: typeof LayersIcon }[]
