import { createStore, type Store } from "./store.ts";

/**
 * The session-stats STORE (#45, phase 1): cost so far + the last request's prompt size.
 * Rendered by the status bar in session-status.tsx (#90), which subscribes to it.
 *
 * Usage arrives as an AG-UI CUSTOM chunk (`zen.usage`) — one per COMPLETED model request,
 * emitted by map-events.ts off pi's `message_end` (never the per-delta cumulative usage,
 * which would multiply cost by the delta count). TanStack's path for CUSTOM chunks is the
 * `onCustomEvent` chat option — so the bridge to React state is this store, one per thread
 * (`thread-stores.ts`), fed by `custom-event-router.ts`.
 *
 * ⚠ THE SUM IS THREAD-LIVED, DELIBERATELY. This store is the one place a thread's whole
 * spend accumulates; it never resets between runs — that is the feature, not a leak. A
 * second thread on the same page has its own (#90 PR 3).
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
	/** How many usage observations were counted. */
	countedMessages: number;
}

const EMPTY_STATS: SessionStats = { totalCost: 0, lastRequestInputTokens: undefined, countedMessages: 0 };

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

export interface SessionStatsStore extends Store<SessionStats> {
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
	readonly applyUsage: (data: unknown) => void;
}

export function createSessionStatsStore(): SessionStatsStore {
	const store = createStore<SessionStats>(EMPTY_STATS);
	return {
		get: store.get,
		subscribe: store.subscribe,
		applyUsage: (data) => {
			if (typeof data !== "object" || data === null) return;
			const observation = data as { role?: unknown; usage?: unknown };
			const usage = readUsageShape(observation.usage);
			if (usage === undefined) return;
			const stats = store.get();
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			const movesLastRequest = observation.role === "assistant" && promptTokens > 0;
			store.set({
				totalCost: stats.totalCost + (usage.totalCost ?? 0),
				lastRequestInputTokens: movesLastRequest ? promptTokens : stats.lastRequestInputTokens,
				countedMessages: stats.countedMessages + 1,
			});
		},
	};
}
