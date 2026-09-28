import {
  ENSO_NOTICE_SOURCE,
  ENSO_PROJECT_HEADER,
  type EnsoDialogSpec,
  type EnsoGuardRule,
  type EnsoToolResultDescriptor,
  type EnsoInterruptedTail,
  type EnsoSessionUsage,
  type EnsoThreadHistory,
  ensoLogger,
  type ProviderRefusalClass,
  readEnsoGuardDenialMetadata,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import type { BrowserLogging, FetchLike } from './browser-logging.ts'
import { createRecentChunksStore, type RecentChunksStore } from './custom-event-router.ts'
import { createFollowConnection, type FollowConnection } from './follow-connection.ts'
import { createModeLines, type ModeLines } from './mode-lines.ts'
import { createModelStore, type ModelStore } from './model-state.tsx'
import { createNotificationsStore, type NotificationsStore } from './notifications.tsx'
import { createPermissionModeStore, type PermissionModeStore } from './permission-mode.tsx'
import { createStore, type Store, type WritableStore } from './store.ts'

/**
 * Everything the browser knows about one thread beyond its messages (#90 PR 3).
 *
 * ⚠ WHY INSTANCES, NOT MODULE STATE. Until this, every store was a module singleton — one
 * mode, one cost, one notification list per PAGE — which was correct only while a page
 * held exactly one thread. The sessions rail holds several and switches between them; a
 * run in one keeps streaming while another is on screen, and its `session-usage` must land in
 * ITS cost, not the visible thread's. So each thread gets its own set, created here, and
 * the pane that renders a thread provides them through `ThreadStoresContext`.
 *
 * ⚠ THE PAGE OWNS ITS LIVE LIST. The rail's first section is the threads this page minted
 * or resumed — only those chat instances can be switched to. Stored sessions appear in the
 * second section and become page-owned only after `/history` succeeds. A session another tab
 * is running is refused by both the rail and the server; two pages never drive one pi session.
 *
 * ⚠ AND IT IS BOUNDED (#272). A live thread holds a follow — one SSE connection — for as
 * long as its pane is mounted, and a browser gives an origin six HTTP/1.1 connections; the
 * server is plain `Bun.serve` over loopback, so there is no h2 multiplexing to hide behind.
 * Past the budget the newest follow AND every unary `/api` call the page makes (`prompt`,
 * `/history`, `/api/mode`) queue behind the open streams, silently. So the page holds at
 * most `MAX_LIVE_THREADS`: minting or adopting past it drops the least recently active idle
 * thread, which closes its follow. Neither a thread with a run in flight nor the one ON
 * SCREEN is ever the victim — a follow the page is showing or streaming is not spare
 * capacity — so a page made only of those goes over budget and records it. The session is
 * the server's, not the page's, so a dropped thread comes back through the rail's earlier threads —
 * the rail and `popstate` already resume a thread this page does not hold.
 */
export interface ThreadStores {
  readonly threadId: string
  /**
   * The messages the thread's chat mounts with (#95): a resumed thread's stored branch,
   * as the server mapped it; empty for a thread minted on this page. Read ONCE, by the
   * chat factory — TanStack owns the messages from there.
   */
  readonly history: readonly UIMessage[]
  /**
   * What the composer opens holding (#433): a fork's prefill — the forked prompt's words, to send
   * again or edit, as pi's `/fork` puts them in its editor — and empty otherwise. Read ONCE, when
   * the composer mounts; the composer owns its draft from there.
   */
  readonly initialDraft: string
  readonly permissionMode: PermissionModeStore
  /** The session's model and thinking level (#338 slice 2); `null` until a live snapshot or `model` observation says. */
  readonly model: ModelStore
  /** The tree pi runs this thread in (#44), from every snapshot; undefined until the follow's first one. */
  readonly cwd: WritableStore<string | undefined>
  /**
   * What the session has spent and how full its context is (#45): the snapshot's `usage`, then
   * each `session-usage` observation, each the WHOLE state from pi's session totals — so a
   * reload, a resume or a second tab shows what the first tab saw accumulate. Undefined until
   * the follow's first snapshot.
   */
  readonly usage: WritableStore<EnsoSessionUsage | undefined>
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
   * (#112, #114): `extension-ui-request` opens it when the slot is free, `dialog-settled`
   * clears it by id, and a snapshot's `openDialogs` replaces it wholesale. ONE slot is the
   * browser's choice, not pi's — extensions can hold several questions at once
   * (`openDialogs()` lists them); this page shows the OLDEST, so no later ask displaces the
   * question being read (#271, the router's `routeUiRequest`), and a second becomes visible
   * only once a snapshot lists it first (the router's `snapshot` branch) — until then it
   * waits on the server, answerable from this thread after a reload. Also cleared by an
   * answer this page sends that the server takes or reports gone.
   */
  readonly dialog: WritableStore<EnsoPendingDialog | undefined>
  /**
   * The follow ended under this page (#119): the server closed, restarted, or dropped the
   * connection, and nothing here reconnects — the thread's state on this page is as of that
   * moment. Set by `follow-ended`; cleared by the next `status` or `snapshot` frame, which only a live
   * follow delivers. While true the status bar says `disconnected` and no stop is offered,
   * whatever the run flag still holds: the page cannot know what the server is doing.
   */
  readonly disconnected: WritableStore<boolean>
  /**
   * What waits behind the run in flight (#75): the texts, the interrupting ones first,
   * from every `queue` frame — one list for every follower, so a second tab sees what
   * the first queued. Empty when nothing waits. Rendered above the composer; a stop hands
   * these back to the composer through the abort receipt, not from here (the frame that
   * empties this can beat the receipt).
   */
  readonly queue: WritableStore<readonly string[]>
  /**
   * The provider's last refusal (#340) while nothing has succeeded since: its class word, and the
   * session's output tokens when it came. A `session-usage` whose output has grown past that clears
   * it — pi's own accounting is what says a reply got through. The status bar reads it, so `$0.0000`
   * next to `idle` is never read as "free" when it means "nothing ran".
   */
  readonly refusal: WritableStore<ProviderRefusalMark | undefined>
  /**
   * The calls a guard refused (#387, #407), by tool-call id, with the rule that refused each.
   * pi hands the page a refusal as an error result shaped like any failed command; this is what
   * tells them apart. Seeded from the history's results (the server joined the guard's session
   * entry onto each), then fed by the live `custom-entry` chunk the guard's entry crosses as —
   * one store either way, so a refusal reads the same live, reloaded and resumed.
   */
  readonly guardDenials: WritableStore<ReadonlyMap<string, EnsoGuardRule>>
  /**
   * Finished tool results' #18 descriptors, by tool-call id, as they arrive LIVE (#411): TanStack
   * drops the one the AG-UI result carries, so the follow connection hands it over here. A stored
   * result carries its descriptor in its own metadata, so nothing is seeded; `EnsoToolResult`
   * reads this first, then the result.
   */
  readonly toolResultDescriptors: WritableStore<ReadonlyMap<string, EnsoToolResultDescriptor>>
  /**
   * The Start-a-session dialog is open (#391). Raised when the page MINTS the thread — New Thread,
   * a page with no thread in its URL — and lowered by Start or Escape; a thread adopted from
   * history never raises it.
   */
  readonly startSession: WritableStore<boolean>
  /**
   * The project this thread runs in (#395): the one its `+` named when minted, or its stored
   * session's when adopted. `undefined` for a thread minted before the page knew its projects (a
   * fresh page's first thread) — the server builds it in the launch directory, which is where the
   * rail files it.
   */
  readonly projectId: string | undefined
  /**
   * Every thread-scoped request's fetch: the #118 seam's (or the page's), naming `projectId` in
   * `X-Enso-Project` so the server builds a new thread's session there. The server reads the header
   * only until the session exists; after that, the session's own directory decides.
   */
  readonly fetch: FetchLike
  /** The thread's transport: TanStack's connection over prompt/follow, and the dialog answer beside it. */
  readonly connection: FollowConnection
}

/** A refusal the status bar shows — see {@link ThreadStores.refusal}. */
export interface ProviderRefusalMark {
  readonly refusalClass: ProviderRefusalClass
  /** Who refused (#387) — `providerRefusalSource`: said beside the word, and on the retry lines that follow. */
  readonly provider?: string | undefined
  readonly outputAtRefusal: number
}

export interface EnsoPendingDialog {
  readonly id: string
  readonly dialog: EnsoDialogSpec
}

/**
 * A fetch that names the thread's project on every request (#395) — or the fetch as it is, for a
 * thread with none. The base is read at CALL time, so a test that swaps `globalThis.fetch` after a
 * thread is minted is still the one asked.
 */
function namingProject(fetchImpl: FetchLike | undefined, projectId: string | undefined): FetchLike {
  return (input: string, init?: RequestInit): Promise<Response> => {
    const base = fetchImpl ?? fetch
    if (projectId === undefined) return base(input, init)
    const headers = new Headers(init?.headers)
    headers.set(ENSO_PROJECT_HEADER, projectId)
    return base(input, { ...init, headers })
  }
}

/** The refusals a stored history's tool results carry — see {@link ThreadStores.guardDenials}. */
function guardDenialsIn(history: readonly UIMessage[]): Map<string, EnsoGuardRule> {
  const denials = new Map<string, EnsoGuardRule>()
  for (const message of history) {
    for (const part of message.parts) {
      if (part.type !== 'tool-result') continue
      const denial = readEnsoGuardDenialMetadata(part.metadata)
      if (denial !== undefined) denials.set(denial.toolCallId, denial.rule)
    }
  }
  return denials
}

/**
 * `fetch` is the one seam between a thread and the network: a test mounts a real pane over a
 * scripted server through it (#118), and the fixture page mints its threads with a fetch that
 * refuses every request (#404). The live page passes nothing — the page's own `fetch`.
 */
function createThreadStores(
  threadId: string,
  history: readonly UIMessage[],
  fetchImpl: FetchLike | undefined,
  opening: { readonly projectId: string | undefined; readonly initialDraft: string },
): ThreadStores {
  const { projectId, initialDraft } = opening
  const notifications = createNotificationsStore()
  const toolResultDescriptors = createStore<ReadonlyMap<string, EnsoToolResultDescriptor>>(new Map())
  const threadFetch = namingProject(fetchImpl, projectId)
  return {
    threadId,
    history,
    initialDraft,
    permissionMode: createPermissionModeStore(),
    model: createModelStore(),
    cwd: createStore<string | undefined>(undefined),
    usage: createStore<EnsoSessionUsage | undefined>(undefined),
    notifications,
    modeLines: createModeLines(notifications),
    recentChunks: createRecentChunksStore(),
    generation: createStore<number | undefined>(undefined),
    dialog: createStore<EnsoPendingDialog | undefined>(undefined),
    disconnected: createStore(false),
    queue: createStore<readonly string[]>([]),
    refusal: createStore<ProviderRefusalMark | undefined>(undefined),
    guardDenials: createStore<ReadonlyMap<string, EnsoGuardRule>>(guardDenialsIn(history)),
    toolResultDescriptors,
    startSession: createStore(false),
    projectId,
    fetch: threadFetch,
    connection: createFollowConnection({
      threadId,
      fetch: threadFetch,
      // The page's own connection to the server — a busy thread (409), a refused answer, the
      // network: Enso's lines (#387).
      onProblem: (problem: unknown) => notifications.push(String(problem), 'warning', 'run', ENSO_NOTICE_SOURCE),
      onToolResultDescriptor: (toolCallId: string, descriptor: EnsoToolResultDescriptor) => {
        toolResultDescriptors.set(new Map(toolResultDescriptors.get()).set(toolCallId, descriptor))
      },
      onTurnStart: () => retireTornTail(threadId),
    }),
  }
}

/**
 * What a resumed thread says about a turn that never settled (#109) — a durable line at
 * the head of the transcript's notices, never a toast, because the torn tail is where the
 * thread stands and the user should know that before typing. Its action is **Continue**
 * (#436): the run picks up from exactly the stored state, with no new user message; a new
 * prompt stays the alternative, and also continues from the tail.
 */
const INTERRUPTED_TAIL_NOTICE: Record<EnsoInterruptedTail, string> = {
  'unanswered-prompt':
    "This session's last prompt was never answered — its run was cut off before a reply. Continue picks up from there without a new message, or send a new prompt.",
  'tool-call-without-result':
    "This session's last turn ended mid-tool-call — the result never arrived. Continue picks up from there (the lost result is recorded as an error), or send a new prompt.",
  'tool-results-without-reply':
    "This session's last turn ended after its tool results, before the model replied to them. Continue picks up from there without a new message, or send a new prompt.",
}

/** The interrupted-tail notice's action (#436): post Continue; the run arrives on the follow, a refusal as a line. */
const CONTINUE_LABEL = 'Continue'

/**
 * What the torn-tail line becomes once a run answers it (PR #442 review) — Continue's, or any other:
 * a prompt sent instead, or a run another tab started. Before, the warning and its button outlived
 * the tail, and a late press was a 409 or a 422 under a reply that had already answered it.
 */
export const TORN_TAIL_CONTINUED = 'The cut-off turn was continued from its stored state.'
export const TORN_TAIL_SUPERSEDED = 'A later run picked up after the cut-off turn.'

/** Per thread, what to do with its torn-tail line when its first run starts; gone once done. */
const tornTailLines = new Map<string, () => void>()

/**
 * The thread's first run — Continue's, a prompt sent instead, another tab's — answers its torn
 * tail. Keyed on the run's first turn, not on `busy` (PR #440 review): every control route takes
 * a lease and raises `busy` without starting a run.
 */
function retireTornTail(threadId: string): void {
  tornTailLines.get(threadId)?.()
  tornTailLines.delete(threadId)
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
  /** pi is parked on a question for the user (the thread's open dialog) — the rail's violet dot. */
  readonly waiting: boolean
  /** Which project's group the rail lists it under — `ThreadStores.projectId`. */
  readonly projectId: string | undefined
}

/**
 * The page's logging (#132): the ring the drawer reads and the shipper the page flushes on
 * hide — set once by `main.tsx` after `configureBrowserLogging`; undefined in tests that
 * mount without it.
 *
 * One per page, like the rail.
 */
export const browserLogging: WritableStore<BrowserLogging | undefined> = createStore<BrowserLogging | undefined>(
  undefined,
)

/** The page's live list, as the record reads it: a thread minted, adopted or dropped (#272). */
const threadLog = ensoLogger('browser', 'threads')

const threads = new Map<string, ThreadStores>()
const summaries = new Map<string, ThreadSummary>()
/** Newest first — the order the rail lists them in. Rebuilt on every change so the snapshot is stable between changes. */
const threadList = createStore<readonly ThreadSummary[]>([])

function publishThreadList(): void {
  threadList.set([...summaries.values()].reverse())
}

/**
 * The most threads this page keeps live at once (#272) — the header's budget.
 *
 * Four follows leave two of the browser's six connections for the unary routes a pane needs
 * (`prompt`, `/history`, `/api/mode`), which is what wedges first when the streams take the
 * lot.
 */
export const MAX_LIVE_THREADS = 4

/**
 * The pane the user is looking at. Undefined only while a URL-named thread is being adopted
 * and nothing is on screen (`chat-screen.tsx`).
 */
let activeThreadId: string | undefined

/**
 * The active pane changed.
 *
 * Two effects, and the first is the load-bearing one (PR #301 review): the visible thread stops
 * being a drop candidate, and its clock restarts so it is not the first to go the moment the
 * user switches away.
 *
 * ⚠ Reading a thread is activity. `updateThreadSummary` only fires on a title or a busy
 * transition, so without this a thread the user is READING — finished reply, idle, not busy —
 * ages like an abandoned one.
 */
export function markThreadActive(threadId: string | undefined): void {
  activeThreadId = threadId
  if (threadId === undefined) return
  const current = summaries.get(threadId)
  if (current === undefined) return
  summaries.set(threadId, { ...current, lastActivityAt: new Date() })
  publishThreadList()
}

/**
 * The drop candidate: the least recently active thread that is neither running nor on screen.
 *
 * ⚠ THE ACTIVE PANE IS NEVER A CANDIDATE (PR #301 review). Recency alone does not protect it:
 * open a thread, read its finished reply, then open four more, and the one being read was the
 * least recently active of them. Dropping it unmounts the pane under the user — `active`
 * resolves to undefined, the header falls back to the untitled label, the content area goes
 * blank, and nothing says why. The page exceeds its budget instead, exactly as it does for a
 * run in flight, and for the same reason: a follow this page is showing is not spare capacity.
 */
function leastRecentlyActiveIdle(): ThreadSummary | undefined {
  let oldest: ThreadSummary | undefined
  for (const summary of summaries.values()) {
    if (summary.busy || summary.threadId === activeThreadId) continue
    if (oldest === undefined || summary.lastActivityAt < oldest.lastActivityAt) oldest = summary
  }
  return oldest
}

/**
 * The thread leaves this page (#272): its follow closes, its stores are forgotten, and the
 * rail stops listing it — so its pane unmounts and the connection is released twice over
 * (here, and again by TanStack's dispose). The pi session is the SERVER's: a dropped thread
 * that ran reappears among the rail's earlier threads and `/history` rebuilds its transcript.
 * Idempotent — dropping a thread this page does not hold does nothing.
 */
function dropThread(threadId: string): void {
  const stores = threads.get(threadId)
  if (stores === undefined) return
  stores.connection.close()
  threads.delete(threadId)
  summaries.delete(threadId)
  tornTailLines.delete(threadId)
  publishThreadList()
}

/**
 * Make room for one more live thread, so the page never holds more follows than the
 * budget.
 *
 * ⚠ Two kinds of thread are never dropped: one with a run in flight, because cutting its
 * follow would leave a run nobody on this page can see or stop, and the one on screen,
 * because its pane would vanish mid-read. A page made entirely of those exceeds the budget
 * deliberately, and says so in the record rather than in silence.
 */
function makeRoomForOneMore(): void {
  while (threads.size >= MAX_LIVE_THREADS) {
    const victim = leastRecentlyActiveIdle()
    if (victim === undefined) {
      threadLog.warn('every live thread is running or on screen: {live} follows open, over the budget of {budget}', {
        live: threads.size,
        budget: MAX_LIVE_THREADS,
      })
      return
    }
    threadLog.info('thread {threadId} dropped to stay inside the follow budget of {budget}', {
      threadId: victim.threadId,
      budget: MAX_LIVE_THREADS,
    })
    dropThread(victim.threadId)
  }
}

/**
 * Mint a new thread on this page and return its stores.
 *
 * The rail lists it at once, untitled. Inside the page's follow budget: minting past it drops
 * an idle thread (#272). `fetch` is the thread's network seam (`createThreadStores`). A minted thread opens on the
 * Start-a-session dialog (#391) — every way the page mints one is a new thread the person is about
 * to start.
 */
export function mintThread(fetchImpl?: FetchLike, projectId?: string): ThreadStores {
  makeRoomForOneMore()
  const stores = createThreadStores(crypto.randomUUID(), [], fetchImpl, { projectId, initialDraft: '' })
  stores.startSession.set(true)
  threads.set(stores.threadId, stores)
  summaries.set(stores.threadId, {
    threadId: stores.threadId,
    title: undefined,
    lastActivityAt: new Date(),
    busy: false,
    waiting: false,
    projectId,
  })
  publishThreadList()
  return stores
}

/**
 * JSON turns TanStack's `Date` into a string on the history route.
 *
 * Restore it at the browser boundary and reject rows that cannot be UI messages;
 * `EnsoThreadHistory.messages` is intentionally unknown because core must not own TanStack's
 * transport shape.
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
 *
 * Adopting a thread already on this page returns it — the rail cannot hold one twice — and
 * adopting one past the page's follow budget drops an idle thread to make room (#272). `fetch`
 * is the thread's network seam, as `mintThread`'s; `initialDraft` is what its composer opens
 * holding (a fork's prefill, #433).
 */
export function adoptThread(history: EnsoThreadHistory, fetchImpl?: FetchLike, initialDraft = ''): ThreadStores {
  const existing = threads.get(history.threadId)
  if (existing !== undefined) return existing
  makeRoomForOneMore()
  const messages = reviveHistoryMessages(history.messages)
  const stores = createThreadStores(history.threadId, messages, fetchImpl, {
    projectId: history.projectId,
    initialDraft,
  })
  stores.permissionMode.applyReceipt(history.permissionMode)
  if (history.interrupted !== undefined) {
    // Whether Continue started the run, known only once the server answers (PR #439 review): a
    // first turn that lands while the answer is pending waits for it — the turn is Continue's on a
    // 202, and someone else's run (another tab's prompt, won just before) on a 409.
    let continuing = Promise.resolve(false)
    const line = stores.notifications.pushWithAction({
      message: INTERRUPTED_TAIL_NOTICE[history.interrupted],
      notifyType: 'warning',
      origin: 'run',
      source: ENSO_NOTICE_SOURCE,
      action: {
        label: CONTINUE_LABEL,
        run: () => {
          continuing = stores.connection.continueRun().then(
            (outcome) => outcome === 'told',
            () => false,
          )
        },
      },
    })
    tornTailLines.set(history.threadId, () => {
      void continuing.then((continued) =>
        stores.notifications.resolveLine(line, continued ? TORN_TAIL_CONTINUED : TORN_TAIL_SUPERSEDED),
      )
    })
  }
  threads.set(stores.threadId, stores)
  summaries.set(stores.threadId, {
    threadId: stores.threadId,
    title: titleFromMessages(messages),
    lastActivityAt: new Date(),
    busy: false,
    waiting: false,
    projectId: history.projectId,
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
export function updateThreadSummary(threadId: string, patch: Pick<ThreadSummary, 'title' | 'busy' | 'waiting'>): void {
  const current = summaries.get(threadId)
  if (current === undefined) return
  if (current.title === patch.title && current.busy === patch.busy && current.waiting === patch.waiting) return
  summaries.set(threadId, { ...current, ...patch, lastActivityAt: new Date() })
  publishThreadList()
}

export const threadListStore: Store<readonly ThreadSummary[]> = threadList

/** One line, from the first user message's text — deepseek-harness titles its sessions exactly this way. */
export const TITLE_MAX_CHARS = 60

/**
 * The message's text parts, joined, whitespace-collapsed and trimmed — the same string
 * `parts.join(' ').replace(/\s+/g, ' ').trim()` produced, computed over a WINDOW twice the
 * cap instead of over the whole prompt.
 *
 * A window that collapses to more than the cap already contains the title, and collapsing
 * is left-to-right, so its first `TITLE_MAX_CHARS + 1` characters are the full string's.
 * The whole prompt is scanned only when the window collapses to LESS than the cap — a
 * prompt that opens with more whitespace than text — where there is no shorter correct
 * answer. The first prompt is routinely a pasted file or stack trace, and this ran per
 * streamed token (#283): 14.9 µs for 20 KB, now 0.19 µs.
 */
function titleTextOf(message: UIMessage): string {
  let source = ''
  for (const part of message.parts) {
    if (part.type !== 'text') continue
    source = source.length === 0 ? part.content : `${source} ${part.content}`
  }
  const window = source
    .slice(0, TITLE_MAX_CHARS * 2)
    .replace(/\s+/g, ' ')
    .trim()
  if (window.length > TITLE_MAX_CHARS || source.length <= TITLE_MAX_CHARS * 2) return window
  return source.replace(/\s+/g, ' ').trim()
}

/**
 * One thread's title, from ONE message — the first user one.
 *
 * Exported so a caller can depend on that message's identity rather than on the list's: the
 * list gets a new identity per streamed chunk, and the title cannot have changed (#283).
 */
export function titleFromMessage(message: UIMessage): string | undefined {
  const text = titleTextOf(message)
  if (text.length === 0) return undefined
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text
}

export function titleFromMessages(messages: ReadonlyArray<UIMessage>): string | undefined {
  const first = messages.find((message) => message.role === 'user')
  return first === undefined ? undefined : titleFromMessage(first)
}

/** Test seam: forget every thread, closing the follow each one holds. Never called from production code. */
export function clearThreadsForTest(): void {
  for (const stores of threads.values()) stores.connection.close()
  threads.clear()
  summaries.clear()
  activeThreadId = undefined
  publishThreadList()
}
