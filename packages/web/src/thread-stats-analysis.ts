import {
  ENSO_TOOL_REFUSERS,
  type EnsoThreadStats,
  type EnsoToolCallStats,
  type EnsoToolRefusal,
  type EnsoToolRefuser,
  type EnsoTurnStats,
  median,
} from '@enso/core'

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
 * ⚠ OURS, ON TOP (#407): a failure is an `isError` result nothing refused. pi hands a refusal
 * over as the same `isError` result a failed command makes — a guard's, a permission rule's,
 * `auto`'s, the person's (#523); the thread's `refusals` (#387) is what tells them apart, so every
 * function here that counts failures takes it — required, so no caller can count a refusal as a
 * failure by leaving it out.
 *
 * ⚠ AND A NON-ZERO EXIT IS NOT A FAILURE (#928). pi marks every `bash` command that exits non-zero
 * `isError` — `grep` with no match, `test -f`, `diff` with differences — though the command ran and
 * answered. The call carries its `exitCode` (`shellExitCodeOf`); it is counted apart, never in the
 * failure rate. A failure is the call itself breaking: a timeout, an abort, a spawn error, another
 * tool's error.
 */

/** The calls something refused, by tool-call id, and who refused each — the thread's `refusals` store. */
export type RefusedCalls = ReadonlyMap<string, EnsoToolRefusal>

/** Refused (#387, #523) — by a guard, a permission rule, `auto`, or the person: a decision, said apart from a failure. */
export function isRefused(call: EnsoToolCallStats, refused: RefusedCalls): boolean {
  return refused.has(call.toolCallId)
}

/** Exited non-zero (#928): a `bash` command that ran and answered no — said apart from a failure. */
export function isNonZeroExit(call: EnsoToolCallStats, refused: RefusedCalls): boolean {
  return call.exitCode !== undefined && !isRefused(call, refused)
}

/** Failed: an error result nothing refused that is not a command's non-zero exit — the call itself broke. */
function isFailure(call: EnsoToolCallStats, refused: RefusedCalls): boolean {
  return call.isError && !isRefused(call, refused) && call.exitCode === undefined
}

/** A difference below a hundredth of a cent is float noise, not spend. */
const COST_EPSILON = 0.00005

/**
 * ⚠ A MODEL WITH NO PRICE BILLS $0 (#692). pi prices a turn from its model's per-token rates, and
 * a model it has no price for carries zero rates — the Codex subscription models multi-account
 * learns from the live catalog do — so each of its turns costs exactly 0 for thousands of tokens,
 * which reads as free. A priced turn that used tokens costs more than 0, so a turn at 0 that used
 * tokens had no price; a turn that used none (an aborted request) really cost nothing.
 */
export function isUnpriced(turn: EnsoTurnStats): boolean {
  return turn.cost === 0 && turn.input + turn.output + turn.cacheRead + turn.cacheWrite > 0
}

/**
 * Whether the branch's turn costs are known: all of them, none (every turn that used tokens had
 * no price), or some — a thread can switch to a model with no price and back.
 */
type Pricing = 'priced' | 'unpriced' | 'partly'

function pricingOf(turnStats: readonly EnsoTurnStats[], unpricedTurnCount: number): Pricing {
  if (unpricedTurnCount === 0) return 'priced'
  return turnStats.some((turn) => turn.cost > 0) ? 'partly' : 'unpriced'
}

/** The prompts with a turn that had no price: their cost counts only their priced turns. */
export function unpricedPrompts(turnStats: readonly EnsoTurnStats[]): ReadonlySet<number> {
  return new Set(turnStats.filter(isUnpriced).map((turn) => turn.prompt))
}

/** One tool, its calls summed — livecraft's `ToolSummary`. */
export interface ToolSummary {
  readonly toolName: string
  readonly calls: number
  readonly failed: number
  readonly exited: number
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
  /** Undefined with no turn, or when a turn had no price — a mean counting it as 0 reads as cheap (#692). */
  readonly averageTurnCost: number | undefined
  readonly medianTurnCost: number | undefined
  readonly pricing: Pricing
  /** The turns that used tokens on a model with no price — counted, their cost is not. */
  readonly unpricedTurnCount: number
  readonly averageToolsPerTurn: number
  readonly toolCalls: number
  readonly failedToolCalls: number
  /** `bash` commands that exited non-zero (#928) — not failures. */
  readonly nonZeroExits: number
  readonly refusedToolCalls: number
  /** The refusals by who refused (#523), in `ENSO_TOOL_REFUSERS` order, only those that refused any. */
  readonly refusedBy: ReadonlyArray<readonly [EnsoToolRefuser, number]>
  /** `failed / calls`, 0 with no call — neither a refusal nor a non-zero exit is a failure. */
  readonly failureRate: number
  /** pi's session total beyond what the branch's messages account for; 0 when within noise. */
  readonly offBranchCost: number
}

export function headlineOf(stats: EnsoThreadStats, refused: RefusedCalls): StatsHeadline {
  const turnCosts = stats.turnStats.map((turn) => turn.cost)
  const turnCount = turnCosts.length
  const unpricedTurnCount = stats.turnStats.filter(isUnpriced).length
  const costsKnown = turnCount > 0 && unpricedTurnCount === 0
  const toolCalls = stats.callStats.length
  const failedToolCalls = stats.callStats.filter((call) => isFailure(call, refused)).length
  const nonZeroExits = stats.callStats.filter((call) => isNonZeroExit(call, refused)).length
  const refusals = stats.callStats.flatMap((call) => {
    const refusal = refused.get(call.toolCallId)
    return refusal === undefined ? [] : [refusal.by]
  })
  const offBranch = stats.usage.cost - stats.branchCost
  return {
    turnCount,
    averageTurnCost: costsKnown ? turnCosts.reduce((total, cost) => total + cost, 0) / turnCount : undefined,
    medianTurnCost: costsKnown ? median(turnCosts) : undefined,
    pricing: pricingOf(stats.turnStats, unpricedTurnCount),
    unpricedTurnCount,
    averageToolsPerTurn: turnCount === 0 ? 0 : toolCalls / turnCount,
    toolCalls,
    failedToolCalls,
    nonZeroExits,
    refusedToolCalls: refusals.length,
    refusedBy: ENSO_TOOL_REFUSERS.flatMap((by) => {
      const count = refusals.filter((refuser) => refuser === by).length
      return count === 0 ? [] : [[by, count] as const]
    }),
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
      exited: 0,
      refused: 0,
      inputChars: 0,
      outputChars: 0,
      durationMs: 0,
      measured: 0,
    }
    summary.calls += 1
    summary.failed += Number(isFailure(call, refused))
    summary.exited += Number(isNonZeroExit(call, refused))
    summary.refused += Number(isRefused(call, refused))
    summary.inputChars += call.inputChars
    summary.outputChars += call.outputChars
    if (call.durationMs !== undefined) {
      summary.durationMs += call.durationMs
      summary.measured += 1
    }
    byName.set(call.toolName, summary)
  }
  return [...byName.values()].toSorted(
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
    .toSorted((first, second) => toolUsageValue(second, metric) - toolUsageValue(first, metric))
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
    .toSorted((first, second) => callValue(second, metric, refused) - callValue(first, metric, refused))
    .slice(0, RANKED_CALLS)
}
