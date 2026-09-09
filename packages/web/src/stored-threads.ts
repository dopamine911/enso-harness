import { ZenStoredThread, ZenThreadHistory } from "@zen/core";
import { Check } from "typebox/value";
import { createStore, type Store } from "./store.ts";

/**
 * The sessions a user can come back to (#95): pi's session files for this workspace, as
 * the server lists them. Page-level, not per thread — it is the rail's second list.
 *
 * ⚠ Refreshed on demand, never streamed: page load, and after a run settles (that is when
 * a session file appears or grows). The same rule as the debug drawer (#86): a listing puts
 * no traffic in the trace it describes.
 *
 * ⚠ A failed listing is STATE, not a log line: an empty list and a listing that could not
 * be fetched must not look the same (#29's rule, applied to a list). The rail shows the
 * error where the rows would be; the last good rows are kept beneath it.
 */

export interface StoredThreadsState {
	readonly threads: readonly ZenStoredThread[];
	/** Why the last refresh produced nothing — a down server, a payload off its schema. */
	readonly error: string | undefined;
}

export interface StoredThreadsStore extends Store<StoredThreadsState> {
	readonly refresh: () => Promise<void>;
}

export function createStoredThreadsStore(
	fetchStoredThreads: () => Promise<unknown> = fetchStoredThreadList,
): StoredThreadsStore {
	const store = createStore<StoredThreadsState>({ threads: [], error: undefined });
	return {
		get: store.get,
		subscribe: store.subscribe,
		refresh: async () => {
			try {
				const listed = await fetchStoredThreads();
				const wellFormed = Array.isArray(listed) && listed.every((session) => Check(ZenStoredThread, session));
				if (!wellFormed) throw new Error("the server's session listing did not match its schema");
				store.set({ threads: listed as ZenStoredThread[], error: undefined });
			} catch (error) {
				store.set({ threads: store.get().threads, error: error instanceof Error ? error.message : String(error) });
			}
		},
	};
}

/**
 * A failed response's body as one readable line: its first line, bounded. The dev proxy
 * answers a dead API with Bun's whole HTML error page (#103 receipt, step 8), and quoting
 * it verbatim filled the rail and squeezed the live list out of view — the moment the
 * operator most needed to see which thread they were on. Shared with the debug pane's
 * fetchers, which had the same page in their session column.
 */
export const FAILURE_DETAIL_MAX_LENGTH = 120;
export function boundedFailureDetail(body: string): string {
	const line = body.split("\n", 1)[0]?.trim() ?? "";
	return line.length > FAILURE_DETAIL_MAX_LENGTH ? `${line.slice(0, FAILURE_DETAIL_MAX_LENGTH)}…` : line;
}

/** The status and the bounded body, as one line. */
export async function describeFailedResponse(response: Response): Promise<string> {
	const detail = boundedFailureDetail(await response.text());
	return detail.length === 0 ? String(response.status) : `${response.status} ${detail}`;
}

async function fetchStoredThreadList(): Promise<unknown> {
	const response = await fetch("/api/stored-threads");
	if (!response.ok) throw new Error(await describeFailedResponse(response));
	return response.json();
}

/** A stored thread's history, for `adoptThread`; a non-2xx throws with the status in the message. */
export async function fetchThreadHistory(threadId: string): Promise<ZenThreadHistory> {
	const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/history`);
	if (!response.ok) throw new Error(await describeFailedResponse(response));
	const payload: unknown = await response.json();
	if (!Check(ZenThreadHistory, payload)) throw new Error("the server's history payload did not match its schema");
	return payload;
}

/**
 * The rail's resume clicks, with the LAST click winning — not the first response (PR #104
 * review). Two earlier sessions clicked before the first history arrives would otherwise
 * both apply, so response timing chose the active thread and, with it, where the next
 * prompt went. A superseded response is dropped whole: not applied, its failure not shown.
 * The fetcher is injected so the race is testable with controlled resolution order.
 */
export function createResumeRequests(
	fetchHistory: (threadId: string) => Promise<ZenThreadHistory>,
	onHistory: (history: ZenThreadHistory) => void,
	onFailure: (message: string) => void,
): (threadId: string) => void {
	let latest: string | undefined;
	return (threadId) => {
		latest = threadId;
		fetchHistory(threadId).then(
			(history) => {
				if (latest !== threadId) return;
				latest = undefined;
				onHistory(history);
			},
			(failure: unknown) => {
				if (latest !== threadId) return;
				latest = undefined;
				onFailure(failure instanceof Error ? failure.message : String(failure));
			},
		);
	};
}

/**
 * The rail's second list: stored sessions this page has NOT already got open. The thread id
 * is pi's session id, so "already open here" is a set lookup — the payoff of one identity.
 */
export function storedThreadsNotOnThisPage(
	stored: readonly ZenStoredThread[],
	pageThreadIds: ReadonlySet<string>,
): ZenStoredThread[] {
	return stored.filter((session) => !pageThreadIds.has(session.threadId));
}
