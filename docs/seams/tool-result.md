# Seam: the tool result descriptor

The part of a tool's result that says how to render it, beside a textual form that is always present:
one payload, a renderer per surface, keyed by kind (#18). Glossary domain: **Surface** (*tool result
descriptor*, *renderer*) with the payload itself an **Observation** field. The contract is in
`@enso/core`; the one renderer that exists today is the web's.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/tool-result.md`.

## The contract

The descriptor. `kind` is open on purpose — the doc comment says what closing it would cost.

<!-- source: packages/core/src/tool-result.ts#EnsoToolResultDescriptor -->
```ts
/**
 * A tool result, described rather than rendered.
 *
 * ⚠ `kind` is `Type.String()` rather than a closed union on purpose: a vendor extension can
 * emit a kind we have never seen, and the unknown-kind path must be a visible fallback
 * rather than a validation failure at the boundary. Closing this union would turn an
 * unrecognised renderer into a dropped result.
 */
export const EnsoToolResultDescriptor = Type.Object({
  /** Renderer selector. Unknown values MUST fall back to the envelope's `content`. */
  kind: Type.String({ minLength: 1 }),
  /** Serializable props for the selected renderer. Never a rendered element. */
  props: Type.Record(Type.String(), Type.Unknown()),
  truncated: Type.Optional(EnsoTruncation),
})
```

<!-- source: packages/core/src/tool-result.ts#EnsoTruncation -->
```ts
/**
 * Truncation carried as data, never pre-rendered (#18).
 *
 * A terminal and a browser make different decisions about how to show "and 4,000 more
 * lines", and a pre-truncated string forces the terminal's choice onto the browser.
 */
export const EnsoTruncation = Type.Object({
  shown: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  unit: EnsoTruncationUnit,
})
```

<!-- source: packages/core/src/tool-result.ts#EnsoTruncationUnit -->
```ts
/**
 * Units a truncation can be counted in. Closed, because a surface must render each one.
 */
export const EnsoTruncationUnit = Type.Union([Type.Literal('lines'), Type.Literal('bytes'), Type.Literal('items')])
```

Where it sits in a result part's metadata bag, and why the key has no dot:

<!-- source: packages/core/src/tool-result.ts#ENSO_TOOL_RESULT_KEY -->
```ts
/**
 * The metadata key our descriptor occupies. Namespaced, because `metadata` is a shared bag.
 *
 * ⚠ NO DOT, DELIBERATELY. The first version was `"enso.toolResult"`, and a dot inside a key
 * is legal JSON but collides with every path-based accessor — `expect(...).toHaveProperty()`,
 * lodash `get`, JSONPath — all of which read `a.b` as "property b of property a". That cost
 * a failing test within minutes of the key being used, and it would have cost a consumer
 * the same confusion later, further from the cause.
 *
 * A colon namespaces just as well and is not path syntax anywhere.
 */
export const ENSO_TOOL_RESULT_KEY = 'enso:toolResult' as const
```

The reader every surface uses — it takes the bag, not the part, so a renderer with no state-layer
types can call it:

<!-- source: packages/core/src/tool-result.ts#readEnsoToolResultDescriptor -->
```ts
/**
 * Read the descriptor out of a `ToolResultPart`'s metadata.
 *
 * Takes the metadata bag rather than the whole part, so this stays usable from the TUI
 * renderer too — which has no TanStack types and must not gain them.
 */
export function readEnsoToolResultDescriptor(
  metadata: Record<string, unknown> | undefined,
): EnsoToolResultDescriptor | undefined {
  if (metadata === undefined) return undefined
  const candidate = metadata[ENSO_TOOL_RESULT_KEY]
  return isEnsoToolResultDescriptor(candidate) ? candidate : undefined
}
```

`isEnsoToolResultDescriptor` (`core/src/tool-result.ts#isEnsoToolResultDescriptor`) is the same schema compiled once at module load
(`core/src/tool-result.ts#descriptorValidator`); a malformed descriptor is rejected, never coerced. Those are the module's six top-level
exports. The descriptor is also a field of the observation that carries a result across the wire:

<!-- source: packages/core/src/observation.ts#EnsoToolResultObservation -->
```ts
/**
 * Tool output.
 *
 * ⚠ `text` is ACCUMULATED, not a delta — pi's docs say `partialResult` "contains the
 * accumulated output so far (not just the delta), allowing clients to simply replace their
 * display on each update." A client that appends will duplicate every chunk, and the bug
 * grows with output length. The field is named `text` rather than `delta` for that reason.
 */
export const EnsoToolResultObservation = Type.Object({
  kind: Type.Literal('tool-result'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  text: Type.String(),
  complete: Type.Boolean(),
  isError: Type.Boolean(),
  descriptor: Type.Optional(EnsoToolResultDescriptor),
})
```

