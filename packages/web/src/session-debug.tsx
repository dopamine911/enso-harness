import { PICC_DEFAULT_PERMISSION_MODE, readPiccPersistedMode, ZenThreadInspection } from "@zen/core";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check } from "typebox/value";
import { Button } from "./components/ui/button.tsx";
import { getRecentCustomChunks, type RecordedCustomChunk } from "./custom-event-router.ts";
import { type PermissionModeState, usePermissionMode } from "./permission-mode.tsx";
import { getSessionStatsSnapshot, type SessionStats, subscribeToSessionStats } from "./session-stats.tsx";

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
}

export interface SessionDebugViewProps {
	readonly threadId: string;
	readonly browser: BrowserBelief;
	/** The server's answer, or undefined before the first refresh. */
	readonly session: ZenThreadInspection | undefined;
	/** Why the last refresh produced nothing — a 404 for a thread that has not run yet, a down server. */
	readonly error: string | undefined;
	/** The last copy's outcome; the label beside the button says which. */
	readonly copyState: CopyState;
	readonly onRefresh: () => void;
	readonly onCopy: () => void;
}

/** The mode the branch's LAST picc `modes` entry carries — picc's own restore rule — else the initial default. */
export function lastPersistedMode(entries: readonly unknown[]): string {
	for (let position = entries.length - 1; position >= 0; position -= 1) {
		const entry = entries[position];
		if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "custom") continue;
		const mode = readPiccPersistedMode(entry);
		if (mode !== undefined) return mode;
	}
	return PICC_DEFAULT_PERMISSION_MODE;
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
	return `${position}:${describeEntry(entry)}`;
}

/** One entry of the branch, read defensively: pi's shapes are carried, not modelled. */
function describeEntry(entry: unknown): string {
	if (typeof entry !== "object" || entry === null) return String(entry);
	const fields = entry as { type?: unknown; customType?: unknown; timestamp?: unknown; message?: unknown };
	const kind = typeof fields.type === "string" ? fields.type : "?";
	const custom = typeof fields.customType === "string" ? `:${fields.customType}` : "";
	const role =
		typeof fields.message === "object" && fields.message !== null && "role" in fields.message
			? ` ${String(fields.message.role)}`
			: "";
	const when = typeof fields.timestamp === "string" ? fields.timestamp.slice(11, 19) : "";
	return `${when} ${kind}${custom}${role}`.trim();
}

function Mismatch({ when, says }: { when: boolean; says: string }): React.ReactNode {
	if (!when) return null;
	return (
		<span className="ml-2 rounded bg-destructive px-1 font-semibold text-destructive-foreground">MISMATCH: {says}</span>
	);
}

export function SessionDebugView({
	threadId,
	browser,
	session,
	error,
	copyState,
	onRefresh,
	onCopy,
}: SessionDebugViewProps): React.ReactNode {
	const browserMode = browser.mode.mode ?? "unknown";
	const hostMode = session?.permissionMode.mode;
	const branchMode = session === undefined ? undefined : lastPersistedMode(session.entries);
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
								{session.parked ? ", dialog parked" : ""}, last activity {session.lastActivityAt.slice(11, 19)}
							</div>
							<div>commands: {session.commands.map((command) => `/${command}`).join(" ")}</div>
							<h4 className="mt-1 text-foreground">branch ({session.entries.length} entries)</h4>
							<ol>
								{session.entries.map((entry, position) => (
									<li key={entryKey(entry, position)}>{describeEntry(entry)}</li>
								))}
							</ol>
						</>
					)}
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
	readonly threadId: string;
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
export function SessionDebugDrawer({ threadId, runInFlight }: SessionDebugDrawerProps): React.ReactNode {
	const mode = usePermissionMode();
	const stats = useSyncExternalStore(subscribeToSessionStats, getSessionStatsSnapshot, getSessionStatsSnapshot);
	const [session, setSession] = useState<ZenThreadInspection | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [copyState, setCopyState] = useState<CopyState>("idle");
	const browser: BrowserBelief = { mode, stats, recentChunks: getRecentCustomChunks() };
	// One sequencer per thread id: a new thread starts a new "latest".
	const fetchLatest = useMemo(() => latestWins(() => fetchThreadInspection(threadId)), [threadId]);
	const refresh = useCallback((): void => {
		fetchLatest().then(
			(fetched) => {
				if (fetched === undefined) return; // superseded by a later refresh
				setSession(fetched);
				setError(undefined);
			},
			(failure: unknown) => {
				setSession(undefined);
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
		navigator.clipboard.writeText(JSON.stringify({ threadId, browser, session }, null, 2)).then(
			() => setCopyState("copied"),
			() => setCopyState("failed"),
		);
	};
	return (
		<SessionDebugView
			threadId={threadId}
			browser={browser}
			session={session}
			error={error}
			copyState={copyState}
			onRefresh={refresh}
			onCopy={copy}
		/>
	);
}
