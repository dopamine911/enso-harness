import {
	describeSessionEntry,
	describeThreadEvent,
	persistedPermissionMode,
	type ZenThreadEvent,
	ZenThreadEvents,
	ZenThreadInspection,
} from "@zen/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "typebox/value";
import { Button } from "./components/ui/button.tsx";
import type { RecordedCustomChunk } from "./custom-event-router.ts";
import { type PermissionModeState, usePermissionMode } from "./permission-mode.tsx";
import type { SessionStats } from "./session-stats.tsx";
import { useStore, useThreadStores } from "./store.ts";

/**
 * The session debug drawer (#86): what the BROWSER believes next to what pi's SESSION
 * actually contains, for the current thread, with any disagreement named.
 *
 * Every readout on this surface is derived from the event stream. When one of them was
 * questioned ("how do I know plan mode is enabled?") the honest answer was "you have to
 * assume" — there was no way to see the thing it derived from without reading vendored
 * source and grepping a session file that, for a thread that had only run slash commands,
 * did not exist yet. This drawer is that answer. It reads `GET /api/threads/:threadId`
 * (the in-memory branch, which is what pi acts on — the file is a lagging copy) and puts
 * it beside the module stores and the last chunks the router received.
 *
 * ⚠ Refreshed on demand, not polled: a debugging surface, not a live meter, and a poll
 * would put a request in every trace a human is trying to read.
 *
 * Three modes can disagree, and each disagreement points somewhere different:
 *   • browser store ≠ host        → the stream or the store dropped a receipt;
 *   • host ≠ branch's last entry  → the host's walk is wrong (a picc shape change).
 * Both are named as MISMATCH in text, not colour alone, so a test — and a screen reader —
 * can see them.
 */

export interface BrowserBelief {
	readonly mode: PermissionModeState;
	readonly stats: SessionStats;
	readonly recentChunks: readonly RecordedCustomChunk[];
	/** The acquisition this page's last run held (`zen.run`, #109); undefined before a run. */
	readonly generation: number | undefined;
}

/**
 * What a difference between the two run numbers means, in words — or undefined when they
 * agree or cannot be compared yet (#109). The server's number moves on every acquisition
 * of the thread; this page's moves only with its own runs. So a server ahead of the page
 * is a run made elsewhere; a page ahead of the server can only be a server that restarted
 * (its count begins again) — and either is the wrong-session class of bug made visible.
 */
export function describeGenerationDrift(browser: number | undefined, server: number | undefined): string | undefined {
	if (browser === undefined || server === undefined || browser === server) return undefined;
	if (server > browser) {
		const runs = server - browser;
		return `server is at run #${server} — ${runs} run${runs === 1 ? "" : "s"} this page did not make (another tab or client)`;
	}
	return `server is at run #${server}, behind this page — the server restarted since this page's last run`;
}

export interface SessionDebugViewProps {
	readonly threadId: string;
	readonly browser: BrowserBelief;
	/** The server's answer, or undefined before the first refresh. */
	readonly session: ZenThreadInspection | undefined;
	/** The thread's two event tails (#97), fetched alongside the inspection; undefined before the first refresh. */
	readonly events: ZenThreadEvents | undefined;
	/** Why the last refresh produced nothing — a 404 for a thread that has not run yet, a down server. */
	readonly error: string | undefined;
	/** The last copy's outcome; the label beside the button says which. */
	readonly copyState: CopyState;
	readonly onRefresh: () => void;
	readonly onCopy: () => void;
}

/**
 * A chunk's name, plus the inner `type` its value carries when there is one. The case that
 * needs it is `zen.unmapped` — pi's raw event, and a model turn produces a run of them (tool
 * starts, thinking, message ends) that read as identical rows without it. It is not special-
 * cased to that name: a `zen.entry` value is a session entry with a `type` too, and reads as
 * `zen.entry (custom)`, which is just as useful.
 */
export function describeChunk(chunk: RecordedCustomChunk): string {
	const value = chunk.value;
	if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
		return chunk.name;
	}
	return `${chunk.name} (${value.type})`;
}

/**
 * pi guarantees every session entry an `id`; read defensively. A malformed entry without one
 * keys by its position in the branch — two such entries in the same second with the same type
 * would otherwise collide on the description and React would reuse the wrong row (PR #87 review).
 */
function entryKey(entry: unknown, position: number): string {
	if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string") return entry.id;
	return `${position}:${describeSessionEntry(entry)}`;
}

function Mismatch({ when, says }: { when: boolean; says: string }): React.ReactNode {
	if (!when) return null;
	return (
		<span className="ml-2 rounded bg-destructive px-1 font-semibold text-destructive-foreground">MISMATCH: {says}</span>
	);
}

function EventTailList({ events }: { events: readonly ZenThreadEvent[] }): React.ReactNode {
	if (events.length === 0) return <div>nothing yet</div>;
	return (
		<ol>
			{events.map((event) => (
				<li key={event.sequence} className={event.provenance === "dropped" ? "text-destructive" : ""}>
					{describeThreadEvent(event)}
				</li>
			))}
		</ol>
	);
}

