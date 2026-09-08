import { afterEach, expect, test } from "bun:test";
import type { ZenThreadInspection } from "@zen/core";
import { renderToStaticMarkup } from "react-dom/server";
import {
	clearRecentCustomChunksForTest,
	getRecentCustomChunks,
	RECENT_CUSTOM_CHUNK_CAPACITY,
	routeZenCustomEvent,
} from "../custom-event-router.ts";
import { clearModeLinesForTest } from "../mode-lines.ts";
import { clearZenNotificationsForTest } from "../notifications.tsx";
import { clearPermissionModeForTest } from "../permission-mode.tsx";
import {
	type BrowserBelief,
	type CopyState,
	describeChunk,
	InspectionFetchError,
	lastPersistedMode,
	latestWins,
	NO_SESSION_YET,
	SessionDebugView,
} from "../session-debug.tsx";
import { clearSessionStatsForTest } from "../session-stats.tsx";

/**
 * #86: the drawer's one job is to NAME a disagreement between what the browser believes
 * and what pi's session holds. These render it statically with each disagreement injected
 * and assert the word MISMATCH appears — or does not — as text, the way a human or a
 * screen reader would see it. The fetch wiring is covered by the live receipt.
 */

afterEach(() => {
	clearRecentCustomChunksForTest();
	clearPermissionModeForTest();
	clearModeLinesForTest();
	clearZenNotificationsForTest();
	clearSessionStatsForTest();
});

const noop = (): void => {
	// Static markup runs no handlers; the callbacks exist only to satisfy the props.
};

const piccEntry = (mode: string, id: string): unknown => ({
	type: "custom",
	customType: "modes",
	data: { mode },
	id,
	parentId: null,
	timestamp: "2026-09-08T10:00:00.000Z",
});

function inspection(overrides: Partial<ZenThreadInspection> = {}): ZenThreadInspection {
	return {
		threadId: "t1",
		sessionId: "session-1",
		cwd: "/repo",
		sessionDir: "/agent/sessions/--repo--",
		sessionFile: null,
		permissionMode: { mode: "plan", available: ["default", "plan"] },
		commands: ["mode", "plan"],
		busy: false,
		parked: false,
		lastActivityAt: "2026-09-08T10:00:05.000Z",
		entries: [
			{ type: "session", id: "root", parentId: null, timestamp: "2026-09-08T10:00:00.000Z" },
			piccEntry("plan", "m1"),
		],
		...overrides,
	};
}

function believing(mode: string | undefined): BrowserBelief {
	return {
		mode: { mode, available: ["default", "plan"] },
		stats: { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 },
		recentChunks: [],
	};
}

const render = (
	browser: BrowserBelief,
	session: ZenThreadInspection | undefined,
	error?: string,
	copyState: CopyState = "idle",
): string =>
	renderToStaticMarkup(
		<SessionDebugView
			threadId="t1"
			browser={browser}
			session={session}
			error={error}
			copyState={copyState}
			onRefresh={noop}
			onCopy={noop}
		/>,
	);

// ── lastPersistedMode: picc's own restore rule, applied to the raw branch ─────

test("the branch's LAST modes entry wins, and a branch with none is picc's initial default", () => {
	expect(lastPersistedMode([piccEntry("acceptEdits", "a"), piccEntry("plan", "b")])).toBe("plan");
	expect(lastPersistedMode([{ type: "message", id: "x", parentId: null, timestamp: "" }])).toBe("default");
	// Another extension's custom entry is not a mode.
	expect(lastPersistedMode([{ type: "custom", customType: "other", data: { mode: "plan" }, id: "o" }])).toBe("default");
});

// ── the mismatch highlight ───────────────────────────────────────────────────

test("agreement everywhere renders no MISMATCH", () => {
	const rendered = render(believing("plan"), inspection());
	expect(rendered).not.toContain("MISMATCH");
	expect(rendered).toContain("host mode: plan");
	expect(rendered).toContain("branch mode: plan");
});

// ⚠ THE FEATURE. Browser store ≠ host means the stream or the store dropped a receipt.
test("⚠ browser store disagreeing with the host is named as a MISMATCH", () => {
	const rendered = render(believing("default"), inspection());
	expect(rendered).toContain("MISMATCH: host says plan");
});

// Host ≠ branch means the host's walk is wrong — a picc shape change slipped past core.
test("⚠ the host disagreeing with the branch's last modes entry is named as a MISMATCH", () => {
	const rendered = render(
		believing("acceptEdits"),
		inspection({ permissionMode: { mode: "acceptEdits", available: [] }, entries: [piccEntry("plan", "m1")] }),
	);
	expect(rendered).toContain("MISMATCH: branch says plan");
});

