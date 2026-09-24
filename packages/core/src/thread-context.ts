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
 * One thing that entered the context since the previous request — dsh's step brief "In" row — or,
 * in a request's detail, one that left it.
 *
 * @group Thread context
 */
export const EnsoContextAddition = Type.Object(
  {
    category: EnsoContextCategory,
    /** One line: a tool's name and its call's subject, a custom message's type, a summary. */
    label: Type.String(),
    /** The Context Browser element it is (`EnsoContextElement.key`), or the prefix of its elements. */
    key: Type.String(),
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
 * The `view` host row that opens the Context view over the chat (#361 phase 5). One spelling:
 * the host declares it, the page opens it by it.
 *
 * @group Thread context
 */
export const ENSO_CONTEXT_COMMAND = 'context'

/**
 * dsh-context's event kinds, over pi's entries:
 * - `inject`: context the harness added — an injected prompt section at the start, a later
 *   system message, an extension's custom message, a branch summary;
 * - `compact`: a compaction — its summary in place of what it replaced;
 * - `prune`: an extension's `context_edit` — a message removed or replaced in later requests;
 * - `switch`: the model or the thinking level changed;
 * - `mode`: the permission mode changed (picc's `modes` entry).
 *
 * @group Thread context
 */
export const EnsoContextEventKind = Type.Union([
  Type.Literal('inject'),
  Type.Literal('compact'),
  Type.Literal('prune'),
  Type.Literal('switch'),
  Type.Literal('mode'),
])
/** @group Thread context */
export type EnsoContextEventKind = Static<typeof EnsoContextEventKind>

/**
 * When and why the context changed — one row of dsh-context's Context Events.
 *
 * @group Thread context
 */
export const EnsoContextEvent = Type.Object(
  {
    kind: EnsoContextEventKind,
    /** One line: the section, the custom message's type, what the summary replaced, the new model. */
    label: Type.String(),
    /** The first request it reached; one past the last request when it reaches only the next. */
    turn: Type.Integer({ minimum: 1 }),
    /** When its entry was stored, ISO. */
    at: Type.String(),
    /** How it changed the context's estimate, signed; zero for a switch or a mode. */
    tokens: Type.Integer(),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextEvent = Static<typeof EnsoContextEvent>

/**
 * One thing a tool call did to a file — dsh-context's File Activity, from pi's own file tools:
 * `read` reads; `write` and `edit` write, with their line footprint; `grep`, `find` and `ls`
 * search — the searched path, and each file a search matched, with its hits. A `bash` command
 * names no file it touched, so it is not here.
 *
 * @group Thread context
 */
export const EnsoFileOperation = Type.Object(
  {
    /** As the call named it — relative to the thread's tree, or absolute. */
    path: Type.String(),
    kind: Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('search')]),
    /** The tool that did it. */
    tool: Type.String(),
    /** What it asked: a read's line range, a search's pattern; empty when nothing narrower. */
    subject: Type.String(),
    /** A write's estimated footprint: lines it wrote, lines it replaced. */
    added: Type.Integer({ minimum: 0 }),
    removed: Type.Integer({ minimum: 0 }),
    /** A search's matches in this file. */
    hits: Type.Integer({ minimum: 0 }),
    /** A read of an image file. */
    image: Type.Boolean(),
    isError: Type.Boolean(),
    /** The turn whose reply made the call. */
    turn: Type.Integer({ minimum: 1 }),
    at: Type.String(),
    /** The call's result in the Context Browser: its element key, in request `turn + 1` or the next. */
    resultKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoFileOperation = Static<typeof EnsoFileOperation>
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
    /** Every context event on the branch, oldest first. */
    events: Type.Array(EnsoContextEvent),
    /** Every file operation on the branch, oldest first. */
    files: Type.Array(EnsoFileOperation),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoThreadContext = Static<typeof EnsoThreadContext>

/**
 * An image in a context element: its kind and size, and its bytes when small enough to preview.
 *
 * @group Thread context
 */
export const EnsoContextImage = Type.Object(
  {
    mimeType: Type.String(),
    /** The decoded size. */
    bytes: Type.Integer({ minimum: 0 }),
    /** Base64, present only up to `ENSO_CONTEXT_IMAGE_PREVIEW_BYTES`. */
    data: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextImage = Static<typeof EnsoContextImage>

/**
 * Past this size an image is described, not carried: a request's detail is read whole, and a
 * screenshot's bytes would be most of it.
 *
 * @group Thread context
 */
export const ENSO_CONTEXT_IMAGE_PREVIEW_BYTES = 512 * 1024

/**
 * What a context element holds, as the browser draws it.
 * - `text`: a prompt section, a user or custom message, a summary — its text and any images;
 * - `tool`: one tool definition as the provider receives it;
 * - `reply`: an assistant message's parts in order — text, thinking, tool calls with arguments;
 * - `toolResult`: a result with the call's arguments beside it, and whether it failed.
 *
 * @group Thread context
 */
export const EnsoContextBody = Type.Union([
  Type.Object(
    { kind: Type.Literal('text'), text: Type.String(), images: Type.Array(EnsoContextImage) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('tool'),
      name: Type.String(),
      description: Type.String(),
      parameters: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('reply'),
      parts: Type.Array(
        Type.Union([
          Type.Object({ type: Type.Literal('text'), text: Type.String() }, { additionalProperties: false }),
          Type.Object({ type: Type.Literal('thinking'), text: Type.String() }, { additionalProperties: false }),
          Type.Object(
            { type: Type.Literal('toolCall'), name: Type.String(), arguments: Type.Unknown() },
            { additionalProperties: false },
          ),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('toolResult'),
      toolName: Type.String(),
      /** The call's arguments; absent when the call is not in the context (compacted away). */
      arguments: Type.Optional(Type.Unknown()),
      isError: Type.Boolean(),
      text: Type.String(),
      images: Type.Array(EnsoContextImage),
    },
    { additionalProperties: false },
  ),
])
/** @group Thread context */
export type EnsoContextBody = Static<typeof EnsoContextBody>

/**
 * One element of a request's context — dsh's browser row: a prompt section, a tool definition,
 * a message, a tool result.
 *
 * @group Thread context
 */
export const EnsoContextElement = Type.Object(
  {
    /** Stable across requests: the entry id, the message's place in it, and the section or tool. */
    key: Type.String(),
    category: EnsoContextCategory,
    /** One line naming it. */
    label: Type.String(),
    /** When its entry was stored, ISO; absent for what pi does not stamp. */
    at: Type.Optional(Type.String()),
    /** pi's estimate, as the makeup counts it. */
    tokens: Type.Integer({ minimum: 0 }),
    /** Not in the previous request's context: it entered since. */
    entered: Type.Boolean(),
    body: EnsoContextBody,
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextElement = Static<typeof EnsoContextElement>

/**
 * One request's context, element by element — what `GET /api/threads/:threadId/context/:request`
 * answers, read when the Context Browser opens a request rather than with the whole trend.
 *
 * @group Thread context
 */
export const EnsoContextRequestDetail = Type.Object(
  {
    threadId: Type.String(),
    /** The request's turn, or `next`: what the next request would be assembled from, now. */
    request: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('next')]),
    /** In context order. */
    elements: Type.Array(EnsoContextElement),
    /** What the previous request held that this one does not — a compaction's work, mostly. */
    left: Type.Array(EnsoContextAddition),
  },
  { additionalProperties: false },
)
/** @group Thread context */
export type EnsoContextRequestDetail = Static<typeof EnsoContextRequestDetail>
