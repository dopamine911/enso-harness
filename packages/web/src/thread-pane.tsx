import { type EnsoForkReceipt, ensoLogger } from '@enso/core'
import type { ConnectionStatus, UIMessage } from '@tanstack/ai-client'
import { type ChatUIHost, createChatHook } from '@tanstack/ai-react/ui'
import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { ChatLayout } from './chat-layout.tsx'
import { ChatPromptInput } from './composer.tsx'
import { routeEnsoCustomEvent } from './custom-event-router.ts'
import { createFixtureChat } from './fixture-conversation.ts'
import { ForkContext, forkFromPage, offerPaneFork, RestoreContext, restoreFromPage } from './fork-thread.ts'
import { cn } from './lib/utils.ts'
import { ChatMessageRow } from './message-row.tsx'
import { isFixtureMode } from './page-mode.ts'
import {
  chatContexts,
  type ThreadChatOptions,
  DebugOpenContext,
  type LaunchActions,
  LaunchActionsContext,
  type PaneSlot,
  PaneSlotContext,
  type ThreadView,
  type PaneView,
  PaneViewContext,
} from './pane-context.ts'
import { ThreadStoresContext, useStore } from './store.ts'
import { PaneHeader } from './thread-panes.tsx'
import { getThreadStores, type ThreadStores, threadTitleFromMessage, updateThreadSummary } from './thread-stores.ts'

/**
 * Where the page places a pane of several (#938): its index left to right, how many are open,
 * whether they are side by side (else tabs, one on screen), and how it is focused and closed.
 */
export interface PanePlace {
  readonly index: number
  readonly count: number
  readonly sideBySide: boolean
  /** Focus this pane, and its prompt when `prompt`. */
  readonly onFocus: (prompt: boolean) => void
  readonly onClose: () => void
}

/** A pane's box and slot: off screen, the only pane (or the tab on screen), or one of a row. */
interface PaneFrame {
  readonly slot: PaneSlot
  readonly visible: boolean
  readonly className: string
  readonly style: React.CSSProperties | undefined
}

/** Off screen: laid out, unpainted, out of reach (#370, #472). */
const OFF_SCREEN = 'invisible absolute inset-0 flex min-h-0 min-w-0 flex-col [content-visibility:hidden]'

/** The pane on screen alone, or as the tab shown: it fills the box. */
const SHOWN_ALONE = 'absolute inset-0 flex min-h-0 min-w-0 flex-col'

const NO_SLOT: PaneSlot = { peek: false, number: undefined, narrow: false, focus: (): void => undefined }

/**
 * Where a pane is drawn (#938): side by side, a flex item in its order, the focused one under the
 * primary's top border; the focused pane alone (or as the tab on screen) filling the box; any other
 * off screen.
 */
function paneFrame(
  active: boolean,
  position: Pick<PanePlace, 'index' | 'count' | 'sideBySide'> | undefined,
  focus: (prompt: boolean) => void,
): PaneFrame {
  if (position === undefined) {
    return { slot: NO_SLOT, visible: active, className: active ? SHOWN_ALONE : OFF_SCREEN, style: undefined }
  }
  const { index, count, sideBySide } = position
  const slot: PaneSlot = {
    peek: sideBySide && !active,
    number: count > 1 ? index + 1 : undefined,
    narrow: sideBySide,
    focus,
  }
  if (!sideBySide) return { slot, visible: active, className: active ? SHOWN_ALONE : OFF_SCREEN, style: undefined }
  return {
    slot,
    visible: true,
    className: cn(
      'relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col border-t-2',
      active ? 'border-t-primary' : 'border-t-transparent bg-background',
      index > 0 && 'border-l',
    ),
    style: { order: index },
  }
}

/**
 * One thread's pane and its chat factory (#90): the widget map every thread renders through, bound
 * to one thread's stores.
 *
 * ⚠ TanStack AI is headless (#23): it supplies the client, the protocol, the dispatch factory and
 * markdown rendering, and no chrome. The chrome is ours: shadcn primitives and the ai-elements
 * shells under `components/ai-elements/` (#31). Its deprecated components (`Chat`, `ChatMessage`,
 * `ChatMessages`, `ChatInput`, `ToolApproval`) read the deprecated `<Chat>` provider's context,
 * not the one `createChatHook` installs, and cannot be mixed in. Message parts render through
 * `SelectedMessagePart`, never by hand: a `TextPart` is `{ type, content }`, and model output is
 * untrusted markdown.
 */

