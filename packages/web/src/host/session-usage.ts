import type { AgentSessionEvent, SessionEntry, SessionStats } from '@earendil-works/pi-coding-agent'
import type { EnsoSessionUsage } from '@enso/core'

/**
 * A thread's spend and context, as pi reckons them (#45) — the two halves of `EnsoSessionUsage`.
 *
 * ⚠ PI'S SESSION TOTALS ARE AUTHORITATIVE. A live thread reads `session.getSessionStats()`,
 * pi's own sum (the `/session` command's number): every usage recorded in the session, on every
 * branch — assistant messages, summarised tool results, and the model calls behind a compaction,
 * a branch summary, or a `usage` entry an extension wrote. A cold thread has no session to ask
 * (#86: looking must not build one), so `storedSessionUsage` runs the same rule over the file's
 * entries — `AgentSession.getSessionStats` in `@earendil-works/pi-coding-agent@0.87.1`,
 * `dist/core/agent-session.js`. `agent-host.test.ts` pins the two equal on one session, so a
 * pi bump that changes its rule goes red there rather than showing a resumed thread a
 * different total than the tab that watched it accumulate.
 *
 * ⚠ NOT the day's log fold (`log-stats.ts`). That folds the `message {role} used` records,
 * which are per completed message and so never include a compaction's call. The two agree on
 * every thread that has not compacted; a compacted one's session total is the larger, and the
 * right one for "what has this thread cost".
 */

/** The usage fields both sources carry — pi's `Usage`, reduced to what is summed. */
interface SummedUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: { readonly total: number }
}

type Totals = Omit<EnsoSessionUsage, 'context'>

function add(totals: Totals, usage: SummedUsage | undefined): void {
  if (usage === undefined) return
  totals.input += usage.input
  totals.output += usage.output
  totals.cacheRead += usage.cacheRead
  totals.cacheWrite += usage.cacheWrite
  totals.cost += usage.cost.total
}

/** The usage an entry carries under pi's rule, or nothing. */
function usageOf(entry: SessionEntry): SummedUsage | undefined {
  switch (entry.type) {
    case 'usage':
    case 'compaction':
    case 'branch_summary':
      return entry.usage
    case 'message':
      return entry.message.role === 'assistant' || entry.message.role === 'toolResult' ? entry.message.usage : undefined
    default:
      return undefined
  }
}

/**
 * A stored session's totals, from its entries — ALL of them (the file's `getEntries()`),
 * not the branch: spend on an abandoned branch was still spent. No `context`: the file does not
 * say which model pi would run, so it does not say the window.
 */
export function storedSessionUsage(entries: readonly SessionEntry[]): EnsoSessionUsage {
  const totals: Totals = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const sessionEntry of entries) add(totals, usageOf(sessionEntry))
  return { ...totals, context: null }
}

/**
 * Whether the session's recorded spend may have just grown — the events after which the host
 * re-reads it (#45). Each is AFTER pi persisted what it counts: pi hands `message_end` to
 * listeners BEFORE it appends the message (`agent-session.js` `_handleAgentEvent`: emit, then
 * `appendMessage`), so `message_end` would read the totals one request short.
 *
 *   - `turn_end` follows every request's assistant message and tool results;
 *   - `agent_end` closes a run a stop cut short of its turn;
 *   - `compaction_end` follows a compaction's own model call and the context it emptied;
 *   - `entry_appended` of a `usage` entry is pi's cache warmer (`cache-warmer.js`
 *     `appendUsage('cache_warm', …)` → `onWarmed`): in its `idle` mode it warms BETWEEN runs,
 *     where no turn follows to carry the spend (PR #357 review).
 */
export function growsSessionSpend(event: AgentSessionEvent): boolean {
  switch (event.type) {
    case 'turn_end':
    case 'agent_end':
    case 'compaction_end':
      return true
    case 'entry_appended':
      return event.entry.type === 'usage'
    default:
      return false
  }
}

/** A live session's totals and context, as pi reports them — nothing recomputed here. */
export function liveSessionUsage(stats: SessionStats): EnsoSessionUsage {
  const { tokens, cost, contextUsage } = stats
  return {
    cost,
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    context:
      contextUsage === undefined
        ? null
        : { tokens: contextUsage.tokens, window: contextUsage.contextWindow, percent: contextUsage.percent },
  }
}
