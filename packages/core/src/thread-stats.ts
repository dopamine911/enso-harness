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
 *     and its first token. Folded by `foldDay`, the same fold `/debug?stats` reads, so the two
 *     surfaces cannot disagree about a duration.
 *   - One duration is the SESSION's (#359): a prompt's own, from the timestamps pi stamps on each
 *     entry as it appends it. The log cannot say it: a run's settle closes every prompt queued
 *     into that run at once, and its records are pruned after 14 days; the entries are neither.
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
    /**
     * The prompt's entry → the last message entry answering it (a reply or a tool result), from
     * pi's own entry timestamps. Absent before the first reply, and for the turns before any prompt.
     */
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
)
/** @group Thread stats */
export type EnsoPromptStats = Static<typeof EnsoPromptStats>

/**
 * One tool call on the branch — the unit livecraft's rankings rank ("costliest calls") and its
 * per-tool totals sum. Sizes are characters of the serialised arguments and of the result's text:
 * not tokens, and never a cost — a tool call has none of its own.
 *
 * @group Thread stats
 */
export const EnsoToolCallStats = Type.Object(
  {
    toolCallId: Type.String(),
    toolName: Type.String(),
    /** The turn whose assistant message made the call. */
    turn: Type.Integer({ minimum: 1 }),
    /** The prompt that turn answered; `0` before any prompt. */
    prompt: Type.Integer({ minimum: 0 }),
    inputChars: Type.Integer({ minimum: 0 }),
    outputChars: Type.Integer({ minimum: 0 }),
    /** pi marked the result `isError` — a guard's refusal is one (map-events.ts says why). */
    isError: Type.Boolean(),
    /** No result on the branch yet: running now, or a run that stopped under it. */
    pending: Type.Boolean(),
    /** Call → result, from the log — absent when the log never saw it or has pruned the day. */
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
)
/** @group Thread stats */
export type EnsoToolCallStats = Static<typeof EnsoToolCallStats>

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
    /** In branch order. Per-tool totals are these, summed by the reader. */
    callStats: Type.Array(EnsoToolCallStats),
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
