import type { EnsoForkReceipt } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { type ChatUIHost, createChatHook } from '@tanstack/ai-react/ui'
import { useEffect, useMemo, useRef } from 'react'
import { ChatLayout } from './chat-layout.tsx'
import { ChatPromptInput } from './composer.tsx'
import { routeEnsoCustomEvent } from './custom-event-router.ts'
import { createFixtureChat } from './fixture-conversation.ts'
import { ForkContext, forkFromPage, RestoreContext, restoreFromPage } from './fork-thread.ts'
import { ChatMessageRow } from './message-row.tsx'
import { isFixtureMode } from './page-mode.ts'
import {
  chatContexts,
  type ThreadChatOptions,
  DebugOpenContext,
  type ThreadView,
  type PaneView,
  PaneViewContext,
} from './pane-context.ts'
import { ThreadStoresContext, useStore } from './store.ts'
import { getThreadStores, type ThreadStores, threadTitleFromMessage, updateThreadSummary } from './thread-stores.ts'

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
 * ⓘ Mounted alone by `__tests__/chat-screen.test.tsx`, two of them, to pin that an off-screen pane
 * renders no debug column.
 */
export function ThreadPane({
  threadId,
  active,
  debugOpen,
  view = 'chat',
  onView = KEEP_VIEW,
  onForked,
}: {
  threadId: string
  active: boolean
  /** The page's `?debug` switch; the column itself opens only in the active pane. */
  debugOpen: boolean
  /** The page's view (#361); shown only in the active pane. Mounted alone (a test), the chat. */
  view?: ThreadView
  /** Changes the page's view. Mounted alone there is no page, so the view stays as it is. */
  onView?: (view: ThreadView) => void
  /** The page opens a fork this pane made (#433). Mounted alone there is no page, and no fork is offered. */
  onForked?: (receipt: EnsoForkReceipt) => void
}): React.ReactNode {
  const stores = getThreadStores(threadId)
  const { useAppChat } = useMemo(() => createThreadChatHook(stores), [stores])
  const chat = useAppChat()
  // A fork reads the transcript when it is asked for, not per chunk: the latest committed list.
  const latestMessages = useRef(chat.messages)
  useEffect(() => {
    latestMessages.current = chat.messages
  }, [chat.messages])
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
  useThreadSummary(stores, chat.messages, chat.sessionGenerating)
  const paneView = useMemo<PaneView>(() => ({ shown: active ? view : undefined, open: onView }), [active, view, onView])
  return (
    <div
      inert={!active}
      className={
        active
          ? 'absolute inset-0 flex min-h-0 min-w-0 flex-col'
          : 'invisible absolute inset-0 flex min-h-0 min-w-0 flex-col [content-visibility:hidden]'
      }
    >
      <ThreadStoresContext.Provider value={stores}>
        <DebugOpenContext.Provider value={debugOpen && active}>
          <PaneViewContext.Provider value={paneView}>
            <ForkContext.Provider value={forkAt}>
              <RestoreContext.Provider value={restoreAt}>
                <chat.AppChat />
              </RestoreContext.Provider>
            </ForkContext.Provider>
          </PaneViewContext.Provider>
        </DebugOpenContext.Provider>
      </ThreadStoresContext.Provider>
    </div>
  )
}
