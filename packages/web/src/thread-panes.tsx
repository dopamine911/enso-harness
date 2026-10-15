import { HandIcon } from 'lucide-react'
import { useContext } from 'react'
import { composerPlaceholder } from './composer.tsx'
import { cn } from './lib/utils.ts'
import { ClosePane, ICON_BUTTON, ThreadSubtitle } from './page-header.tsx'
import { useThreadProject } from './page-listings.ts'
import { PaneSlotContext, PaneViewContext, useChatContext } from './pane-context.ts'
import type { PaneLayout } from './pane-layout.ts'
import { revealQuestion, RUN_DOT, RUN_WORD_COLOUR } from './run-status.ts'
import { useStore, useThreadStores } from './store.ts'
import { getThreadStores, type ThreadSummary, threadListStore } from './thread-stores.ts'
import { LiveDot, UNTITLED_THREAD } from './threads-rail.tsx'

/**
 * The panes' own chrome (#938): the header of a pane beside the focused one, its composer's
 * stand-in, and the tabs the panes become when the window is too narrow for them side by side.
 */

/** A thread's name on a pane's header or tab: its name, its first prompt, or the untitled word. */
function paneTitle(thread: ThreadSummary | undefined): string {
  return thread?.name ?? thread?.title ?? UNTITLED_THREAD
}

/** The page's summary of `threadId`, kept current. */
function useSummary(threadId: string): ThreadSummary | undefined {
  return useStore(threadListStore).find((thread) => thread.threadId === threadId)
}

/** A pill on a pane's header, in its state's colour (the prototype's `.pane-flag`). */
const FLAG =
  'inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-semibold whitespace-nowrap'

/**
 * What a pane beside the focused one flags (#938): a question waiting on you — a button that
 * focuses the pane at the question, so it is seen and answered from the focused one — or, while
 * its run is doing something, the run's word. Nothing at rest.
 */
function PaneFlag({ thread, onFocus }: { thread: ThreadSummary; onFocus: () => void }): React.ReactNode {
  const dialog = useStore(getThreadStores(thread.threadId).dialog)
  const { open } = useContext(PaneViewContext)
  const { headline } = thread
  if (dialog !== undefined) {
    return (
      <button
        type="button"
        data-pane-flag="waiting"
        title={`answer it here: ${dialog.dialog.title}`}
        className={cn(FLAG, 'border-human text-human hover:bg-human/15')}
        onClick={(): void => {
          open('chat')
          onFocus()
          requestAnimationFrame(() => revealQuestion(dialog.id))
        }}
      >
        <HandIcon aria-hidden="true" className="size-3.5" />
        Waiting on you
      </button>
    )
  }
  if (headline === undefined || headline.state === 'idle' || headline.state === 'finished') return null
  return (
    <span data-pane-flag={headline.state} className={cn(FLAG, 'border-current', RUN_WORD_COLOUR[headline.state])}>
      <span aria-hidden="true" className={RUN_DOT[headline.state]} />
      {headline.word}
    </span>
  )
}

/**
 * The header of a pane beside the focused one (#938, the prototype's `.pane-peek` header): its
 * title — a button that focuses the pane — its place and what it runs with, its flag, and its close.
 */
export function PaneHeader({
  threadId,
  number,
  onFocus,
  onClose,
}: {
  threadId: string
  number: number
  onFocus: () => void
  onClose: () => void
}): React.ReactNode {
  const thread = useSummary(threadId)
  const title = paneTitle(thread)
  return (
    <header className="flex min-h-15 shrink-0 items-center gap-2 border-b px-4 py-2">
      <div className="grid min-w-0 flex-1">
        <button
          type="button"
          aria-label={`focus pane ${number}: ${title}`}
          className="max-w-full justify-self-start truncate rounded-xs text-left font-heading text-base leading-snug font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onFocus}
        >
          {title}
        </button>
        <ThreadSubtitle threadId={threadId} paneLabel={{ text: `Pane ${number}`, focused: false }} />
      </div>
      {thread === undefined ? null : <PaneFlag thread={thread} onFocus={onFocus} />}
      <ClosePane number={number} onClose={onClose} className={ICON_BUTTON} />
    </header>
  )
}

