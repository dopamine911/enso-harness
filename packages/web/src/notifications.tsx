import type { ZenNotifyType } from "@zen/core";
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils.ts";

/**
 * pi's `notify` messages, rendered (#29).
 *
 * A notify arrives as an AG-UI CUSTOM chunk (`zen.notify`), and TanStack's designated
 * path for those is the `onCustomEvent` chat option — an imperative callback on the
 * OPTIONS object, which is built at module scope before any component exists. So the
 * bridge to React state is this module-level store: `pushZenNotification` is called from
 * `onCustomEvent`, and `SessionNotifications` subscribes via `useSyncExternalStore`.
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

let notifications: ReadonlyArray<ZenNotification> = [];
let nextNotificationId = 1;
const listeners = new Set<() => void>();

export function pushZenNotification(message: string, notifyType: ZenNotifyType | undefined): void {
	const appended = [...notifications, { id: nextNotificationId++, message, notifyType, at: new Date() }];
	notifications = appended.slice(-MAX_KEPT_NOTIFICATIONS);
	for (const listener of listeners) listener();
}

export function subscribeToZenNotifications(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getZenNotificationsSnapshot(): ReadonlyArray<ZenNotification> {
	return notifications;
}

/** Test seam: reset the store between cases. Never called from production code. */
export function clearZenNotificationsForTest(): void {
	notifications = [];
	nextNotificationId = 1;
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

/** The transcript-tail block: every notification the session has received, in order. */
export function SessionNotifications(): React.ReactNode {
	const currentNotifications = useSyncExternalStore(
		subscribeToZenNotifications,
		getZenNotificationsSnapshot,
		getZenNotificationsSnapshot,
	);
	if (currentNotifications.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			{currentNotifications.map((notification) => (
				<NotificationLine key={notification.id} notification={notification} />
			))}
		</div>
	);
}
