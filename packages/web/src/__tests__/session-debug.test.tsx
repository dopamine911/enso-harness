import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ZenThreadEvent, ZenThreadEvents, ZenThreadInspection } from "@zen/core";
import { renderToStaticMarkup } from "react-dom/server";
import { RECENT_CUSTOM_CHUNK_CAPACITY, routeZenCustomEvent } from "../custom-event-router.ts";
import {
	type BrowserBelief,
	type CopyState,
	describeChunk,
	InspectionFetchError,
	latestWins,
	NO_SESSION_YET,
	SessionDebugView,
} from "../session-debug.tsx";
import { clearThreadsForTest, mintThread, type ThreadStores } from "../thread-stores.ts";

/**
 * #86: the drawer's one job is to NAME a disagreement between what the browser believes
 * and what pi's session holds. These render it statically with each disagreement injected
 * and assert the word MISMATCH appears — or does not — as text, the way a human or a
 * screen reader would see it. The fetch wiring is covered by the live receipt.
 */

let stores: ThreadStores;
beforeEach(() => {
	stores = mintThread();
});
afterEach(() => clearThreadsForTest());

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
		generation: 1,
		lastActivityAt: "2026-09-08T10:00:05.000Z",
		entries: [
			{ type: "session", id: "root", parentId: null, timestamp: "2026-09-08T10:00:00.000Z" },
			piccEntry("plan", "m1"),
		],
		...overrides,
	};
}

function believing(mode: string | undefined, generation: number | undefined = 1): BrowserBelief {
	return {
		mode: { mode, available: ["default", "plan"] },
		stats: { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 },
		recentChunks: [],
		generation,
	};
}

const render = (
	browser: BrowserBelief,
	session: ZenThreadInspection | undefined,
	error?: string,
	copyState: CopyState = "idle",
): string => renderWith({ browser, session, error, copyState });

interface RenderOverrides {
	readonly browser: BrowserBelief;
	readonly session: ZenThreadInspection | undefined;
	readonly error?: string | undefined;
	readonly copyState?: CopyState;
	readonly events?: ZenThreadEvents;
}

const renderWith = ({ browser, session, error, copyState = "idle", events }: RenderOverrides): string =>
	renderToStaticMarkup(
		<SessionDebugView
			threadId="t1"
			browser={browser}
			session={session}
			events={events}
			error={error}
			copyState={copyState}
			onRefresh={noop}
			onCopy={noop}
		/>,
	);

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

// The run fence (#109): the page's last run number against the server's current one.
test("⚠ a server ahead of this page's last run is named as a MISMATCH — a run this page did not make", () => {
	const rendered = render(believing("plan", 1), inspection({ generation: 3 }));
	expect(rendered).toContain("last run: #1");
	expect(rendered).toContain("MISMATCH: server is at run #3 — 2 runs this page did not make");
	expect(rendered).toContain("run #3");
});

test("⚠ a server BEHIND this page's last run is named as a restart", () => {
	const rendered = render(believing("plan", 4), inspection({ generation: 2 }));
	expect(rendered).toContain("MISMATCH: server is at run #2, behind this page — the server restarted");
});

test("no run yet on this page compares nothing: no MISMATCH, and it says so", () => {
	const rendered = render({ ...believing("plan"), generation: undefined }, inspection({ generation: 2 }));
	expect(rendered).toContain("last run: none from this page");
	expect(rendered).not.toContain("MISMATCH");
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
	routeZenCustomEvent(stores, "zen.mode", { mode: "default", available: [] });
	routeZenCustomEvent(stores, "zen.unmapped", { type: "some_future_event" });
	const recorded = stores.recentChunks.get();
	expect(recorded.map((chunk) => chunk.name)).toEqual(["zen.mode", "zen.unmapped"]);
	expect(recorded[0]?.sequence).toBeLessThan(recorded[1]?.sequence ?? 0);
});

test("the record is a ring: beyond capacity the oldest chunks fall off", () => {
	for (let sent = 0; sent < RECENT_CUSTOM_CHUNK_CAPACITY + 5; sent += 1) {
		routeZenCustomEvent(stores, "zen.unmapped", { sent });
	}
	const recorded = stores.recentChunks.get();
	expect(recorded).toHaveLength(RECENT_CUSTOM_CHUNK_CAPACITY);
	expect(recorded[0]?.value).toEqual({ sent: 5 });
});

// A model turn is a run of `zen.unmapped` chunks; without the inner type they are
// indistinguishable rows, which is the opposite of what a debug list is for.
test("an unmapped chunk is described by the pi event it carries; a receipt just by its name", () => {
	routeZenCustomEvent(stores, "zen.unmapped", { type: "tool_execution_start", toolName: "bash" });
	routeZenCustomEvent(stores, "zen.mode", { mode: "plan", available: [] });
	const [unmapped, receipt] = stores.recentChunks.get();
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

// ── the event tails (#97): the ordering view ────────────────────────────────────

function threadEvent(overrides: Partial<ZenThreadEvent>): ZenThreadEvent {
	return {
		sequence: 1,
		type: "entry_appended",
		provenance: "live",
		at: "2026-09-08T12:34:56.000Z",
		count: 1,
		...overrides,
	};
}

test("both tails render under their own heading; a dropped event is marked as a failure", () => {
	const events: ZenThreadEvents = {
		threadId: "t1",
		emitted: [threadEvent({ provenance: "dropped", type: "notify" })],
		sent: [threadEvent({ provenance: "sent", type: "RUN_FINISHED" })],
	};
	const rendered = renderWith({ browser: believing("plan"), session: inspection(), events });
	expect(rendered).toContain("the host emitted");
	expect(rendered).toContain("the server sent");
	expect(rendered).toContain("dropped notify");
	expect(rendered).toContain("sent RUN_FINISHED");
	expect(rendered).toMatch(/text-destructive[^>]*>[^<]*dropped notify/);
	// Before the first refresh the tails say so, rather than rendering as an empty thread.
	expect(render(believing("plan"), inspection())).toContain("not fetched yet");
});
