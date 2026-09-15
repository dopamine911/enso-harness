import type { ZenNotifyType, ZenUiRequestOrigin } from '@zen/core'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { createStore, type Store, useStore, useThreadStores } from './store.ts'

/**
 * pi's `notify` messages, rendered (#29).
 *
 * A notify arrives as an AG-UI CUSTOM chunk (`zen.notify`), and TanStack's designated
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

export interface ZenNotification {
  id: number
  message: string
  notifyType: ZenNotifyType | undefined
  /**
   * `session-start`: an extension's notice replayed from the session's own start.
   * `run`: everything else — a run's notice, and the harness's own `Mode:` line (#84),
   * which is not extension chatter and stays open however early it arrives.
   */
  origin: ZenUiRequestOrigin
  at: Date
}

/**
 * ⚠ Bounded because notify is UNBOUNDED INPUT — any extension may emit any number. A
 * runaway loop must degrade to "the newest 100 lines", not an ever-growing render list.
 * Dropping the OLDEST is the right end: the tail is what the user is looking at.
 */
const MAX_KEPT_NOTIFICATIONS = 100

export interface NotificationsStore extends Store<ReadonlyArray<ZenNotification>> {
  readonly push: (message: string, notifyType: ZenNotifyType | undefined, origin: ZenUiRequestOrigin) => void
}

export function createNotificationsStore(): NotificationsStore {
  const store = createStore<ReadonlyArray<ZenNotification>>([])
  let nextNotificationId = 1
  return {
    get: store.get,
    subscribe: store.subscribe,
    push: (message: string, notifyType: ZenNotifyType | undefined, origin: ZenUiRequestOrigin) => {
      const appended = [...store.get(), { id: nextNotificationId++, message, notifyType, origin, at: new Date() }]
      store.set(appended.slice(-MAX_KEPT_NOTIFICATIONS))
    },
  }
}

/** The grouping rule (#96), in one place: a startup notice that is merely informational. */
function isStartupNotice(notification: ZenNotification): boolean {
  return notification.origin === 'session-start' && (notification.notifyType ?? 'info') === 'info'
}

const NOTIFY_TYPE_ICONS = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: OctagonAlertIcon,
} as const

/**
 * One notification as a small transcript line. Presentational — takes the notification as
 * a prop so it is testable without the store.
 *
 * `notifyType` styling: error uses the destructive token; warning has no shadcn token, so
 * it stays muted with the triangle icon carrying the distinction; an absent type renders
 * as info. The full timestamp lives in `title` (hover) — the visible line stays short.
 */
export function NotificationLine({ notification }: { notification: ZenNotification }): React.ReactNode {
  const Icon = NOTIFY_TYPE_ICONS[notification.notifyType ?? 'info']
  return (
    <div
      role="status"
      title={notification.at.toLocaleString()}
      className={cn(
        'flex items-center gap-2 text-xs',
        notification.notifyType === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{notification.message}</span>
    </div>
  )
}

/**
 * The startup notices, folded (#96): one summary line, the notices verbatim behind it. A
 * native `<details>` — keyboard- and screen-reader-complete without a component, and its
 * open state survives a re-render of the list because React keeps the element.
 */
function StartupNotices({ notifications }: { notifications: readonly ZenNotification[] }): React.ReactNode {
  if (notifications.length === 0) return null
  const noun = notifications.length === 1 ? 'notice' : 'notices'
  return (
    <details data-zen-startup-notices="" className="text-muted-foreground text-xs">
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
