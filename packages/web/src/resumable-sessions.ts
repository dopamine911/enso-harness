import { ZenResumableSession, ZenThreadHistory } from "@zen/core";
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

export interface ResumableSessionsState {
	readonly sessions: readonly ZenResumableSession[];
	/** Why the last refresh produced nothing — a down server, a payload off its schema. */
	readonly error: string | undefined;
}

export interface ResumableSessionsStore extends Store<ResumableSessionsState> {
	readonly refresh: () => Promise<void>;
}

export function createResumableSessionsStore(
	fetchSessions: () => Promise<unknown> = fetchSessionList,
): ResumableSessionsStore {
	const store = createStore<ResumableSessionsState>({ sessions: [], error: undefined });
	return {
		get: store.get,
		subscribe: store.subscribe,
		refresh: async () => {
			try {
				const listed = await fetchSessions();
				const wellFormed = Array.isArray(listed) && listed.every((session) => Check(ZenResumableSession, session));
				if (!wellFormed) throw new Error("the server's session listing did not match its schema");
				store.set({ sessions: listed as ZenResumableSession[], error: undefined });
			} catch (error) {
				store.set({ sessions: store.get().sessions, error: error instanceof Error ? error.message : String(error) });
			}
		},
	};
}

async function fetchSessionList(): Promise<unknown> {
	const response = await fetch("/api/sessions");
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	return response.json();
}

/** A stored thread's history, for `adoptThread`; a non-2xx throws with the status in the message. */
export async function fetchThreadHistory(threadId: string): Promise<ZenThreadHistory> {
	const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/history`);
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
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
export function sessionsNotOnThisPage(
	stored: readonly ZenResumableSession[],
	pageThreadIds: ReadonlySet<string>,
): ZenResumableSession[] {
	return stored.filter((session) => !pageThreadIds.has(session.threadId));
}