/**
 * ⚠ ONE CHAT FACTORY PER THREAD (#90), built by the thread's pane. Two facts force it:
 *
 *   • TanStack hands `onCustomEvent` only `(name, value, { toolCallId })` — no thread id —
 *     and the option is bound on the factory, not per call. The only way a `message-end`
 *     chunk lands in the right thread's cost is a callback that belongs to exactly one
 *     thread: this closure over its stores.
 *   • Changing `threadId` on a single `useChat` disposes the old client — `stop()` then
 *     `dispose()`, verified in `use-chat.js` — and the follow it holds open. Switching
 *     threads must therefore keep every pane mounted and change only what is visible.
 *
 * `connection` is the thread's `FollowConnection` (#112): TanStack's `SubscribeConnectionAdapter`
 * over prompt/follow. `live: true` opens the follow at mount rather than on the first send,
 * so a run another tab started on this thread renders here without prompting first.
 *
 * `?fixture` swaps the live server connection for the scripted conversation in
 * `fixture-conversation.ts` — the styling dev loop (#31). Everything downstream of the
 * connection is identical on both paths, which is the point.
 */
function threadChatOptions(stores: ThreadStores): ThreadChatOptions {
  return {
    threadId: stores.threadId,
    // A resumed thread mounts with its stored branch (#95); a minted one with nothing.
    initialMessages: [...stores.history],
    connection: isFixtureMode ? createFixtureChat().transport() : stores.connection,
    live: !isFixtureMode,
    /**
     * TanStack's designated path for AG-UI CUSTOM chunks (#29) — verified against the
     * stream processor: every CUSTOM chunk fires this with `(chunk.name, chunk.value)`.
     * The dispatch itself lives in `custom-event-router.ts` so it is testable (#53 S1.3).
     */
    onCustomEvent: (eventType: string, data: unknown): void => routeEnsoCustomEvent(stores, eventType, data),
  }
}

/**
 * One thread's chat factory: the pair `createChatHook` returns, bound to this thread's
 * options. ⚠ `useAppChat` takes NO overrides on purpose — TanStack's `threadId`/`live`
 * overrides would re-point a factory that belongs to exactly one thread, which is the
 * dispose-the-follow hazard `createThreadChatHook` exists to avoid.
 */
interface ThreadChatHook {
  readonly useAppChat: () => ChatUIHost<ThreadChatOptions> & { AppChat: React.ComponentType }
  readonly useChatContext: () => ChatUIHost<ThreadChatOptions>
}

function createThreadChatHook(stores: ThreadStores): ThreadChatHook {
  return createChatHook({ options: threadChatOptions(stores), context: chatContexts, ...chatComponents })
}

/**
 * The widget map every per-thread factory is built from — declared once, so all threads
 * render identically. Type-annotated by inference through `createThreadChatHook`.
 */
const chatComponents = {
  components: {
    /**
     * ⚠ `input` MUST be declared before `layout`.
     *
     * `docs/ui/react`: "Define `input` before `layout` in your component map to ensure
     * TypeScript recognizes it as registered." `LayoutProps` only carries `Input` when a
     * `components.input` is present, and that conditional type resolves in literal
     * property order — so declaring `layout` first makes `Input` vanish from its props
     * with a confusing error. Property order is load-bearing here, which is not a thing
     * one expects of an object literal.
     */
    input: ChatPromptInput,
    layout: ChatLayout,
    /**
     * ⚠ Ignores the bound `Parts` component ON PURPOSE — see `SelectedMessagePart`'s
     * header for why (TanStack's own dispatcher drops tools it has no name for). The row is
     * `ChatMessageRow`, which `TranscriptRows` draws for the messages in view (#739).
     */
    message: ChatMessageRow,
  },
  // ⚠ Deliberately empty, and load-bearing as documentation: nothing renders the bound
  // `Parts` component (the `message` slot above dispatches parts itself), so any entry
  // written here is dead code that LOOKS live.
  partsComponents: {},
  // No `interruptsComponents`: pi's questions are not AG-UI interrupts on this surface
  // (#112) — they arrive as blocking `extension-ui-request` chunks and render through the
  // layout's `PendingDialog`.
}

/** A pane mounted without a page has no view to change. */
const KEEP_VIEW = (): void => undefined

/**
 * The rail's summary of a pane's thread, kept current: its title, whether it runs, whether it waits.
 *
 * ⚠ The title depends on the FIRST user message and nothing else, but the message list gets a new
 * identity on every streamed chunk, so an effect over the list would re-derive it per token (#283).
 * It depends on that message instead, which the list's churn does not reach. A long thread's page
 * does not hold its first prompt (#739): the history names it.
 */
