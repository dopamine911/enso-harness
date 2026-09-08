import type { UIMessage } from "@tanstack/ai-client";
import { createRecentChunksStore, type RecentChunksStore } from "./custom-event-router.ts";
import { createModeLines, type ModeLines } from "./mode-lines.ts";
import { createNotificationsStore, type NotificationsStore } from "./notifications.tsx";
import { createPermissionModeStore, type PermissionModeStore } from "./permission-mode.tsx";
import { createSessionStatsStore, type SessionStatsStore } from "./session-stats.tsx";
import { createStore, type Store } from "./store.ts";

/**
 * Everything the browser knows about one thread beyond its messages (#90 PR 3).
 *
 * ⚠ WHY INSTANCES, NOT MODULE STATE. Until this, every store was a module singleton — one
 * mode, one cost, one notification list per PAGE — which was correct only while a page
 * held exactly one thread. The sessions rail holds several and switches between them; a
 * run in one keeps streaming while another is on screen, and its `zen.usage` must land in
 * ITS cost, not the visible thread's. So each thread gets its own set, created here, and
 * the pane that renders a thread provides them through `ThreadStoresContext`.
 *
 * ⚠ THE PAGE OWNS THE LIST, NOT THE SERVER. The rail lists the threads THIS PAGE minted:
 * only a page-owned chat instance can be switched to, and attaching to a thread some other
 * tab is running — or one from before a server restart — is a resume feature this issue
 * does not build. `GET /api/threads` (#86) stays the inspection view. Threads die with the
 * page; the rail says "live sessions" so that scope is on the label.
 */
export interface ThreadStores {
	readonly threadId: string;
	readonly permissionMode: PermissionModeStore;
	readonly stats: SessionStatsStore;
	readonly notifications: NotificationsStore;
	readonly modeLines: ModeLines;
	readonly recentChunks: RecentChunksStore;
}

function createThreadStores(threadId: string): ThreadStores {
	const notifications = createNotificationsStore();
	return {
		threadId,
		permissionMode: createPermissionModeStore(),
		stats: createSessionStatsStore(),
		notifications,
		modeLines: createModeLines(notifications),
		recentChunks: createRecentChunksStore(),
	};
}

// ── the page's threads ────────────────────────────────────────────────────────

/** What the rail shows for one thread — written by its pane from the chat it owns. */
export interface ThreadSummary {
	readonly threadId: string;
	/** The first user message, or undefined until there is one. */
	readonly title: string | undefined;
	/** When the pane last saw its transcript or in-flight state change. */
	readonly lastActivityAt: Date;
	/** A run is in flight. */
	readonly busy: boolean;
}

const threads = new Map<string, ThreadStores>();
const summaries = new Map<string, ThreadSummary>();
/** Newest first — the order the rail lists them in. Rebuilt on every change so the snapshot is stable between changes. */
const threadList = createStore<readonly ThreadSummary[]>([]);

function publishThreadList(): void {
	threadList.set([...summaries.values()].reverse());
}

/** Mint a new thread on this page and return its stores. The rail lists it at once, untitled. */
export function mintThread(): ThreadStores {
	const stores = createThreadStores(crypto.randomUUID());
	threads.set(stores.threadId, stores);
	summaries.set(stores.threadId, {
		threadId: stores.threadId,
		title: undefined,
		lastActivityAt: new Date(),
		busy: false,
	});
	publishThreadList();
	return stores;
}

/** The stores of a thread this page minted. Looking up an unknown id is a programming error, so it throws. */
export function getThreadStores(threadId: string): ThreadStores {
	const stores = threads.get(threadId);
	if (stores === undefined) throw new Error(`getThreadStores: ${threadId} was not minted on this page`);
	return stores;
}

/** Called by a thread's pane whenever its transcript or in-flight state changes. */
export function updateThreadSummary(threadId: string, patch: Pick<ThreadSummary, "title" | "busy">): void {
	const current = summaries.get(threadId);
	if (current === undefined) return;
	if (current.title === patch.title && current.busy === patch.busy) return;
	summaries.set(threadId, { ...current, ...patch, lastActivityAt: new Date() });
	publishThreadList();
}

export const threadListStore: Store<readonly ThreadSummary[]> = threadList;

/** One line, from the first user message's text — deepseek-harness titles its sessions exactly this way. */
export const TITLE_MAX_CHARS = 60;

export function titleFromMessages(messages: ReadonlyArray<UIMessage>): string | undefined {
	const first = messages.find((message) => message.role === "user");
	if (first === undefined) return undefined;
	const text = first.parts
		.filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.content)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length === 0) return undefined;
	return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text;
}

/** Test seam: forget every thread. Never called from production code. */
export function clearThreadsForTest(): void {
	threads.clear();
	summaries.clear();
	publishThreadList();
}
