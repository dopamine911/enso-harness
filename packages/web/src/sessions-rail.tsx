import type { ZenResumableSession } from "@zen/core";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import type { ThreadSummary } from "./thread-stores.ts";

/**
 * The sessions rail (#90 PR 3): which conversation am I in, what else is live on this
 * page, how do I start over. deepseek-harness's left rail is the reference — a title, a
 * relative age, a New session button.
 *
 * Two lists, each labelled for what it is. "LIVE SESSIONS": the threads this page has open
 * — they die with the page. "EARLIER SESSIONS" (#95): pi's session files for this
 * workspace that this page has not got open; a click resumes one, with its history and
 * its mode, under the same id — the thread id IS pi's session id. A session another page
 * is RUNNING right now (a run in flight, a dialog parked) is shown but not clickable:
 * two pages must not drive one pi session at once. Idle is resumable, even when this
 * server still holds it — a reload must get its own session back (PR #104 review).
 *
 * Presentational: the lists, the active id, and the callbacks arrive as props, so a static
 * render pins the wording and the active marker without any chat.
 */

/** `now`, `12s`, `3m`, `2h`, `6d` — deepseek's form, one unit, no "ago". */
export function relativeAge(from: Date, now: Date): string {
	const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** What an untitled thread reads as — a thread that has not been asked anything yet. */
export const UNTITLED_SESSION = "new session";

export interface SessionsRailProps {
	readonly threads: readonly ThreadSummary[];
	readonly activeThreadId: string;
	/** Stored sessions not open on this page, newest first — already filtered by the caller. */
	readonly earlier: readonly ZenResumableSession[];
	/** Why the earlier list could not be fetched, or undefined. Shown where the rows would be. */
	readonly earlierError: string | undefined;
	/** For the relative ages; injected so a static render is deterministic. */
	readonly now: Date;
	readonly onSelect: (threadId: string) => void;
	readonly onResume: (threadId: string) => void;
	readonly onNew: () => void;
}

/** One stored session's row: title, age, and — when another page is running it — why it cannot be clicked. */
function EarlierSessionRow({
	session,
	now,
	onResume,
}: {
	session: ZenResumableSession;
	now: Date;
	onResume: (threadId: string) => void;
}): React.ReactNode {
	const at = new Date(session.lastActivityAt);
	return (
		<li>
			<button
				type="button"
				disabled={session.busy}
				title={session.busy ? "running in another tab — resumable once that run settles" : at.toLocaleString()}
				onClick={() => onResume(session.threadId)}
				className={cn(
					"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground text-xs",
					session.busy ? "cursor-not-allowed opacity-60" : "hover:bg-muted",
				)}
			>
				{session.busy ? (
					<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground">
						<span className="sr-only">running in another tab</span>
					</span>
				) : null}
				<span className={cn("min-w-0 flex-1 truncate", session.title === undefined ? "italic" : "")}>
					{session.title ?? UNTITLED_SESSION}
				</span>
				<span className="shrink-0 tabular-nums">{relativeAge(at, now)}</span>
			</button>
		</li>
	);
}

export function SessionsRail({
	threads,
	activeThreadId,
	earlier,
	earlierError,
	now,
	onSelect,
	onResume,
	onNew,
}: SessionsRailProps): React.ReactNode {
	return (
		<nav aria-label="sessions" className="flex w-56 shrink-0 flex-col gap-2 border-r p-2">
			<Button type="button" size="sm" variant="outline" onClick={onNew}>
				New session
			</Button>
			<h2 className="px-1 pt-1 font-medium text-muted-foreground text-xs">live sessions</h2>
			<ol aria-label="live sessions" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
				{threads.map((thread) => {
					const active = thread.threadId === activeThreadId;
					return (
						<li key={thread.threadId}>
							<button
								type="button"
								aria-current={active ? "true" : undefined}
								onClick={() => onSelect(thread.threadId)}
								className={cn(
									"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
									active ? "bg-muted text-foreground" : "text-muted-foreground",
								)}
							>
								{/* The busy dot is the status bar's, at rail size: a run is in flight there. */}
								{thread.busy ? (
									<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground">
										<span className="sr-only">running</span>
									</span>
								) : null}
								<span className={cn("min-w-0 flex-1 truncate", thread.title === undefined ? "italic" : "")}>
									{thread.title ?? UNTITLED_SESSION}
								</span>
								<span className="shrink-0 tabular-nums" title={thread.lastActivityAt.toLocaleString()}>
									{relativeAge(thread.lastActivityAt, now)}
								</span>
							</button>
						</li>
					);
				})}
			</ol>
			<h2 className="px-1 pt-1 font-medium text-muted-foreground text-xs">earlier sessions</h2>
			{earlierError !== undefined ? (
				<div role="alert" className="px-2 text-destructive text-xs">
					could not list sessions: {earlierError}
				</div>
			) : null}
			<ol aria-label="earlier sessions" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
				{earlier.length === 0 && earlierError === undefined ? (
					<li className="px-2 py-1.5 text-muted-foreground text-xs italic">none yet</li>
				) : null}
				{earlier.map((session) => (
					<EarlierSessionRow key={session.threadId} session={session} now={now} onResume={onResume} />
				))}
			</ol>
		</nav>
	);
}