function useThreadSummary(stores: ThreadStores, messages: readonly UIMessage[], generating: boolean): void {
  const { threadId } = stores
  const openingPrompt = useStore(stores.earlier)?.firstPrompt
  const firstUserMessage = openingPrompt ?? messages.find((message) => message.role === 'user')
  const title = useMemo(
    () => (firstUserMessage === undefined ? undefined : threadTitleFromMessage(firstUserMessage)),
    [firstUserMessage],
  )
  const waiting = useStore(stores.dialog) !== undefined
  useEffect(() => {
    updateThreadSummary(threadId, { title, busy: generating, waiting })
  }, [threadId, title, generating, waiting])
}

const followLog = ensoLogger('browser', 'follow')

/**
 * The record of WHY the chat client's live subscription ended on an error (#915): the exception.
 *
 * TanStack catches a throw from handling a chunk — its stream processor, a callback of ours, a React
 * update — ends the subscription, says `connectionStatus: 'error'` and keeps the exception as `error`.
 * Caught there, a chunk handler's throw reaches no page-level error handler, so nothing else would
 * ever log it; the follow adapter has already told the page that updates stopped, and on which chunk
 * (`follow-connection.ts#consumerStopped`), and the run alert shows the exception's message.
 * Any other subscription error is recorded here too — a follow that never opened, already logged
 * by the adapter as "the follow could not be opened" — so that one has two lines.
 */
function useSubscriptionFailureRecord(
  threadId: string,
  connectionStatus: ConnectionStatus,
  error: Error | undefined,
): void {
  useEffect(() => {
    if (connectionStatus !== 'error') return
    followLog.warn('the live subscription ended on an error: {error}', {
      threadId,
      error: error === undefined ? 'no error was kept' : `${error.name}: ${error.message}`,
      ...(error?.stack === undefined ? {} : { stack: error.stack }),
    })
  }, [threadId, connectionStatus, error])
}

/** The fork and the restore a pane offers (#433, #551): on a page, not on a pane mounted alone. */
function usePaneForks(
  stores: ThreadStores,
  messages: readonly UIMessage[],
  onForked: ((receipt: EnsoForkReceipt) => void) | undefined,
): {
  forkAt: ((messageId: string | undefined) => void) | undefined
  restoreAt: ((messageId: string) => void) | undefined
} {
  // A fork reads the transcript when it is asked for, not per chunk: the latest committed list.
  const latestMessages = useRef(messages)
  useEffect(() => {
    latestMessages.current = messages
  }, [messages])
  const forkAt = useMemo(
    () =>
      onForked === undefined
        ? undefined
        : (messageId: string | undefined): void => {
            void forkFromPage(stores, latestMessages.current, messageId).then((receipt) => {
              if (receipt !== undefined) onForked(receipt)
            })
          },
    [stores, onForked],
  )
  // The header's Fork thread (#879) is this pane's `/fork`: the transcript it reads is here.
  useEffect(() => (forkAt === undefined ? undefined : offerPaneFork(stores, forkAt)), [stores, forkAt])
  // Restoring files (#551) is offered beside the fork: on a page, not on a pane mounted alone.
  const restoreAt = useMemo(
    () =>
      onForked === undefined
        ? undefined
        : (messageId: string): void => {
            void restoreFromPage(stores, latestMessages.current, messageId)
          },
    [stores, onForked],
  )
  return { forkAt, restoreAt }
}

/**
 * The pane's frame (#938), kept as one object while its place holds: what its context says to the
 * layout must not change identity per streamed chunk. The focus it offers reads the page's latest.
 */
function usePaneFrame(active: boolean, place: PanePlace | undefined): PaneFrame {
  const latest = useRef(place)
  useEffect(() => {
    latest.current = place
  }, [place])
  const focus = useCallback((prompt: boolean): void => latest.current?.onFocus(prompt), [])
  const index = place?.index
  const count = place?.count
  const sideBySide = place?.sideBySide
  return useMemo(
    () =>
      paneFrame(
        active,
        index === undefined || count === undefined ? undefined : { index, count, sideBySide: sideBySide === true },
        focus,
      ),
    [active, index, count, sideBySide, focus],
  )
}

/**
 * Beside the focused pane, a click anywhere in it focuses it (#938), as the prototype's pane does:
 * its content is inert, so the click lands on the pane, and nothing in it acts until it is focused.
 * Its own buttons — the title, the flag, the close, the composer's stand-in — do what they say. The
 * pointer's way in; the keyboard's are those buttons and Alt+number.
 */
function useClickToFocus(slot: PaneSlot): React.RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement | null>(null)
  const { peek, focus } = slot
  useEffect(() => {
    const element = box.current
    if (!peek || element === null) return undefined
    const onClick = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('button') !== null) return
      focus(false)
    }
    element.addEventListener('click', onClick)
    return () => element.removeEventListener('click', onClick)
  }, [peek, focus])
  return box
}

