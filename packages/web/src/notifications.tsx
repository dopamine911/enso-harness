import type { EnsoNotifyType, EnsoUiRequestOrigin } from '@enso/core'
import { ChevronRightIcon, InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { Button } from './components/ui/button.tsx'
import { createStore, type Store, useThreadStores } from './store.ts'

/**
 * pi's `notify` messages, rendered (#29).
 *
 * A notify arrives as an AG-UI CUSTOM chunk (`extension-ui-request`), and TanStack's designated
 * path for those is the `onCustomEvent` chat option — an imperative callback on the
 * OPTIONS object. So the bridge to React state is this store, one per thread
 * (`thread-stores.ts`): `custom-event-router.ts` pushes into it, and the chat layout groups the
 * rendering thread's lines by where they read (`placeLines`).
 *
 * ⚠ Notifications are DURABLE lines, not toasts, on purpose: this harness's standing rule
 * is that a silent success is indistinguishable from a dropped one, and a toast that
 * auto-dismisses while the user is in another window reproduces exactly that. The list is
 * session-lived.
 *
 * ⚠ A LINE READS WHERE IT HAPPENED (#382). Each is anchored, as it is pushed, to the message it
 * follows (`after`) and renders after that message's bubble — not in one block after the whole
 * transcript, where a refusal ended up below the reply it preceded, and under every later turn.
 * The anchor is the stream's current assistant message when there is one (`FollowConnection.
 * streamMessageId`), else the transcript's last message; a line with neither heads the
 * transcript. A line whose message the transcript no longer holds (a re-read after compaction
 * replaced the ids) falls to the tail, still in order.
 *
 * ⚠ Startup notices are GROUPED, not dropped (#96). Every thread opens with the same
 * extension lines (multi-account's two, on every screenshot from #84 to #94) — infra facts
 * about the process, true of every thread. They fold into one collapsed `<details>` at the
 * head of the block, expanded on click, never auto-dismissed. The tag is the host's
 * (`origin: "session-start"` — replayed from before the first subscriber), never a guess
 * from position: a run's own notice before its first token — a guard refusal — stays open.
 * So does any `warning`/`error`, whatever its origin: an extension that failed at startup is
 * not noise.
 */

export interface EnsoNotification {
  id: number
  message: string
  notifyType: EnsoNotifyType | undefined
  /**
   * `session-start`: an extension's notice replayed from the session's own start.
   * `run`: everything else — a run's notice, and the harness's own `Mode:` line (#84),
   * which is not extension chatter and stays open however early it arrives.
   */
  origin: EnsoUiRequestOrigin
  /**
   * Who acted (#387): the extension that said it, the provider that refused, or `Enso` for the
   * harness's own lines — always from data (a tagged sender, a refusal's provider), never from
   * the wording. Absent when nothing names one.
   */
  source?: string | undefined
  /** The one thing a reader can do about it (#436: Continue on a torn tail); gone once pressed. */
  action?: NotificationAction | undefined
  at: Date
  /**
   * The message this line follows (#382): set once, as it is pushed — see the module's
   * "A line reads where it happened". Undefined for a session-start notice (it precedes every
   * run), and for a line pushed before the transcript held any message: both head the transcript.
   */
  after: string | undefined
}

/**
 * A line's one action (#436) — a label and what pressing it does. One-shot: pressing takes it off
 * the line (`takeAction`), so it cannot be pressed twice; what came of it is said as lines of its own.
 */
export interface NotificationAction {
  readonly label: string
  readonly run: () => void
}

/**
 * ⚠ Bounded because notify is UNBOUNDED INPUT — any extension may emit any number. A
 * runaway loop must degrade to "the newest 100 lines", not an ever-growing render list.
 * Dropping the OLDEST is the right end: the tail is what the user is looking at.
 */
const MAX_KEPT_NOTIFICATIONS = 100

/** A line to add: everything a notification holds but what the store gives it — its id, time and anchor. */
type NotificationLineInput = Omit<EnsoNotification, 'id' | 'at' | 'after'>

export interface NotificationsStore extends Store<ReadonlyArray<EnsoNotification>> {
  readonly push: (
    message: string,
    notifyType: EnsoNotifyType | undefined,
    origin: EnsoUiRequestOrigin,
    source?: string,
  ) => void
  /** Add a line that carries an action (#436) — the one the reader can press once. Answers the line's id. */
  readonly pushWithAction: (line: NotificationLineInput & { action: NotificationAction }) => number
  /**
   * Add a line after a message the caller names (#766), not the stream's or the tail: a stop read
   * back off the branch, whose message the server named. A message the transcript does not hold
   * falls to the tail, as any line's does.
   */
  readonly pushAfter: (after: string, line: NotificationLineInput) => void
  /** Take a line's action off it and hand it back, or `undefined` when it has none (any more). */
  readonly takeAction: (id: number) => NotificationAction | undefined
  /**
   * Rewrite a line the thread has moved past, as an `info` line with no action (PR #442 review):
   * a torn-tail warning once a run has answered it. A line already dropped off the bound is gone.
   */
  readonly resolveLine: (id: number, message: string) => void
  /**
   * Put an action back on its line (PR #438 review): a press whose outcome was not final — the
   * server busy, unreachable, the page disconnected — must not use up the only way to act. A line
   * already resolved, or dropped off the bound, stays as it is.
   */
  readonly restoreAction: (id: number, action: NotificationAction) => void
  /**
   * The transcript's last message, as the page last rendered it (#382): the anchor of a line
   * pushed while the stream names none — a reloaded thread before its first run, a line the page
   * raises itself between runs.
   */
  readonly setTranscriptTail: (messageId: string | undefined) => void
}

/**
 * `streamMessageId` is the thread's follow, read at push time: the assistant message of the chunk
 * being processed (`FollowConnection.streamMessageId`). Absent, every line anchors to the
 * transcript's tail.
 */
export function createNotificationsStore(
  streamMessageId: () => string | undefined = () => undefined,
): NotificationsStore {
  const store = createStore<ReadonlyArray<EnsoNotification>>([])
  let nextNotificationId = 1
  let transcriptTail: string | undefined
  /** Lines a later fact has answered (`resolveLine`) — never given an action back. */
  const resolved = new Set<number>()
  const append = (line: NotificationLineInput, anchor?: string): number => {
    const id = nextNotificationId++
    const after = line.origin === 'session-start' ? undefined : (anchor ?? streamMessageId() ?? transcriptTail)
    const appended = [...store.get(), { ...line, id, at: new Date(), after }]
    store.set(appended.slice(-MAX_KEPT_NOTIFICATIONS))
    return id
  }
  const rewrite = (id: number, change: (notification: EnsoNotification) => EnsoNotification): void => {
    store.set(store.get().map((notification) => (notification.id === id ? change(notification) : notification)))
  }
  return {
    get: store.get,
    subscribe: store.subscribe,
    push: (message: string, notifyType: EnsoNotifyType | undefined, origin: EnsoUiRequestOrigin, source?: string) => {
      append({ message, notifyType, origin, source })
    },
    pushWithAction: append,
    pushAfter: (after: string, line: NotificationLineInput) => {
      append(line, after)
    },
    takeAction: (id: number) => {
      const action = store.get().find((notification) => notification.id === id)?.action
      if (action === undefined) return undefined
      rewrite(id, (notification) => ({ ...notification, action: undefined }))
      return action
    },
    resolveLine: (id: number, message: string) => {
      resolved.add(id)
      rewrite(id, (notification) => ({ ...notification, message, notifyType: 'info', action: undefined }))
    },
    restoreAction: (id: number, action: NotificationAction) => {
      if (!resolved.has(id)) rewrite(id, (notification) => ({ ...notification, action }))
    },
    setTranscriptTail: (messageId: string | undefined) => {
      transcriptTail = messageId
    },
  }
}

/** The grouping rule (#96), in one place: a startup notice that is merely informational. */
function isStartupNotice(notification: EnsoNotification): boolean {
  return notification.origin === 'session-start' && (notification.notifyType ?? 'info') === 'info'
}

const NOTIFY_TYPE_ICONS = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: OctagonAlertIcon,
} as const

