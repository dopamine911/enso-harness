import { ZenNotifyType, ZenUiRequestOrigin } from "@zen/core";
import { Check } from "typebox/value";
import {
	ZEN_CUSTOM_EVENT_ENTRY,
	ZEN_CUSTOM_EVENT_MODE,
	ZEN_CUSTOM_EVENT_NOTIFY,
	ZEN_CUSTOM_EVENT_USAGE,
} from "./rpc/custom-event-names.ts";
import { createStore, type Store } from "./store.ts";
import type { ThreadStores } from "./thread-stores.ts";

/**
 * The browser's ONE path from an AG-UI CUSTOM chunk to a thread's stores (mode lines,
 * current mode, session stats, notifications, the debug record). TanStack's
 * `onCustomEvent` fires this with `(chunk.name, chunk.value)` for every CUSTOM chunk —
 * verified against its stream processor (#29).
 *
 * ⚠ THE THREAD COMES FROM THE CALLER, NOT THE CHUNK. TanStack hands `onCustomEvent` only
 * `(name, value, { toolCallId })` — no thread id — and the option is bound per chat
 * factory. So each thread's pane builds its own factory whose `onCustomEvent` closes over
 * that thread's stores (#90 PR 3); a chunk can never be attributed to the wrong thread
 * because the callback that receives it belongs to exactly one.
 *
 * Extracted from `chat-screen.tsx`'s chat options so it can be TESTED (#53 S1.3): as an
 * inline closure on an options object, renaming a chunk name, dropping the notify-type
 * allowlist, or swapping two `apply*` calls all left the suite green. The tests drive this
 * function directly with a fresh set of stores and read their snapshots.
 *
 * ⚠ Every value is read defensively, the way every wire crossing in the browser is: a
 * malformed value renders as nothing rather than throwing inside TanStack's stream loop,
 * where a throw would end the run. Chunk names this surface does not render
 * (`zen.unmapped`) fall through untouched — see the mapper for why they exist at all.
 */
export function routeZenCustomEvent(stores: ThreadStores, eventType: string, data: unknown): void {
	stores.recentChunks.record(eventType, data);
	if (eventType === ZEN_CUSTOM_EVENT_ENTRY) {
		// One persisted entry, two views (#84): the transcript line (history) and the
		// current-mode store (state). Both read picc's shape through the same core helper.
		stores.modeLines.apply(data);
		stores.permissionMode.applyPersistedEntry(data);
		return;
	}
	if (eventType === ZEN_CUSTOM_EVENT_MODE) {
		stores.permissionMode.applyReceipt(data);
		return;
	}
	if (eventType === ZEN_CUSTOM_EVENT_USAGE) {
		stores.stats.applyUsage(data);
		return;
	}
	if (eventType !== ZEN_CUSTOM_EVENT_NOTIFY) return;
	if (typeof data !== "object" || data === null) return;
	const observation = data as { message?: unknown; notifyType?: unknown; origin?: unknown };
	if (typeof observation.message !== "string") return;
	// The three declared notify types come from the schema, not a second literal list: an
	// unrecognised value degrades to an untyped notification, never a validation failure.
	const notifyType = Check(ZenNotifyType, observation.notifyType) ? observation.notifyType : undefined;
	// An unreadable origin degrades to `run` — the OPEN rendering (#96): when the tag cannot
	// be trusted, a notice is shown, never grouped away.
	const origin = Check(ZenUiRequestOrigin, observation.origin) ? observation.origin : "run";
	stores.notifications.push(observation.message, notifyType, origin);
}

// ── the last N chunks, for the debug drawer (#86) ─────────────────────────────
// The router is the ONE path every CUSTOM chunk crosses, which makes it the honest place
// to keep "what the browser was actually told". A fixed-size ring per thread: old chunks
// fall off the front, and a long session costs nothing extra.

export interface RecordedCustomChunk {
	/** Monotonic per thread — the chunk's identity, since name + time can collide. */
	readonly sequence: number;
	readonly name: string;
	readonly value: unknown;
	/** ISO 8601, when the router saw it. */
	readonly receivedAt: string;
}

/** Enough to see a whole run's worth (a receipt, a few entries, usage) without scrolling. */
export const RECENT_CUSTOM_CHUNK_CAPACITY = 50;

export interface RecentChunksStore extends Store<readonly RecordedCustomChunk[]> {
	readonly record: (name: string, value: unknown) => void;
}

/** Oldest first; the snapshot is a fresh array per record, so a consumer cannot mutate the ring. */
export function createRecentChunksStore(): RecentChunksStore {
	const store = createStore<readonly RecordedCustomChunk[]>([]);
	let nextSequence = 0;
	return {
		get: store.get,
		subscribe: store.subscribe,
		record: (name, value) => {
			nextSequence += 1;
			const appended = [...store.get(), { sequence: nextSequence, name, value, receivedAt: new Date().toISOString() }];
			store.set(appended.slice(-RECENT_CUSTOM_CHUNK_CAPACITY));
		},
	};
}
