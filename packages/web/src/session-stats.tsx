import { useSyncExternalStore } from "react";

/**
 * The session-stats bar (#45, phase 1): cost so far + the last request's prompt size.
 *
 * Usage arrives as an AG-UI CUSTOM chunk (`zen.usage`) — one per COMPLETED model request,
 * emitted by map-events.ts off pi's `message_end` (never the per-delta cumulative usage,
 * which would multiply cost by the delta count). TanStack's path for CUSTOM chunks is the
 * `onCustomEvent` chat option, built at module scope before any component exists — so the
 * bridge to React state is this module-level store, the same shape notifications.tsx uses:
 * `applyZenMessageUsage` is called from `onCustomEvent`, and `SessionStatsBar` subscribes
 * via `useSyncExternalStore`.
 *
 * ⚠ THE SUM IS PAGE-LIVED, DELIBERATELY. pi is spawned per prompt (#43), so pi's own
 * session totals reset every turn; this store is the one place the whole chat thread's
 * spend accumulates. It never resets between runs — that is the feature, not a leak.
 *
 * ⚠ "LAST REQUEST", NOT "CONTEXT". input + cacheRead + cacheWrite is the prompt size the
 * model saw on the latest ASSISTANT request — a decent proxy for context growth, but the
 * context WINDOW does not cross our wire (pi's `Model.contextWindow` never leaves the
 * process), so a percent-full bar here would be a number we invented. That is #44's
 * territory; this bar states only what it measured.
 */

interface ZenUsageShape {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalCost?: number;
}

export interface SessionStats {
	/** Sum of `totalCost` across every counted request this page has seen. */
	totalCost: number;
	/** input + cacheRead + cacheWrite of the LATEST assistant request, or undefined before the first. */
	lastRequestInputTokens: number | undefined;
	/** How many usage observations were counted — the bar hides until the first. */
	countedMessages: number;
}

const EMPTY_STATS: SessionStats = { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 };

let stats: SessionStats = EMPTY_STATS;
const listeners = new Set<() => void>();

/**
 * ⓘ Looks like map-events' `readUsage` but parses a DIFFERENT shape, deliberately: that
 * one reads pi's wire usage (`{cost: {total}}`), this one reads our own `ZenUsage`
 * (`{totalCost}`) after it crossed the CUSTOM chunk. One shared helper would need a shape
 * switch, which costs more than the ~10 lines it saves (PR #51 review, nit 2).
 */
function readUsageShape(raw: unknown): ZenUsageShape | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const usage = raw as Record<string, unknown>;
	const numberAt = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
	return {
		input: numberAt("input"),
		output: numberAt("output"),
		cacheRead: numberAt("cacheRead"),
		cacheWrite: numberAt("cacheWrite"),
		...(typeof usage.totalCost === "number" ? { totalCost: usage.totalCost as number } : {}),
	};
}

/**
 * Fold one `zen.usage` chunk's value into the stats. Defensive like every wire crossing in
 * chat-screen.tsx: a malformed value changes nothing rather than throwing in the stream loop.
 *
 * ⚠ Cost sums over EVERY counted message (assistant and toolResult summaries — pi's own
 * attribution rule, see ZenMessageUsage in @zen/core), but "last request" reads ASSISTANT
 * messages only: a toolResult summary is a side model call whose prompt is the tool output,
 * not the conversation — letting it overwrite the number would show a misleading dip.
 *
 * ⚠ And only assistant messages whose prompt total is ABOVE ZERO. An errored or aborted
 * request still emits an assistant `message_end`, with all-zero usage (observed on the
 * wire: an empty-prompt run produced exactly that shape). A real request never sees zero
 * prompt tokens, so a zero here means "the request failed", not "the context emptied" —
 * the same misleading dip as toolResult, through a different door. Cost still adds its
 * zero and the message still counts, so pi's attribution rule is untouched.
 */
export function applyZenMessageUsage(data: unknown): void {
	if (typeof data !== "object" || data === null) return;
	const observation = data as { role?: unknown; usage?: unknown };
	const usage = readUsageShape(observation.usage);
	if (usage === undefined) return;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const movesLastRequest = observation.role === "assistant" && promptTokens > 0;
	stats = {
		totalCost: stats.totalCost + (usage.totalCost ?? 0),
		lastRequestInputTokens: movesLastRequest ? promptTokens : stats.lastRequestInputTokens,
		countedMessages: stats.countedMessages + 1,
	};
	for (const listener of listeners) listener();
}

export function subscribeToSessionStats(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getSessionStatsSnapshot(): SessionStats {
	return stats;
}

/** Test seam: reset the store between cases. Never called from production code. */
export function clearSessionStatsForTest(): void {
	stats = EMPTY_STATS;
}

/** $0.0132 — four decimals because a single small request costs fractions of a cent. */
function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

/** 12,345 → "12,345"; grouping so a six-figure token count stays readable at a glance. */
function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

/**
 * The slim line above the composer. Hidden until the first counted request — an all-zero
 * bar before anything ran would read as a broken meter, not an empty one.
 *
 * ⓘ No `role="status"`/live region, deliberately (PR #51 review, nit 3): unlike a notify
 * line, this is a persistent readout that updates on EVERY completed request, and a live
 * region would interrupt a screen reader mid-task each time. The numbers stay poll-able,
 * never announced.
 */
export function SessionStatsBar(): React.ReactNode {
	const currentStats = useSyncExternalStore(subscribeToSessionStats, getSessionStatsSnapshot, getSessionStatsSnapshot);
	if (currentStats.countedMessages === 0) return null;
	return (
		<div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-3 px-4 pb-1 text-muted-foreground text-xs">
			<span title="sum of every model request this page has made (pi's own attribution rule)">
				cost {formatCost(currentStats.totalCost)}
			</span>
			{currentStats.lastRequestInputTokens === undefined ? null : (
				<span title="prompt tokens the model saw on the latest request (input + cache read + cache write) — not a context-window percentage; the window size does not cross the wire">
					last request {formatTokens(currentStats.lastRequestInputTokens)} tokens in
				</span>
			)}
		</div>
	);
}