/** Each line kind's row and icon colours — see {@link TranscriptLine}. */
const LINE_STYLE: Record<EnsoNotifyType, { row: string; icon: string }> = {
  // Ledger (#407): the receipt transcript — an error boxed in-line, every other line on a hairline.
  error: {
    row: 'rounded-md border border-refuse bg-card px-3 py-2 text-foreground ledger:my-3 ledger:max-w-none ledger:rounded-xs',
    icon: 'text-refuse',
  },
  warning: { row: 'text-foreground ledger:max-w-none ledger:border-b ledger:py-3', icon: 'text-refuse' },
  info: { row: 'text-muted-foreground ledger:max-w-none ledger:border-b ledger:py-3', icon: '' },
}

/**
 * One line in the transcript's voice: an icon by `notifyType`, the text beside it (#383 review).
 * Presentational, and the ONE definition of that row — a notification renders through it, and so
 * does a refused attempt's bubble (`refused-attempt.tsx`), which has no notification to give.
 *
 * `notifyType` styling (the design direction's transcript lines): an error is a bordered card in
 * the refusal colour, text in the foreground; a warning is foreground text beside a triangle in
 * the refusal colour; info — and an absent type — is muted. Anything else — a `title`, a
 * `data-*` marker — passes through to the row.
 *
 * `source` leads the text when there is one (#387): `Anthropic · …`, `pi-multi-account · …`,
 * `Enso · …` — who acted, so a reader knows what would fix it without reading logs.
 */
