import type { LayoutProps } from '@tanstack/ai-react/ui'
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { Conversation, ConversationContent, ConversationScrollButton } from './components/ai-elements/conversation.tsx'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { PendingQueue } from './composer.tsx'
import { PendingDialog } from './dialog-card.tsx'
import { LaunchHead, LaunchNotices, LaunchRecent } from './launch-panel.tsx'
import { useLaunching } from './launch-settings.tsx'
import { useThreadProject } from './page-listings.ts'
import {
  useChatContext,
  type ThreadChatOptions,
  DebugOpenContext,
  type ThreadView,
  PaneViewContext,
} from './pane-context.ts'
import { useThreadStores } from './store.ts'
import { DiffFocusContext, ThreadChanges } from './thread-changes.tsx'
import { ThreadContextDrawer } from './thread-context.tsx'
import { ThreadDebugDrawer } from './thread-debug.tsx'
import { ThreadEvalDrawer } from './thread-eval.tsx'
import { settledToolResults } from './thread-git.tsx'
import { ThreadPromptRunDiffs } from './thread-prompt-run-diffs.tsx'
import { ThreadStatsDrawer } from './thread-stats.tsx'
import { ThreadStatusBar } from './thread-status.tsx'
import { OpenInDiffContext } from './tool-views.tsx'
import { locateStatsTarget, type RevealStatsTarget, revealElement, ringElement } from './transcript-reveal.ts'
import {
  type TranscriptScroller,
  TranscriptRevealBridge,
  useIncidentReveal,
  TranscriptContent,
  useTranscriptSelection,
} from './transcript.tsx'

/**
 * A thread's layout (#90, #361): the views' box with the transcript laid out under every view, the
 * composer under the box, the `?debug` column beside it, and the status bar under both. Before the
 * session starts, the launch panel (#877) in the views' place, around the same composer.
 */

/** The launch panel's column: its head, the composer and the recent threads, top-aligned at the prototype's padding (#417), scrolled when they don't fit. */
const LAUNCH_COLUMN = 'flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-8 max-md:px-4 max-md:py-6'

/**
 * How long Show in Chat (#553) waits, after scrolling a message's row into view, before ringing it.
 * A guess, not a signal: the windowed list measures the rows it draws and corrects its scroll on its
 * own time, and nothing says when it is done. The ring is decoration only — the row is already
 * scrolled to — so a ring a little early costs nothing.
 */
const RING_AFTER_SCROLL_MS = 400

/**
 * Renders a run-level error as a destructive Alert. Reads the thread's chat through the
 * shared contexts declared above — the same `useChatContext` every widget here uses.
 */
function RunProblem(): React.ReactNode {
  const chat = useChatContext()
  if (chat.error === undefined || chat.error === null) return null
  return (
    <Alert variant="destructive" className="my-4">
      <AlertTitle>the run failed</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap">
        {chat.error instanceof Error ? chat.error.message : String(chat.error)}
      </AlertDescription>
    </Alert>
  )
}

/** A view panel's `id`s, in the pane on screen only — a hidden pane's would duplicate them. */
function panelIdsOf(shown: ThreadView | undefined, view: ThreadView): { id?: string; 'aria-labelledby'?: string } {
  return shown === undefined ? {} : { id: `thread-view-${view}`, 'aria-labelledby': `thread-view-${view}-tab` }
}

/** The view drawn over the transcript (#361), when one other than the chat is shown. */
function ThreadViewOverlay({
  shown,
  revealInTranscript,
  revealMessage,
  changesMoment,
}: {
  shown: ThreadView | undefined
  revealInTranscript: RevealStatsTarget
  /** Chat opened at the message `messageId` names, ringed; `false` when the transcript does not hold it. */
  revealMessage: (messageId: string) => boolean
  /** When the tree may have moved: a settled tool result, the run starting or ending. */
  changesMoment: string
}): React.ReactNode {
  // The thread's context (#361): what each request was made of, over the transcript.
  if (shown === 'context') {
    return (
      <div role="tabpanel" {...panelIdsOf(shown, 'context')} className="absolute inset-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-context-view">
          <ThreadContextDrawer />
        </div>
      </div>
    )
  }
  // The thread's stats (#45 phase 2), over the transcript (#361).
  if (shown === 'stats') {
    return (
      <div role="tabpanel" {...panelIdsOf(shown, 'stats')} className="absolute inset-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-stats-view">
          <ThreadStatsDrawer onNavigate={revealInTranscript} />
          <ThreadEvalDrawer onNavigate={revealInTranscript} />
        </div>
      </div>
    )
  }
  // What changed since the last push (#452): the tree and the chosen file's diff, over the transcript.
  if (shown === 'changes') {
    return (
      <div role="tabpanel" {...panelIdsOf(shown, 'changes')} className="absolute inset-0">
        <ThreadChanges moment={changesMoment} />
      </div>
    )
  }
  // The Diff Viewer (#553): the thread's prompt runs, stepped through snapshot to snapshot, over the transcript.
  if (shown === 'prompt-runs') {
    return (
      <div role="tabpanel" {...panelIdsOf(shown, 'prompt-runs')} className="absolute inset-0">
        <ThreadPromptRunDiffs
          moment={changesMoment}
          revealMessage={revealMessage}
          revealInTranscript={revealInTranscript}
        />
      </div>
    )
  }
  return null
}

