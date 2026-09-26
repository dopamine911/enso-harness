import type { EnsoNotifyType, EnsoUiRequestOrigin } from '@enso/core'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { createStore, type Store, useStore, useThreadStores } from './store.ts'

/**
 * pi's `notify` messages, rendered (#29).
 *
 * A notify arrives as an AG-UI CUSTOM chunk (`extension-ui-request`), and TanStack's designated
 * path for those is the `onCustomEvent` chat option — an imperative callback on the
 * OPTIONS object. So the bridge to React state is this store, one per thread
 * (`thread-stores.ts`): `custom-event-router.ts` pushes into it, and
 * `ThreadNotifications` subscribes to the rendering thread's.
 *
 * ⚠ Notifications are DURABLE lines, not toasts, on purpose: this harness's standing rule
 * is that a silent success is indistinguishable from a dropped one, and a toast that
 * auto-dismisses while the user is in another window reproduces exactly that. The list is
 * session-lived and renders at the tail of the transcript.
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
  at: Date
}

/**
 * ⚠ Bounded because notify is UNBOUNDED INPUT — any extension may emit any number. A
 * runaway loop must degrade to "the newest 100 lines", not an ever-growing render list.
 * Dropping the OLDEST is the right end: the tail is what the user is looking at.
 */
const MAX_KEPT_NOTIFICATIONS = 100

export interface NotificationsStore extends Store<ReadonlyArray<EnsoNotification>> {
  readonly push: (message: string, notifyType: EnsoNotifyType | undefined, origin: EnsoUiRequestOrigin) => void
}

export function createNotificationsStore(): NotificationsStore {
  const store = createStore<ReadonlyArray<EnsoNotification>>([])
  let nextNotificationId = 1
  return {
    get: store.get,
    subscribe: store.subscribe,
    push: (message: string, notifyType: EnsoNotifyType | undefined, origin: EnsoUiRequestOrigin) => {
      const appended = [...store.get(), { id: nextNotificationId++, message, notifyType, origin, at: new Date() }]
      store.set(appended.slice(-MAX_KEPT_NOTIFICATIONS))
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

/**
 * One line in the transcript's voice: an icon by `notifyType`, the text beside it (#383 review).
 * Presentational, and the ONE definition of that row — a notification renders through it, and so
 * does a refused attempt's bubble (`refused-attempt.tsx`), which has no notification to give.
 *
 * `notifyType` styling: error uses the destructive token; warning has no shadcn token, so it stays
 * muted with the triangle icon carrying the distinction; an absent type renders as info. Anything
 * else — a `title`, a `data-*` marker — passes through to the row.
 */
export function TranscriptLine({
  notifyType,
  message,
  ...rest
}: {
  notifyType: EnsoNotifyType | undefined
  message: string
} & Omit<React.ComponentProps<'div'>, 'role' | 'className' | 'children'>): React.ReactNode {
  const Icon = NOTIFY_TYPE_ICONS[notifyType ?? 'info']
  return (
    <div
      role="status"
      {...rest}
      className={cn(
        'flex items-start gap-2 text-xs',
        notifyType === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 break-words whitespace-pre-wrap">
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
 * without the store. The full timestamp lives in `title` (hover) — the visible line stays short.
 */
export function NotificationLine({ notification }: { notification: EnsoNotification }): React.ReactNode {
  return (
    <TranscriptLine
      notifyType={notification.notifyType}
      message={notification.message}
      title={notification.at.toLocaleString()}
    />
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
    <details data-enso-startup-notices="" className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        {notifications.length} startup {noun} from extensions
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5 pl-4">
        {notifications.map((notification) => (
          <NotificationLine key={notification.id} notification={notification} />
        ))}
      </div>
    </details>
  )
}

/**
 * The transcript-tail block: every notification the rendering thread has received, in
 * order — the startup notices folded at its head (they precede every run's by
 * construction: the host replays them before the first prompt), the rest as lines.
 */
export function ThreadNotifications(): React.ReactNode {
  const currentNotifications = useStore(useThreadStores().notifications)
  if (currentNotifications.length === 0) return null
  const startup = currentNotifications.filter(isStartupNotice)
  const open = currentNotifications.filter((notification) => !isStartupNotice(notification))
  return (
    <div className="flex flex-col gap-1.5">
      <StartupNotices notifications={startup} />
      {open.map((notification) => (
        <NotificationLine key={notification.id} notification={notification} />
      ))}
    </div>
  )
}
