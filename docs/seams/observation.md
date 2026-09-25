# Seam: the observation vocabulary

The contract between what the runtime emits and what a surface renders: one semantic fact about a
thread, in our words, and the frame that carries it on the follow. Glossary domain: **Observation** —
three words for three hops, the runtime emits *events*, the host's mapper turns them into
*observations*, the follow carries *frames*; and one rule for every surface that looks: observation
reads, writes nothing, records nothing, controls nothing (#144). This is the wire between server and
browser (#112) and the thing a log record at `debug` describes.

The kinds are not restated here: [`../reference/observations.md`](../reference/observations.md) is
generated from the union, mapper, prompt route, browser adapter, every chunk name and its
browser consumer — one row per kind — and the docs gate diffs it against its generator.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/observation.md`.

## The contract

The union. Closed, and with no "skip" member by design (module header, `observation.ts` lines 9–13):
an event the mapper has no word for becomes `unmapped`, so dropping is inexpressible.

<!-- source: packages/core/src/observation.ts#EnsoObservation -->
```ts
/**
 */
export const EnsoObservation = Type.Union([
  EnsoTextDelta,
  EnsoThinkingDelta,
  EnsoToolCall,
  EnsoToolResultObservation,
  EnsoCustomEntry,
  EnsoPermissionMode,
  EnsoPermissionModeRejected,
  EnsoModelObservation,
  EnsoMessageStart,
  EnsoMessageEnd,
  EnsoSessionUsageObservation,
  EnsoTurnStart,
  EnsoTurnEnd,
  EnsoProviderRefused,
  EnsoProviderRetrying,
  EnsoProviderRetryEnded,
  EnsoQueue,
  EnsoPromptRejected,
  EnsoExtensionError,
  EnsoExtensionUiRequest,
  EnsoDialogSettled,
  EnsoRunEnded,
  EnsoSettled,
  EnsoUnmapped,
])
```

Each member is one `Type.Object` declared beside its `kind` literal in `observation.ts` — the schema
column of [`../reference/observations.md`](../reference/observations.md) names every one, so they are
not repeated here. The one shape shared across kinds is the accounting that rides on a text delta and a
message end:

<!-- source: packages/core/src/observation.ts#EnsoUsage -->
```ts
/**
 * Token and cost accounting, present on `message_update`, assistant and tool messages.
 */
export const EnsoUsage = Type.Object({
  input: Type.Integer({ minimum: 0 }),
  output: Type.Integer({ minimum: 0 }),
  cacheRead: Type.Integer({ minimum: 0 }),
  cacheWrite: Type.Integer({ minimum: 0 }),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
})
```

The frames. Every follow opens with exactly one snapshot, then observations each with a `seq` greater
than the last, and status frames (`follow.ts` header, lines 11–15):

<!-- source: packages/core/src/follow.ts#EnsoFollowFrame -->
```ts
export const EnsoFollowFrame = Type.Union([EnsoFollowSnapshot, EnsoFollowObservation, EnsoFollowStatus])
```

<!-- source: packages/core/src/follow.ts#EnsoFollowSnapshot -->
```ts
/**
 * The server↔browser wire (#112): a thread's feed, as the follow route serves it.
 *
 * Every follow opens with exactly one `snapshot` — the thread as of `asOfSeq` — and then
 * carries only `observation` frames (each `seq` greater than the last) and `status`
 * frames (the thread's lifecycle as the server sees it). A reconnect is a new follow and
 * a new snapshot; there is no cursor to resume from, because the snapshot IS the resync
 * (deepseek-harness: one complete snapshot per generation, then only deltas).
 *
 * The payload is `EnsoObservation` — the same layer the event tails and the debug pane
 * reason in. AG-UI is not on this wire; a browser adapter derives it if a renderer wants it
 * (`docs/architecture.md`, decided constraints).
 */
export const EnsoFollowSnapshot = Type.Object(
  {
    type: Type.Literal('snapshot'),
    threadId: Type.String(),
    /** The feed's position this snapshot is exact as of; every later observation's `seq` is greater. */
    asOfSeq: Type.Integer({ minimum: 0 }),
    /** A pi session exists for the thread on this server. False: served cold from the file, or empty. */
    live: Type.Boolean(),
    busy: Type.Boolean(),
    /** See `EnsoThreadSummary.generation`. */
    generation: Type.Integer({ minimum: 0 }),
    permissionMode: EnsoPermissionModeState,
    /** The session's model and thinking level (#338 slice 2); `null` when the thread is not live — a stored thread does not say. */
    model: Type.Union([EnsoModelState, Type.Null()]),
    /**
     * The tree pi reads and writes for this thread (#44), AS OF THIS SNAPSHOT — the live session's
     * own cwd, or, when the thread is not live, the one this server builds every session in
     * (`server/index.ts` takes it from its own launch arguments, never a request). Not re-sent
     * when a session is built mid-follow: it cannot differ, since the host creates and lists
     * sessions by that same cwd. What makes a wrong-project session visible.
     *
     * ⚠ Adding a field here is wire-breaking for an OPEN TAB: the schema is closed, so a page and
     * server of different versions reject each other's snapshots. The page says so and asks for a
     * reload (`follow-connection.ts`) rather than going quietly stale.
     */
    cwd: Type.String(),
    /**
     * What the session has spent and how full its context is (#45), as of this snapshot — pi's
     * totals from the live session, or from the file when the thread is not live (then with no
     * `context`). Later changes arrive as `session-usage` observations, each the whole state.
     */
    usage: EnsoSessionUsage,
    /** The branch as TanStack `UIMessage`s — `Unknown` because the shape is the renderer's, not enso's. */
    messages: Type.Array(Type.Unknown()),
    /** Every question pi is blocked on right now, oldest first (#114). Empty when not live. */
    openDialogs: Type.Array(EnsoOpenDialog),
    interrupted: Type.Optional(EnsoInterruptedTail),
  },
  { additionalProperties: false },
)
```

<!-- source: packages/core/src/follow.ts#EnsoFollowObservation -->
```ts
export const EnsoFollowObservation = Type.Object(
  {
    type: Type.Literal('observation'),
    seq: Type.Integer({ minimum: 1 }),
    observation: EnsoObservation,
  },
  { additionalProperties: false },
)
```

<!-- source: packages/core/src/follow.ts#EnsoFollowStatus -->
```ts
export const EnsoFollowStatus = Type.Object(
  {
    type: Type.Literal('status'),
    live: Type.Boolean(),
    busy: Type.Boolean(),
    generation: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
```

## Who implements it, who consumes it

**Produced in two places.** The mapper, `mapPiEvent` in `packages/web/src/host/map-events.ts` (below
the thread-runtime seam since L2, #162 workstream 4)
(line 229, top-level; not fenced here because the declaration is the whole 120-line switch): one
runtime event in, one observation out, never `undefined` (header lines 25–28). Its second parameter is
the delivery the host tagged (#96): `replayed` becomes `origin: "session-start"` on a ui request, `live`
becomes `"run"` (lines 225–227). The one kind the server synthesises itself is `prompt-rejected`: the
prompt route in `packages/web/src/server/follow.ts` announces it (line 256) when the runtime refuses
a prompt after its receipt went out. Both are grounded in the kinds table's "Produced by" column.

**Minted once.** The registry, `packages/web/src/server/thread-registry.ts`, is the only place a `seq`
is assigned: `publishObservation` (line 347) increments the feed's counter, records the observation
(`observation-log.ts` — `info` for the spine kinds, `debug` for every observation, `trace` with the
payload), then publishes. The feed subscribes the runtime once per live thread and routes every event
through the mapper (lines 332–334); the prompt route's `announce` (line 516) enters the same counter.

**Consumed by the follow route and the browser.** `followThread` (`server/follow.ts` line 154) writes
one frame per feed frame — `observation` with its `seq`, `status` with `live`/`busy`/`generation`
(lines 160–170) — after a snapshot taken in the same tick as the subscription, exact as of `asOfSeq`
(lines 144–148, 176–187). In the browser `packages/web/src/follow-connection.ts` checks every frame
against `EnsoFollowFrame` with a validator compiled at module load (line 497, compiled at 71), pushes
the snapshot and status frames whole as chunks named by their type (lines 383–389), closes runs on
`settled` (line 396) and matches `prompt-rejected` to the prompt it
queued (line 400). `packages/web/src/to-agui.ts` is the adapter proper: observation → state-layer
chunk, run in the page, never serialised or stored (header lines 5–34).

**The resync rule.** Nothing is replayed by cursor. A reconnect opens a new follow and gets a new
snapshot (`follow.ts` header lines 13–15; `server/follow.ts` lines 176–187); when the last follower
leaves, the registry forgets the feed and `seq` restarts with the next follower, snapshot-first
(`thread-registry.ts` lines 556–564). `asOfSeq` is the watermark the snapshot is complete through.

## What fences it

- **The kinds oracle**: `packages/core/src/__tests__/observation-kinds.ts` (`@enso/core/observation-kinds`) derives every `kind`
  literal from the union itself — never a hard-coded count, which drifted once (566e8b1). Two sweeps
  compare against it: `host/__tests__/observation-sweep.test.ts` proves every event the mapper
  handles, plus the server-synthesised kinds, validates against `EnsoObservation` and covers every
  member; `__tests__/to-agui.test.ts` proves the adapter handles every member. The oracle lives
  in `@enso/core` because both sweeps sit in zones that may import only `core` (#173).
- **The generated inventory**: `docs/reference/observations.md` must equal its generator's stdout
  (`test/docs-gate.test.ts`); a kind with no producer or consumer is printed as a finding, not omitted.
- **Closed frames**: the three frame schemas are `additionalProperties: false` (`follow.ts` lines
  40, 50, 61); the browser refuses a frame that fails `EnsoFollowFrame` with a problem record, not a
  crash (`follow-connection.ts` lines 497–500).
- **The vendor gate** (`test/vendor-gate.test.ts`, #145): the mapper and the adapter import
  `@enso/core`, not the runtime's package.

## What crosses it that should not

**`EnsoQueue` keeps the runtime's SHAPE, under our words (#216).** pi's `queue_update` holds two
lists — steering messages, which enter at the next step boundary, and follow-ups, which enter after
the run settles — and `observation.ts#EnsoQueue` has the same two as `interrupting` / `enqueued`,
mapped in `host/map-events.ts` where pi's field names are read and nowhere else. The inbound half is
`EnsoPromptAdmission` on the prompt body (`thread-runtime.md` → *What crosses it that should not*).
What still crosses is the SPLIT, and no consumer uses it: the router concatenates the two lists into
one `ThreadStores.queue`, and the abort receipt concatenates them too. It survives because a follower
renders what is waiting and "this one cuts in" is a different sentence from "this one waits its
turn"; a runtime with one queue class, or three, changes this shape and nothing above it.

**`messages` on the snapshot is the state layer's shape.** `EnsoFollowSnapshot.messages`
(`follow.ts` line 35), carried as `Type.Array(Type.Unknown())`: not an observation but the storage
seam's rebuild, built by `server/transcript-to-messages.ts` and put on the opening snapshot by the
follow route — see `storage.md`, and `presentation.md` → *What crosses it that should not*, which
prices it. It is on THIS wire, with `Unknown` in place of a shape, and no client reads it off the
snapshot today.

**`EnsoUnmapped.event` is `Type.Unknown()`** by decision, and is the one place a raw event crosses to
the browser whole.

**The mapper reads the runtime's field names — below the seam.** `map-events.ts` declares
`PiContentPart` and `PiToolDetails` and reads `event.assistantMessageEvent`; since L2 (#162 workstream
4) it lives under `host/`, where the vendor's names are allowed, and the host calls it at delivery so
`ThreadRuntime.subscribe` hands out observations. Nothing above the host reads an event.

**Nothing of the browser's old parallel vocabulary, since #162 workstream 5.** The browser used to
route observations to its stores by a second set of names — eleven `Enso.*` custom events, `enso.mode`
for a `permission-mode`, `enso.notify` for an `extension-ui-request`, a forged notify for a
`permission-mode-rejected` — and a rename had two sides to land on. A CUSTOM chunk is now named by
`EnsoObservation.kind` and carries the observation whole (`to-agui.ts#custom`); the snapshot and status
frames cross whole, named by `EnsoFollowFrame.type`; the one chunk that is neither — the follow ending
under the page — is `FOLLOW_ENDED_CUSTOM_EVENT`, declared by its only reader, the router.
`custom-event-names.ts` is gone.

Ordered live crossings, then the deliberate holes, then the closed receipts: the bold lead of this
section is the architecture table's leak column (`scripts/docs/seams-table.ts`), so a paragraph
saying "nothing" must not stand in front of one saying "something" (#216, #219).

## Pivot cost

Replace the runtime and the vocabulary does not move: the union, the frames, the follow route, the
registry's feed, the browser adapter, the kinds table and both sweeps stay. What changes is the
producer — the host's `map-events.ts` learns the new loop's event names, or maps its typed events
directly. The fake that drives the server (`follow.test.ts` in particular, which asserts frames one
by one: snapshot, `seq`, status, dialog outcomes) emits observations and proves the consumer side
today without a runtime at all.

Replace the state layer instead and the adapter goes: `to-agui.ts` and the
router — "a renderer that stops speaking AG-UI deletes it and the adapter" (`to-agui.ts` line 28).
The observation vocabulary survives whole, and so does every frame that carries one. The wire does
NOT: `EnsoFollowSnapshot.messages` is the state layer's shape on this wire and
`EnsoThreadHistory.messages` is the same shape on the history route, both as `Unknown` — so both
change format with no schema diff to show it, which is why `presentation.md` → *Pivot cost* names
seven sites and not three.
