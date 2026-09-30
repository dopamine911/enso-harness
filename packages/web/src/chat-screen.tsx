import {
  type DialogAnswer,
  ENSO_CONTEXT_COMMAND,
  ENSO_FORK_COMMAND,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_IMAGE_MIME_TYPES,
  ENSO_NOTICE_SOURCE,
  ENSO_PROMPT_MAX_IMAGES,
  type EnsoDialogAnswer,
  type EnsoDialogSpec,
  type EnsoForkReceipt,
  type EnsoProject,
  type EnsoPromptImage,
  type EnsoProviderRefusal,
  type EnsoThreadHistory,
  isEnsoImageMimeType,
  type RuntimeCommand,
} from '@enso/core'
import type { ContentPart } from '@tanstack/ai'
import type { ConnectConnectionAdapter, UIMessage } from '@tanstack/ai-client'
import { automaticPartsForMessage, type ChatUISelectedPart, selectChatUI } from '@tanstack/ai-client/ui'
import {
  type ChatUIContexts,
  type ChatUIHost,
  createChatHook,
  createChatHookContexts,
  type LayoutProps,
  type MessageProps,
} from '@tanstack/ai-react/ui'
import {
  ArrowUpIcon,
  ChartColumnIcon,
  CircleQuestionMarkIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitForkIcon,
  LayersIcon,
  MenuIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  SquareIcon,
} from 'lucide-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { AddProjectDialog } from './add-project.tsx'
import { useRereadAfterCompaction } from './branch-reread.ts'
import { type ChoiceHandlers, CommandPalette, runTypedHostCommand, typedCommandName } from './command-palette.tsx'
import { fetchThreadCommands } from './commands-connection.ts'
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from './components/ai-elements/attachments.tsx'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './components/ai-elements/conversation.tsx'
import { Message, MessageContent } from './components/ai-elements/message.tsx'
import {
  PromptInput,
  PromptInputButton,
  type PromptInputError,
  type PromptInputMessage,
  PromptInputTextarea,
  usePromptInputAttachments,
} from './components/ai-elements/prompt-input.tsx'
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
  Queue as QueueShell,
} from './components/ai-elements/queue.tsx'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Textarea } from './components/ui/textarea.tsx'
import { routeEnsoCustomEvent } from './custom-event-router.ts'
import { EnsoRing, EnsoSmile } from './enso-mark.tsx'
import type { EnsoRendererMap } from './EnsoToolResult.tsx'
import { createFixtureChat, fixtureFetch } from './fixture-conversation.ts'
import type { DialogAnswerOutcome, FollowConnection } from './follow-connection.ts'
import { ForkContext, forkFromPage } from './fork-thread.ts'
import { ModelChip, ModelChoiceDialog, ThinkingLevelSelect, useModelState, useRecordedModel } from './model-state.tsx'
import { ThreadNotifications } from './notifications.tsx'
import { PermissionModeSelect, usePermissionMode } from './permission-mode.tsx'
import { createProjectsStore, projectOf, removeProject } from './project-list.ts'
import { PromptManagerDialog } from './prompt-manager.tsx'
import { QuestionnaireControls } from './questionnaire-card.tsx'
import { providerRefusalLine, providerRefusalSource, RefusedAttemptLine, refusalOfMessage } from './refused-attempt.tsx'
import { SelectedMessagePart } from './selected-message-part.tsx'
import { SettingsDialog } from './settings-dialog.tsx'
import { StartSessionDialog } from './start-session.tsx'
import { ThreadStoresContext, useStore, useThreadStores } from './store.ts'
import {
  createResumeRequests,
  createStoredThreadsStore,
  fetchThreadHistory,
  storedThreadsNotOnThisPage,
} from './stored-threads.ts'
import { ThreadChanges } from './thread-changes.tsx'
import { ThreadContextDialog, ThreadContextDrawer } from './thread-context.tsx'
import { ThreadDebugDrawer } from './thread-debug.tsx'
import { ThreadEvalDrawer } from './thread-eval.tsx'
import { settledToolResults } from './thread-git.tsx'
import { ThreadStatsDrawer } from './thread-stats.tsx'
import { ThreadStatusBar } from './thread-status.tsx'
import {
  adoptThread,
  getThreadStores,
  markThreadActive,
  mintThread,
  type ThreadStores,
  type ThreadSummary,
  threadListStore,
  titleFromMessage,
  updateThreadSummary,
} from './thread-stores.ts'
import { readThreadUrl, type ThreadUrl, urlForThread } from './thread-url.ts'
import { forkParentTitles, ThreadsRail, UNTITLED_THREAD } from './threads-rail.tsx'
import { locateStatsTarget, type RevealStatsTarget, revealElement } from './transcript-reveal.ts'

/**
 * The enso web surface (#24, #17) — every component and the chat wiring, importable with
 * no DOM at module scope (the ENTRY that mounts it is main.tsx, kept thin so the
 * coverage manifest can import everything else). Composed per `docs/ui/react`; presentation layer per #31
 * (shadcn radix-nova theme + components vendored from ai-elements, laid out after the
 * ai-elements chatbot example).
 *
 * ⚠ THIS FILE WAS WRONG THREE TIMES. Each mistake is recorded because each was corrected
 * by Daniel rather than by the code, and the next session should not repeat any of them.
 *
 * 1. HAND-ROLLED THE CHAT. Mapped `chat.messages` and guessed at `UIMessage`'s part
 *    vocabulary — defeating the reason for adopting TanStack AI (#23) and leaving #18's
 *    real integration point (`partsComponents.toolResult`) unwired. It also read
 *    `part.text` where `TextPart` is `{type, content}`, which would have rendered every
 *    assistant message BLANK with no error at all.
 *
 * 2. HAND-WROTE CHROME THAT SHIPS. `<p>{part.content}</p>` rendered assistant output as
 *    plain text where `TextPart` renders markdown safely (react-markdown with `rehype-sanitize`
 *    LAST then; `@tanstack/markdown` with raw HTML escaped since `@tanstack/ai-react` 0.25).
 *    Every reply from a coding agent is markdown, and safe rendering matters on its own:
 *    model output is untrusted text entering a DOM.
 *
 * 3. OVER-CORRECTED INTO DEPRECATED COMPONENTS. Six of the eight exports are
 *    `@deprecated`, removed at 1.0.0 — `Chat`, `ChatMessage`, `ChatMessages`, `ChatInput`,
 *    `ToolApproval`. Only `TextPart` and `ThinkingPart` are current, and both are content
 *    renderers rather than chrome. `ChatInput`'s own notice says "use an application-owned
 *    input component", so the form deleted in step 2 was the right SHAPE all along.
 *
 *    ⚠ It failed loudly, which was the one mercy:
 *        Uncaught Error: Chat components must be wrapped in <Chat>.
 *    `ChatInput` reads the DEPRECATED `<Chat>` provider's context, not the one
 *    `createChatHook` installs. The two APIs cannot be mixed and nothing in the types says
 *    so.
 *
 * ⓘ TanStack AI is HEADLESS. It supplies the client, the protocol, the dispatch factory and
 * markdown rendering. There is no CSS in the package and no styled kit on npm. So the chrome
 * here is ours: shadcn/ui primitives plus the ai-elements shells vendored under
 * `components/ai-elements/` (each carries its own provenance header).
 */

/**
 * Renderers keyed by descriptor `kind` (#18).
 *
 * ⚠ Empty on purpose. Every tool result falls through to the mandatory textual form, which
 * is exactly what the contract promises for an unknown kind — so empty is the honest
 * default, not a gap. A renderer is added when a tool earns one.
 */
const descriptorRenderers: EnsoRendererMap = {}

/**
 * `?fixture` swaps the live server connection for the scripted conversation in
 * `fixture-conversation.ts` — the styling dev loop (#31). Everything downstream of the
 * connection (the hook, the parts pipeline, every component below) is identical on both
 * paths, which is the point: the fixture styles the SAME renderers the live page uses.
 */
// ⚠ `typeof window` guard: this module is imported by the coverage manifest under `bun
// test`, where no DOM exists — fixture mode is a browser concern, so headless is never
// fixture mode. The ENTRY (main.tsx) stays the only module that touches the DOM freely.
const isFixtureMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('fixture')
/**
 * The network every thread on this page talks through — the page's own, or on the fixture page a
 * fetch that refuses (#404): the transport swap covers only TanStack's send, and a prompt sent
 * mid-reply, Stop or a mode change reached the real server and ran a real model. Every thread
 * the page mints or adopts goes through these two, so none is left on the real network.
 */
const PAGE_FETCH = isFixtureMode ? fixtureFetch : undefined
const mintPageThread = (projectId?: string, threadId?: string): ThreadStores =>
  mintThread(PAGE_FETCH, projectId, threadId)
const adoptPageThread = (history: EnsoThreadHistory, initialDraft?: string): ThreadStores =>
  adoptThread(history, PAGE_FETCH, initialDraft)