export function TranscriptLine({
  notifyType,
  message,
  source,
  ...rest
}: {
  notifyType: EnsoNotifyType | undefined
  message: string
  source?: string | undefined
} & Omit<React.ComponentProps<'div'>, 'role' | 'className' | 'children'>): React.ReactNode {
  const kind = notifyType ?? 'info'
  const Icon = NOTIFY_TYPE_ICONS[kind]
  return (
    <div
      role="status"
      {...rest}
      className={cn('flex max-w-3xl items-start gap-2 text-sm leading-normal', LINE_STYLE[kind].row)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', LINE_STYLE[kind].icon)} />
      <span className="min-w-0 break-words whitespace-pre-wrap">
        {source === undefined ? null : (
          <>
            <b data-enso-line-source="" className="font-medium text-foreground">
              {source}
            </b>
            {' · '}
          </>
        )}
        <LinkedText text={message} />
      </span>
    </div>
  )
}

/**
 * A URL in a line: `http(s)://` up to whitespace, minus the sentence punctuation that trails it
 * (`…at https://x/device.` — the period is the sentence's). Only http(s): nothing else becomes an href.
 */
const LINE_URL = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/g

/**
 * A URL as a person reads it in a line (#388): host and path, `…` standing for a query or
 * fragment. A login's authorization URL is 500 characters of query nobody reads; the host is what
 * says where the link goes, and the full URL is on hover and in the href.
 */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}${parsed.search.length > 0 || parsed.hash.length > 0 ? '…' : ''}`
  } catch {
    return url
  }
}

/**
 * A line's text with every URL in it a link that opens a new tab (#388): a login URL, a device
 * code's verification page, a provider's docs link in a refusal. Before, a URL was plain text —
 * unclickable, and one unbreakable token that pushed the whole transcript sideways.
 */
function LinkedText({ text }: { text: string }): React.ReactNode {
  const pieces: React.ReactNode[] = []
  let consumed = 0
  for (const found of text.matchAll(LINE_URL)) {
    const url = found[0]
    if (found.index > consumed) pieces.push(text.slice(consumed, found.index))
    pieces.push(
      <a
        key={found.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        className="underline underline-offset-2"
      >
        {shortUrl(url)}
      </a>,
    )
    consumed = found.index + url.length
  }
  if (consumed < text.length) pieces.push(text.slice(consumed))
  return pieces
}

/**
 * One notification as a small transcript line. Takes the notification as a prop so it is testable
 * without the store. The full timestamp lives in `title` (hover) — the visible line stays short. A
 * line with an action (#436) carries its button after the text; `onAction` is what pressing it does.
 */
export function NotificationLine({
  notification,
  onAction,
}: {
  notification: EnsoNotification
  onAction?: () => void
}): React.ReactNode {
  const line = (
    <TranscriptLine
      notifyType={notification.notifyType}
      message={notification.message}
      source={notification.source}
      title={notification.at.toLocaleString()}
    />
  )
  if (notification.action === undefined) return line
  return (
    <div className="flex flex-col gap-1.5">
      {line}
      <Button type="button" size="sm" variant="outline" className="ml-6 self-start" onClick={onAction}>
        {notification.action.label}
      </Button>
    </div>
  )
}

/**
 * The startup notices, folded (#96): one summary line, the notices verbatim behind it. A
 * native `<details>` — keyboard- and screen-reader-complete without a component, and its
 * open state survives a re-render of the list because React keeps the element.
 */
function StartupNotices({ notifications }: { notifications: readonly EnsoNotification[] }): React.ReactNode {
  if (notifications.length === 0) return null
  const noun = notifications.length === 1 ? 'notice' : 'notices'
  return (
    <details data-enso-startup-notices="" className="group max-w-3xl text-sm text-muted-foreground">
      <summary className="-ml-2 inline-flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2 marker:hidden hover:bg-popover hover:text-foreground">
        <ChevronRightIcon aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
        <InfoIcon aria-hidden="true" className="size-4" />
        {notifications.length} startup {noun} from extensions
      </summary>
      <div className="mt-1 flex flex-col gap-1.5 pl-6">
        {notifications.map((notification) => (
          <NotificationLine key={notification.id} notification={notification} />
        ))}
      </div>
    </details>
  )
}

/**
 * The thread's lines by where they read (#382) — see the module's "A line reads where it happened":
 * - `head`: before the first message — the startup notices (they precede every run by
 *   construction: the host replays them before the first prompt), then the lines that came
 *   before any message;
 * - `after`: by message id, the lines that follow that message's bubble;
 * - `tail`: after the last message — the lines whose message the transcript no longer holds.
 *
 * Each list keeps the order the lines arrived in. Grouped once per change of the lines or the
 * transcript, not per row: every row re-renders on every streamed chunk.
 */
export interface PlacedLines {
  readonly head: readonly EnsoNotification[]
  readonly after: ReadonlyMap<string, readonly EnsoNotification[]>
  readonly tail: readonly EnsoNotification[]
}

export function placeLines(
  notifications: readonly EnsoNotification[],
  transcriptIds: ReadonlySet<string>,
): PlacedLines {
  const head: EnsoNotification[] = []
  const after = new Map<string, EnsoNotification[]>()
  const tail: EnsoNotification[] = []
  for (const notification of notifications) {
    const anchor = notification.after
    if (anchor === undefined) head.push(notification)
    else if (!transcriptIds.has(anchor)) tail.push(notification)
    else {
      const lines = after.get(anchor)
      if (lines === undefined) after.set(anchor, [notification])
      else lines.push(notification)
    }
  }
  return { head, after, tail }
}

/** One block of the rendering thread's lines: its startup notices folded first, then the rest open. */
export function NotificationLines({ lines }: { lines: readonly EnsoNotification[] | undefined }): React.ReactNode {
  const { notifications } = useThreadStores()
  if (lines === undefined || lines.length === 0) return null
  const startup = lines.filter(isStartupNotice)
  const open = lines.filter((notification) => !isStartupNotice(notification))
  return (
    <div className="flex flex-col gap-1.5">
      <StartupNotices notifications={startup} />
      {open.map((notification) => (
        <NotificationLine
          key={notification.id}
          notification={notification}
          onAction={() => notifications.takeAction(notification.id)?.run()}
        />
      ))}
    </div>
  )
}