/**
 * The views' box of a started thread: the views share it, the transcript keeping its size under
 * every view and the others drawn over it.
 */
function ThreadViews(): React.ReactNode {
  const chat = useChatContext()
  const { shown, open } = useContext(PaneViewContext)
  const scroller = useRef<TranscriptScroller | null>(null)
  const revealInTranscript = useCallback<RevealStatsTarget>(
    (target, stats) => {
      const bridge = scroller.current
      const content = bridge?.content() ?? null
      const element = content === null ? undefined : locateStatsTarget(content, stats, target)
      if (element === undefined || bridge === null) return false
      // Found in the transcript the Stats view hides (still mounted, so it can be searched):
      // show it, then scroll once it has a layout to scroll in.
      open('chat')
      requestAnimationFrame(() => {
        bridge.stopScroll()
        revealElement(element)
      })
      return true
    },
    [open],
  )
  // A tool card's "open in Diff" (#920): the Diff view, at the file the call wrote or edited.
  const [diffFocus, setDiffFocus] = useState<{ readonly path: string } | undefined>(undefined)
  const openInDiff = useCallback(
    (path: string): void => {
      setDiffFocus({ path })
      open('changes')
    },
    [open],
  )
  /** Whether the transcript is the view shown — a pane off screen keeps its chat. */
  const onChat = (shown ?? 'chat') === 'chat'
  const { selection, placed } = useTranscriptSelection(chat.messages, chat.sessionGenerating)
  const incidentReveal = useIncidentReveal(scroller)
  // A message by its id — a resumed thread's messages are its branch's entries (#553) — wherever it
  // is: the windowed list (#739) scrolls its row into view first, as an incident's reveal does
  // (#588), and the row, once drawn, is ringed after RING_AFTER_SCROLL_MS. Only the newest ring is
  // waited for, and none once the views are gone.
  const { rowScroll } = incidentReveal
  const ringTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(ringTimer.current), [])
  const revealMessage = useCallback(
    (messageId: string): boolean => {
      const row = chat.messages.findIndex((message) => message.id === messageId)
      const bridge = scroller.current
      if (row === -1 || bridge === null) return false
      open('chat')
      bridge.stopScroll()
      rowScroll.current?.(row)
      window.clearTimeout(ringTimer.current)
      ringTimer.current = window.setTimeout(() => {
        const element = bridge.content()?.querySelector(`[data-index="${row}"] [data-role]`)
        if (element !== null && element !== undefined) ringElement(element)
      }, RING_AFTER_SCROLL_MS)
      return true
    },
    [chat.messages, open, rowScroll],
  )
  return (
    <OpenInDiffContext.Provider value={openInDiff}>
      <DiffFocusContext.Provider value={diffFocus}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The transcript stays mounted AND LAID OUT under every view — `invisible` and `inert`,
          never `hidden` (#362): a `display: none` box comes back resized, and the stick-to-bottom
          scroller re-pins a reader who had scrolled up. Kept at its size, its scroll, its lock
          and its bubbles (the stats rows' targets) survive a trip to Context or Stats. */}
          <div
            role="tabpanel"
            {...panelIdsOf(shown, 'chat')}
            inert={!onChat}
            className={
              onChat ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'invisible flex min-h-0 min-w-0 flex-1 flex-col'
            }
          >
            <Conversation>
              <TranscriptRevealBridge into={scroller} />
              <ConversationContent className="mx-auto w-full max-w-transcript gap-6 px-6 pt-6 pb-8 max-md:p-4 ledger:gap-0">
                <TranscriptContent
                  messages={chat.messages}
                  setMessages={chat.setMessages}
                  selection={selection}
                  placed={placed}
                  incidentReveal={incidentReveal}
                />
                {/* ⚠ Mounted before anything opens one, deliberately. This is where #4's
                `ask` verdict reaches the browser, and an unmounted slot is precisely
                why an approval would silently never appear. */}
                <PendingDialog />
                <RunProblem />
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
          </div>
          <ThreadViewOverlay
            shown={shown}
            revealInTranscript={revealInTranscript}
            revealMessage={revealMessage}
            changesMoment={`${settledToolResults(chat.messages)}:${chat.sessionGenerating}`}
          />
        </div>
      </DiffFocusContext.Provider>
    </OpenInDiffContext.Provider>
  )
}

/**
 * The layout slot of the widget map.
 *
 * ⚠ A run's error is not a message part, so no `partsComponents` entry catches it (#24): it lives
 * on the chat instance, and `RunProblem` renders it here, deliberately. A layout that reads no
 * `chat.error` shows a failed run (a RUN_ERROR from a blocked `/mode`) as an empty assistant turn.
 *
 * The `Messages` slot goes unused on purpose (#739): TanStack's draws every message.
 * `TranscriptRows` draws the ones in view.
 */
export function ChatLayout({ Input }: LayoutProps<ThreadChatOptions>): React.ReactNode {
  const chat = useChatContext()
  const debugOpen = useContext(DebugOpenContext)
  const { shown, open } = useContext(PaneViewContext)
  const stores = useThreadStores()
  const threadProject = useThreadProject(stores.projectId)
  // A thread not started shows its launch panel (#877) where the views are.
  const launching = useLaunching()
  const launchTitle = useId()
  return (
    // `data-thread-layout`: a panel the bar opens finds this layout's composer from it (#714).
    <div data-thread-layout="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* The main column: the views' box, then the composer under every view (#707) — or, before
            the session starts, the launch panel around the same composer, centred and scrolling. */}
        <div
          className={launching ? LAUNCH_COLUMN : 'flex min-h-0 min-w-0 flex-1 flex-col'}
          {...(launching ? { role: 'region', 'aria-labelledby': launchTitle } : {})}
        >
          {launching ? (
            <>
              <LaunchHead titleId={launchTitle} />
              {/* Mounted here too: what the page said on the thread, a question or a failed run
                  before the first prompt is said. */}
              <div className="mx-auto grid w-full max-w-launch gap-2 empty:hidden">
                <LaunchNotices />
                <PendingDialog />
                <RunProblem />
              </div>
            </>
          ) : (
            <ThreadViews />
          )}
          {/* ⚠ UNDER EVERY VIEW, NOT IN THE CHAT'S PANEL (#707): inside it, the composer would go
              invisible and inert with the transcript whenever Context, Stats or Diff is in front, and
              text typed there would go nowhere. pi's queue (#75, not TanStack's `Queue` slot: a
              prompt sent during a run is listed here for every follower) goes with it.
              ⚠ ONE COMPOSER, MOVED, NEVER COPIED (#877): the launch panel's form and the docked
              composer are this one element, kept at this place in the tree — only its wrapper's class
              changes — so its draft, its attachments and its focus stay through Start. */}
          <PendingQueue />
          <div className={launching ? 'mx-auto w-full max-w-launch' : 'contents'}>
            <Input />
          </div>
          {launching ? <LaunchRecent /> : null}
        </div>
        {/* The session debug pane (#86): what the browser believes beside what pi's
						    session holds, for THIS thread. Scrolls on its own so a long branch never
						    moves the composer. */}
        {debugOpen ? (
          <div
            id="thread-debug-pane"
            className="w-debug-pane shrink-0 overflow-y-auto border-l bg-card max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-debug-drawer max-md:shadow-pop"
          >
            <ThreadDebugDrawer />
          </div>
        ) : null}
      </div>
      {/* The status bar (#90): activity, prompts, tool calls, cost — always visible, full
					    width under transcript AND debug pane, so it is the one place to look. */}
      <ThreadStatusBar
        messages={chat.messages}
        generating={chat.sessionGenerating}
        projectTitle={threadProject?.title}
        openView={open}
        shown={shown !== undefined}
      />
    </div>
  )
}