/** `?debug` opens the session debug drawer (#86) — same switch shape as `?fixture`. */
const isDebugMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')
/**
 * The chat contexts every widget below reads through — created ONCE and handed to every
 * per-thread factory (`createThreadChatHook`), TanStack's escape hatch for "widgets in
 * other files". One `useChatContext` serves every thread's tree because each pane's
 * `AppChat` provides the same context, with its own chat instance.
 */
const chatContexts = createChatHookContexts()
const useChatContext: ChatUIContexts['useChatContext'] = chatContexts.useChatContext

/**
 * ⚠ ONE CHAT FACTORY PER THREAD (#90 PR 3), built by the thread's pane. Two facts force it:
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
/** The options type the widget map below is written against — one shape for every thread. */
interface ThreadChatOptions {
  threadId: string
  initialMessages: UIMessage[]
  /** The live follow, or — under `?fixture` — the scripted conversation's local adapter. */
  connection: ConnectConnectionAdapter | FollowConnection
  live: boolean
  onCustomEvent: (eventType: string, data: unknown) => void
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
 * Whether THIS pane shows the `?debug` column. Provided per pane as `debugOpen && active`:
 * every live pane stays mounted, so gating on the page-level switch alone rendered the
 * column — with its fixed `id` and its own inspection fetches — once per thread, hidden or
 * not (PR #94 review). Exactly one pane is active, so exactly one column exists.
 */
const DebugOpenContext = createContext(false)

/**
 * The page's main views (#361): the transcript, or an analysis of the thread in its place. One
 * choice for the page — switching thread keeps it — rendered by the pane on screen.
 */
export type ThreadView = 'chat' | 'context' | 'stats' | 'changes'

/** A tab's value back to a view: the only strings the tab list hands over are these. */
const THREAD_VIEWS: Readonly<Record<string, ThreadView>> = {
  chat: 'chat',
  context: 'context',
  stats: 'stats',
  changes: 'changes',
}

/**
 * What THIS pane shows, and how to change the page's view. `shown` is undefined in a hidden
 * pane, which then draws its transcript and nothing else: the stats view — its fetches, its
 * `stores.usage` subscription, its panel `id`s — exists once, in the pane on screen, the debug
 * column's rule above (PR #358 review).
 */
interface PaneView {
  readonly shown: ThreadView | undefined
  readonly open: (view: ThreadView) => void
}

const PaneViewContext = createContext<PaneView>({ shown: undefined, open: (): void => undefined })

/** What `TranscriptRevealBridge` hands the layout: the pane's transcript and its scroll lock. */
interface TranscriptScroller {
  readonly content: () => HTMLElement | null
  readonly stopScroll: () => void
}

/**
 * Lends the layout what only `<Conversation>`'s children can reach (#359): its content element,
 * the root a stats target is looked for under (one pane's, never a hidden pane's), and
 * `stopScroll`. Stick-to-bottom pulls a streaming transcript back down on every resize; a jump to
 * turn 3 has to let go of that lock first, or the next token undoes it.
 */
function TranscriptRevealBridge({ into }: { into: React.RefObject<TranscriptScroller | null> }): null {
  const { contentRef, stopScroll } = useStickToBottomContext()
  useEffect(() => {
    into.current = { content: () => contentRef.current, stopScroll }
    return () => {
      into.current = null
    }
  }, [into, contentRef, stopScroll])
  return null
}

/** One selected part paired with the React key that identifies it. */
export interface KeyedPart {
  /** Stable across re-renders AND position changes — see `keyedParts` for why that matters. */
  partKey: string
  selected: ChatUISelectedPart
  isTrailingPart: boolean
}

/**
 * Pairs each selected part with a React key that is an IDENTITY, not a position.
 *
 * ⚠ Tool parts MOVE. The selection runs over the whole message list (see `ChatMessageRow`'s
 * header), so a result the server stamps onto a different message re-pairs its call and
 * shifts that call's index. A key carrying the array index therefore changes identity for a
 * part that did not change — React remounts it and the rendered tool block loses its state.
 * `noArrayIndexKey` is right to refuse it, and this is the fix rather than a suppression:
 * tool parts already carry a real id (`id` on tool-call, `toolCallId` on tool-result), so
 * key by that. Text/thinking/image parts carry no id, but they are append-only within one
 * message, so a per-KIND occurrence counter identifies them without borrowing the position
 * of the whole list.
 *
 * `isTrailingPart` rides along so the caller needs no index either — see its use below.
 *
 * ⓘ Exported for `__tests__/chat-screen.test.tsx` only; nothing else imports it.
 */
export function keyedParts(parts: ChatUISelectedPart[]): KeyedPart[] {
  const seenPerKind = new Map<string, number>()
  return parts.map((selected, position) => {
    const identity = partIdentity(selected)
    if (identity !== undefined) {
      return { partKey: `${selected.key}-${identity}`, selected, isTrailingPart: position === parts.length - 1 }
    }
    const seen = seenPerKind.get(selected.key) ?? 0
    seenPerKind.set(selected.key, seen + 1)
    return { partKey: `${selected.key}#${seen}`, selected, isTrailingPart: position === parts.length - 1 }
  })
}

/** The part's own stable id, or undefined for the kinds that carry none. */
function partIdentity(selected: ChatUISelectedPart): string | undefined {
  if (selected.key === 'toolCall') return selected.part.id
  if (selected.key === 'toolResult') return selected.part.toolCallId
  return undefined
}

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

/**
 * The composer row's permission-mode control (#84): the thread's current mode, and a
 * dropdown that switches it through the mode route (L3 step C) — a control, not a prompt.
 * Beside the composer rather than in the page header (#90 PR 3): it is per THREAD, and
 * deepseek-harness keeps the mode selector in the composer chrome for the same reason.
 *
 * ⚠ `POST …/mode`, never a prompt: the browser says a mode; how the host's extension is
 * told is the host's (for picc, its per-mode command). The indicator then updates from the
 * `permission-mode` receipt the host emits once the mode is persisted — the mode actually set —
 * never from the click. Invariant 2: a route tells pi; the feed ends the story.
 *
 * ⚠ Disabled while a run is in flight, the same rule the send button follows: a mode
 * change mid-run would collide with the busy-thread semantics #75 is deciding.
 *
 * On mount it asks the server what a fresh thread starts in, so the control reads
 * `default` from the first paint rather than `unknown` until the first run. In fixture
 * mode there is no server; the fetch fails and the store honestly stays `unknown`.
 */
function PermissionModeControl(): React.ReactNode {
  const chat = useChatContext()
  const stores = useThreadStores()
  const { mode, available } = usePermissionMode()
  useEffect(() => {
    void stores.permissionMode.seed(async () => (await stores.fetch('/api/mode')).json())
  }, [stores])
  return (
    <PermissionModeSelect
      mode={mode}
      available={available}
      disabled={chat.sessionGenerating}
      onSelect={(next: string) => void stores.connection.changeMode(next)}
    />
  )
}

/**
 * The composer row's model controls (#338 slice 2, the control half of #44): the `thinking`
 * select and the model chip, both reading the thread's model store, both changing it through
 * `POST …/command` — a control, not a prompt, like the mode select beside them. The chip opens
 * the model dialog the owner renders (`onOpenModelDialog`), the same one the palette's `/model`
 * row opens. ⚠ NOT disabled while a run is in flight or before the first run: pi takes a model
 * change between turns, the route answers 409 while busy and the refusal is said as a notice —
 * and choosing before the first prompt is the point (#341, `model-state.tsx`'s header).
 */
function ModelControls({ onHost, onOpenModelDialog }: HostCommandHandlers): React.ReactNode {
  const state = useModelState()
  const recorded = useRecordedModel()
  return (
    <>
      <ThinkingLevelSelect state={state} onSelect={(level: string): void => onHost('thinking', level)} />
      <ModelChip state={state} recorded={recorded} onOpen={(): void => onOpenModelDialog('model')} />
    </>
  )
}

/** How a `host` command is run and how the model dialog is opened — the composer's, handed to its chrome and palette. */
interface HostCommandHandlers {
  readonly onHost: (commandName: string, optionId?: string) => void
  /** Open the dialog for a `select` host command, by name. */
  readonly onOpenModelDialog: (commandName: string) => void
  /** Open the view a `view` host command names (`/context`, #361), by name. */
  readonly onOpenView: (commandName: string) => void
}

/**
 * The palette's handlers, built from the composer's — ONE object, so a row chosen in the palette
 * and the same command typed bare (#388) are routed by the same code.
 */
function paletteHandlers(
  host: HostCommandHandlers,
  onRun: (commandName: string) => void,
  onInsert: (commandName: string) => void,
): ChoiceHandlers {
  return {
    onRun,
    onInsert,
    onHost: host.onHost,
    onOpenModelDialog: (command: RuntimeCommand): void => host.onOpenModelDialog(command.name),
    onOpenView: (command: RuntimeCommand): void => host.onOpenView(command.name),
  }
}

/*
 * ⓘ `DialogAnswerControls` and `EnsoDialogCard` are exported for `__tests__/chat-screen.test.tsx`
 * (#49): static renders of each dialog method. Nothing outside this file and that test imports
 * them. `PendingDialog` is asserted through the mounted pane (`thread-pane.test.tsx`, #118).
 */

/**
 * pi's blocking dialogs — `select`, `confirm`, `input`, `editor` — answered from the page (#27, #112).
 *
 * The question arrives on the follow as a blocking `extension-ui-request` (the `EnsoDialogSpec` the
 * server built, validated again by the router before it reaches the store), and the answer
 * is one `POST /api/threads/:id/dialog`. No interrupt: the run keeps going on the follow
 * while the human decides, and nothing on the server is parked.
 *
 * ⚠ The payloads handed to `answer` are EXACTLY pi's wire shapes minus the envelope
 * (`{value}` / `{confirmed}`) — the server validates them against the question
 * (`validateDialogAnswer`) and forwards them verbatim, so inventing a richer shape here
 * would be refused there. The one shape that is not pi's is the questionnaire's `{answers}`
 * (#12), which the host hands to the asking tool. Cancel is pi's `{cancelled: true}`.
 */
/**
 * The per-method answer controls, one early return per dialog method — extracted from a
 * ternary chain so each shape reads on its own.
 *
 * `input` and `editor` share the form; the only difference is the field element.
 */
export function DialogAnswerControls({
  dialog,
  answer,
  disabled,
}: {
  dialog: EnsoDialogSpec
  answer: (payload: EnsoDialogAnswer) => void
  /** An answer is already in flight: every control refuses a second one — see {@link OpenQuestion} (#275). */
  disabled: boolean
}): React.ReactNode {
  if (dialog.method === 'questionnaire') {
    return <QuestionnaireControls dialog={dialog} answer={answer} disabled={disabled} />
  }
  if (dialog.method === 'confirm') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">{dialog.message}</p>
        <div className="flex gap-2">
          <Button type="button" disabled={disabled} onClick={() => answer({ confirmed: true })}>
            Yes
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => answer({ confirmed: false })}>
            No
          </Button>
        </div>
      </div>
    )
  }
  if (dialog.method === 'select') {
    return (
      <div className="flex flex-col gap-3">
        {/* The detail behind the question (#73): a file preview, a diff, a command. Preformatted,
				    never markdown — model-chosen file content must not render as HTML. */}
        {dialog.message === undefined || dialog.message.length === 0 ? null : (
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
            {dialog.message}
          </pre>
        )}
        <div className="flex flex-wrap gap-2">
          {dialog.options.map((option) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => answer({ value: option })}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <InputGuidance dialog={dialog} />
      <form
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const field = event.currentTarget.elements.namedItem('answer')
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
            answer({ value: field.value })
          }
        }}
        className="flex items-start gap-2"
      >
        {dialog.method === 'editor' ? (
          <Textarea name="answer" defaultValue={dialog.prefill ?? ''} rows={6} disabled={disabled} className="flex-1" />
        ) : (
          <Input
            name="answer"
            // A credential (#338 slice 3: `/login`'s API key) is masked, and never a transcript line.
            type={dialog.method === 'input' && dialog.secret === true ? 'password' : 'text'}
            placeholder={dialog.placeholder ?? ''}
            autoComplete={dialog.method === 'input' && dialog.secret === true ? 'new-password' : 'off'}
            disabled={disabled}
            className="flex-1"
          />
        )}
        <Button type="submit" disabled={disabled}>
          Answer
        </Button>
      </form>
    </div>
  )
}

