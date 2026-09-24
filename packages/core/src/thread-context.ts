import { type Static, Type } from 'typebox'
import { EnsoContextUsage } from './thread-runtime.ts'

/**
 * One thread's context, request by request (#361): what `GET /api/threads/:threadId/context`
 * answers and the Context view draws — dsh-context's composition and trend, over pi.
 *
 * ⚠ REBUILT FROM THE STORED BRANCH, NOT FOLDED FROM EVENTS. pi stores the system prompt (a
 * leading system message with named sections and every tool definition) and every later change
 * on the branch, and exports the function that assembles a request from it
 * (`buildContextEntries`). So a request's context is what that function returns for the branch
 * up to just before its reply, for a thread of any age, live or reopened. An extension's
 * `context` transform changes a request in flight without storing the change; it is not here.
 *
 * ⚠ ESTIMATES BESIDE ACTUALS. Each category is pi's own estimate (`estimateTokens`: characters
 * over four, rounded up). The provider's count for the whole request is `actual`, from the reply's
 * recorded usage. They differ, and the view says which is which.
 */

/**
 * dsh-context's six categories, mapped to pi (#361 has the table):
 * - `system`: the leading system message's instructions and its sections `preamble`, `tools`,
 *   `rules`, `docs`, `cwd` — what pi writes for every thread;
 * - `tools`: the tool definitions the system messages declare;
 * - `user`: prompts, and a user's `!` command with its output;
 * - `injected`: what the harness added beyond the conversation — the sections `project_context`,
 *   `skills`, `addendum` and any an extension declares, later system messages, an extension's
 *   custom messages, compaction and branch summaries;
 * - `assistant`: replies — text, thinking, tool calls;
 * - `toolResults`: what the tools returned.
 *
 * @group Thread context
 */
export const EnsoContextCategory = Type.Union([
  Type.Literal('system'),
  Type.Literal('tools'),
  Type.Literal('user'),
  Type.Literal('injected'),
  Type.Literal('assistant'),
  Type.Literal('toolResults'),
])
/** @group Thread context */
export type EnsoContextCategory = Static<typeof EnsoContextCategory>

const estimate = Type.Integer({ minimum: 0 })

/**
 * A context's estimated tokens by category.
 *
 * @group Thread context
 */
export const EnsoContextMakeup = Type.Object(
  {
    system: estimate,
    tools: estimate,
    user: estimate,
    injected: estimate,
    assistant: estimate,
    toolResults: estimate,
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextMakeup = Static<typeof EnsoContextMakeup>

/**
 * One thing that entered the context since the previous request — dsh's step brief "In" row.
 *
 * @group Thread context
 */
export const EnsoContextAddition = Type.Object(
  {
    category: EnsoContextCategory,
    /** One line: a tool's name and its result's first line, a custom message's type, a summary. */
    label: Type.String(),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextAddition = Static<typeof EnsoContextAddition>

/**
 * One model request: the context it was assembled from, and what the provider reported for it.
 *
 * @group Thread context
 */
export const EnsoContextRequest = Type.Object(
  {
    /** The turn its reply is — the same number as `EnsoTurnStats.turn`. */
    turn: Type.Integer({ minimum: 1 }),
    /** The prompt it answered; `0` before any prompt. */
    prompt: Type.Integer({ minimum: 0 }),
    /** When its reply was stored, ISO. */
    at: Type.String(),
    model: Type.String(),
    estimated: EnsoContextMakeup,
    /** The provider's counts, from the reply's usage: all zero when it reported none (an error). */
    actual: Type.Object(
      {
        /** Tokens the request was: input, cache read and cache write. */
        prompt: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        cacheRead: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    /** A compaction took effect since the previous request; `tokensBefore` is pi's figure for the context it replaced. */
    compaction: Type.Optional(
      Type.Object({ tokensBefore: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    ),
    /** The step brief: the prompt, what entered since the previous request, and the reply. */
    brief: Type.Object(
      {
        /** The prompt's text, whitespace folded, at most 120 characters; empty before any prompt. */
        prompt: Type.String(),
        /** In context order, at most `ENSO_CONTEXT_ADDITIONS_SHOWN`; `moreAdded` counts the rest. */
        added: Type.Array(EnsoContextAddition),
        moreAdded: Type.Integer({ minimum: 0 }),
        /** The reply's first line of text, at most 120 characters. */
        reply: Type.String(),
        /** The tools the reply called, in order. */
        toolCalls: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextRequest = Static<typeof EnsoContextRequest>

/**
 * How many additions a brief lists before it counts the rest — a compaction makes every kept
 * entry new again, and the brief is three lines, not a transcript.
 *
 * @group Thread context
 */
export const ENSO_CONTEXT_ADDITIONS_SHOWN = 6

/**
 * The thread's context: now, and at every request on its branch.
 *
 * @group Thread context
 */
export const EnsoThreadContext = Type.Object(
  {
    threadId: Type.String(),
    /** A pi session exists for the thread on this server; `false` is read from the file. */
    live: Type.Boolean(),
    /** pi's context meter: the last response's tokens against the model's window. */
    usage: Type.Union([EnsoContextUsage, Type.Null()]),
    /** What the next request would be assembled from, now. */
    next: EnsoContextMakeup,
    /** Every request on the branch, oldest first. */
    requests: Type.Array(EnsoContextRequest),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoThreadContext = Static<typeof EnsoThreadContext>