test("an unflushed session says so instead of showing a path", () => {
	expect(render(believing("plan"), inspection({ sessionFile: null }))).toContain("in memory, not flushed yet");
	expect(render(believing("plan"), inspection({ sessionFile: "/agent/sessions/x.jsonl" }))).toContain(
		"/agent/sessions/x.jsonl",
	);
});

test("before the first fetch, and on a failed one, the session column says why", () => {
	expect(render(believing(undefined), undefined)).toContain("not fetched yet");
	// A fresh thread's 404 is information, not a failure — the drawer words it that way.
	expect(render(believing(undefined), undefined, NO_SESSION_YET)).toContain("nothing has run on this thread");
	expect(render(believing(undefined), undefined, "TypeError: fetch failed")).toContain("fetch failed");
});

// ── the router's record ──────────────────────────────────────────────────────

test("every CUSTOM chunk the router sees is recorded, oldest first, with a stable identity", () => {
	routeZenCustomEvent("zen.mode", { mode: "default", available: [] });
	routeZenCustomEvent("zen.unmapped", { type: "queue_update" });
	const recorded = getRecentCustomChunks();
	expect(recorded.map((chunk) => chunk.name)).toEqual(["zen.mode", "zen.unmapped"]);
	expect(recorded[0]?.sequence).toBeLessThan(recorded[1]?.sequence ?? 0);
});

test("the record is a ring: beyond capacity the oldest chunks fall off", () => {
	for (let sent = 0; sent < RECENT_CUSTOM_CHUNK_CAPACITY + 5; sent += 1) {
		routeZenCustomEvent("zen.unmapped", { sent });
	}
	const recorded = getRecentCustomChunks();
	expect(recorded).toHaveLength(RECENT_CUSTOM_CHUNK_CAPACITY);
	expect(recorded[0]?.value).toEqual({ sent: 5 });
});

// A model turn is a run of `zen.unmapped` chunks; without the inner type they are
// indistinguishable rows, which is the opposite of what a debug list is for.
test("an unmapped chunk is described by the pi event it carries; a receipt just by its name", () => {
	routeZenCustomEvent("zen.unmapped", { type: "tool_execution_start", toolName: "bash" });
	routeZenCustomEvent("zen.mode", { mode: "plan", available: [] });
	const [unmapped, receipt] = getRecentCustomChunks();
	expect(unmapped && describeChunk(unmapped)).toBe("zen.unmapped (tool_execution_start)");
	expect(receipt && describeChunk(receipt)).toBe("zen.mode");
});

// ── the refetch race (PR #87 review) ─────────────────────────────────────────
// The drawer refetches on open AND on every run settle, so two fetches overlap: the
// mount-time 404 for a thread that has not run yet, and the post-run fetch once a fast
// prompt settles. Whichever was ISSUED last must win, not whichever RESOLVES last.

test("⚠ a request superseded by a later one is dropped even when it resolves last", async () => {
	const pending: Array<{ resolve: (value: string) => void }> = [];
	const fetchLatest = latestWins(
		() =>
			new Promise<string>((resolve) => {
				pending.push({ resolve });
			}),
	);
	const first = fetchLatest();
	const second = fetchLatest();
	// The LATER request settles first, then the earlier one arrives late.
	pending[1]?.resolve("after the run");
	pending[0]?.resolve("nothing has run yet");
	expect(await second).toBe("after the run");
	expect(await first).toBeUndefined();
});

test("a superseded request's failure is dropped too; the latest request's failure still throws", async () => {
	let calls = 0;
	const fetchLatest = latestWins(() => {
		calls += 1;
		return calls === 1 ? Promise.reject(new Error("stale failure")) : Promise.resolve("fresh");
	});
	const stale = fetchLatest();
	const fresh = fetchLatest();
	expect(await fresh).toBe("fresh");
	await expect(stale).resolves.toBeUndefined();
	const onlyFailure = latestWins(() => Promise.reject(new Error("real failure")));
	await expect(onlyFailure()).rejects.toThrow("real failure");
});

test("a non-2xx carries its status as data, not as a prefix to parse", () => {
	const notFound = new InspectionFetchError(404, "no live session for thread t1");
	expect(notFound.status).toBe(404);
	expect(notFound.message).toBe("404 no live session for thread t1");
	expect(notFound).toBeInstanceOf(Error);
});

// A failed copy must not look identical to a successful one.
test("the copy outcome is named beside the button", () => {
	expect(render(believing("plan"), inspection(), undefined, "copied")).toContain("copied");
	expect(render(believing("plan"), inspection(), undefined, "failed")).toContain("copy failed");
	expect(render(believing("plan"), inspection(), undefined, "idle")).not.toContain("copy failed");
});
