import type { UIMessage } from "@tanstack/ai-client";
import { automaticPartsForMessage, selectChatUI } from "@tanstack/ai-client/ui";
import { useSyncExternalStore } from "react";
import { getSessionStatsSnapshot, type SessionStats, subscribeToSessionStats } from "./session-stats.tsx";

/**
 * The status bar (#90 PR 1): the always-on line that says what this session is doing and
 * what it has cost, so the answer to "is anything happening?" is a glance, not a prompt.
 * deepseek-harness's footer is the reference: `97 turns · 111 steps · LLM 23m5s · …` — the
 * bar is WHERE YOU LOOK, so it is always there.
 *
 * ⚠ ALWAYS VISIBLE, ZEROS INCLUDED. `SessionStatsBar` (#45) hid until the first counted
 * request so an all-zero line would not read as a broken meter. That was the wrong call for
 * a bar whose job is to be the place you look: a fresh session reading `idle · 0 turns ·
 * $0.0000` is the honest state, the same reasoning that put `default` in the mode dropdown
 * before the first prompt (#84 round 2). A bar that appears only after the first request is
 * a bar you never learn to look at.
 *
 * ⚠ EVERYTHING HERE IS DERIVED FROM STATE THE PAGE ALREADY HOLDS — no new wire. Activity
 * from `chat.isLoading` and the shape of the last message; counts from the message list;
 * cost and prompt size from the `zen.usage` store (session-stats.tsx). Timing — LLM time,
 * TTFT, tok/s — is NOT on the wire and is not invented here; the host would have to stamp
 * events. That is a later slice of #90, named there.
 *
 * ⓘ No `role="status"`/live region, deliberately (PR #51 review, nit 3): this is a
 * persistent readout that changes on every delta, and a live region would interrupt a
 * screen reader continuously. The numbers stay poll-able, never announced; the send/stop
 * button already carries the in-flight state to assistive tech.
 */

/** What the run is doing right now, as far as the page can tell from the transcript. */
export type Activity =
	| { readonly kind: "idle" }
	/** A run is in flight but nothing has streamed yet, or the model is between steps. */
	| { readonly kind: "working" }
	| { readonly kind: "thinking" }
	| { readonly kind: "running"; readonly tool: string }
	| { readonly kind: "responding" };

/**
 * Read the activity off the transcript's tail. The last AUTOMATIC part of the last message
 * (TanStack's own selection, matched results folded into their calls) is the step in
 * progress: a call with no result yet is a tool running; a call WITH its result means the
 * model has the output and is composing — `working`, not `running`, because the tool is
 * done. Thinking and text are what they say. Anything else — no assistant message yet, a
 * user message as the tail, an image — is `working`: in flight, nothing more specific known.
 */
export function describeActivity(messages: ReadonlyArray<UIMessage>, isLoading: boolean): Activity {
	if (!isLoading) return { kind: "idle" };
	const last = selectChatUI({ messages }).messages.at(-1);
	if (last === undefined || last.message.role !== "assistant") return { kind: "working" };
	const tail = automaticPartsForMessage(last).at(-1);
	if (tail === undefined) return { kind: "working" };
	if (tail.key === "toolCall")
		return tail.result === undefined ? { kind: "running", tool: tail.part.name } : { kind: "working" };
	if (tail.key === "thinking") return { kind: "thinking" };
	if (tail.key === "text") return { kind: "responding" };
	return { kind: "working" };
}

export interface SessionCounts {
	/** User messages — one per thing the human asked. */
	readonly turns: number;
	/** Tool calls across the whole transcript, paired or not. */
	readonly toolCalls: number;
}

/** Count the transcript. Cheap enough to run per render; the list is what is on screen. */
export function countSession(messages: ReadonlyArray<UIMessage>): SessionCounts {
	let turns = 0;
	let toolCalls = 0;
	for (const message of messages) {
		if (message.role === "user") turns += 1;
		for (const part of message.parts) if (part.type === "tool-call") toolCalls += 1;
	}
	return { turns, toolCalls };
}

/** `running read` — the tool named as pi names it, so it matches the transcript's step row. */
export function activityLabel(activity: Activity): string {
	return activity.kind === "running" ? `running ${activity.tool}` : activity.kind;
}

export interface SessionStatusViewProps {
	readonly activity: Activity;
	readonly counts: SessionCounts;
	readonly stats: SessionStats;
}

/** Pure view — everything it shows arrives as props, so a static render pins the wording. */
export function SessionStatusView({ activity, counts, stats }: SessionStatusViewProps): React.ReactNode {
	const inFlight = activity.kind !== "idle";
	return (
		<footer
			id="session-status"
			className="flex items-center gap-3 border-t px-4 py-1 font-mono text-muted-foreground text-xs"
		>
			<span
				className="flex items-center gap-1.5"
				title="what the run is doing right now, read off the transcript's tail"
			>
				<span
					aria-hidden="true"
					className={
						inFlight ? "size-2 animate-pulse rounded-full bg-foreground" : "size-2 rounded-full bg-muted-foreground/40"
					}
				/>
				{activityLabel(activity)}
			</span>
			<span title="user messages in this transcript">
				{counts.turns} {counts.turns === 1 ? "turn" : "turns"}
			</span>
			<span title="tool calls across this transcript, finished or not">
				{counts.toolCalls} {counts.toolCalls === 1 ? "tool call" : "tool calls"}
			</span>
			<span className="ml-auto" title="sum of every model request this page has made (pi's own attribution rule)">
				${stats.totalCost.toFixed(4)}
			</span>
			{stats.lastRequestInputTokens === undefined ? null : (
				<span title="prompt tokens the model saw on the latest request (input + cache read + cache write) — not a context-window percentage; the window size does not cross the wire">
					last {stats.lastRequestInputTokens.toLocaleString("en-US")} tok in
				</span>
			)}
		</footer>
	);
}

export interface SessionStatusBarProps {
	readonly messages: ReadonlyArray<UIMessage>;
	readonly isLoading: boolean;
}

/**
 * The bar wired to the page: the chat's messages and in-flight flag come in as props
 * (the chat hook is bound inside chat-screen.tsx, and this module stays free of it), the
 * usage store is subscribed here.
 */
export function SessionStatusBar({ messages, isLoading }: SessionStatusBarProps): React.ReactNode {
	const stats = useSyncExternalStore(subscribeToSessionStats, getSessionStatsSnapshot, getSessionStatsSnapshot);
	return (
		<SessionStatusView activity={describeActivity(messages, isLoading)} counts={countSession(messages)} stats={stats} />
	);
}