/**
 * What an `input` question carries beside its field (#388) — both set by the host, never by pi:
 * the explanation (a login's code prompt says the paste is the fallback, and what to paste; plain
 * text, never markdown) and the page to open (a login's authorization page, in a NEW TAB of this
 * browser, the one where the login has to happen). The page is a link styled as a button, not
 * `window.open`, so it is a click the browser allows. The schema admits only http(s); the check
 * here keeps a `javascript:` URL from ever becoming an href if that changes.
 */
function InputGuidance({ dialog }: { dialog: EnsoDialogSpec }): React.ReactNode {
  if (dialog.method !== 'input') return null
  const { message, link } = dialog
  return (
    <>
      {message === undefined || message.length === 0 ? null : (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">{message}</p>
      )}
      {link === undefined || !/^https?:\/\//.test(link.url) ? null : (
        <Button asChild variant="outline" className="self-start">
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            {link.label}
          </a>
        </Button>
      )}
    </>
  )
}

/**
 * The question as a card — the one surface that parks pi on a human, so it is a NAMED GROUP
 * (#276): `role="group"` whose accessible name is the question, with the title carrying a
 * heading role so a screen reader can jump straight to it.
 *
 * NOT `role="dialog"`/`aria-modal`: the run keeps going behind it and the rest of the page
 * stays usable, so claiming modality would be a lie a screen reader acts on. {@link
 * OpenQuestion} moves focus into the group on arrival, and that focus move is what announces it
 * — which is why there is no live region here: a polite region wrapping the card would read the
 * whole question a second time.
 */
export function EnsoDialogCard({
  dialogId,
  dialog,
  answer,
  cancel,
  disabled,
  ref,
}: {
  /** The open question's id — unique per question, so the `aria-labelledby` target is too. */
  dialogId: string
  dialog: EnsoDialogSpec
  answer: (payload: EnsoDialogAnswer) => void
  cancel: () => void
  disabled: boolean
  ref?: React.Ref<HTMLDivElement>
}): React.ReactNode {
  const titleId = `enso-dialog-title-${dialogId}`
  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={titleId}
      className="my-2 grid max-w-3xl overflow-hidden rounded-lg border border-human bg-card signal:ring-1 signal:ring-human/30 ledger:my-3 ledger:rounded-xs ledger:border-dashed ink:border-2"
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wider text-human uppercase">
          <CircleQuestionMarkIcon aria-hidden="true" className="size-4" />
          pi is asking
        </span>
        <span className="font-mono text-xs text-muted-foreground">{dialog.method}</span>
      </div>
      <div className="grid gap-3 p-3">
        <h2 id={titleId} className="font-heading text-base font-semibold">
          {dialog.title}
        </h2>
        <DialogAnswerControls dialog={dialog} answer={answer} disabled={disabled} />
      </div>
      <div className="flex justify-end px-3 pb-3">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={cancel}>
          Cancel — decline the question
        </Button>
      </div>
    </div>
  )
}

/**
 * Answer the thread's open question through its connection.
 *
 * The slot clears once the question is SPENT — taken by the server (`answered`), or already
 * settled from another tab or expired (`gone`). A `refused` answer (an unoffered value, 422)
 * leaves the question open on the server, so it stays on screen with the reason as a notice:
 * nothing would re-show it otherwise, and the thread would sit busy behind a card that vanished
 * (PR #113 review). `unreachable` (the request never arrived) leaves it open the same way. The
 * outcome is handed back so the caller can tell a spent question from one still standing
 * (#275). ⓘ Exported for `__tests__/chat-screen.test.tsx`.
 */
export async function settleDialog(
  stores: Pick<ThreadStores, 'connection' | 'dialog'>,
  response: DialogAnswer,
): Promise<DialogAnswerOutcome> {
  const outcome = await stores.connection.answerDialog(response)
  if (outcome === 'answered' || outcome === 'gone') stores.dialog.set(undefined)
  return outcome
}

/** The thread's open question, if any — see {@link OpenQuestion}. */
function PendingDialog(): React.ReactNode {
  const stores = useThreadStores()
  const pending = useStore(stores.dialog)
  if (pending === undefined) return null
  // ⚠ Keyed by the question's id: the in-flight flag and the focus move are per-QUESTION
  // state, so the next question arrives on a fresh mount instead of inheriting either.
  return <OpenQuestion key={pending.id} id={pending.id} dialog={pending.dialog} />
}

/**
 * One open question: answered ONCE (#275), and announced on arrival (#276).
 *
 * The card stays mounted for the whole round trip — `settleDialog` clears the slot only once
 * the server has taken the answer — so nothing but this flag stops a second click from
 * sending a second `POST …/dialog`. The server 404s the spent question, the adapter reports
 * `gone`, and the user reads a red `dialog <id> gone: 404 …` line for an answer that in fact
 * landed. ⚠ The flag is a REF as well as state: two clicks in one task (a double-click on
 * `Yes`, a second option on a `select`) both read the state from before the first re-render,
 * so the state is what disables the controls and the ref is what closes that race. A
 * `refused` (422) or `unreachable` answer leaves the question standing, so those re-open the
 * controls; anything else spends it and this unmounts.
 */
function OpenQuestion({ id, dialog }: { id: string; dialog: EnsoDialogSpec }): React.ReactNode {
  const stores = useThreadStores()
  const [settling, setSettling] = useState(false)
  const inFlight = useRef(false)
  const card = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // The run is parked on a human, so the question takes focus: it announces the group (whose
    // name IS the question) and spares a keyboard user the whole transcript to find it.
    card.current?.querySelector<HTMLElement>('button, input, textarea')?.focus()
  }, [])
  const settle = (response: DialogAnswer): void => {
    if (inFlight.current) return
    inFlight.current = true
    setSettling(true)
    void settleDialog(stores, response).then((outcome) => {
      if (outcome !== 'refused' && outcome !== 'unreachable') return
      inFlight.current = false
      setSettling(false)
    })
  }
  return (
    <EnsoDialogCard
      ref={card}
      dialogId={id}
      dialog={dialog}
      disabled={settling}
      answer={(payload: EnsoDialogAnswer) => settle({ id, ...payload })}
      cancel={() => settle({ id, cancelled: true })}
    />
  )
}

