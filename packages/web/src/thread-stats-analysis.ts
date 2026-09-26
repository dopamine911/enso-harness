import type { EnsoThreadStats, EnsoToolCallStats } from '@enso/core'

/**
 * What the stats drawer derives from `EnsoThreadStats` before it draws (#45 phase 2): the
 * averages, the per-tool totals and the two rankings — pi-livecraft's `analyzeSession` and
 * `SessionAnalysisWidget` rankings (`.inspiration/pi-extensions/pi-livecraft`), ported to our
 * wire. Pure, so the rules are pinned without a DOM.
 *
 * ⚠ livecraft's rules, kept: a duration ranking lists only calls the log timed, never a zero for
 * one it did not; a failure ranking lists only calls pi marked `isError`; a tool's duration says
 * how many of its calls were measured.
 */

/** A difference below a hundredth of a cent is float noise, not spend. */
const COST_EPSILON = 0.00005

/** One tool, its calls summed — livecraft's `ToolSummary`. */
export interface ToolSummary {
  readonly toolName: string
  readonly calls: number
  readonly failed: number
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
  /** `failed / calls`, 0 with no call. */
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

export function headlineOf(stats: EnsoThreadStats): StatsHeadline {
  const turnCosts = stats.turnStats.map((turn) => turn.cost)
  const turnCount = turnCosts.length
  const toolCalls = stats.callStats.length
  const failedToolCalls = stats.callStats.filter((call) => call.isError).length
  const offBranch = stats.usage.cost - stats.branchCost
  return {
    turnCount,
    averageTurnCost: turnCount === 0 ? 0 : turnCosts.reduce((total, cost) => total + cost, 0) / turnCount,
    medianTurnCost: median(turnCosts),
    averageToolsPerTurn: turnCount === 0 ? 0 : toolCalls / turnCount,
    toolCalls,
    failedToolCalls,
    failureRate: toolCalls === 0 ? 0 : failedToolCalls / toolCalls,
    offBranchCost: offBranch >= COST_EPSILON ? offBranch : 0,
  }
}

/** Per tool, most calls first, ties by name — livecraft's `summarizeTools`. */
export function toolSummaries(calls: readonly EnsoToolCallStats[]): ToolSummary[] {
  const byName = new Map<string, { -readonly [Key in keyof ToolSummary]: ToolSummary[Key] }>()
  for (const call of calls) {
    const summary = byName.get(call.toolName) ?? {
      toolName: call.toolName,
      calls: 0,
      failed: 0,
      inputChars: 0,
      outputChars: 0,
      durationMs: 0,
      measured: 0,
    }
    summary.calls += 1
    summary.failed += Number(call.isError)
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

export function callValue(call: EnsoToolCallStats, metric: CallMetric): number {
  if (metric === 'duration') return call.durationMs ?? 0
  if (metric === 'failure') return Number(call.isError)
  return metric === 'input' ? call.inputChars : call.outputChars
}

/** livecraft shows the top eight calls. */
const RANKED_CALLS = 8

/** The calls by a metric, top eight; by duration only timed calls, by failure only failed ones. */
export function rankCalls(calls: readonly EnsoToolCallStats[], metric: CallMetric): EnsoToolCallStats[] {
  return calls
    .filter((call) => {
      if (metric === 'duration') return call.durationMs !== undefined
      return metric !== 'failure' || call.isError
    })
    .sort((first, second) => callValue(second, metric) - callValue(first, metric))
    .slice(0, RANKED_CALLS)
}
