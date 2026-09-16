import type { UIMessage } from '@tanstack/ai-client'
import type { ZenDialogSpec, ZenInterruptedTail, ZenThreadHistory } from '@zen/core'
import type { BrowserLogging } from './browser-logging.ts'
import { createRecentChunksStore, type RecentChunksStore } from './custom-event-router.ts'
import { createFollowConnection, type FollowConnection } from './follow-connection.ts'
import { createModeLines, type ModeLines } from './mode-lines.ts'
import { createNotificationsStore, type NotificationsStore } from './notifications.tsx'
import { createPermissionModeStore, type PermissionModeStore } from './permission-mode.tsx'
import { createStore, type Store, type WritableStore } from './store.ts'
import { createThreadStatsStore, type ThreadStatsStore } from './thread-stats.tsx'

/**
 * Everything the browser knows about one thread beyond its messages (#90 PR 3).
 *
 * ⚠ WHY INSTANCES, NOT MODULE STATE. Until this, every store was a module singleton — one
 * mode, one cost, one notification list per PAGE — which was correct only while a page
 * held exactly one thread. The sessions rail holds several and switches between them; a
 * run in one keeps streaming while another is on screen, and its `message-end` must land in
 * ITS cost, not the visible thread's. So each thread gets its own set, created here, and
 * the pane that renders a thread provides them through `ThreadStoresContext`.
 *
 * ⚠ THE PAGE OWNS ITS LIVE LIST. The rail's first section is the threads this page minted
 * or resumed — only those chat instances can be switched to. Stored sessions appear in the
 * second section and become page-owned only after `/history` succeeds. A session another tab
 * is running is refused by both the rail and the server; two pages never drive one pi session.
 */
export interface ThreadStores {
  readonly threadId: string
  /**
   * The messages the thread's chat mounts with (#95): a resumed thread's stored branch,
   * as the server mapped it; empty for a thread minted on this page. Read ONCE, by the
   * chat factory — TanStack owns the messages from there.
   */
  readonly history: readonly UIMessage[]
  readonly permissionMode: PermissionModeStore
  readonly stats: ThreadStatsStore
  readonly notifications: NotificationsStore
  readonly modeLines: ModeLines
  readonly recentChunks: RecentChunksStore
  /**
   * The server-side acquisition this page's LAST run on the thread held, from its
   * `status` frame's `generation` (#109); undefined until a run starts. The debug pane compares it
   * with the server's current `generation`: a difference names a run this page did not
   * make — another tab, or a rebuild after the idle window.
   */
  readonly generation: WritableStore<number | undefined>
  /**
   * The question this page shows pi blocked on; undefined when none. Fed by three chunks
   * (#112, #114): `extension-ui-request` opens it, `dialog-settled` clears it by id, and a
   * snapshot's `openDialogs` replaces it wholesale. ONE slot is the browser's choice,
   * not pi's — extensions can hold several questions at once (`openDialogs()` lists them);
   * this page shows the oldest, and a second only once a snapshot lists it (see
   * `routeDialogEvent`). Also cleared by an answer this page sends that the server takes
   * or reports gone.
   */
  readonly dialog: WritableStore<ZenPendingDialog | undefined>
  /**
   * The follow ended under this page (#119): the server closed, restarted, or dropped the
   * connection, and nothing here reconnects — the thread's state on this page is as of that
   * moment. Set by `follow-ended`; cleared by the next `status` or `snapshot` frame, which only a live
   * follow delivers. While true the status bar says `disconnected` and no stop is offered,
   * whatever the run flag still holds: the page cannot know what the server is doing.
   */
  readonly disconnected: WritableStore<boolean>
  /**
   * What waits behind the run in flight, as pi holds it (#75): the texts, steering first,
   * from every `queue` frame — one list for every follower, so a second tab sees what
   * the first queued. Empty when nothing waits. Rendered above the composer; a stop hands
   * these back to the composer through the abort receipt, not from here (the frame that
   * empties this can beat the receipt).
   */
  readonly queue: WritableStore<readonly string[]>
  /** The thread's transport: TanStack's connection over prompt/follow, and the dialog answer beside it. */
  readonly connection: FollowConnection
}

export interface ZenPendingDialog {
  readonly id: string
  readonly dialog: ZenDialogSpec
}

/**
 * `fetch` is injectable so a test can mount a real pane over a scripted server (#118) — the
 * one seam between the page and the network. Production never passes it.
 */
function createThreadStores(threadId: string, history: readonly UIMessage[], fetchImpl?: typeof fetch): ThreadStores {
  const notifications = createNotificationsStore()
  return {
    threadId,
    history,
    permissionMode: createPermissionModeStore(),
    stats: createThreadStatsStore(),
    notifications,
    modeLines: createModeLines(notifications),
    recentChunks: createRecentChunksStore(),
    generation: createStore<number | undefined>(undefined),
    dialog: createStore<ZenPendingDialog | undefined>(undefined),
    disconnected: createStore(false),
    queue: createStore<readonly string[]>([]),
    connection: createFollowConnection({
      threadId,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      onProblem: (problem: unknown) => notifications.push(String(problem), 'warning', 'run'),
    }),
  }
}

/**
 * What a resumed thread says about a turn that never settled (#109) — a durable line at
 * the head of the transcript's notices, never a toast, because the next prompt continues
 * from the torn tail and the user should know that before typing it.
 */