/** The composer's draft with more text appended — restored prompts after what was already typed, one blank line between. */
function joinDrafts(current: string, ...more: readonly string[]): string {
  return [current, ...more].filter((part) => part.trim().length > 0).join('\n\n')
}

/** What the form would not take, as the notice says it (#68): how many, and the cap by name — never a silent drop. */
export function describeAttachmentError(error: PromptInputError): string {
  const files = error.count === 1 ? '1 file was' : `${error.count} files were`
  switch (error.code) {
    case 'accept':
      return `${files} not attached: only images are attached here (${ENSO_IMAGE_MIME_TYPES.map((mimeType) => mimeType.slice('image/'.length)).join(', ')})`
    case 'max_file_size':
      return `${files} not attached: an image is at most ${(ENSO_IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB`
    case 'max_files':
      return `${files} not attached: at most ${ENSO_PROMPT_MAX_IMAGES} images on one prompt`
  }
}

/**
 * Stop, while there is something to stop (#116): a run in flight, or a login waiting on its
 * provider (#348). Through the thread's connection — `POST …/abort`. ⚠ NOT `chat.stop()`: that
 * aborts this client's POST, which returned at admission, and touches nothing on the server. What
 * it stopped ends on the follow (`settled` and `status` for a run; `login` and the cancel's line
 * for a login), so this button changes nothing itself; the feed does. The run flag is
 * `sessionGenerating`, the shared one — `isLoading` never rises here (#103 receipt). A login holds
 * no run lease, so it has its own flag, `stores.login`. Not offered once the follow has ended
 * (#119): the flags are then as of that moment, and a stop that may stop nothing is issue #4's
 * shape — `docs/architecture.md`, The control plane, invariant 5.
 */
function StopControl({
  running,
  disconnected,
  onStop,
}: {
  running: boolean
  disconnected: boolean
  onStop: () => void
}): React.ReactNode {
  const login = useStore(useThreadStores().login)
  if (disconnected || !(running || login !== undefined)) return null
  const stopsLogin = !running && login !== undefined
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="size-11"
      aria-label={stopsLogin ? `cancel the login to ${login.provider}` : 'stop the run'}
      title={
        stopsLogin
          ? `cancel the login to ${login.provider} — nothing is stored`
          : 'stop the run in flight — pi is told; the run ends on the feed'
      }
      onClick={onStop}
    >
      <SquareIcon />
    </Button>
  )
}

/**
 * Inside the ported form: the attachment strip, the textarea, the `/` palette, the attach /
 * stop / send buttons. A separate component because the attachments live in the form's context
 * (`usePromptInputAttachments`), and "can send" depends on them — an image with no words
 * sends (#68).
 */
function ComposerBody({
  draft,
  setDraft,
  textareaRef,
  disconnected,
  running,
  onStop,
  onRunCommand,
  onInsertCommand,
  host,
}: {
  draft: string
  setDraft: (next: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  disconnected: boolean
  running: boolean
  onStop: () => void
  onRunCommand: (commandName: string) => void
  onInsertCommand: (commandName: string) => void
  host: HostCommandHandlers
}): React.ReactNode {
  const stores = useThreadStores()
  const attachments = usePromptInputAttachments()
  const canSend = (draft.trim().length > 0 || attachments.files.length > 0) && !disconnected
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-input bg-card p-2 transition-colors focus-within:border-ring">
      {attachments.files.length === 0 ? null : (
        <Attachments aria-label="attached images" className="px-1 pt-1">
          {attachments.files.map((file) => (
            <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
              <AttachmentPreview />
              <AttachmentRemove label={`remove ${file.filename || 'image'}`} />
            </Attachment>
          ))}
        </Attachments>
      )}
      <div className="flex items-end gap-2">
        <PromptInputTextarea
          ref={textareaRef}
          value={draft}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
          placeholder={disconnected ? 'disconnected — reload and resume from the rail' : 'ask pi something'}
          autoComplete="off"
          rows={1}
          className="max-h-40 min-h-11 flex-1 resize-none border-0 bg-transparent text-base shadow-none placeholder:text-muted-foreground focus-visible:ring-0 dark:bg-transparent"
        />
        {/* The `/` palette (#338): the session's slash commands, grouped; an extension command
            runs through `send`, a prompt template or skill lands in the draft with focus, a host
            command POSTs (slice 2) and `/model` opens the dialog the composer renders. */}
        <CommandPalette
          threadId={stores.threadId}
          fetch={stores.fetch}
          disabled={disconnected}
          {...paletteHandlers(host, onRunCommand, onInsertCommand)}
        />
        {/* Attach (#68): the same file dialog a paste or a drop bypasses. */}
        <PromptInputButton
          aria-label="attach an image"
          title="attach an image — or paste one, or drop it here"
          disabled={disconnected}
          onClick={attachments.openFileDialog}
        >
          <PaperclipIcon />
        </PromptInputButton>
        <StopControl running={running} disconnected={disconnected} onStop={onStop} />
        {/* Send stays offered in flight: a prompt during a run queues through pi (#75) —
				    the form's submit takes the direct route past TanStack's own queue. */}
        <Button type="submit" size="icon" className="size-11" aria-label="send message" disabled={!canSend}>
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  )
}

/**
 * What waits behind the run, as pi holds it (#75) — the `queue` list, rendered above the
 * composer with ai-elements' Queue shell (#121). Every follower sees the same list; a stop
 * hands the texts back to the composer of the tab that stopped. Nothing when nothing waits.
 * ⓘ Exported for `__tests__/chat-screen.test.tsx`.
 */
function PendingQueue(): React.ReactNode {
  const stores = useThreadStores()
  const queued = useStore(stores.queue)
  if (queued.length === 0) return null
  // pi's queue is texts without ids; the same text may wait twice. Key by text and its
  // occurrence so a duplicate keeps its own row and a removal from the head does not remount.
  const seen = new Map<string, number>()
  const keyed = queued.map((queuedPrompt) => {
    const occurrence = seen.get(queuedPrompt) ?? 0
    seen.set(queuedPrompt, occurrence + 1)
    return { text: queuedPrompt, key: `${queuedPrompt}\u0000${occurrence}` }
  })
  return (
    <QueueShell aria-label="queued prompts" className="mx-6 mb-2">
      <QueueSection>
        <QueueSectionTrigger>
          <QueueSectionLabel count={queued.length} label={queued.length === 1 ? 'prompt queued' : 'prompts queued'} />
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            {keyed.map(({ text, key }) => (
              <QueueItem key={key}>
                <span className="flex items-start gap-2">
                  <QueueItemIndicator />
                  <QueueItemContent title={text}>{text}</QueueItemContent>
                </span>
              </QueueItem>
            ))}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </QueueShell>
  )
}

/**
 * The whole transcript's selection, built ONCE per streamed chunk and indexed by message id
 * (#280). Every row used to run `selectChatUI` over the entire list to find its own entry,
 * which is O(messages × parts) per chunk, not per user action: measured over the real
 * selector, one render pass of a 300-message thread spent 7.1 ms in the selector alone
 * (0.03 ms at 20, 0.98 ms at 100) before React touched the DOM. Indexed, the same pass costs
 * 0.03 ms.
 *
 * `openRunMessageIds` rides along because it is the only other thing a row needed from the
 * chat: with it here, no row calls `useChatContext`, and a row that reads only this can hand
 * everything it draws to a memo (see `MessageBody`).
 */
interface TranscriptSelection {
  readonly partsByMessageId: ReadonlyMap<string, KeyedPart[]>
  /**
   * The messages whose run is in flight, while the thread generates: every assistant message after
   * the last user message. Not just the last message (#412): joining a run that is already going
   * (a reload) opens a NEW message for what streams next, after the stored one that holds the
   * call pi is still waiting on — and a user message is where a run, or a queued prompt pi took,
   * began, so no call before it is still running.
   */
  readonly openRunMessageIds: ReadonlySet<string>
  /**
   * The messages that CONTINUE the one before them — same role, so no speaker line of their own:
   * one pi turn is several assistant messages (each tool round is one), and "pi" says it once.
   */
  readonly continuedMessageIds: ReadonlySet<string>
}

const TranscriptSelectionContext = createContext<TranscriptSelection>({
  partsByMessageId: new Map(),
  openRunMessageIds: new Set(),
  continuedMessageIds: new Set(),
})

/**
 * The empty selection, for a lookup that finds nothing.
 *
 * ⚠ Reached only if `selectChatUI` ever returns a different message SET than `chat.messages`
 * (PR #304 review): rows iterate the latter and the index is built from the former. Nothing
 * here checks that — the per-row code this replaced returned `[]` on the same miss, so the
 * assumption is carried, not introduced. A bubble drawn empty is the symptom.
 */
