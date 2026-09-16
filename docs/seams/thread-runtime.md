# Seam: the thread runtime

The contract the host implements for one thread and the server drives: prompt, answer a dialog, list
what it may run, read its mode, subscribe to its events, abort, clear its queue, dispose. Glossary
domain: **Thread** (the runtime session behind a live thread) and **Control** (what the routes tell
it). This is the seam a runtime replacement would re-implement — the one pivot the repo has already
survived (#69, RPC subprocess → in-process) crossed exactly here, with the three fakes below and the
refusal-path tests unchanged.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/thread-runtime.md`.

## The contract

The runtime itself. Function-bearing, and declared as a schema anyway — the one rule ("every shape is
a schema in `@zen/core`") beats a finer rule that needs explaining; the module header says so.

<!-- source: packages/core/src/thread-runtime.ts#ThreadRuntime -->
```ts
export const ThreadRuntime = Type.Object({
  /** Fire a prompt. Never awaits the run — see the section header. */
  prompt: Type.Unsafe<(request: PromptRequest, outcome: PromptOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * Deliver a human's answer (or cancellation) to a pending blocking dialog. Never throws:
   * an unknown or already-settled id is reported through the host's problem channel, so
   * callers do not wrap this in a try/catch.
   */
  answerDialog: Type.Unsafe<(response: DialogAnswer) => void>(Type.Function([Type.Unknown()], Type.Void())),
  /**
   * Every question a blocking dialog is waiting on, oldest first — what the follow's
   * snapshot lists (#114), and what an answer is validated against (#112: a select's value
   * handed to the extension VERBATIM is an injection seam unless the server checks it).
   * Empty once answered, cancelled, or never asked.
   */
  openDialogs: Type.Unsafe<() => ZenOpenDialog[]>(Type.Function([], Type.Unknown())),
  /** The slash commands this session can run — extension commands, prompt templates, skills. Synchronous: read off the live registry, no round trip. */
  listCommands: Type.Unsafe<() => RuntimeCommand[]>(Type.Function([], Type.Unknown())),
  /**
   * The permission-mode receipt a run starts with (#84): picc's CURRENT mode for this
   * session, computed the way picc itself restores it — the last persisted `modes` entry
   * in the session branch, else the initial `default` — and the modes this session may
   * switch to, picc's set intersected with the commands actually registered. picc keeps
   * the live value in a closure with no getter, so this is the only honest read.
   * Synchronous: it walks the in-memory branch and registry, no round trip — and it is
   * deliberately NOT `listCommands`, whose call count the refusal path's tests pin.
   */
  permissionModeState: Type.Unsafe<() => ZenPermissionModeState>(Type.Function([], Type.Unknown())),
  /**
   * Switch the mode (L3 step C, #162 workstream 4). The host translates to whatever its mode
   * extension accepts — for picc, the per-mode slash command, run as a prompt the same way
   * `prompt` runs one — so the caller says a mode and never a command. Fire-and-forget like
   * `prompt`: acceptance is `outcome.onAccepted` (an extension command's acceptance IS its
   * completion), the change itself is the `permission_mode` event on the feed, and a
   * rejection after acceptance is lost the same way. The caller has already checked the
   * mode is one `permissionModeState().available` offers.
   */
  setPermissionMode: Type.Unsafe<(mode: string, outcome: PromptOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * Receive every event in pi's rpc wire shape (the shape `map-events.ts` consumes), plus
   * `extension_ui_request` and `extension_error` records the host synthesises. Events
   * emitted before the FIRST subscriber are buffered and replayed to it, so nothing an
   * extension says at `session_start` is lost; with no subscriber after that, events are
   * dropped (#69 PR 2 — a held `agent_settled` would end the next run). Returns the
   * unsubscribe.
   *
   * The subscriber is told HOW each event reached it (`delivery`, #96): `replayed` from
   * that held buffer — emitted during the session's own start — or `live`. The mapper turns
   * it into the observation's `origin`, so the browser can group startup chatter without
   * guessing from position in the stream.
   *
   * ⚠ `Type.Unsafe` rather than `Type.Function([RuntimeEventSchema], …)`, and the reason is
   * a cost of declaring behaviour as a schema worth recording: the latter infers its
   * parameter as `Static<typeof RuntimeEventSchema>`, which DROPS the `& Record<string,
   * unknown>` intersection that makes an event's unmodelled fields reachable — consumers
   * would get `{ type: string }` and could not read `event.willRetry`. `Type.Unsafe<T>`
   * keeps the schema for uniformity and the precise type for consumers; it is "unsafe"
   * because the two are no longer derived from one another, so a schema change must be
   * mirrored in the annotation by hand.
   */
  subscribe: Type.Unsafe<(onEvent: (event: RuntimeEvent, delivery: EventDelivery) => void) => () => void>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /** Abort the in-flight run and wait until the agent is idle. The session survives. */
  abort: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
  /**
   * Drop every prompt waiting behind the run and return the texts, steering first (#75,
   * clear-and-restore): pi's `AgentSession.clearQueue()`, which also emits the
   * `queue_update` every follower reads. The stop route hands the texts back to the tab
   * that stopped, so nothing typed is lost and nothing runs unasked on the next turn.
   */
  clearQueue: Type.Unsafe<() => { steering: string[]; followUp: string[] }>(Type.Function([], Type.Unknown())),
  /** Cancel pending dialogs, tell extensions the session is shutting down, release the session. Idempotent. */
  dispose: Type.Unsafe<() => void>(Type.Function([], Type.Void())),
})
```

What crosses it inward — a prompt and what admission reports back:

<!-- source: packages/core/src/thread-runtime.ts#PromptRequest -->
```ts
export interface PromptRequest {
  message: string
  images?: readonly PromptImageContent[]
  /** Required by pi when the session is already streaming — otherwise `prompt` rejects. */
  streamingBehavior?: StreamingBehavior
}
```

<!-- source: packages/core/src/thread-runtime.ts#PromptOutcome -->
```ts
export interface PromptOutcome {
  /** Preflight accepted the prompt (or an extension command finished). NOT run completion. */
  onAccepted: () => void
  /** Preflight rejected the prompt before acceptance; the run never started. */
  onRejected: (reason: string) => void
}
```

<!-- source: packages/core/src/thread-runtime.ts#StreamingBehavior -->
```ts
/** What to do when a prompt arrives while the agent is already streaming. */
export const StreamingBehavior = Type.Union([Type.Literal('steer'), Type.Literal('followUp')])
```

<!-- source: packages/core/src/thread-runtime.ts#PromptImageContent -->
```ts
/** Base64 image content, accepted by `prompt`, `steer` and `follow_up`. */
export const PromptImageContent = Type.Object({
  type: Type.Literal('image'),
  data: Type.String(),
  mimeType: Type.String(),
})
```

A human's answer to a question the runtime is blocked on:

<!-- source: packages/core/src/thread-runtime.ts#DialogAnswer -->
```ts
/** An answer to a blocking dialog, keyed to the request id the `extension_ui_request` carried. */
export type DialogAnswer = { id: string } & ({ cancelled: true } | { value: string } | { confirmed: boolean })
```

What crosses it outward — the runtime's event, deliberately open, and how a subscriber received it:

<!-- source: packages/core/src/thread-runtime.ts#RuntimeEventSchema -->
```ts
/** One event from pi, in the rpc wire shape. Only `type` is constrained — see the header. */
export const RuntimeEventSchema = openObject({
  type: Type.String({ minLength: 1 }),
})
```

<!-- source: packages/core/src/thread-runtime.ts#RuntimeEvent -->
```ts
export type RuntimeEvent = Static<typeof RuntimeEventSchema> & OpenRecord
```

<!-- source: packages/core/src/thread-runtime.ts#EventDelivery -->
```ts
/**
 * How an event reached a subscriber (#96): `replayed` from the host's until-first-subscriber
 * buffer (the session's own start), or `live`. The two deliveries a subscriber can see — the
 * event tail's `held`/`dropped` provenances (#97) never reach one.
 */
export type EventDelivery = 'live' | 'replayed'
```

What the runtime says it can run — one entry per slash command:

<!-- source: packages/core/src/thread-runtime.ts#RuntimeCommand -->
```ts
/**
 * One entry from pi's `get_commands`.
 *
 * ⚠ `source` matters for a reason the field name does not convey: these are the ONLY
 * commands invokable over rpc. pi's docs are explicit that built-in TUI commands
 * (`/settings`, `/hotkeys`, …) are excluded and "would not execute if sent via `prompt`" —
 * so a `/`-prefixed message absent from this list is not a command at all, it is prose the
 * model will try to answer. See `session.ts` for why that has to be refused rather than
 * forwarded.
 */
export const RuntimeCommand = Type.Object({
  name: Type.String(),
  source: Type.Union([Type.Literal('extension'), Type.Literal('prompt'), Type.Literal('skill')]),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
})
```

## Who implements it, who consumes it

**Implemented once**, in the host: `packages/web/src/host/agent-host.ts` builds a `ThreadRuntime` per
thread inside `createSession` (the object literal at `const runtime: ThreadRuntime`) and hands it out
as `HostedThread.runtime`. Three host modules do the adapting behind it: `session-events.ts` turns
the runtime's session events into the open `RuntimeEvent` shape (replicated from the vendor's own
JSON-event mapping, so the mapper's 29 tests kept consuming exactly what they consumed over the pipe);
`extension-ui-context.ts` is the dialog side (an extension's `select` / `confirm` / `input` / `editor`
becomes an open dialog; `answerDialog` resolves it); `permission-dialog.ts` lifts the mode extension's
file-permission component into a `select`.

**Consumed by the server only.** `packages/web/src/server/thread-registry.ts` holds one per live
thread (`ThreadEntry.hosted.runtime`), subscribes it to the feed, and hands a `ThreadLease.runtime` to
the run that acquired the thread. `server/follow.ts` calls `prompt`, `listCommands`, `answerDialog`,
`openDialogs`, `permissionModeState` from the unary routes; the abort route goes through the registry,
whose `abort` is the one caller of `clearQueue` and `abort` (`thread-registry.ts:394,399`).
`server/index.ts` reads `permissionModeState` for the thread routes. The browser never sees it: what it
gets is observations on the follow.

**Proven implementable three times.** The fakes are the second implementation this seam has today —
each builds a `ThreadRuntime` from plain closures and drives the real server or registry over it:

| Fake | Where | What it exercises |
|---|---|---|
| `fakeHostedThread` | `packages/web/src/server/__tests__/server-handler.test.ts` | the whole HTTP surface over a scripted runtime: prompt, follow, dialog, abort, history, bundle |
| `fakeHosted` | `packages/web/src/server/__tests__/thread-registry.test.ts` | the registry's lifecycle: acquire, lease, release, idle, dispose, the abort-then-prompt race |
| the inline `runtime` | `packages/web/src/server/__tests__/follow.test.ts` | the prompt/follow split frame by frame: snapshot, `seq`, status, dialog outcomes |

A fourth, `bundle-route.test.ts`, builds a minimal one to give the bundle a live thread to inspect.

## What fences it

- **The vendor gate** (`test/vendor-gate.test.ts`, #145): only `packages/web/src/host/` and
  `packages/harness/extensions/` may import the runtime's package. The server and the browser reach
  the runtime through this contract and nothing else; a vendor import anywhere else is a gate failure
  with the file named.
- **The glossary gate** (`test/glossary-gate.test.ts`, #165): the seam's own names may not regress —
  `PiSession`, `pi-rpc`, and any `Pi`-prefixed identifier outside the host are refused. The contract
  was called `PiSession` in a module called `pi-rpc.ts` until #166.
- **Two allowlist lines** name the leak below: `packages/web/src/rpc/map-events.ts` and
  `packages/web/src/rpc/branch-to-messages.ts` in the glossary gate's `RETIRED_ALLOWED`, each with
  its reason.

## What crosses it that should not

**`RuntimeEvent` is open on purpose, and the mapper reads inside it.** The contract constrains only
`type`; everything else on an event is the runtime's own shape, carried verbatim so a new event kind
becomes `unmapped` rather than a parse failure. That is the right choice at the seam — and it means
the mapper (`packages/web/src/rpc/map-events.ts`, which sits *above* the host) reads the vendor's
field names directly: `PiContentPart`, `PiToolDetails`, `event.assistantMessageEvent`, `event.partialResult`.
This is leak **L2**, the event-side half (`.local/refactor/goals.md` §2; #162 workstream 4). The
persistence-side half is on the storage page. Fixing it means the host produces the observation, or an
event shape of ours, and the mapper stops knowing the vendor's field names; until then the two files
are named in the glossary gate's allowlist so the leak is inventory, not surprise.

**`listCommands` returns the runtime's command entries** (`RuntimeCommand`: name, source,
description). The shape is ours by declaration; its `source` values are the runtime's categories
carried as strings. Small, stated.

Nothing else. Prompt, outcome, answer, delivery and streaming behavior are ours, and the runtime's
own types do not appear in this module (the vendor gate holds that).

## Pivot cost

Replace the runtime and the files that change are the host's: `agent-host.ts` (build a `ThreadRuntime`
over the new loop; the storage seam lives in the same file — see `storage.md`), `session-events.ts`
(produce `RuntimeEvent`s, or retire the wire shape and produce observations directly),
`extension-ui-context.ts` and `permission-dialog.ts` (or their equivalents, if the new loop has
extensions and questions at all) — plus `map-events.ts` for as long as L2 stands, because it reads the
old loop's field names. The server, the registry, the four routes, the follow, the browser and every
test that drives the server over a fake do not change: that is what the three fakes prove today, and
it is the whole point of the seam.
