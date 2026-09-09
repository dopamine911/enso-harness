import { afterEach, beforeEach, expect, test } from "bun:test";
import { routeZenCustomEvent } from "../custom-event-router.ts";
import {
	ZEN_CUSTOM_EVENT_DIALOG,
	ZEN_CUSTOM_EVENT_ENTRY,
	ZEN_CUSTOM_EVENT_MODE,
	ZEN_CUSTOM_EVENT_NOTIFY,
	ZEN_CUSTOM_EVENT_RUN,
	ZEN_CUSTOM_EVENT_UNMAPPED,
	ZEN_CUSTOM_EVENT_USAGE,
} from "../rpc/custom-event-names.ts";
import { clearThreadsForTest, mintThread, type ThreadStores } from "../thread-stores.ts";

/**
 * #53 S1.3: the CUSTOM-chunk router was an inline closure no test reached — renaming
 * `zen.entry`, dropping the notify-type allowlist, or swapping the two `apply*` calls all
 * left the suite green. These drive the extracted function with a fresh thread's stores
 * (#90 PR 3) and read them back.
 */

let stores: ThreadStores;
beforeEach(() => {
	stores = mintThread();
});
afterEach(() => clearThreadsForTest());

const route = (eventType: string, data: unknown): void => routeZenCustomEvent(stores, eventType, data);
const notificationMessages = (): string[] => stores.notifications.get().map((notification) => notification.message);

// ⚠ ONE ENTRY, TWO VIEWS (#84). A picc modes entry is both history (the transcript line)
// and state (the current-mode store). Dropping either `apply*` call from the entry branch
// leaves the other view green, so both are read here.
test("zen.entry reaches BOTH the mode-lines store and the current-mode store", () => {
	route(ZEN_CUSTOM_EVENT_ENTRY, {
		kind: "custom-entry",
		customType: "modes",
		data: { mode: "acceptEdits" },
	});
	expect(notificationMessages()).toEqual(["Mode: acceptEdits"]);
	expect(stores.permissionMode.get().mode).toBe("acceptEdits");
	// and it did NOT land in the stats store (the swap-the-two-apply-calls mutation)
	expect(stores.stats.get().totalCost).toBe(0);
});

test("zen.mode reaches the current-mode store and nothing else — it is state, not a transcript line", () => {
	route(ZEN_CUSTOM_EVENT_MODE, { mode: "default", available: ["default", "plan"] });
	expect(stores.permissionMode.get()).toEqual({ mode: "default", available: ["default", "plan"] });
	expect(notificationMessages()).toEqual([]);
});

test("zen.run sets the thread's run generation; a malformed value leaves the last one standing (#109)", () => {
	expect(stores.generation.get()).toBeUndefined();
	route(ZEN_CUSTOM_EVENT_RUN, { generation: 3 });
	expect(stores.generation.get()).toBe(3);
	route(ZEN_CUSTOM_EVENT_RUN, { generation: -1 });
	route(ZEN_CUSTOM_EVENT_RUN, { generation: "4" });
	route(ZEN_CUSTOM_EVENT_RUN, null);
	expect(stores.generation.get()).toBe(3);
	expect(notificationMessages()).toEqual([]);
});

test("zen.dialog opens the thread's question; a malformed one opens nothing and says so (#112)", () => {
	route(ZEN_CUSTOM_EVENT_DIALOG, { id: "d1", dialog: { method: "confirm", title: "Apply?", message: "m" } });
	expect(stores.dialog.get()).toEqual({ id: "d1", dialog: { method: "confirm", title: "Apply?", message: "m" } });
	route(ZEN_CUSTOM_EVENT_DIALOG, { id: "", dialog: { method: "select" } });
	expect(stores.dialog.get()?.id).toBe("d1");
	expect(notificationMessages()).toEqual([expect.stringContaining("could not read")]);
});

