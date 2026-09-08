import type { ZenNotifyType } from "@zen/core";
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { createStore, type Store, useStore, useThreadStores } from "./store.ts";

/**
 * pi's `notify` messages, rendered (#29).
 *
 * A notify arrives as an AG-UI CUSTOM chunk (`zen.notify`), and TanStack's designated
 * path for those is the `onCustomEvent` chat option — an imperative callback on the
 * OPTIONS object. So the bridge to React state is this store, one per thread
 * (`thread-stores.ts`): `custom-event-router.ts` pushes into it, and
 * `SessionNotifications` subscribes to the rendering thread's.
 *
 * ⚠ Notifications are DURABLE lines, not toasts, on purpose: this harness's standing rule
 * is that a silent success is indistinguishable from a dropped one, and a toast that
 * auto-dismisses while the user is in another window reproduces exactly that. The list is
 * session-lived and renders at the tail of the transcript.
 */

export interface ZenNotification {
	id: number;
	message: string;
	notifyType: ZenNotifyType | undefined;
	at: Date;
}

/**
 * ⚠ Bounded because notify is UNBOUNDED INPUT — any extension may emit any number. A
 * runaway loop must degrade to "the newest 100 lines", not an ever-growing render list.
 * Dropping the OLDEST is the right end: the tail is what the user is looking at.
 */
const MAX_KEPT_NOTIFICATIONS = 100;

export interface NotificationsStore extends Store<ReadonlyArray<ZenNotification>> {
	readonly push: (message: string, notifyType: ZenNotifyType | undefined) => void;
}

export function createNotificationsStore(): NotificationsStore {
	const store = createStore<ReadonlyArray<ZenNotification>>([]);
	let nextNotificationId = 1;
	return {
		get: store.get,
		subscribe: store.subscribe,
		push: (message, notifyType) => {
			const appended = [...store.get(), { id: nextNotificationId++, message, notifyType, at: new Date() }];
			store.set(appended.slice(-MAX_KEPT_NOTIFICATIONS));
		},
	};
}

const NOTIFY_TYPE_ICONS = {
	info: InfoIcon,
	warning: TriangleAlertIcon,
	error: OctagonAlertIcon,
} as const;

/**
 * One notification as a small transcript line. Presentational — takes the notification as
 * a prop so it is testable without the store.
 *
 * `notifyType` styling: error uses the destructive token; warning has no shadcn token, so
 * it stays muted with the triangle icon carrying the distinction; an absent type renders
 * as info. The full timestamp lives in `title` (hover) — the visible line stays short.
 */
export function NotificationLine({ notification }: { notification: ZenNotification }): React.ReactNode {
	const Icon = NOTIFY_TYPE_ICONS[notification.notifyType ?? "info"];
	return (
		<div
			role="status"
			title={notification.at.toLocaleString()}
			className={cn(
				"flex items-center gap-2 text-xs",
				notification.notifyType === "error" ? "text-destructive" : "text-muted-foreground",
			)}
		>
			<Icon className="size-3.5 shrink-0" />
			<span className="whitespace-pre-wrap">{notification.message}</span>
		</div>
	);
}

/** The transcript-tail block: every notification the rendering thread has received, in order. */
export function SessionNotifications(): React.ReactNode {
	const currentNotifications = useStore(useThreadStores().notifications);
	if (currentNotifications.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			{currentNotifications.map((notification) => (
				<NotificationLine key={notification.id} notification={notification} />
			))}
		</div>
	);
}
