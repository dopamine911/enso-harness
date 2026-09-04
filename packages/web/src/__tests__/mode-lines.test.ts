import { afterEach, expect, test } from "bun:test";
import { applyZenCustomEntry, clearModeLinesForTest } from "../mode-lines.ts";
import { clearZenNotificationsForTest, getZenNotificationsSnapshot } from "../notifications.tsx";

/**
 * #29's remaining half: a mode change becomes a visible transcript line.
 *
 * ⚠ The subject is a MODULE-LEVEL store with a distinct-value gate — state across calls —
 * so these tests deliberately drive sequences on the one shared instance and reset via the
 * test seams between cases. A suite that could rebuild the store per call would never see
 * the gate fail.
 */

afterEach(() => {
	clearModeLinesForTest();
	clearZenNotificationsForTest();
});

const modesEntry = (mode: unknown) => ({ customType: "modes", data: { mode } });
const renderedMessages = () =>
	getZenNotificationsSnapshot().map((notification) => notification.message);

// ⚠ The first value RENDERS, deliberately: picc persists on every session start, so the
// opening line tells the user which mode the session is actually in. State wording
// ("Mode: x") is what makes that honest — it is never a claim that something changed.
test("the first mode value renders as a state line", () => {
	applyZenCustomEntry(modesEntry("default"));
	expect(renderedMessages()).toEqual(["Mode: default"]);
});

// ⚠ The distinct-value gate: picc re-persists the SAME mode on rule updates and session
// starts, and each re-persist must render nothing — or every allow-rule edit would echo
// a phantom mode line.
test("re-persists of the same mode render nothing; a real change renders once", () => {
	applyZenCustomEntry(modesEntry("default"));
	applyZenCustomEntry(modesEntry("default"));
	applyZenCustomEntry(modesEntry("default"));
	applyZenCustomEntry(modesEntry("acceptEdits"));
	applyZenCustomEntry(modesEntry("acceptEdits"));
	expect(renderedMessages()).toEqual(["Mode: default", "Mode: acceptEdits"]);
});

test("switching back to an earlier mode renders again — the gate is last-value, not a set", () => {
	applyZenCustomEntry(modesEntry("default"));
	applyZenCustomEntry(modesEntry("plan"));
	applyZenCustomEntry(modesEntry("default"));
	expect(renderedMessages()).toEqual(["Mode: default", "Mode: plan", "Mode: default"]);
});

// Some other extension's persisted state is not ours to render.
test("a custom entry of another type is ignored", () => {
	applyZenCustomEntry({ customType: "tanstack:interruptBinding", data: { mode: "sneaky" } });
	expect(renderedMessages()).toEqual([]);
});

test("malformed values are ignored, never thrown from the stream loop", () => {
	applyZenCustomEntry(undefined);
	applyZenCustomEntry("modes");
	applyZenCustomEntry({ customType: "modes" });
	applyZenCustomEntry({ customType: "modes", data: null });
	applyZenCustomEntry(modesEntry(42));
	applyZenCustomEntry(modesEntry(""));
	expect(renderedMessages()).toEqual([]);
});