export function SessionDebugView({
	threadId,
	browser,
	session,
	events,
	error,
	copyState,
	onRefresh,
	onCopy,
}: SessionDebugViewProps): React.ReactNode {
	const browserMode = browser.mode.mode ?? "unknown";
	const hostMode = session?.permissionMode.mode;
	const branchMode = session === undefined ? undefined : persistedPermissionMode(session.entries);
	const generationDrift = describeGenerationDrift(browser.generation, session?.generation);
	return (
		<aside aria-label="session debug" className="flex flex-col gap-3 p-3 font-mono text-muted-foreground text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-semibold text-foreground">session debug</span>
				<span className="flex gap-1">
					<Button type="button" size="sm" variant="outline" onClick={onRefresh}>
						refresh
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={onCopy}>
						copy as JSON
					</Button>
					{copyState === "copied" ? <span role="status">copied</span> : null}
					{copyState === "failed" ? (
						<span role="status" className="text-destructive">
							copy failed — clipboard needs a secure context or permission
						</span>
					) : null}
				</span>
				<span className="w-full break-all">thread {threadId}</span>
			</div>
			<div className="flex flex-col gap-3">
				<section>
					<h3 className="font-semibold text-foreground">browser believes</h3>
					<div>
						mode: {browserMode}
						<Mismatch when={hostMode !== undefined && hostMode !== browserMode} says={`host says ${hostMode}`} />
					</div>
					<div>available: {browser.mode.available.join(", ") || "(none yet)"}</div>
					<div>
						last run: {browser.generation === undefined ? "none from this page" : `#${browser.generation}`}
						<Mismatch when={generationDrift !== undefined} says={generationDrift ?? ""} />
					</div>
					<div>
						stats: {browser.stats.countedMessages} counted, cost ${browser.stats.totalCost.toFixed(4)}
					</div>
					<h4 className="mt-1 text-foreground">last {browser.recentChunks.length} CUSTOM chunks</h4>
					<ol>
						{browser.recentChunks.map((chunk) => (
							<li key={chunk.sequence}>
								{chunk.receivedAt.slice(11, 19)} {describeChunk(chunk)}
							</li>
						))}
					</ol>
				</section>
				<section>
					<h3 className="font-semibold text-foreground">pi's session has</h3>
					{error !== undefined ? <div className="text-destructive">{error}</div> : null}
					{session === undefined ? (
						<div>{error === undefined ? "not fetched yet — press refresh" : null}</div>
					) : (
						<>
							<div className="break-all">session {session.sessionId}</div>
							<div className="break-all">cwd {session.cwd}</div>
							<div className="break-all">dir {session.sessionDir}</div>
							<div className="break-all">
								file{" "}
								{session.sessionFile ?? (
									<span title="pi flushes a session to disk only after its first assistant message; until then the branch below is the only copy">
										in memory, not flushed yet
									</span>
								)}
							</div>
							<div>
								host mode: {hostMode}
								<Mismatch when={branchMode !== hostMode} says={`branch says ${branchMode}`} />
							</div>
							<div>branch mode: {branchMode}</div>
							<div>
								{session.busy ? "busy" : "idle"}
								{session.parked ? ", dialog parked" : ""}, run #{session.generation}, last activity{" "}
								{session.lastActivityAt.slice(11, 19)}
							</div>
							<div>commands: {session.commands.map((command) => `/${command}`).join(" ")}</div>
							<h4 className="mt-1 text-foreground">branch ({session.entries.length} entries)</h4>
							<ol>
								{session.entries.map((entry, position) => (
									<li key={entryKey(entry, position)}>{describeSessionEntry(entry)}</li>
								))}
							</ol>
						</>
					)}
				</section>
				{/* The event tails (#97): the ordering view. `emitted` is what the host's funnel saw,
				    with how each was delivered; `sent` is what the server wrote to this browser.
				    A disagreement with the two sections above names the layer a bug lives in. */}
				<section>
					<h3 className="font-semibold text-foreground">the host emitted</h3>
					{events === undefined ? <div>not fetched yet</div> : <EventTailList events={events.emitted} />}
					<h3 className="mt-2 font-semibold text-foreground">the server sent</h3>
					{events === undefined ? <div>not fetched yet</div> : <EventTailList events={events.sent} />}
				</section>
			</div>
		</aside>
	);
}

/** A non-2xx from the inspection endpoint, with the status as data — not a prefix to parse out of a message. */
export class InspectionFetchError extends Error {
	constructor(
		readonly status: number,
		detail: string,
	) {
		super(`${status} ${detail}`);
		this.name = "InspectionFetchError";
	}
}