const NO_PARTS: KeyedPart[] = []

interface MessageBodyProps {
  readonly messageId: string
  readonly role: UIMessage['role']
  readonly parts: KeyedPart[]
  /** This message's run is in flight: a tool call with no result reads `running…` (#130). */
  readonly runOpen: boolean
  /** The provider refused this attempt (#381): said in the bubble, after whatever parts it has. */
  readonly refusal: EnsoProviderRefusal | undefined
  /** Whether the speaker line is drawn — not when the message before it is the same speaker's. */
  readonly speaker: boolean
}

/**
 * Who a message is from, above it (the design direction's speaker line): `you`, or pi beside its
 * ring. Ledger drops the ring and prints the user's prompt as a receipt line, `› you`.
 */
function MessageSpeaker({ role }: { role: UIMessage['role'] }): React.ReactNode {
  if (role === 'user') {
    return (
      <div className="flex items-center justify-end gap-1 font-mono text-xs text-muted-foreground ledger:justify-start ink:font-heading ink:text-sm ink:italic">
        <span aria-hidden="true" className="hidden text-evidence ledger:inline">
          ›
        </span>
        you
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground ink:font-heading ink:text-sm ink:italic">
      {role === 'assistant' ? (
        <EnsoRing className="size-4.5 text-foreground signal:text-evidence ledger:hidden" />
      ) : null}
      {role === 'assistant' ? 'pi' : role}
    </div>
  )
}

/**
 * One message's bubble, re-rendered only when what it SHOWS changed (#280): measured on the
 * mounted pane, a streamed delta into a 300-message thread rendered 301 bubbles before this
 * memo and renders 1 after it.
 *
 * ⚠ The comparison is over the selected PARTS, not over the message object, and that is the
 * whole subtlety. The selection runs over the WHOLE list precisely so a tool result the server
 * stamps onto a LATER message still pairs with its call (see `ChatMessageRow`), so what an
 * earlier bubble draws is not a function of its own message alone — which is why TanStack's
 * `memo(MessageView)`, comparing the message, is measuring the wrong thing for this row. Nor
 * is it cheaper: on the chunk that paired such a result, TanStack replaced EVERY message
 * object in the list (probed 2026-09-18), so a message-identity memo bails out there for
 * nobody. Part identity is what decides the output, so that is what is compared — the same
 * rule the vendor applies one level down, per part (`selectedPartPropsEqual`).
 */
const MessageBody = memo(function MessageBody({
  messageId,
  role,
  parts,
  runOpen,
  refusal,
  speaker,
}: MessageBodyProps): React.ReactNode {
  return (
    <Message
      from={role}
      data-role={role}
      className="max-w-3xl gap-1 ledger:ml-0 ledger:max-w-none ledger:border-b ledger:py-3"
    >
      {speaker ? <MessageSpeaker role={role} /> : null}
      <MessageContent className="text-base leading-relaxed group-[.is-assistant]:w-full group-[.is-user]:rounded-lg group-[.is-user]:px-3 group-[.is-user]:py-2 signal:group-[.is-user]:rounded-br-sm ledger:group-[.is-user]:ml-0 ledger:group-[.is-user]:bg-transparent ledger:group-[.is-user]:p-0">
        {parts.map(({ partKey, selected, isTrailingPart }) => (
          <SelectedMessagePart
            key={`${messageId}-${partKey}`}
            selected={selected}
            // ⚠ Part-level, not chat-level: true only for the TRAILING part of
            // the TRAILING message while a run is in flight. Passing bare
            // `chat.isLoading` here re-opened EVERY prior thinking block on
            // every later send (the Reasoning shell's auto-close latches after
            // its first close, so they also never closed again) and overwrote
            // each block's "Thought for N seconds" with the later run's timing.
            isStreaming={runOpen && isTrailingPart}
            runOpen={runOpen}
            renderers={descriptorRenderers}
          />
        ))}
        {/* A refused attempt (#381), from pi's stored message: without this a reload drew an
				    empty bubble where the refusal had been said live. */}
        {refusal === undefined ? null : <RefusedAttemptLine refusal={refusal} />}
      </MessageContent>
      {role === 'user' ? <ForkPromptButton messageId={messageId} /> : null}
    </Message>
  )
}, sameRenderedMessage)

/**
 * A prompt's fork action (#433): a new thread holding everything before this prompt, its composer
 * holding the prompt's words — pi's `/fork`. Not offered where no page opens the fork.
 */
function ForkPromptButton({ messageId }: { messageId: string }): React.ReactNode {
  const forkAt = useContext(ForkContext)
  if (forkAt === undefined) return null
  return (
    <div className="flex justify-end ledger:justify-start">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs text-muted-foreground"
        title="a new thread holding everything before this prompt, with its words ready to send again"
        onClick={(): void => forkAt(messageId)}
      >
        <GitForkIcon aria-hidden="true" />
        fork from here
      </Button>
    </div>
  )
}

/** The same refusal line, whether or not the message object behind it was replaced. */
function sameRefusal(before: EnsoProviderRefusal | undefined, after: EnsoProviderRefusal | undefined): boolean {
  if (before === undefined || after === undefined) return before === after
  return (
    providerRefusalLine(before) === providerRefusalLine(after) &&
    providerRefusalSource(before) === providerRefusalSource(after)
  )
}

/**
 * Whether two renders of one row would draw the same thing. `messageId` and `role` are not
 * compared: the list is keyed by message id, so one mounted row is one message for its whole
 * life. `isTrailingPart` is not compared either — it is the part's position, which equal
 * lengths and equal keys already settle.
 */
function sameRenderedMessage(previous: MessageBodyProps, next: MessageBodyProps): boolean {
  if (previous.runOpen !== next.runOpen || previous.speaker !== next.speaker) return false
  if (!sameRefusal(previous.refusal, next.refusal)) return false
  if (previous.parts.length !== next.parts.length) return false
  return previous.parts.every((part, index) => {
    const other = next.parts[index]
    if (other === undefined || part.partKey !== other.partKey) return false
    const before = part.selected
    const after = other.selected
    if (before.key !== after.key || before.part !== after.part) return false
    if (before.key === 'toolCall' && after.key === 'toolCall') {
      return before.result === after.result && before.interrupt === after.interrupt
    }
    if (before.key === 'toolResult' && after.key === 'toolResult') return before.matched === after.matched
    return true
  })
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
    input: function ChatPromptInput(): React.ReactNode {
      // Application-owned, per `ChatInput`'s deprecation notice. `useChatContext` is the
      // one returned by `createChatHook` above — referenced at render time, so the
      // binding is initialised by then.
      const chat = useChatContext()
      const stores = useThreadStores()
      const disconnected = useStore(stores.disconnected)
      // Controlled, so the send button can disable on empty and a take-back can write it —
      // the ai-elements chatbot example's PromptInput does the same. A fork opens holding the
      // forked prompt's words (#433), as pi's `/fork` fills its editor.
      const [draft, setDraft] = useState(stores.initialDraft)
      // The textarea, so a palette choice can put focus back where typing continues (#338).
      const textareaRef = useRef<HTMLTextAreaElement | null>(null)
      // The user messages this composer put in the transcript for prompts pi is still
      // HOLDING (#75): a stop hands those texts back, and the bubble that was never asked
      // leaves with them — pi's TUI does the same. A claimed prompt's bubble stays.
      const heldLocally = useRef<Array<{ id: string; text: string }>>([])
      // The pane's fork (#433): `/fork` forks at the last prompt; absent where no page opens a fork.
      const forkAt = useContext(ForkContext)
      // ⚠ `takeBack` runs after a network round trip, from a closure made by an older render.
      // `chat.messages` there is that render's snapshot; filtering it would replace the
      // transcript with the snapshot minus one — reverting every delta that streamed in
      // between (PR #129 review). The ref is the transcript as of the latest COMMITTED
      // render — written in an effect, never during render (react-doctor, and React's rule).
      const latestMessages = useRef(chat.messages)
      useEffect(() => {
        latestMessages.current = chat.messages
      }, [chat.messages])
      // A compaction rewrote the branch (#348): the transcript is re-read once the thread is idle.
      useRereadAfterCompaction(stores, chat)
      /**
       * Send what the form holds: the text, and the pasted or dropped images as inline bytes.
       * Nothing sends while disconnected (#119, PR #123 review): the prompt would reach a
       * server that rebuilds the thread, but this page's follow is gone, so the reply would
       * land nowhere this page can see. An image with no words is a prompt (pi-ai keeps the
       * image and drops the empty text block); nothing at all is not. Says whether it sent, so
       * the submit clears the draft on THAT — not on three predicates in three files agreeing
       * that a submit always reaches the wire (PR #343 review, round 2).
       */
      const send = (text: string, images: readonly EnsoPromptImage[]): boolean => {
        if (disconnected) return false
        if (text.trim().length === 0 && images.length === 0) return false
        const parts: ContentPart[] = [
          ...(text.length === 0 ? [] : [{ type: 'text' as const, content: text }]),
          ...images.map((image) => ({
            type: 'image' as const,
            source: { type: 'data' as const, value: image.data, mimeType: image.mimeType },
          })),
        ]
        if (!chat.sessionGenerating) {
          void chat.sendMessage({ content: parts })
          return true
        }
        // A prompt DURING a run queues through pi (#75). ⚠ Not `chat.sendMessage`: TanStack
        // holds a send in its own queue while the run it started is open and delivers it at
        // settle — the browser's queue, invisible to other tabs, lost on reload. So the user
        // message goes into the transcript here, and the text goes to pi now: pi lists it on
        // the follow for every follower (`queue`, the list above this composer) and claims
        // it when the run's turn ends. Refused or unreachable, the words come back to the
        // draft. ⚠ The images do not: pi's queue hands back texts (`EnsoAbortReceipt.restored`),
        // and the composer's attachments are the form's, not this component's — re-attach.
        const id = crypto.randomUUID()
        heldLocally.current.push({ id, text })
        chat.setMessages([...chat.messages, { id, role: 'user', parts, createdAt: new Date() }])
        void stores.connection.prompt(text, images).then((outcome) => {
          if (outcome === 'refused' || outcome === 'unreachable') takeBack([text])
        })
        return true
      }
      /**
       * Texts pi never took come back to the draft, and their never-asked bubbles leave the transcript.
       *
       * @invariant abort-clear-restore/composer-takes-back The stopping tab's composer gets the texts back; the bubbles that were never asked leave.
       * A stop's `restored` is appended to the draft after anything already typed, and the user
       * bubbles this composer put in the transcript for prompts the runtime still held are removed;
       * a claimed prompt's bubble stays, and deltas that streamed meanwhile are kept (the filter
       * reads the latest committed transcript, not this render's). Only texts come back: images
       * attached to a queued prompt are not restored, a limit the composer states, not a gap.
       */
      const takeBack = (texts: readonly string[]): void => {
        const leaving = new Set<string>()
        for (const takenBackText of texts) {
          const position = heldLocally.current.findIndex((held) => held.text === takenBackText)
          if (position === -1) continue
          leaving.add(heldLocally.current[position]?.id ?? '')
          heldLocally.current.splice(position, 1)
        }
        if (leaving.size > 0) chat.setMessages(latestMessages.current.filter((message) => !leaving.has(message.id)))
        setDraft((current) => joinDrafts(current, ...texts))
      }
      // Stop (#116) hands back what was queued behind the run (#75, clear-and-restore): the
      // abort receipt's texts become the draft, in order, after anything already typed.
      const stopRun = (): void => {
        void stores.connection.abort().then(({ restored }) => {
          if (restored.length > 0) takeBack(restored)
        })
      }
      // The Start-a-session dialog (#391): open on a minted thread; Start configures the session
      // and sends the first prompt through THIS send, so the bubble and the run are the composer's.
      const startSessionOpen = useStore(stores.startSession)
      const threadProject = useThreadProject(stores.projectId)
      const permission = usePermissionMode()
      // The `/` palette's two outcomes (#338; the rule is in `command-palette.tsx`'s header).
      // ⚠ NEITHER TOUCHES WHAT THE USER HAS TYPED (PR #343 review). An extension command is a
      // prompt like any other — the same `send` the button uses, so it queues through pi mid-run
      // (#75) and is refused while disconnected, exactly as typed `/mode` is — and the draft
      // stays, because it was not what got sent. A prompt template or a skill takes arguments,
      // and pi reads a template only at the START of the message, so `/<name> ` goes in front
      // and the words already typed become its argument. Focus lands after them BY CONSTRUCTION:
      // the caret is placed at the end once React has committed the new value (a frame later),
      // not left to the browser's default after a programmatic change (PR #343 review, round 2).
      const runCommand = (commandName: string): void => {
        send(`/${commandName}`, [])
        textareaRef.current?.focus()
      }
      const insertCommand = (commandName: string): void => {
        setDraft((current) => `/${commandName} ${current.trimStart()}`)
        requestAnimationFrame(() => {
          const field = textareaRef.current
          if (field === null) return
          field.focus()
          field.setSelectionRange(field.value.length, field.value.length)
        })
      }
      // The `select` host command whose dialog is open (`model`); undefined while closed. The
      // dialog is rendered ONCE here, for the chip and the palette's `/model` row alike (#338 slice 2).
      const [modelDialog, setModelDialog] = useState<string | undefined>(undefined)
      // `/context` (#361 phase 5): the one `view` this page draws. A view a newer host declares
      // and this page does not know is said, not silently dropped.
      const [contextOpen, setContextOpen] = useState(false)
      // A `host` command runs through its own route, never as a prompt: `POST …/command`, a
      // control like the mode select's — on the SAME connection, so a 409 (running) or a 422
      // (the host's reason) is recorded and said the one way a refused mode change is (PR #344
      // review). Nothing here moves the chip — the `model` observation on the follow does
      // (invariant 2); the click did nothing else.
      const host: HostCommandHandlers = {
        onHost: (commandName: string, optionId?: string): void => {
          void stores.connection.runHostCommand({
            name: commandName,
            ...(optionId === undefined ? {} : { value: optionId }),
          })
        },
        onOpenModelDialog: setModelDialog,
        onOpenView: (commandName: string): void => {
          if (commandName === ENSO_CONTEXT_COMMAND) setContextOpen(true)
          else if (commandName === ENSO_FORK_COMMAND && forkAt !== undefined) forkAt(undefined)
          else
            stores.notifications.push(
              `/${commandName} opens a view this page does not have`,
              'warning',
              'run',
              ENSO_NOTICE_SOURCE,
            )
        },
      }
      // A bare `/<name>` typed and sent (#388): when the thread's command list names it as a HOST
      // row, it does what choosing that row in the palette does — `/login` opens the provider
      // picker — instead of reaching the transcript as a user message the server then refuses
      // ("the run failed", which outlived the login started next). Anything else, or a list that
      // cannot be read, is sent exactly as before. The lookup builds the thread's session if it is
      // not live (#390), so this works as the first thing typed after a server restart.
      // The draft clears BEFORE the lookup (#389 review): the composer stays live during it, and a
      // second Enter on a draft still holding `/word` would route or send it twice. A send the
      // fallback refuses (disconnected) gives the words back, as a refused submit keeps them.
      const submitTypedCommand = async (commandName: string, text: string): Promise<void> => {
        setDraft('')
        const listed = await fetchThreadCommands(stores.threadId, stores.fetch).catch((): undefined => undefined)
        const row = listed?.commands.find((command) => command.source === 'host' && command.name === commandName)
        if (row === undefined) {
          if (!send(text, [])) setDraft(text)
          return
        }
        const opened = runTypedHostCommand(row, paletteHandlers(host, runCommand, insertCommand))
        if (!opened)
          stores.notifications.push(
            `/${row.name} is a setting: choose a value from the / palette`,
            'info',
            'run',
            ENSO_NOTICE_SOURCE,
          )
      }

      return (
        <PromptInput
          className="w-full px-6 pt-3 pb-4"
          accept={ENSO_IMAGE_MIME_TYPES.join(',')}
          multiple
          maxFiles={ENSO_PROMPT_MAX_IMAGES}
          maxFileSize={ENSO_IMAGE_MAX_BYTES}
          // A file the form would not take is said, not dropped (#68): the reason names the cap.
          onError={(error: PromptInputError): void =>
            stores.notifications.push(describeAttachmentError(error), 'warning', 'run', ENSO_NOTICE_SOURCE)
          }
          onSubmit={({ text, files }: PromptInputMessage): void => {
            // The form hands back `data:` URLs (blob → FileReader); the wire takes bytes + kind.
            // The form's `accept` already filtered by `File.type`; this is the same set, as a
            // guard rather than a cast, and a miss is said the same way the form says one.
            const images: EnsoPromptImage[] = []
            let notImages = 0
            for (const file of files) {
              const inline = /^data:([^;,]+);base64,(.*)$/.exec(file.url)
              const mimeType = inline?.[1]
              const data = inline?.[2]
              if (mimeType === undefined || data === undefined || !isEnsoImageMimeType(mimeType)) {
                notImages += 1
                continue
              }
              images.push({ mimeType, data })
            }
            if (notImages > 0) {
              stores.notifications.push(
                describeAttachmentError({ code: 'accept', message: '', count: notImages }),
                'warning',
                'run',
                ENSO_NOTICE_SOURCE,
              )
            }
            // The draft WAS the text: it clears here, at the submit, not in `send` — the palette
            // sends through `send` too and must leave what the user has typed alone (PR #343 review)
            // — and only if something went: a submit `send` refuses keeps its words.
            const commandName = images.length === 0 ? typedCommandName(text) : undefined
            if (commandName !== undefined) void submitTypedCommand(commandName, text)
            else if (send(text, images)) setDraft('')
          }}
        >
          {/* The composer chrome (#90): the knobs at the point of use, deepseek's shape — the
              model chip and thinking level (#338 slice 2) beside the mode. */}
          <div className="flex items-center justify-end gap-3 px-1 pb-1">
            <ModelControls {...host} />
            <PermissionModeControl />
          </div>
          <ModelChoiceDialog
            threadId={stores.threadId}
            fetch={stores.fetch}
            command={modelDialog}
            onClose={(): void => setModelDialog(undefined)}
            returnFocus={(): void => textareaRef.current?.focus()}
            onPick={host.onHost}
          />
          <ThreadContextDialog
            open={contextOpen}
            onClose={(): void => setContextOpen(false)}
            returnFocus={(): void => textareaRef.current?.focus()}
          />
          <StartSessionDialog
            threadId={stores.threadId}
            fetch={stores.fetch}
            project={threadProject}
            open={startSessionOpen}
            onClose={(): void => stores.startSession.set(false)}
            mode={permission.mode}
            modes={permission.available}
            configure={stores.connection.configure}
            send={(text: string): boolean => send(text, [])}
          />
          <ComposerBody
            draft={draft}
            setDraft={setDraft}
            textareaRef={textareaRef}
            disconnected={disconnected}
            running={chat.sessionGenerating}
            onStop={stopRun}
            onRunCommand={runCommand}
            onInsertCommand={insertCommand}
            host={host}
          />
        </PromptInput>
      )
    },
    /**
     * ⚠⚠ A RUN_ERROR HAD NOWHERE TO RENDER, WHICH IS HOW `/mode` LOOKED LIKE NOTHING.
     *
     * Daniel typed `/mode`, the server correctly emitted RUN_ERROR explaining that pi was
     * blocked on an interactive dialog — and the page showed an empty assistant turn,
     * because the layout mounted Messages, Interrupts, Queue and Input and nothing read
     * `chat.error`. The transcript he pasted back was the INPUT PLACEHOLDER, which was
     * simply the next visible text on the page.
     *
     * Errors are not a message part, so no `partsComponents` entry catches them. They
     * live on the chat instance and have to be rendered deliberately.
     */
    layout: function ChatLayout({ Messages, Input }: LayoutProps<ThreadChatOptions>): React.ReactNode {
      const chat = useChatContext()
      const debugOpen = useContext(DebugOpenContext)
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
      /** Whether the transcript is the view shown — a pane off screen keeps its chat. */
      const onChat = (shown ?? 'chat') === 'chat'
      /** A panel's `id`s, in the pane on screen only — a hidden pane's would duplicate them. */
      const panelIds = (view: ThreadView): { id?: string; 'aria-labelledby'?: string } =>
        shown === undefined ? {} : { id: `thread-view-${view}`, 'aria-labelledby': `thread-view-${view}-tab` }
      // The one place the transcript is selected (#280): here, where the chat is already read,
      // once per chunk instead of once per row.
      const selection = useMemo<TranscriptSelection>(() => {
        const partsByMessageId = new Map<string, KeyedPart[]>()
        for (const selected of selectChatUI({ messages: chat.messages }).messages) {
          partsByMessageId.set(selected.message.id, keyedParts(automaticPartsForMessage(selected)))
        }
        const continuedMessageIds = new Set<string>()
        chat.messages.forEach((message, position) => {
          if (position > 0 && chat.messages[position - 1]?.role === message.role) continuedMessageIds.add(message.id)
        })
        const openRunMessageIds = new Set<string>()
        if (chat.sessionGenerating) {
          for (const message of chat.messages.toReversed()) {
            if (message.role !== 'assistant') break
            openRunMessageIds.add(message.id)
          }
        }
        return { partsByMessageId, openRunMessageIds, continuedMessageIds }
      }, [chat.messages, chat.sessionGenerating])
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* The views share one box: the transcript keeps its size under every view, and the
						    others are drawn over it. */}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {/* The transcript stays mounted AND LAID OUT under every view — `invisible` and
							    `inert`, never `hidden` (#362 review): a `display: none` box comes back resized,
							    and the stick-to-bottom scroller re-pins a reader who had scrolled up. Kept at
							    its size, its scroll, its lock and its bubbles (the stats rows' targets)
							    survive a trip to Context or Stats. */}
              <div
                role="tabpanel"
                {...panelIds('chat')}
                inert={!onChat}
                className={
                  onChat ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'invisible flex min-h-0 min-w-0 flex-1 flex-col'
                }
              >
                <Conversation>
                  <TranscriptRevealBridge into={scroller} />
                  <ConversationContent className="w-full gap-4 px-6 py-4 ledger:gap-0">
                    {chat.messages.length === 0 ? (
                      <ConversationEmptyState>
                        <EnsoSmile className="size-28" />
                        <h2 className="font-heading text-xl font-semibold">
                          Give agents room to work. Keep the receipts.
                        </h2>
                        <p className="text-sm text-muted-foreground">ask pi something to get started</p>
                      </ConversationEmptyState>
                    ) : (
                      <TranscriptSelectionContext.Provider value={selection}>
                        <Messages />
                      </TranscriptSelectionContext.Provider>
                    )}
                    {/* pi's notify lines (#29) — the transcript tail, above the question,
										    so "Mode set to X" reads next to the run it belongs to. */}
                    <ThreadNotifications />
                    {/* ⚠ Mounted before anything opens one, deliberately. This is where #4's
										    `ask` verdict reaches the browser, and an unmounted slot is precisely
										    why an approval would silently never appear. */}
                    <PendingDialog />
                    <RunProblem />
                  </ConversationContent>
                  <ConversationScrollButton />
                </Conversation>
                {/* pi's queue, not TanStack's `Queue` slot (#75): a prompt sent during a run goes to
								    pi and is listed here for every follower; TanStack's own queue is bypassed. */}
                <PendingQueue />
                <Input />
              </div>
              {/* The thread's context (#361): what each request was made of, over the transcript. */}
              {shown === 'context' ? (
                <div role="tabpanel" {...panelIds('context')} className="absolute inset-0 overflow-y-auto">
                  <div className="mx-auto w-full max-w-context-view">
                    <ThreadContextDrawer />
                  </div>
                </div>
              ) : null}
              {/* The thread's stats (#45 phase 2), over the transcript (#361). */}
              {shown === 'stats' ? (
                <div role="tabpanel" {...panelIds('stats')} className="absolute inset-0 overflow-y-auto">
                  <div className="mx-auto w-full max-w-stats-view">
                    <ThreadStatsDrawer onNavigate={revealInTranscript} />
                    <ThreadEvalDrawer />
                  </div>
                </div>
              ) : null}
              {/* What changed since the last push (#452): the tree and the chosen file's diff, over the transcript. */}
              {shown === 'changes' ? (
                <div role="tabpanel" {...panelIds('changes')} className="absolute inset-0">
                  <ThreadChanges moment={`${settledToolResults(chat.messages)}:${chat.sessionGenerating}`} />
                </div>
              ) : null}
            </div>
            {/* The session debug pane (#86): what the browser believes beside what pi's
						    session holds, for THIS thread. Scrolls on its own so a long branch never
						    moves the composer. */}
            {debugOpen ? (
              <div id="thread-debug-pane" className="w-debug-pane shrink-0 overflow-y-auto border-l">
                <ThreadDebugDrawer />
              </div>
            ) : null}
          </div>
          {/* The status bar (#90): activity, prompts, tool calls, cost — always visible, full
					    width under transcript AND debug pane, so it is the one place to look. */}
          <ThreadStatusBar messages={chat.messages} generating={chat.sessionGenerating} />
        </div>
      )
    },
    /**
     * ⚠ Ignores the bound `Parts` component ON PURPOSE — see `SelectedMessagePart`'s
     * header for why (TanStack's own dispatcher drops tools it has no name for).
     *
     * The selection is the library's, run over the WHOLE message list — the same input its
     * own Messages component gives `selectChatUI` — so a tool result the server stamps onto
     * a DIFFERENT message than its call still pairs. A per-message `selectMessageUI` was the
     * first draft and would have shown such a call as "running…" forever.
     *
     * ⚠ That whole-list selection USED TO RUN HERE, once per row, which made it O(messages ×
     * parts) per STREAMED TOKEN rather than per user action — 7.1 ms of pure selector time
     * per render pass at 300 messages, 0.98 ms at 100 (#280). It now runs once in
     * `ChatLayout` and arrives indexed, so this row allocates nothing and reads no chat
     * context: it still runs for every message on every chunk (it consumes the indexed
     * selection, and React re-renders a context consumer), but all it does is a `Map` lookup
     * and hand `MessageBody` its props — and that memo is what keeps the redraw to the one
     * bubble that changed.
     */
    message: function ChatMessageRow({ message }: MessageProps<ThreadChatOptions>): React.ReactNode {
      const { partsByMessageId, openRunMessageIds, continuedMessageIds } = useContext(TranscriptSelectionContext)
      return (
        <MessageBody
          messageId={message.id}
          role={message.role}
          parts={partsByMessageId.get(message.id) ?? NO_PARTS}
          runOpen={openRunMessageIds.has(message.id)}
          refusal={refusalOfMessage(message)}
          speaker={!continuedMessageIds.has(message.id)}
        />
      )
    },
  },
  // ⚠ Deliberately empty, and load-bearing as documentation: nothing renders the bound
  // `Parts` component (the `message` slot above dispatches parts itself), so any entry
  // written here is dead code that LOOKS live — which is precisely the state this
  // arrangement replaced (`partsComponents.toolCall` sat here for weeks, unreachable).
  partsComponents: {},
  // No `interruptsComponents`: pi's questions are not AG-UI interrupts on this surface
  // (#112) — they arrive as blocking `extension-ui-request` chunks and render through `PendingDialog` above.
}

