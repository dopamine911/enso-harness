import type { ConnectConnectionAdapter, UIMessage } from '@tanstack/ai-client'
import { type ChatUIContexts, createChatHookContexts } from '@tanstack/ai-react/ui'
import { createContext } from 'react'
import type { FollowConnection } from './follow-connection.ts'
import type { ThreadAfterDelete } from './project-list.ts'
import type { SettingsSection } from './thread-url.ts'

/**
 * What the widgets in a thread's pane read through (#90): TanStack's chat contexts, shared by every
 * thread's factory, and the pane's view and debug switches.
 */

/**
 * The chat contexts every widget below reads through — created ONCE and handed to every
 * per-thread factory (`createThreadChatHook`), TanStack's escape hatch for "widgets in
 * other files". One `useChatContext` serves every thread's tree because each pane's
 * `AppChat` provides the same context, with its own chat instance.
 */
export const chatContexts = createChatHookContexts()
export const useChatContext: ChatUIContexts['useChatContext'] = chatContexts.useChatContext

/** The options type the widget map below is written against — one shape for every thread. */
export interface ThreadChatOptions {
  threadId: string
  initialMessages: UIMessage[]
  /** The live follow, or — under `?fixture` — the scripted conversation's local adapter. */
  connection: ConnectConnectionAdapter | FollowConnection
  live: boolean
  onCustomEvent: (eventType: string, data: unknown) => void
}

/**
 * Whether THIS pane shows the `?debug` column. Provided per pane as `debugOpen && active`:
 * every live pane stays mounted, so gating on the page-level switch alone would render the
 * column — with its fixed `id` and its own inspection fetches — once per thread, hidden or
 * not (#94). Exactly one pane is active, so exactly one column exists.
 */
export const DebugOpenContext = createContext(false)

/**
 * Closes the `?debug` column — the pane header's close (#417), the same switch as the thread menu's
 * Hide debug pane. Undefined on a page without `?debug`, where the column has no close to offer.
 */
export const CloseDebugContext = createContext<(() => void) | undefined>(undefined)

/**
 * The page's main views (#361): the transcript, or an analysis of the thread in its place. One
 * choice per pane (#938) — switching the thread in a pane keeps it — rendered by the pane itself.
 */
export type ThreadView = 'chat' | 'context' | 'stats' | 'changes'

/**
 * What THIS pane shows, and how to change its view. `shown` is undefined in a hidden
 * pane, which then draws its transcript and nothing else: the stats view — its fetches, its
 * `stores.usage` subscription — exists only in panes on screen, the debug column's rule above
 * (#358). Each pane on screen keeps its own view (#938); the header's tabs change the focused one's.
 */
export interface PaneView {
  readonly shown: ThreadView | undefined
  readonly open: (view: ThreadView) => void
}

export const PaneViewContext = createContext<PaneView>({ shown: undefined, open: (): void => undefined })

/**
 * Where THIS pane is among several on screen (#938). `peek`: drawn beside the focused pane — it keeps
 * streaming, its transcript and views are read but not acted on, and its composer's place shows what
 * was typed there; a click focuses it, so the page still has exactly one composer (#707), and the
 * panel `id`s the header's tabs name are the focused pane's alone. `number`: its place, 1-based,
 * while several are open. `narrow`: side by side, where its status strip drops the counts. The only
 * pane, and one off screen, is none of these.
 */
export interface PaneSlot {
  readonly peek: boolean
  readonly number: number | undefined
  readonly narrow: boolean
  /** Focus this pane, and its prompt when `prompt` — a click on it, its composer's stand-in. */
  readonly focus: (prompt: boolean) => void
}

export const PaneSlotContext = createContext<PaneSlot>({
  peek: false,
  number: undefined,
  narrow: false,
  focus: (): void => undefined,
})

/**
 * What a pane does on the page (#877, #933): open one of its project's recent threads — shown when
 * on this page, else resumed, as a rail row opens it — open Projects, where a thread with no folder
 * to start in is sent, and open a Settings section (an incident card's hint opens Security). Absent
 * where no page holds the pane.
 */
export interface LaunchActions {
  readonly openThread: (thread: ThreadAfterDelete) => void
  readonly manageProjects: () => void
  readonly openSettings: (section: SettingsSection) => void
}

export const LaunchActionsContext = createContext<LaunchActions | undefined>(undefined)
