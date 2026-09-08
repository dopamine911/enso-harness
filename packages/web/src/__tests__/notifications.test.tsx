import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createNotificationsStore,
	NotificationLine,
	type NotificationsStore,
	SessionNotifications,
} from "../notifications.tsx";
import { ThreadStoresContext } from "../store.ts";
import { clearThreadsForTest, mintThread } from "../thread-stores.ts";

/**
 * #29's browser half: notify messages become visible transcript lines. One store per
 * thread (#90 PR 3): the store contract is tested on a fresh instance, and the block is
 * rendered inside a minted thread's context, the way a pane provides it.
 */

let store: NotificationsStore;
beforeEach(() => {
	store = createNotificationsStore();
});
afterEach(() => clearThreadsForTest());

test("a pushed notification appears in the snapshot, in order", () => {
	store.push("first", "info");
	store.push("second", undefined);
	const snapshot = store.get();
	expect(snapshot.map((notification) => notification.message)).toEqual(["first", "second"]);
	expect(snapshot[1]?.notifyType).toBeUndefined();
});

test("subscribers are told about a push, and unsubscribe stops that", () => {
	let notified = 0;
	const unsubscribe = store.subscribe(() => {
		notified += 1;
	});
	store.push("a", "info");
	expect(notified).toBe(1);
	unsubscribe();
	store.push("b", "info");
	expect(notified).toBe(1);
});

// ⚠ Notify is unbounded input (any extension, any volume) — the store must degrade to
// "the newest lines", never an ever-growing render list.
test("the store keeps only the newest 100, dropping the oldest", () => {
	for (let sequence = 1; sequence <= 105; sequence++) {
		store.push(`n${sequence}`, undefined);
	}
	const snapshot = store.get();
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

test("the session block renders nothing while the thread's store is empty, then every line", () => {
	const thread = mintThread();
	const block = (): string =>
		renderToStaticMarkup(
			<ThreadStoresContext.Provider value={thread}>
				<SessionNotifications />
			</ThreadStoresContext.Provider>,
		);
	expect(block()).toBe("");
	thread.notifications.push("one", "info");
	thread.notifications.push("two", "warning");
	const rendered = block();
	expect(rendered).toContain("one");
	expect(rendered).toContain("two");
});

// ⚠ THE REASON STORES ARE PER THREAD. A line pushed into one thread must not render in
// another's transcript — before #90 PR 3 there was one list per page and it would have.
test("⚠ a notification belongs to its thread: another thread's block does not show it", () => {
	const first = mintThread();
	const second = mintThread();
	first.notifications.push("only in the first", "info");
	const rendered = renderToStaticMarkup(
		<ThreadStoresContext.Provider value={second}>
			<SessionNotifications />
		</ThreadStoresContext.Provider>,
	);
	expect(rendered).toBe("");
});