/** A pane mounted without a page has no view to change. */
const KEEP_VIEW = (): void => undefined

/**
 * One thread's pane: its chat factory, its stores in context, its summary kept current for
 * the rail.
 *
 * Stays mounted while another thread is on screen — see `createThreadChatHook` for why hiding,
 * not unmounting, is load-bearing. ⚠ And never `hidden` (#370): a `display: none` pane comes back
 * resized, and the stick-to-bottom scroller re-pins a reader who had scrolled up — the tabs' bug
 * (#362 review), one level up. Every pane fills the same box (`absolute inset-0`), so a switch
 * moves nothing; one off screen is `content-visibility: hidden`, which skips its style, layout
 * and paint like `display: none` but keeps its layout and scroll state. Measured at the page's
 * four live panes (#472 review): a switch cost ~45 ms of main thread against ~47 with `hidden`
 * and ~67 with `invisible` alone, which restyled every transcript. `invisible` stays as the
 * fallback where `content-visibility` is unsupported (otherwise the later panes would paint over
 * the shown one); `inert` keeps an off-screen pane out of the tab order and the accessibility tree.
 *
 * ⓘ Exported for `__tests__/chat-screen.test.tsx` only, which mounts two of them to pin
 * that an off-screen pane renders no debug column. Nothing else imports it.
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
  // ⚠ The title depends on the FIRST user message and nothing else, but `chat.messages`
  // gets a new identity on every streamed chunk — so an effect over the list re-derived it
  // per token and threw the answer away (#283). Depend on that message instead; the list's
  // churn does not reach it, and `updateThreadSummary` is no longer called per token.
  const firstUserMessage = chat.messages.find((message) => message.role === 'user')
  const title = useMemo(
    () => (firstUserMessage === undefined ? undefined : titleFromMessage(firstUserMessage)),
    [firstUserMessage],
  )
  const waiting = useStore(stores.dialog) !== undefined
  useEffect(() => {
    updateThreadSummary(threadId, { title, busy: chat.sessionGenerating, waiting })
  }, [threadId, title, chat.sessionGenerating, waiting])
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
              <chat.AppChat />
            </ForkContext.Provider>
          </PaneViewContext.Provider>
        </DebugOpenContext.Provider>
      </ThreadStoresContext.Provider>
    </div>
  )
}

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
 * The stored sessions the rail can come back to (#95). Page-level, refreshed on load and
 * whenever a run settles — the moments a session file appears or grows.
 */