/** Fetches one thread's inspection; a non-2xx becomes an `InspectionFetchError`. */
export async function fetchThreadInspection(threadId: string): Promise<ZenThreadInspection> {
	const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`);
	if (!response.ok) throw new InspectionFetchError(response.status, await response.text());
	const payload: unknown = await response.json();
	if (!Check(ZenThreadInspection, payload)) throw new Error("the server's inspection payload did not match its schema");
	return payload;
}

/** Fetches one thread's event tails (#97); the same 404 rule as the inspection. */
export async function fetchThreadEvents(threadId: string): Promise<ZenThreadEvents> {
	const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/events`);
	if (!response.ok) throw new InspectionFetchError(response.status, await response.text());
	const payload: unknown = await response.json();
	if (!Check(ZenThreadEvents, payload)) throw new Error("the server's events payload did not match its schema");
	return payload;
}

/** One refresh = both payloads, so the three columns describe the same moment. */
async function fetchThreadDebug(threadId: string): Promise<{ session: ZenThreadInspection; events: ZenThreadEvents }> {
	const [session, events] = await Promise.all([fetchThreadInspection(threadId), fetchThreadEvents(threadId)]);
	return { session, events };
}

/** What a 404 means here: nothing has run on this thread yet, which is information, not a failure. */
export const NO_SESSION_YET = "no live session yet — nothing has run on this thread";

/**
 * Only the LATEST request's outcome may be applied (PR #87 review). The drawer refetches
 * on open and on every run settle, so two fetches can be in flight at once — the mount-time
 * 404 for a thread that has not run yet, and the post-run fetch once a fast prompt settles.
 * Without this, whichever resolves LAST wins regardless of which was ISSUED last, and a
 * drawer built to catch inconsistency would briefly show "nothing has run" after a run.
 *
 * Returns a wrapper: each call issues a fresh request and resolves only if no later call has
 * been made by the time it settles; a superseded result resolves `undefined` and is dropped.
 */
export function latestWins<T>(issue: () => Promise<T>): () => Promise<T | undefined> {
	let latest = 0;
	return async (): Promise<T | undefined> => {
		latest += 1;
		const mine = latest;
		const outcome = await issue().then(
			(value) => ({ value, failure: undefined }),
			(failure: unknown) => ({ value: undefined, failure: failure ?? new Error("rejected without a reason") }),
		);
		if (mine !== latest) return undefined;
		if (outcome.failure !== undefined) throw outcome.failure;
		return outcome.value;
	};
}

export interface SessionDebugDrawerProps {
	/** The chat's `isLoading`: the drawer refetches when this turns false, i.e. when a run settles. */
	readonly runInFlight: boolean;
}

/** The clipboard call's outcome, so a failed copy does not look identical to a successful one. */
export type CopyState = "idle" | "copied" | "failed";

/**
 * The drawer wired to the stores, the router's record, and the server. Mounted by `?debug`.
 *
 * Refetches on open and each time a run SETTLES — that is the moment the session changed
 * and a human wants to compare — plus on demand. Not polled: a debugging surface should
 * put no request in the trace a human is trying to read. Opening it on a fresh thread
 * reads "nothing has run yet", the honest state, rather than an error.
 */
export function SessionDebugDrawer({ runInFlight }: SessionDebugDrawerProps): React.ReactNode {
	const stores = useThreadStores();
	const { threadId } = stores;
	const mode = usePermissionMode();
	const stats = useStore(stores.stats);
	const recentChunks = useStore(stores.recentChunks);
	const generation = useStore(stores.generation);
	const [session, setSession] = useState<ZenThreadInspection | undefined>(undefined);
	const [events, setEvents] = useState<ZenThreadEvents | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const browser: BrowserBelief = { mode, stats, recentChunks, generation };
	// One sequencer per thread id: a new thread starts a new "latest".
	const fetchLatest = useMemo(() => latestWins(() => fetchThreadDebug(threadId)), [threadId]);
	const refresh = useCallback((): void => {
		fetchLatest().then(
			(fetched) => {
				if (fetched === undefined) return; // superseded by a later refresh
				setSession(fetched.session);
				setEvents(fetched.events);
				setError(undefined);
			},
			(failure: unknown) => {
				setSession(undefined);
				setEvents(undefined);
				if (failure instanceof InspectionFetchError && failure.status === 404) {
					setError(NO_SESSION_YET);
					return;
				}
				setError(failure instanceof Error ? failure.message : String(failure));
			},
		);
	}, [fetchLatest]);
	useEffect(() => {
		if (!runInFlight) refresh();
	}, [runInFlight, refresh]);
	const copy = (): void => {
		navigator.clipboard.writeText(JSON.stringify({ threadId, browser, session, events }, null, 2)).then(
			() => setCopyState("copied"),
			() => setCopyState("failed"),
		);
	};
	return (
		<SessionDebugView
			threadId={threadId}
			browser={browser}
			session={session}
			events={events}
			error={error}
			copyState={copyState}
			onRefresh={refresh}
			onCopy={copy}
		/>
	);
}
