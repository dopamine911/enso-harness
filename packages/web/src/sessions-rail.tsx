import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import type { ThreadSummary } from "./thread-stores.ts";

/**
 * The sessions rail (#90 PR 3): which conversation am I in, what else is live on this
 * page, how do I start over. deepseek-harness's left rail is the reference — a title, a
 * relative age, a New session button.
 *
 * ⚠ "LIVE SESSIONS", ON THE LABEL. The rail lists the threads this page minted and nothing
 * else — see `thread-stores.ts` for why the server's list is not its source — and those
 * die with the page. A rail that empties on reload would be confusing if it claimed to be
 * history; it claims to be exactly what it is.
 *
 * Presentational: the list, the active id, and the two callbacks arrive as props, so a
 * static render pins the wording and the active marker without any chat.
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
	/** For the relative ages; injected so a static render is deterministic. */
	readonly now: Date;
	readonly onSelect: (threadId: string) => void;
	readonly onNew: () => void;
}

export function SessionsRail({ threads, activeThreadId, now, onSelect, onNew }: SessionsRailProps): React.ReactNode {
	return (
		<nav aria-label="live sessions" className="flex w-56 shrink-0 flex-col gap-2 border-r p-2">
			<Button type="button" size="sm" variant="outline" onClick={onNew}>
				New session
			</Button>
			<h2 className="px-1 pt-1 font-medium text-muted-foreground text-xs">live sessions</h2>
			<ol className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
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
		</nav>
	);
}