/**
 * One thread's pane: its chat factory, its stores in context, its summary kept current for
 * the rail.
 *
 * Stays mounted while another thread is on screen — see `createThreadChatHook` for why hiding,
 * not unmounting, is load-bearing. ⚠ And never `hidden` (#370): a `display: none` pane comes back
 * resized, and the stick-to-bottom scroller re-pins a reader who had scrolled up — the tabs' trap
 * (#362), one level up. Every pane fills the same box (`absolute inset-0`), so a switch moves
 * nothing; one off screen is `content-visibility: hidden`, which skips its style, layout and paint
 * like `display: none` but keeps its layout and scroll state, and costs a switch no more than
 * `hidden` does (#472). `invisible` stays as the fallback where `content-visibility` is unsupported
 * (otherwise the later panes would paint over the shown one); `inert` keeps an off-screen pane out
 * of the tab order and the accessibility tree.
 *
 * Side by side (#938), every pane of the page's layout is a flex item of the box, in its order —
 * the same element, so streaming, scroll and draft carry over. The focused one draws the page's
 * header at its top and holds the composer; one beside it draws its own header, and a click
 * anywhere in it focuses it.
 *
 * ⓘ Mounted alone by `__tests__/chat-screen.test.tsx`, two of them, to pin that an off-screen pane
 * renders no debug column.
 */
export function ThreadPane({
  threadId,
  active,
  place,
  header,
  debugOpen,
  view = 'chat',
  onView = KEEP_VIEW,
  onForked,
  launchActions,
}: {
  threadId: string
  /** The focused pane on screen: the page's composer is its (#707). */
  active: boolean
  /** Where the page's layout has it (#938); undefined off screen, and mounted alone. */
  place?: PanePlace | undefined
  /** The page's header, drawn at the top of the focused pane (#938). */
  header?: React.ReactNode
  /** The page's `?debug` switch; the column itself opens only in the active pane. */
  debugOpen: boolean
  /** This pane's view (#361, #938); shown while it is on screen. Mounted alone (a test), the chat. */
  view?: ThreadView
  /** Changes a pane's view — this one's, `threadId` (#938). Mounted alone there is no page, so the view stays as it is. */
  onView?: (view: ThreadView, threadId: string) => void
  /** The page opens a fork this pane made (#433). Mounted alone there is no page, and no fork is offered. */
  onForked?: (receipt: EnsoForkReceipt) => void
  /** What the launch panel does on the page (#877). Mounted alone, it offers no thread to pick up. */
  launchActions?: LaunchActions
}): React.ReactNode {
  const stores = getThreadStores(threadId)
  const { useAppChat } = useMemo(() => createThreadChatHook(stores), [stores])
  const chat = useAppChat()
  const { forkAt, restoreAt } = usePaneForks(stores, chat.messages, onForked)
  useThreadSummary(stores, chat.messages, chat.sessionGenerating)
  useSubscriptionFailureRecord(threadId, chat.connectionStatus, chat.error)
  const frame = usePaneFrame(active, place)
  const { visible, slot } = frame
  const open = useCallback((chosen: ThreadView): void => onView(chosen, threadId), [onView, threadId])
  const paneView = useMemo<PaneView>(() => ({ shown: visible ? view : undefined, open }), [visible, view, open])
  const box = useClickToFocus(slot)
  return (
    <div ref={box} inert={!visible} data-pane-thread={threadId} className={frame.className} style={frame.style}>
      <ThreadStoresContext.Provider value={stores}>
        <DebugOpenContext.Provider value={debugOpen && active}>
          <PaneViewContext.Provider value={paneView}>
            <PaneSlotContext.Provider value={slot}>
              <PaneTop threadId={threadId} active={active} header={header} onClose={place?.onClose} />
              <ForkContext.Provider value={forkAt}>
                <RestoreContext.Provider value={restoreAt}>
                  <LaunchActionsContext.Provider value={launchActions}>
                    <chat.AppChat />
                  </LaunchActionsContext.Provider>
                </RestoreContext.Provider>
              </ForkContext.Provider>
            </PaneSlotContext.Provider>
          </PaneViewContext.Provider>
        </DebugOpenContext.Provider>
      </ThreadStoresContext.Provider>
    </div>
  )
}

/**
 * A pane's top (#938): the page's header in the focused pane, its own header in a pane beside it —
 * its title, its place, its flag and its close — and nothing off screen.
 */
function PaneTop({
  threadId,
  active,
  header,
  onClose,
}: {
  threadId: string
  active: boolean
  header: React.ReactNode
  onClose: (() => void) | undefined
}): React.ReactNode {
  const { peek, number, focus } = useContext(PaneSlotContext)
  if (active) return header
  if (!peek || number === undefined || onClose === undefined) return null
  return <PaneHeader threadId={threadId} number={number} onFocus={(): void => focus(false)} onClose={onClose} />
}