/**
 * The composer's place in a pane beside the focused one (#938): what was typed there, or what the
 * box would invite, and the key that focuses the pane. One composer on the page (#707): this is a
 * button to it — a click focuses the pane, its prompt with it. The composer itself stays mounted,
 * hidden, so its draft and attachments wait for the pane's return.
 */
export function ComposerStandIn(): React.ReactNode {
  const stores = useThreadStores()
  const chat = useChatContext()
  const { number, focus } = useContext(PaneSlotContext)
  const draft = useStore(stores.draft).trim()
  const launching = useStore(stores.launch)
  const disconnected = useStore(stores.disconnected)
  const ended = useStore(stores.incidents).ended
  const invitation = composerPlaceholder({ disconnected, ended, launching, running: chat.sessionGenerating })
  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      <button
        type="button"
        aria-label={`type in pane ${number ?? ''}`}
        className="mx-auto flex min-h-12 w-full max-w-transcript items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={(): void => focus(true)}
      >
        <span className={cn('min-w-0 flex-1 truncate', draft === '' ? '' : 'text-foreground')}>
          {draft === '' ? invitation : draft}
        </span>
        <span aria-hidden="true" className="shrink-0 font-mono text-meta font-semibold tracking-wider uppercase">
          Alt+{number}
        </span>
      </button>
    </div>
  )
}

/** A pane's tab, below the width its panes fit side by side (#938): its thread's state, title, project, and close. */
function PaneTab({
  threadId,
  number,
  focused,
  onFocus,
  onClose,
}: {
  threadId: string
  number: number
  focused: boolean
  onFocus: () => void
  onClose: () => void
}): React.ReactNode {
  const thread = useSummary(threadId)
  const project = useThreadProject(thread?.projectId)
  let state: 'waiting' | 'running' | 'idle' = 'idle'
  if (thread?.busy === true) state = 'running'
  if (thread?.waiting === true) state = 'waiting'
  const said = { waiting: ' · waiting on you', running: ' · running', idle: '' }[state]
  return (
    <div
      className={cn(
        'flex max-w-64 shrink-0 items-center rounded-t-sm border border-b-0',
        focused ? 'border-t-2 border-border-strong border-t-primary bg-background' : 'bg-sidebar',
      )}
    >
      <button
        type="button"
        aria-current={focused ? 'true' : undefined}
        className="grid min-h-11 min-w-0 py-1 pr-2 pl-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onFocus}
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <LiveDot state={state} />
          <span className="truncate">{paneTitle(thread)}</span>
        </span>
        <span className="truncate text-meta text-muted-foreground">
          {project?.title ?? ''}
          {said}
        </span>
      </button>
      <ClosePane
        number={number}
        onClose={onClose}
        className="size-8 text-muted-foreground hover:bg-card hover:text-foreground [&_svg]:size-4"
      />
    </div>
  )
}

/**
 * The panes as tabs (#938): below 1024px for two, below 1440px for three — the same panes and the
 * same focus rule, one on screen at a time. Each tab says its thread's state, so a question waiting
 * in another is seen from the one on screen.
 */
export function PaneTabs({
  layout,
  onFocus,
  onClose,
}: {
  layout: PaneLayout
  onFocus: (index: number) => void
  onClose: (index: number) => void
}): React.ReactNode {
  return (
    <div
      role="group"
      aria-label="open threads"
      className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto border-b px-3 pt-2"
    >
      {layout.threadIds.map((threadId, index) => (
        <PaneTab
          key={threadId}
          threadId={threadId}
          number={index + 1}
          focused={index === layout.focused}
          onFocus={(): void => onFocus(index)}
          onClose={(): void => onClose(index)}
        />
      ))}
    </div>
  )
}