Because `text` is accumulated, a partial result is not a small message: at pi's `bash` cadence
(`BASH_UPDATE_THROTTLE_MS = 100`, each update carrying `output.snapshot()`) writing every update
costs O(output × ticks). Measured on the real wire, a 3-second command producing 240 KB wrote
3724 KB of partial `observation` frames, and the browser's only consumer of the kind — the
`tool-result` case of `observationToAguiEvents` in `packages/web/src/to-agui.ts`, which returns
`[]` for `complete: false` — discarded all 30 of them. So **a partial `tool-result` does not cross
the follow at all** (#279): the wire carries the completed result, whole. The elision is in the one
place every frame crosses (`packages/web/src/server/follow.ts#writeFrame`):

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
function writeFrame(threads: ThreadRegistry, threadId: string, response: ServerResponse, frame: EnsoFollowFrame): void {
  if (frame.type === 'observation' && frame.observation.kind === 'tool-result' && !frame.observation.complete) return
  const name = frame.type === 'observation' ? frame.observation.kind : undefined
  threads.sentTail(threadId)?.record(frame.type, name, 'sent')
  response.write(`data: ${JSON.stringify(frame)}\n\n`)
}
```

Nothing above the wire changed: the mapper still builds the accumulated partial from
`tool_execution_update`, the observation log still records it at `trace`, and the `emitted` tail
of `/api/threads/:id/events` still counts it — only the `sent` tail and the socket omit it. A
browser that wants live tool output gets it by un-eliding this one branch and giving the adapter
a `complete: false` emission to make, not by changing the wire schema.

The web's half — renderers keyed by kind, and the one definition of what state a call is in:

<!-- source: packages/web/src/EnsoToolResult.tsx#EnsoRendererMap -->
```ts
/** Renderers keyed by descriptor `kind`. Absent keys are not an error — see the fallback. */
export type EnsoRendererMap = Record<string, (props: Record<string, unknown>) => React.ReactNode>
```

<!-- source: packages/web/src/EnsoToolResult.tsx#toolResultState -->
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
 *
 * `truncation` is pi's `TruncationResult` — the one shape every built-in tool (read, bash, grep,
 * find, ls) puts there (#411: this once read `shown`/`total`/`unit`, which pi never sends, so no
 * pi result ever had a descriptor). It is said in LINES whenever lines were dropped, even when
 * the byte limit is what cut them — the reader counts lines, and pi's own notice does
 * (`Showing lines 1-1841 of 3000 (50.0KB limit)`). Only a cut inside one line is said in bytes.
 */
export function descriptorFrom(toolName: string, details: unknown): EnsoToolResultDescriptor | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const truncation = (details as { truncation?: Partial<TruncationResult> | null }).truncation
  if (truncation?.truncated !== true) return undefined
  const { outputLines, totalLines, outputBytes, totalBytes } = truncation
  const kind = `pi.tool.${toolName}`
  if (typeof outputLines === 'number' && typeof totalLines === 'number' && outputLines < totalLines) {
    return { kind, props: {}, truncated: { shown: outputLines, total: totalLines, unit: 'lines' } }
  }
  if (typeof outputBytes !== 'number' || typeof totalBytes !== 'number') return undefined
  return { kind, props: {}, truncated: { shown: outputBytes, total: totalBytes, unit: 'bytes' } }
}
```

Only truncation is mapped, and the `kind` is `pi.tool.<toolName>` with empty `props` — the floor, not
the ceiling: a tool that wants a richer descriptor should emit one. **No tool does today.**
`web-fetch` and `web-search` return `details: undefined` on every path
(`web-fetch/index.ts#refusal`, `web-fetch/index.ts#renderResponse`; `web-search/index.ts#progressForwarder`, `web-search/index.ts#refusal`, `web-search/index.ts#renderUngrounded`, `web-search/index.ts#renderOutcome`),
so no extension of ours attaches a descriptor. `toolResultMetadata` (`host/map-events.ts#toolResultMetadata`) is the
one place the key is written onto a part's `metadata`.

**Carried** on the observation (`EnsoToolResultObservation.descriptor`), then onto the state layer's
result event under the same key — as an extra field, because that event declares `content` and
nothing else (the header of `packages/web/src/to-agui.ts`, and its `tool-result` case in `to-agui.ts#observationToAguiEvents`). **The state layer drops it there** (#411):
TanStack's processor writes a result part from `content`, state and error only, and keeps no extra
field, so live the part has no `metadata`. The follow connection therefore hands a finished result's
descriptor to the thread's `toolResultDescriptors` store before it pushes the result
(`follow-connection.ts#observe`, `thread-stores.ts#onToolResultDescriptor`). A resumed thread needs no store: its
parts are built from the stored transcript, `metadata` and all.

**Rendered by `EnsoToolResult`** (`packages/web/src/EnsoToolResult.tsx#EnsoToolResult`), reached from every tool
row but a guard refusal's (`selected-message-part.tsx#ToolCallRow`, `selected-message-part.tsx#SelectedMessagePart`) — a refused call is drawn as a receipt
by `guard-refusal.tsx` instead, its reason being the result's text (#407). The order is fixed: pending (`running…`) while the run
is open and no result has paired; `aborted` once the run has ended with none (#130); an errored
envelope renders its error and never consults the descriptor; then the descriptor — the
store's, else the one on `metadata` (`EnsoToolResult.tsx#useDescriptor`) — picks the rendering: none is the
textual fallback, and a `kind` with no renderer is the textual fallback WITH the truncation note under
it, because the truncation is data, not the renderer's. *The fallback
is the point, not a courtesy* (the header of `EnsoToolResult.tsx`): a type-tag design's characteristic failure is an unrenderable
payload showing as nothing, indistinguishable from a successful empty result. `toolResultState` is also
what the status bar's `running <tool>` reads (`thread-status.tsx#describeActivity`).

**The renderer map is empty** (`chat-screen.tsx#descriptorRenderers`): every result falls through to the text form,
which is exactly what the contract promises for an unknown kind, so empty is the honest default. A
renderer is added when a tool earns one. A truncated `read` or `bash` result therefore reads as its
text and `showing 1841 of 3000 lines` under it.

**Second implementation:** none for a surface. `packages/web/src/__tests__/tool-result.test.tsx` renders
`EnsoToolResult` over a one-entry `EnsoRendererMap` (`tool-result.test.tsx#renderers`) and pins the branches: a known kind renders
through its renderer, an unknown kind falls back to the envelope text and never to blank,
an error wins over a descriptor. The reader and validator are pinned pure. The terminal surface has no renderer today; the contract's design for it — ignore
`metadata`, render `content` — is stated in the module header (`core/src/tool-result.ts`), not exercised.

## What fences it

- **The docs gate**, for this page's fences.
- **The schema rule**: a shape is declared in `@enso/core` or does not exist; the descriptor is one
  TypeBox schema serving the static type, the wire and the validator (header of `core/src/tool-result.ts`).
- **The unknown-kind test** (in `tool-result.test.tsx`) is the one this seam is worth: it holds the
  rule that no descriptor can make a result invisible.
- **The vendor gate** keeps the runtime's types out of `EnsoToolResult.tsx` and `tool-result.ts`; the
  reader takes a plain record so the terminal can call it without the state layer's types
  (`core/src/tool-result.ts#readEnsoToolResultDescriptor`).

## What crosses it that should not

**Nothing of ours leaks.** The descriptor, the key, the truncation and the reader are declared once
in `@enso/core` and consumed by name. Two facts to know, neither a leak of this seam:

- **The descriptor is derived from the runtime's `details` field**, read by the mapper as the
  vendor's own type (`TruncationResult`, imported by `host/map-events.ts`; `result?.details` in `host/map-events.ts#mapPiEvent`). That is L2's
  event-side half, inventoried on the thread-runtime page; the mapper is the one place it is read.
- **The `kind` values in use are the runtime's tool names** — `pi.tool.bash`, `pi.tool.read` — minted
  by `descriptorFrom`. A kind is a string by contract and the renderer map has no entry for any
  of them, so today the vendor's name is data, not a dependency; a renderer keyed on `pi.tool.*` would
  make it one.

## Pivot cost

**Replace the web renderer** (a different state layer, a different component kit) and the files that
change are web-local: `EnsoToolResult.tsx` (the map, the state, the fallback), `selected-message-part.tsx`
and `thread-status.tsx` (its two callers), `to-agui.ts` (where the descriptor rides onto the stream),
and `chat-screen.tsx`'s empty map. `packages/core/src/tool-result.ts` and the observation's
`descriptor` field do not change; `tool-result.test.tsx`'s reader tests run against core
alone.

**Add the terminal renderer** — the second surface #18 designed for — and nothing in core changes: it
calls `readEnsoToolResultDescriptor(metadata)` on whatever bag it holds, keys its own map by `kind`, and
falls back to `content`. That is the pivot this seam was built to make cheap, and it has not been made.

**Replace the runtime** and the producer moves: `descriptorFrom` and its `TruncationResult` read go with
the mapper (thread-runtime page, L2); the descriptor a new loop's tools emit is whatever they put under
`ENSO_TOOL_RESULT_KEY`. Renderer, reader, schema and tests stay.
