import { afterEach, expect, test } from "bun:test";
import { routeZenCustomEvent } from "../custom-event-router.ts";
import { clearModeLinesForTest } from "../mode-lines.ts";
import { clearZenNotificationsForTest, getZenNotificationsSnapshot } from "../notifications.tsx";
import {
	ZEN_CUSTOM_EVENT_ENTRY,
	ZEN_CUSTOM_EVENT_NOTIFY,
	ZEN_CUSTOM_EVENT_UNMAPPED,
	ZEN_CUSTOM_EVENT_USAGE,
} from "../rpc/custom-event-names.ts";
import { clearSessionStatsForTest, getSessionStatsSnapshot } from "../session-stats.tsx";

/**
 * #53 S1.3: the CUSTOM-chunk router was an inline closure no test reached — renaming
 * `zen.entry`, dropping the notify-type allowlist, or swapping the two `apply*` calls all
 * left the suite green. These drive the extracted function and read the three stores.
 */

afterEach(() => {
	clearModeLinesForTest();
	clearZenNotificationsForTest();
	clearSessionStatsForTest();
});

const notificationMessages = () => getZenNotificationsSnapshot().map((notification) => notification.message);

test("zen.entry reaches the mode-lines store — a picc modes entry renders one Mode line", () => {
	routeZenCustomEvent(ZEN_CUSTOM_EVENT_ENTRY, {
		kind: "custom-entry",
		customType: "modes",
		data: { mode: "acceptEdits" },
	});
	expect(notificationMessages()).toEqual(["Mode: acceptEdits"]);
	// and it did NOT land in the stats store (the swap-the-two-apply-calls mutation)
	expect(getSessionStatsSnapshot().totalCost).toBe(0);
});

test("zen.usage reaches the session-stats store and nothing else", () => {
	routeZenCustomEvent(ZEN_CUSTOM_EVENT_USAGE, {
		kind: "message-usage",
		role: "assistant",
		usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalCost: 0.5 },
	});
	expect(getSessionStatsSnapshot().totalCost).toBe(0.5);
	expect(notificationMessages()).toEqual([]);
});

test("zen.notify pushes the message with each declared notify type", () => {
	for (const notifyType of ["info", "warning", "error"] as const) {
		routeZenCustomEvent(ZEN_CUSTOM_EVENT_NOTIFY, { message: `m-${notifyType}`, notifyType });
	}
	expect(getZenNotificationsSnapshot().map((notification) => notification.notifyType)).toEqual([
		"info",
		"warning",
		"error",
	]);
});

test("an unrecognised notify type degrades to an untyped notification, never a drop", () => {
	routeZenCustomEvent(ZEN_CUSTOM_EVENT_NOTIFY, { message: "hello", notifyType: "loud" });
	routeZenCustomEvent(ZEN_CUSTOM_EVENT_NOTIFY, { message: "plain" });
	expect(getZenNotificationsSnapshot().map((notification) => [notification.message, notification.notifyType])).toEqual([
		["hello", undefined],
		["plain", undefined],
	]);
});

test("a chunk name this surface does not render falls through untouched", () => {
	routeZenCustomEvent(ZEN_CUSTOM_EVENT_UNMAPPED, { type: "some_future_event" });
	routeZenCustomEvent("zen.entry-renamed", { customType: "modes", data: { mode: "plan" } });
	routeZenCustomEvent("", { message: "x" });
	expect(notificationMessages()).toEqual([]);
	expect(getSessionStatsSnapshot().totalCost).toBe(0);
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
			expect(() => routeZenCustomEvent(eventType, value)).not.toThrow();
		}
	}
	expect(notificationMessages()).toEqual([]);
	expect(getSessionStatsSnapshot().totalCost).toBe(0);
});
