# Seam: the tool result descriptor

The part of a tool's result that says how to render it, beside a textual form that is always present:
one payload, a renderer per surface, keyed by kind (#18). Glossary domain: **Surface** (*tool result
descriptor*, *renderer*) with the payload itself an **Observation** field. The contract is in
`@zen/core`; the one renderer that exists today is the web's.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/tool-result.md`.

## The contract

The descriptor. `kind` is open on purpose — the doc comment says what closing it would cost.

<!-- source: packages/core/src/tool-result.ts#ZenToolResultDescriptor -->
```ts
/**
 * A tool result, described rather than rendered.
 *
 * ⚠ `kind` is `Type.String()` rather than a closed union on purpose: a vendor extension can
 * emit a kind we have never seen, and the unknown-kind path must be a visible fallback
 * rather than a validation failure at the boundary. Closing this union would turn an
 * unrecognised renderer into a dropped result.
 */
export const ZenToolResultDescriptor = Type.Object({
  /** Renderer selector. Unknown values MUST fall back to the envelope's `content`. */
  kind: Type.String({ minLength: 1 }),
  /** Serializable props for the selected renderer. Never a rendered element. */
  props: Type.Record(Type.String(), Type.Unknown()),
  truncated: Type.Optional(ZenTruncation),
})
```

<!-- source: packages/core/src/tool-result.ts#ZenTruncation -->
```ts
/**
 * Truncation carried as data, never pre-rendered (#18).
 *
 * A terminal and a browser make different decisions about how to show "and 4,000 more
 * lines", and a pre-truncated string forces the terminal's choice onto the browser.
 */
export const ZenTruncation = Type.Object({
  shown: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  unit: ZenTruncationUnit,
})
```

<!-- source: packages/core/src/tool-result.ts#ZenTruncationUnit -->
```ts
/** Units a truncation can be counted in. Closed, because a surface must render each one. */
export const ZenTruncationUnit = Type.Union([Type.Literal('lines'), Type.Literal('bytes'), Type.Literal('items')])
```

Where it sits in a result part's metadata bag, and why the key has no dot:

<!-- source: packages/core/src/tool-result.ts#ZEN_TOOL_RESULT_KEY -->
```ts
/**
 * The metadata key our descriptor occupies. Namespaced, because `metadata` is a shared bag.
 *
 * ⚠ NO DOT, DELIBERATELY. The first version was `"zen.toolResult"`, and a dot inside a key
 * is legal JSON but collides with every path-based accessor — `expect(...).toHaveProperty()`,
 * lodash `get`, JSONPath — all of which read `a.b` as "property b of property a". That cost
 * a failing test within minutes of the key being used, and it would have cost a consumer
 * the same confusion later, further from the cause.
 *
 * A colon namespaces just as well and is not path syntax anywhere.
 */
export const ZEN_TOOL_RESULT_KEY = 'zen:toolResult' as const
```

The reader every surface uses — it takes the bag, not the part, so a renderer with no state-layer
types can call it:

<!-- source: packages/core/src/tool-result.ts#readZenToolResultDescriptor -->
```ts
/**
 * Read the descriptor out of a `ToolResultPart`'s metadata.
 *
 * Takes the metadata bag rather than the whole part, so this stays usable from the TUI
 * renderer too — which has no TanStack types and must not gain them.
 */
export function readZenToolResultDescriptor(
  metadata: Record<string, unknown> | undefined,
): ZenToolResultDescriptor | undefined {
  if (metadata === undefined) return undefined
  const candidate = metadata[ZEN_TOOL_RESULT_KEY]
  return isZenToolResultDescriptor(candidate) ? candidate : undefined
}
```

`isZenToolResultDescriptor` (`tool-result.ts:96-99`) is the same schema compiled once at module load
(`:88-94`); a malformed descriptor is rejected, never coerced. Those are the module's six top-level
exports. The descriptor is also a field of the observation that carries a result across the wire:

<!-- source: packages/core/src/observation.ts#ZenToolResultObservation -->
```ts
/**
 * Tool output.
 *
 * ⚠ `text` is ACCUMULATED, not a delta — pi's docs say `partialResult` "contains the
 * accumulated output so far (not just the delta), allowing clients to simply replace their
 * display on each update." A client that appends will duplicate every chunk, and the bug
 * grows with output length. The field is named `text` rather than `delta` for that reason.
 */
export const ZenToolResultObservation = Type.Object({
  kind: Type.Literal('tool-result'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  text: Type.String(),
  complete: Type.Boolean(),
  isError: Type.Boolean(),
  descriptor: Type.Optional(ZenToolResultDescriptor),
})
```