const storedThreads = createStoredThreadsStore()

/** The projects the rail groups threads under (#395). Page-level, fetched on load. */
const projectList = createProjectsStore()

/** The project a thread runs in, as the page lists it — a thread with none is the launch directory's. */
function useThreadProject(projectId: string | undefined): EnsoProject | undefined {
  return projectOf(useStore(projectList).rows, projectId)
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
 * The page's views as tabs (#361): Radix's tab list, for its keyboard (arrows move between tabs)
 * and its roles — the primitive, styled here to the design direction's tab (a raised selected tab
 * with an underline in the primary; Signal rings it instead, Ink underlines in ink). The panels
 * are the active pane's own (`ChatLayout`), so each trigger names its panel by id rather than
 * through Radix's `TabsContent`, which would unmount the transcript.
 */
/**
 * A question from pi waits in the transcript while another view is shown (#362 review): the Chat
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

/**
 * The page's header: the threads button (narrow screens), the mark, where you are — the active
 * thread's title, the same one the rail shows — then the view tabs, settings and `?debug`'s switch.
 */
function AppHeader({
  active,
  activeThreadId,
  rail,
  view,
  onView,
  debugOpen,
  onToggleDebug,
}: {
  active: ThreadSummary | undefined
  activeThreadId: string | undefined
  rail: { open: boolean; toggle: () => void }
  view: ThreadView
  onView: (view: ThreadView) => void
  debugOpen: boolean
  onToggleDebug: () => void
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
          {active?.title ?? (activeThreadId === undefined ? 'resuming…' : UNTITLED_THREAD)}
        </span>
      </div>
      {isFixtureMode ? (
        <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">fixture</span>
      ) : null}
      <ViewTabs view={view} onView={onView} threadId={active?.threadId} />
      <PromptManagerDialog threadId={activeThreadId} />
      <SettingsDialog />
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

/** The header's threads button: on a narrow screen, the rail is a page of its own (#407). */
function RailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): React.ReactNode {
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
  // Only the shown view's panel is in the page, so only its tab names one (#362 review): a
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

/** The page (#90): header, the sessions rail, and one mounted pane per live thread. */
export function ChatScreen(): React.ReactNode {
  const threads = useStore(threadListStore)
  const stored = useStore(storedThreads)
  const projects = useStore(projectList)
  // Undefined only while a URL-named thread is being adopted: no pane, nothing active.
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(FIRST_THREAD_ID)
  const [resumeError, setResumeError] = useState<string | undefined>(BOOT.kind === 'fresh' ? BOOT.notice : undefined)
  const anyBusy = threads.some((thread) => thread.busy)
  useEffect(() => {
    // Load, and every time the page goes from a run in flight to none: something settled.
    if (!(anyBusy || isFixtureMode)) void storedThreads.refresh()
  }, [anyBusy])
  useEffect(() => {
    if (!isFixtureMode) void projectList.refresh()
  }, [])
  const pageThreadIds = new Set(threads.map((thread) => thread.threadId))
  // ⚠ Two things a resume's outcome must know, and cannot read from shared state (PR #143
  // review — a shared "how" slot plus a "no threads yet" check desynced the URL from the
  // pane the moment the boot's resume overlapped a rail click):
  // - HOW its own request meant to reach history: it rides with the request (`intent`).
  // - WHETHER a navigation happened since it was issued: `epoch` counts every navigation,
  //   and an outcome from before the current one is dropped whole. New Thread during the
  //   boot's "resuming…" therefore wins outright: the URL says the new thread, the pane
  //   shows it, and the boot's answer arrives to nobody.
  // `activePane` mirrors `activeThreadId` for the same closures.
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
  const resume = useMemo(
    () =>
      // `prefill` rides with a fork's open (#433): the new thread's composer opens holding it.
      // `fromUrl`: the id is the URL's (the boot, back/forward), not a row or a fork (#378).
      createResumeRequests<{ how: ThreadNavigation; epoch: number; prefill?: string; fromUrl?: boolean }>(
        fetchThreadHistory,
        (history, intent) => {
          if (intent.epoch !== epoch.current) return // a navigation happened since — superseded
          setResumeError(undefined)
          navigate(adoptPageThread(history, intent.prefill).threadId, intent.how)
        },
        (message, intent) => {
          if (intent.epoch !== epoch.current) return
          setResumeError(message)
          // The page must show SOMETHING: a resume that failed with no pane behind it (the
          // boot's, or a rail click while the boot was still out) leaves a fresh thread, said
          // (the error is on the rail), and the URL rewritten so a reload does not ask again.
          if (activePane.current === undefined) navigate(mintPageThread().threadId, 'replace')
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
          if (activePane.current === undefined) navigate(mintPageThread().threadId, 'replace')
        },
      ),
    [navigate],
  )
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
  // Boot: the URL named a thread — adopt it. Once per page; the coordinator drops a stale answer.
  useEffect(() => {
    if (BOOT.kind === 'resume') resumeFrom(BOOT.threadId, 'pop', true)
  }, [resumeFrom])
  // Back/forward: the URL moved; the page follows it — a thread on this page is a switch, one
  // that is not is a resume. Neither writes history again.
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
  // The debug column (#86) is a right-hand pane, not a bottom drawer: stacked under the
  // transcript it took forty percent of the height and squeezed the conversation it
  // exists to explain. Opt-in by `?debug`; open by default when it is, and collapsible
  // from the header so it can get out of the way without a reload.
  // Adding and removing projects (#395 slice 3). A refused removal is said on the rail; a removed
  // project's open threads stay, under "other" — the server ended them, and the rail never drops one.
  const [addingProject, setAddingProject] = useState(false)
  const [projectNotice, setProjectNotice] = useState<string | undefined>(undefined)
  const forgetProject = async (projectId: string): Promise<void> => {
    const outcome = await removeProject(projectId)
    setProjectNotice(outcome.kind === 'ok' ? undefined : `could not remove the project: ${outcome.reason}`)
    await Promise.all([projectList.refresh(), storedThreads.refresh()])
  }
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