test("zen.usage reaches the session-stats store and nothing else", () => {
	route(ZEN_CUSTOM_EVENT_USAGE, {
		kind: "message-end",
		role: "assistant",
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
	});
	expect(stores.stats.get().totalCost).toBe(0.5);
	expect(notificationMessages()).toEqual([]);
});

test("zen.notify pushes the message with each declared notify type", () => {
	for (const notifyType of ["info", "warning", "error"] as const) {
		route(ZEN_CUSTOM_EVENT_NOTIFY, { message: `m-${notifyType}`, notifyType });
	}
	expect(stores.notifications.get().map((notification) => notification.notifyType)).toEqual([
		"info",
		"warning",
		"error",
	]);
});

// #96: the origin is the host's tag, carried as-is; when it cannot be read the notice is
// shown OPEN (`run`), because the safe failure of a grouping rule is "not grouped".
test("zen.notify carries the origin into the store; an unreadable origin degrades to run, never to hidden", () => {
	route(ZEN_CUSTOM_EVENT_NOTIFY, { message: "startup", notifyType: "info", origin: "session-start" });
	route(ZEN_CUSTOM_EVENT_NOTIFY, { message: "during", notifyType: "info", origin: "run" });
	route(ZEN_CUSTOM_EVENT_NOTIFY, { message: "untagged", notifyType: "info" });
	route(ZEN_CUSTOM_EVENT_NOTIFY, { message: "mistagged", notifyType: "info", origin: "elsewhere" });
	expect(stores.notifications.get().map((notification) => [notification.message, notification.origin])).toEqual([
		["startup", "session-start"],
		["during", "run"],
		["untagged", "run"],
		["mistagged", "run"],
	]);
});

test("an unrecognised notify type degrades to an untyped notification, never a drop", () => {
	route(ZEN_CUSTOM_EVENT_NOTIFY, { message: "hello", notifyType: "loud" });
	route(ZEN_CUSTOM_EVENT_NOTIFY, { message: "plain" });
	expect(stores.notifications.get().map((notification) => [notification.message, notification.notifyType])).toEqual([
		["hello", undefined],
		["plain", undefined],
	]);
});

test("a chunk name this surface does not render falls through untouched", () => {
	route(ZEN_CUSTOM_EVENT_UNMAPPED, { type: "some_future_event" });
	route("zen.entry-renamed", { customType: "modes", data: { mode: "plan" } });
	route("", { message: "x" });
	expect(notificationMessages()).toEqual([]);
	expect(stores.stats.get().totalCost).toBe(0);
});

// ⚠ A throw here would end TanStack's stream loop — every malformed value must render as nothing.
test("malformed payloads never throw and never render", () => {
	const malformed: unknown[] = [
		null,
		undefined,
		42,
		"text",
		[],
		{},
		{ message: 7 },
		{ message: null, notifyType: "info" },
	];
	for (const eventType of [ZEN_CUSTOM_EVENT_NOTIFY, ZEN_CUSTOM_EVENT_ENTRY, ZEN_CUSTOM_EVENT_USAGE]) {
		for (const value of malformed) {
			expect(() => route(eventType, value)).not.toThrow();
		}
	}
	expect(notificationMessages()).toEqual([]);
	expect(stores.stats.get().totalCost).toBe(0);
});

// ⚠ THE REASON THE ROUTER TAKES ITS STORES. TanStack hands `onCustomEvent` no thread id;
// each pane's factory closes over its own stores, so a chunk routed through one thread's
// callback must land in that thread and no other.
test("⚠ a chunk routed to one thread never touches another thread's stores", () => {
	const other = mintThread();
	route(ZEN_CUSTOM_EVENT_USAGE, {
		kind: "message-end",
		role: "assistant",
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
	});
	route(ZEN_CUSTOM_EVENT_MODE, { mode: "plan", available: ["plan"] });
	expect(stores.stats.get().totalCost).toBe(0.5);
	expect(other.stats.get().totalCost).toBe(0);
	expect(other.permissionMode.get().mode).toBeUndefined();
	expect(other.recentChunks.get()).toEqual([]);
});
