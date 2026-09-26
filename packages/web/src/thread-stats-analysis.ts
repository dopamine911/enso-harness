import type { EnsoThreadStats, EnsoToolCallStats } from '@enso/core'

/**
 * What the stats drawer derives from `EnsoThreadStats` before it draws (#45 phase 2): the
 * averages, the per-tool totals and the two rankings — pi-livecraft's `analyzeSession` and
 * `SessionAnalysisWidget` rankings (`.inspiration/pi-extensions/pi-livecraft`), ported to our
 * wire. Pure, so the rules are pinned without a DOM.
 *
 * ⚠ livecraft's rules, kept: a duration ranking lists only calls the log timed, never a zero for
 * one it did not; a failure ranking lists only failed calls; a tool's duration says how many of
 * its calls were measured.
 *
 * ⚠ OURS, ON TOP (#407): a failure is an `isError` result a guard did NOT refuse. pi hands a
 * guard's refusal over as the same `isError` result a failed command makes; the thread's
 * `guardDenials` (#387) is what tells them apart, so every function here that counts failures
 * takes it — required, so no caller can count a refusal as a failure by leaving it out.
 */

/** The calls a guard refused, by tool-call id — the thread's `guardDenials` store. */
export type RefusedCalls = ReadonlyMap<string, unknown>

/** Refused by a guard (#387): policy doing its job, said apart from a failure. */
export function isRefused(call: EnsoToolCallStats, refused: RefusedCalls): boolean {
  return refused.has(call.toolCallId)
}

/** Failed: an error result no guard refused — the tool ran, or tried to, and failed. */
function isFailure(call: EnsoToolCallStats, refused: RefusedCalls): boolean {
  return call.isError && !isRefused(call, refused)
}

/** A difference below a hundredth of a cent is float noise, not spend. */
const COST_EPSILON = 0.00005

/** One tool, its calls summed — livecraft's `ToolSummary`. */
export interface ToolSummary {
  readonly toolName: string
  readonly calls: number
  readonly failed: number
  readonly refused: number
  readonly inputChars: number
  readonly outputChars: number
  /** The measured calls' durations, summed; `measured` says how many that is. */
  readonly durationMs: number
  readonly measured: number
}

/** The drawer's headline figures — livecraft's summary cards and context block. */
export interface StatsHeadline {
  readonly turnCount: number
  readonly averageTurnCost: number
  readonly medianTurnCost: number
  readonly averageToolsPerTurn: number
  readonly toolCalls: number
  readonly failedToolCalls: number
  readonly refusedToolCalls: number
  /** `failed / calls`, 0 with no call — a refusal is not a failure. */
  readonly failureRate: number
  /** pi's session total beyond what the branch's messages account for; 0 when within noise. */
  readonly offBranchCost: number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

export function headlineOf(stats: EnsoThreadStats, refused: RefusedCalls): StatsHeadline {
  const turnCosts = stats.turnStats.map((turn) => turn.cost)
  const turnCount = turnCosts.length
  const toolCalls = stats.callStats.length
  const failedToolCalls = stats.callStats.filter((call) => isFailure(call, refused)).length
  const refusedToolCalls = stats.callStats.filter((call) => isRefused(call, refused)).length
  const offBranch = stats.usage.cost - stats.branchCost
  return {
    turnCount,
    averageTurnCost: turnCount === 0 ? 0 : turnCosts.reduce((total, cost) => total + cost, 0) / turnCount,
    medianTurnCost: median(turnCosts),
    averageToolsPerTurn: turnCount === 0 ? 0 : toolCalls / turnCount,
    toolCalls,
    failedToolCalls,
    refusedToolCalls,
    failureRate: toolCalls === 0 ? 0 : failedToolCalls / toolCalls,
    offBranchCost: offBranch >= COST_EPSILON ? offBranch : 0,
  }
}

/** Per tool, most calls first, ties by name — livecraft's `summarizeTools`. */
export function toolSummaries(calls: readonly EnsoToolCallStats[], refused: RefusedCalls): ToolSummary[] {
  const byName = new Map<string, { -readonly [Key in keyof ToolSummary]: ToolSummary[Key] }>()
  for (const call of calls) {
    const summary = byName.get(call.toolName) ?? {
      toolName: call.toolName,
      calls: 0,
      failed: 0,
      refused: 0,
      inputChars: 0,
      outputChars: 0,
      durationMs: 0,
      measured: 0,
    }
    summary.calls += 1
    summary.failed += Number(isFailure(call, refused))
    summary.refused += Number(isRefused(call, refused))
    summary.inputChars += call.inputChars
    summary.outputChars += call.outputChars
    if (call.durationMs !== undefined) {
      summary.durationMs += call.durationMs
      summary.measured += 1
    }
    byName.set(call.toolName, summary)
  }
  return [...byName.values()].sort(
    (first, second) => second.calls - first.calls || first.toolName.localeCompare(second.toolName),
  )
}

/** What "cumulative usage by tool" ranks by. */
export type ToolUsageMetric = 'output' | 'input' | 'duration'

export function toolUsageValue(tool: ToolSummary, metric: ToolUsageMetric): number {
  if (metric === 'duration') return tool.durationMs
  return metric === 'input' ? tool.inputChars : tool.outputChars
}

/** The tools by a metric, largest first; by duration, only tools with a measured call. */
export function rankTools(tools: readonly ToolSummary[], metric: ToolUsageMetric): ToolSummary[] {
  return tools
    .filter((tool) => metric !== 'duration' || tool.measured > 0)
    .sort((first, second) => toolUsageValue(second, metric) - toolUsageValue(first, metric))
}

/** What "costliest calls" ranks by. */
export type CallMetric = 'input' | 'output' | 'duration' | 'failure'

export function callValue(call: EnsoToolCallStats, metric: CallMetric, refused: RefusedCalls): number {
  if (metric === 'duration') return call.durationMs ?? 0
  if (metric === 'failure') return Number(isFailure(call, refused))
  return metric === 'input' ? call.inputChars : call.outputChars
}

/** livecraft shows the top eight calls. */
const RANKED_CALLS = 8

/** The calls by a metric, top eight; by duration only timed calls, by failure only failed ones — never a refused one. */
export function rankCalls(
  calls: readonly EnsoToolCallStats[],
  metric: CallMetric,
  refused: RefusedCalls,
): EnsoToolCallStats[] {
  return calls
    .filter((call) => {
      if (metric === 'duration') return call.durationMs !== undefined
      return metric !== 'failure' || isFailure(call, refused)
    })
    .sort((first, second) => callValue(second, metric, refused) - callValue(first, metric, refused))
    .slice(0, RANKED_CALLS)
}
