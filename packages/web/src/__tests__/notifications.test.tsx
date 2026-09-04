import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	clearZenNotificationsForTest,
	getZenNotificationsSnapshot,
	NotificationLine,
	pushZenNotification,
	SessionNotifications,
	subscribeToZenNotifications,
} from "../notifications.tsx";

/**
 * #29's browser half: notify messages become visible transcript lines. The store is
 * module-level because TanStack's `onCustomEvent` is an option on an object built before
 * any component exists — these tests cover the store contract and the rendering, since
 * nothing in CI drives the live stream.
 */

afterEach(() => clearZenNotificationsForTest());

test("a pushed notification appears in the snapshot, in order", () => {
	pushZenNotification("first", "info");
	pushZenNotification("second", undefined);
	const snapshot = getZenNotificationsSnapshot();
	expect(snapshot.map((notification) => notification.message)).toEqual(["first", "second"]);
	expect(snapshot[1]?.notifyType).toBeUndefined();
});

test("subscribers are told about a push, and unsubscribe stops that", () => {
	let notified = 0;
	const unsubscribe = subscribeToZenNotifications(() => {
		notified += 1;
	});
	pushZenNotification("a", "info");
	expect(notified).toBe(1);
	unsubscribe();
	pushZenNotification("b", "info");
	expect(notified).toBe(1);
});

// ⚠ Notify is unbounded input (any extension, any volume) — the store must degrade to
// "the newest lines", never an ever-growing render list.
test("the store keeps only the newest 100, dropping the oldest", () => {
	for (let sequence = 1; sequence <= 105; sequence++) {
		pushZenNotification(`n${sequence}`, undefined);
	}
	const snapshot = getZenNotificationsSnapshot();
	expect(snapshot.length).toBe(100);
	expect(snapshot[0]?.message).toBe("n6");
	expect(snapshot.at(-1)?.message).toBe("n105");
});

test("a notification line renders its message", () => {
	const rendered = renderToStaticMarkup(
		<NotificationLine
			notification={{ id: 1, message: "Mode set to Plan Mode", notifyType: "info", at: new Date(0) }}
		/>,
	);
	expect(rendered).toContain("Mode set to Plan Mode");
	expect(rendered).toContain('role="status"');
});

test("an error notification styles with the destructive token; others stay muted", () => {
	const errorLine = renderToStaticMarkup(
		<NotificationLine notification={{ id: 1, message: "x", notifyType: "error", at: new Date(0) }} />,
	);
	const infoLine = renderToStaticMarkup(
		<NotificationLine notification={{ id: 2, message: "x", notifyType: undefined, at: new Date(0) }} />,
	);
	expect(errorLine).toContain("text-destructive");
	expect(infoLine).toContain("text-muted-foreground");
});

test("the session block renders nothing while the store is empty, then every line", () => {
	expect(renderToStaticMarkup(<SessionNotifications />)).toBe("");
	pushZenNotification("one", "info");
	pushZenNotification("two", "warning");
	const rendered = renderToStaticMarkup(<SessionNotifications />);
	expect(rendered).toContain("one");
	expect(rendered).toContain("two");
});
