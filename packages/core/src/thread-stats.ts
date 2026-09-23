import { type Static, Type } from 'typebox'
import { EnsoDurationSummary } from './log-stats.ts'
import { EnsoSessionUsage } from './thread-runtime.ts'

/**
 * One thread, analysed (#45 phase 2): what `GET /api/threads/:threadId/stats` answers and the
 * chat's stats drawer renders — per prompt, per turn, per tool.
 *
 * ⚠ TWO SOURCES, EACH FOR WHAT IT HOLDS WHOLE.
 *   - pi's SESSION holds every message on the branch with the usage pi attributed to it, for a
 *     thread of any age: costs, tokens, tool calls and their failures, sizes. `usage` is pi's
 *     session TOTAL (`getSessionStats`), the authoritative figure.
 *   - The LOG holds how long things took, and only for what was observed and not yet pruned (the
 *     directory keeps 14 days): tool durations joined by `toolCallId`, a run's prompt → settle
 *     and its first token. Folded by `dayStats`, the same fold `/debug?stats` reads, so the two
 *     surfaces cannot disagree about a duration.
 *
 * ⚠ THE BRANCH IS NOT THE SESSION. `turnStats` and `promptStats` walk the current branch; `usage` sums
 * every entry pi recorded. The difference — an abandoned branch, a compaction's or a branch
 * summary's model call, a cache warm — is reported as such by the reader (`usage.cost − branchCost`),
 * never spread over turns it does not belong to (livecraft's "unattributed", adopted).
 */

/**
 * One assistant request: the model call pi attributed usage to.
 *
 * @group Thread stats
 */
export const EnsoTurnStats = Type.Object(
  {
    /** 1-based, in branch order. */
    turn: Type.Integer({ minimum: 1 }),
    /** The prompt it answered — its number in `promptStats`; `0` for a turn before any prompt. */
    prompt: Type.Integer({ minimum: 0 }),
    model: Type.String(),
    cost: Type.Number({ minimum: 0 }),
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
    /** pi's `stopReason` — `error` and `aborted` turns are the ones a reader looks for. */
    stopReason: Type.String(),
  },
  { additionalProperties: false },
)
/** @group Thread stats */
export type EnsoTurnStats = Static<typeof EnsoTurnStats>

/**
 * One prompt and everything the model did for it until the next.
 *
 * @group Thread stats
 */
export const EnsoPromptStats = Type.Object(
  {
    /** 1-based, in branch order; `0` collects turns before the first prompt (a resumed fork, a command). */
    prompt: Type.Integer({ minimum: 0 }),
    /** The prompt's text, whitespace folded, at most 120 characters. */
    text: Type.String(),
    turnCount: Type.Integer({ minimum: 0 }),
    /** Its turns' cost plus any summarised tool result's. */
    cost: Type.Number({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
    failedToolCalls: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
/** @group Thread stats */
export type EnsoPromptStats = Static<typeof EnsoPromptStats>

/**
 * One tool, across the branch. Sizes are characters of the serialised arguments and of the
 * result's text — not tokens, and never a cost: a tool call has none of its own.
 *
 * @group Thread stats
 */
export const EnsoToolStats = Type.Object(
  {
    toolName: Type.String(),
    calls: Type.Integer({ minimum: 0 }),
    /** Results pi marked `isError` — a guard's refusal is one (map-events.ts says why). */
    failures: Type.Integer({ minimum: 0 }),
    inputChars: Type.Integer({ minimum: 0 }),
    outputChars: Type.Integer({ minimum: 0 }),
    /** Call → result, from the log; `count` below `calls` is the part that was not observed or was pruned. */
    durations: EnsoDurationSummary,
  },
  { additionalProperties: false },
)
/** @group Thread stats */
export type EnsoToolStats = Static<typeof EnsoToolStats>

/**
 * The thread, analysed.
 *
 * @group Thread stats
 */
export const EnsoThreadStats = Type.Object(
  {
    threadId: Type.String(),
    /** A pi session exists for the thread on this server; `false` is read from the file. */
    live: Type.Boolean(),
    /** pi's session total — every branch, compactions and cache warms included. */
    usage: EnsoSessionUsage,
    /** What the branch's own messages were attributed: the turns plus summarised tool results. */
    branchCost: Type.Number({ minimum: 0 }),
    turnStats: Type.Array(EnsoTurnStats),
    promptStats: Type.Array(EnsoPromptStats),
    /** Sorted by calls, most first. */
    toolStats: Type.Array(EnsoToolStats),
    /** From the log: each run's first prompt → settle, and its time to first token. */
    latency: Type.Object(
      { prompts: EnsoDurationSummary, firstDelta: EnsoDurationSummary },
      { additionalProperties: false },
    ),
    /** The log days the durations were read from — what exists of the thread's span, newest last. */
    logDays: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Thread stats */
export type EnsoThreadStats = Static<typeof EnsoThreadStats>