Because `text` is accumulated, a partial result is not a small message: at pi's `bash` cadence
(`BASH_UPDATE_THROTTLE_MS = 100`, each update carrying `output.snapshot()`) writing every update
costs O(output × ticks). Measured on the real wire, a 3-second command producing 240 KB wrote
3724 KB of partial `observation` frames, and the browser's only consumer of the kind — the
`tool-result` case of `observationToAguiEvents` in `packages/web/src/to-agui.ts`, which returns
`[]` for `complete: false` — discarded all 30 of them. So **a partial `tool-result` does not cross
the follow at all** (#279): the wire carries the completed result, whole. The elision is in the one
place every frame crosses (`packages/web/src/server/follow.ts:98-103`):

<!-- source: packages/web/src/server/follow.ts#writeFrame -->
```ts
/**
 * Write one frame, recording it into the thread's sent tail (#97) when the thread is live
 * — the one place every frame crosses to a browser, so the record and the wire agree.
 *
 * ⚠ One frame does not cross at all (#279): a `tool-result` observation that is not
 * complete. pi's tools report progress with the ACCUMULATED output, not a delta (see
 * `docs/seams/tool-result.md`), and `bash` does it every 100 ms, so writing them costs
 * O(output × ticks) — measured, a 3-second command producing 240 KB of output wrote
 * 3724 KB of partial frames. The only browser consumer of the kind,
 * `observationToAguiEvents` (`to-agui.ts`, its `tool-result` case), returns `[]` for
 * `complete: false`: all 3724 KB were serialised, pushed through the SSE socket and
 * schema-checked for no rendered pixel. The OBSERVATION is untouched — the feed still
 * numbers it, `recordObservation` still logs it and the emitted tail still counts it, so
 * the partial text is still in the `trace` record and in `/api/threads/:id/events`; this
 * elides the WIRE. Frame `seq` therefore skips the elided numbers, which nothing on the
 * browser side reads, and the sent tail does not record them either: it claims only what
 * crossed.
 */
function writeFrame(threads: ThreadRegistry, threadId: string, response: ServerResponse, frame: ZenFollowFrame): void {
  if (frame.type === 'observation' && frame.observation.kind === 'tool-result' && !frame.observation.complete) return
  const name = frame.type === 'observation' ? frame.observation.kind : undefined
  threads.peek(threadId)?.sent.record(frame.type, name, 'sent')
  response.write(`data: ${JSON.stringify(frame)}\n\n`)
}
```

Nothing above the wire changed: the mapper still builds the accumulated partial from
`tool_execution_update`, the observation log still records it at `trace`, and the `emitted` tail
of `/api/threads/:id/events` still counts it — only the `sent` tail and the socket omit it. A
browser that wants live tool output gets it by un-eliding this one branch and giving the adapter
a `complete: false` emission to make, not by changing the wire schema.

The web's half — renderers keyed by kind, and the one definition of what state a call is in:

<!-- source: packages/web/src/ZenToolResult.tsx#ZenRendererMap -->
```ts
/** Renderers keyed by descriptor `kind`. Absent keys are not an error — see the fallback. */
export type ZenRendererMap = Record<string, (props: Record<string, unknown>) => React.ReactNode>
```

<!-- source: packages/web/src/ZenToolResult.tsx#toolResultState -->
```ts
/** `runOpen`: the run this call belongs to is still in flight — the caller knows (`sessionGenerating && isLastMessage`), the result cannot. */
export function toolResultState(result: ToolResultPart | undefined, runOpen: boolean): ToolResultState {
  if (result === undefined) return runOpen ? { status: 'pending' } : { status: 'aborted' }
  if (result.error !== undefined) return { status: 'error', result, error: result.error }
  return { status: 'done', result }
}
```

## Who implements it, who consumes it

**Produced by the host, and only the host.** `packages/web/src/host/map-events.ts` builds a descriptor
from the runtime's `details` bag on `tool_execution_update` and `tool_execution_end`, and
`host/transcript.ts` does the same from a stored result on a cold read (the transcript's `tool-result`
entry carries it), so a live transcript and a resumed one agree. The builder:

<!-- source: packages/web/src/host/map-events.ts#descriptorFrom -->
```ts
/**
 * Build our descriptor from pi's `details`.
 *
 * ⚠ Only truncation is mapped today, and deliberately: `details` is tool-specific and
 * inventing a `kind` per tool here would put rendering decisions in the transport. A tool
 * that wants a richer descriptor should emit one; this is the floor, not the ceiling.
 */
export function descriptorFrom(toolName: string, details: unknown): ZenToolResultDescriptor | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const truncation = (details as PiToolDetails).truncation
  if (truncation === null || truncation === undefined) return undefined
  const { shown, total, unit } = truncation
  if (typeof shown !== 'number' || typeof total !== 'number') return undefined
  return {
    kind: `pi.tool.${toolName}`,
    props: {},
    truncated: {
      shown,
      total,
      unit: unit === 'bytes' || unit === 'items' ? unit : 'lines',
    },
  }
}
```

Only truncation is mapped, and the `kind` is `pi.tool.<toolName>` with empty `props` — the floor, not
the ceiling: a tool that wants a richer descriptor should emit one (`:72-78`). **No tool does today.**
`web-fetch` and `web-search` return `details: undefined` on every path
(`packages/harness/extensions/web-fetch/index.ts:170,277,309`; `web-search/index.ts:339,344,358,388`),
so no extension of ours attaches a descriptor. `toolResultMetadata` (`map-events.ts:97-101`) is the
one place the key is written onto a part's `metadata`.

**Carried** on the observation (`ZenToolResultObservation.descriptor`), then onto the state layer's
result event under the same key — as an extra field, because that event declares `content` and
nothing else (`packages/web/src/to-agui.ts:30-42,126-128`).

**Rendered by `ZenToolResult`** (`packages/web/src/ZenToolResult.tsx:69-129`), reached from every tool
row (`selected-message-part.tsx:103-106,166`). The order is fixed: pending (`running…`) while the run
is open and no result has paired; `aborted` once the run has ended with none (#130); an errored
envelope renders its error and never consults the descriptor (`:103-113`); then the descriptor is read
off `metadata` — none, or a `kind` with no renderer, is the textual fallback (`:115-121`). *The fallback
is the point, not a courtesy* (`:11-14`): a type-tag design's characteristic failure is an unrenderable
payload showing as nothing, indistinguishable from a successful empty result. `toolResultState` is also
what the status bar's `running <tool>` reads (`thread-status.tsx:5`).

**The renderer map is empty** (`chat-screen.tsx:122-129`): every result falls through to the text form,
which is exactly what the contract promises for an unknown kind, so empty is the honest default. A
renderer is added when a tool earns one.

**Second implementation:** none for a surface. `packages/web/src/__tests__/tool-result.test.tsx` renders
`ZenToolResult` over a one-entry `ZenRendererMap` (`:15-17`) and pins the branches: a known kind renders
through its renderer (`:39-43`), an unknown kind falls back to the envelope text and never to blank
(`:46-50`), an error wins over a descriptor (`:73-77`). The reader and validator are pinned pure
(`:23-33`). The terminal surface has no renderer today; the contract's design for it — ignore
`metadata`, render `content` — is stated in the module header (`tool-result.ts:24-28`), not exercised.

## What fences it

- **The docs gate**, for this page's fences.
- **The schema rule**: a shape is declared in `@zen/core` or does not exist; the descriptor is one
  TypeBox schema serving the static type, the wire and the validator (`tool-result.ts:7-13`).
- **The unknown-kind test** (`tool-result.test.tsx:46-50`) is the one this seam is worth: it holds the
  rule that no descriptor can make a result invisible.
- **The vendor gate** keeps the runtime's types out of `ZenToolResult.tsx` and `tool-result.ts`; the
  reader takes a plain record so the terminal can call it without the state layer's types
  (`tool-result.ts:104-105`).

## What crosses it that should not

**Nothing of ours leaks.** The descriptor, the key, the truncation and the reader are declared once
in `@zen/core` and consumed by name. Two facts to know, neither a leak of this seam:

- **The descriptor is derived from the runtime's `details` field**, read by the mapper under the
  vendor's name (`PiToolDetails`, `map-events.ts:39-43`; `result?.details` at `:274-276`). That is L2's
  event-side half, inventoried on the thread-runtime page; the mapper is the one place it is read.
- **The `kind` values in use are the runtime's tool names** — `pi.tool.bash`, `pi.tool.read` — minted
  by `descriptorFrom` (`:86`). A kind is a string by contract and the renderer map has no entry for any
  of them, so today the vendor's name is data, not a dependency; a renderer keyed on `pi.tool.*` would
  make it one.

## Pivot cost

**Replace the web renderer** (a different state layer, a different component kit) and the files that
change are web-local: `ZenToolResult.tsx` (the map, the state, the fallback), `selected-message-part.tsx`
and `thread-status.tsx` (its two callers), `to-agui.ts` (where the descriptor rides onto the stream),
and `chat-screen.tsx`'s empty map. `packages/core/src/tool-result.ts` and the observation's
`descriptor` field do not change; `tool-result.test.tsx`'s reader tests (`:23-33`) run against core
alone.

**Add the terminal renderer** — the second surface #18 designed for — and nothing in core changes: it
calls `readZenToolResultDescriptor(metadata)` on whatever bag it holds, keys its own map by `kind`, and
falls back to `content`. That is the pivot this seam was built to make cheap, and it has not been made.

**Replace the runtime** and the producer moves: `descriptorFrom` and its `PiToolDetails` read go with
the mapper (thread-runtime page, L2); the descriptor a new loop's tools emit is whatever they put under
`ZEN_TOOL_RESULT_KEY`. Renderer, reader, schema and tests stay.