const INTERRUPTED_TAIL_NOTICE: Record<ZenInterruptedTail, string> = {
  'unanswered-prompt':
    "This session's last prompt was never answered — its run was cut off before a reply. The next prompt continues from there.",
  'tool-call-without-result':
    "This session's last turn ended mid-tool-call — the result never arrived. The next prompt continues from there.",
}

// ── the page's threads ────────────────────────────────────────────────────────

/** What the rail shows for one thread — written by its pane from the chat it owns. */
export interface ThreadSummary {
  readonly threadId: string
  /** The first user message, or undefined until there is one. */
  readonly title: string | undefined
  /** When the pane last saw its transcript or in-flight state change. */
  readonly lastActivityAt: Date
  /** A run is in flight. */
  readonly busy: boolean
}

/**
 * The page's logging (#132): the ring the drawer reads and the shipper the page flushes on
 * hide — set once by `main.tsx` after `configureBrowserLogging`; undefined in tests that
 * mount without it. One per page, like the rail.
 */
export const browserLogging: WritableStore<BrowserLogging | undefined> = createStore<BrowserLogging | undefined>(
  undefined,
)

const threads = new Map<string, ThreadStores>()
const summaries = new Map<string, ThreadSummary>()
/** Newest first — the order the rail lists them in. Rebuilt on every change so the snapshot is stable between changes. */
const threadList = createStore<readonly ThreadSummary[]>([])

function publishThreadList(): void {
  threadList.set([...summaries.values()].reverse())
}

/** Mint a new thread on this page and return its stores. The rail lists it at once, untitled. `fetch` is the #118 test seam. */
export function mintThread(fetchImpl?: typeof fetch): ThreadStores {
  const stores = createThreadStores(crypto.randomUUID(), [], fetchImpl)
  threads.set(stores.threadId, stores)
  summaries.set(stores.threadId, {
    threadId: stores.threadId,
    title: undefined,
    lastActivityAt: new Date(),
    busy: false,
  })
  publishThreadList()
  return stores
}

/**
 * JSON turns TanStack's `Date` into a string on the history route. Restore it at the browser
 * boundary and reject rows that cannot be UI messages; `ZenThreadHistory.messages` is
 * intentionally unknown because core must not own TanStack's transport shape.
 */
export function reviveHistoryMessages(messages: readonly unknown[]): UIMessage[] {
  const revived: UIMessage[] = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    if (typeof message.id !== 'string') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!Array.isArray(message.parts)) continue
    // JSON carries the date as a string; anything else (absent, malformed) is no date.
    const parsed = typeof message.createdAt === 'string' ? new Date(message.createdAt) : undefined
    const createdAt = parsed !== undefined && !Number.isNaN(parsed.getTime()) ? parsed : undefined
    const { createdAt: _wireCreatedAt, ...rest } = message
    revived.push({
      ...rest,
      id: message.id,
      role: message.role,
      parts: message.parts as UIMessage['parts'],
      ...(createdAt === undefined ? {} : { createdAt }),
    })
  }
  return revived
}

/**
 * A stored session becomes a live thread on this page (#95): stores under ITS id (the
 * thread id is pi's session id, so the next prompt reopens the same file), its branch as
 * the history the chat mounts with, and its persisted mode as the control's first state —
 * a plan-mode session must not read `default` until its first run (#84's lesson).
 * Adopting a thread already on this page returns it — the rail cannot hold one twice.
 */
export function adoptThread(history: ZenThreadHistory): ThreadStores {
  const existing = threads.get(history.threadId)
  if (existing !== undefined) return existing
  const messages = reviveHistoryMessages(history.messages)
  const stores = createThreadStores(history.threadId, messages)
  stores.permissionMode.applyReceipt(history.permissionMode)
  if (history.interrupted !== undefined) {
    stores.notifications.push(INTERRUPTED_TAIL_NOTICE[history.interrupted], 'warning', 'run')
  }
  threads.set(stores.threadId, stores)
  summaries.set(stores.threadId, {
    threadId: stores.threadId,
    title: titleFromMessages(messages),
    lastActivityAt: new Date(),
    busy: false,
  })
  publishThreadList()
  return stores
}

/** The stores of a thread this page minted. Looking up an unknown id is a programming error, so it throws. */
export function getThreadStores(threadId: string): ThreadStores {
  const stores = threads.get(threadId)
  if (stores === undefined) throw new Error(`getThreadStores: ${threadId} was not minted on this page`)
  return stores
}

/** Called by a thread's pane whenever its transcript or in-flight state changes. */
export function updateThreadSummary(threadId: string, patch: Pick<ThreadSummary, 'title' | 'busy'>): void {
  const current = summaries.get(threadId)
  if (current === undefined) return
  if (current.title === patch.title && current.busy === patch.busy) return
  summaries.set(threadId, { ...current, ...patch, lastActivityAt: new Date() })
  publishThreadList()
}

export const threadListStore: Store<readonly ThreadSummary[]> = threadList

/** One line, from the first user message's text — deepseek-harness titles its sessions exactly this way. */
export const TITLE_MAX_CHARS = 60

export function titleFromMessages(messages: ReadonlyArray<UIMessage>): string | undefined {
  const first = messages.find((message) => message.role === 'user')
  if (first === undefined) return undefined
  const text = first.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.content)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return undefined
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text
}

/** Test seam: forget every thread. Never called from production code. */
export function clearThreadsForTest(): void {
  threads.clear()
  summaries.clear()
  publishThreadList()
}
