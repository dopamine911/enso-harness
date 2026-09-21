# Seam: the thread runtime

The contract the host implements for one thread and the server drives: prompt, answer a dialog, list
what it may run, read its mode, subscribe to its events, abort, clear its queue, dispose. Glossary
domain: **Thread** (the runtime session behind a live thread) and **Control** (what the routes tell
it). This is the seam a runtime replacement would re-implement — the one pivot the repo has already
survived (#69, RPC subprocess → in-process) crossed exactly here, with the fake below and the
refusal-path tests unchanged.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/thread-runtime.md`.

## The contract

The runtime itself. Function-bearing, and declared as a schema anyway — the one rule ("every shape is
a schema in `@zen/core`") beats a finer rule that needs explaining; the module header says so.

<!-- source: packages/core/src/thread-runtime.ts#ThreadRuntime -->
```ts
/** ⚠ Function-bearing — the one schema the module header's rule is written for. */
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
   * Receive every observation of this thread (L2, #162 workstream 4): the runtime's events
   * mapped to `ZenObservation` BELOW this seam, plus what the host itself observes — a
   * dialog it opened, an extension's error, a mode its extension persisted. Nothing of the
   * runtime's own event shape reaches a subscriber. Observations emitted before the FIRST
   * subscriber are buffered and replayed to it, so nothing an extension says at start-up is
   * lost; with no subscriber after that, they are dropped (#69 PR 2 — a held `settled` would
   * end the next run). A replayed observation carries `origin: 'session-start'` where the kind
   * has an origin (#96), so the browser can group start-up chatter without guessing from
   * position in the stream. Returns the unsubscribe.
   *
   * ⚠ `Type.Unsafe` keeps the schema for uniformity and the precise type for consumers; a
   * schema change must be mirrored in the annotation by hand.
   */
  subscribe: Type.Unsafe<(onObservation: (observation: ZenObservation) => void) => () => void>(
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
/**
 * An answer to a blocking dialog, keyed to the request id the `extension_ui_request` carried.
 *
 * ⚠ THE ARMS ARE MUTUALLY EXCLUSIVE, and the `?: never` members are what says so (#225). Without
 * them the union is untagged — `{ id, cancelled: true, confirmed: true }` satisfies two arms at
 * once — and a reader can only ask whether a key EXISTS, never what it holds. `answerThreadDialog`
 * asked exactly that and skipped `validateDialogAnswer` for anything carrying a `cancelled` key,
 * which is the select-injection fence (`dialog.ts`) open for an answer that also carried a value.
 * With the arms disjoint, `answer.cancelled === true` narrows, so every reader tests the VALUE.
 */
export type DialogAnswer = { id: string } & (
  | { cancelled: true; value?: never; confirmed?: never }
  | { value: string; cancelled?: never; confirmed?: never }
  | { confirmed: boolean; cancelled?: never; value?: never }
)
```

What crosses it outward — an observation of ours, and nothing of the runtime's (L2, #162 workstream
4): the host maps its runtime's events below this seam, so a subscriber's callback receives
`ZenObservation` (the union on `observation.md`). The runtime's own event shape is the host's
business, in `packages/web/src/host/runtime-event.ts`, and the mapper that reads it,
`packages/web/src/host/map-events.ts`, sits beside it.

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
whose `abort` is the one caller of `clearQueue` and `abort` (`thread-registry.ts:428,433`).
`server/index.ts` reads `permissionModeState` for the thread routes. The browser never sees it: what it
gets is observations on the follow.

**Proven implementable a second time, once.** The fake is the second implementation this seam has
today: `createFakeHostedThread` (`packages/web/src/server/__tests__/fake-hosted-thread.ts`) builds the
whole `ThreadRuntime` from plain closures that record every call, and the real server, registry and
routes run over it. #178 consolidated the four per-file fakes this page used to list into that one
builder — before it, "four tests each built the nine methods, and a change to the contract was five
edits that could disagree about what the contract was" (the file's own header). What varies per
consumer is one method replaced over the fake's own parts (`FakeHostedThreadOptions.runtime`, handed
`FakeThreadParts`), not another implementation of the seam:

| Consumer | What it replaces | What it exercises |
|---|---|---|
| `server-handler.test.ts` (`fakeHost`) | a scripted `prompt` that emits through the fake's `emit`, a literal `listCommands` / `permissionModeState`, a picc-shaped `inspect` | the whole HTTP surface: prompt, follow, dialog, abort, history, bundle |
| `thread-registry.test.ts` (`fakeHosted`) | an `abort` that resolves only when the test says so, a `clearQueue` a test can make throw | the registry's lifecycle: acquire, lease, release, idle, dispose, the abort-then-prompt race |
| `follow.test.ts` (`fakeHost`) | a `prompt` that holds its `outcome` so the test accepts when it chooses | the prompt/follow split frame by frame: snapshot, `seq`, status, dialog outcomes |
| `bundle-route.test.ts` (`liveThread`) | one literal `permissionModeState`, plus the inspection | the bundle's serialization of a live thread |

Everything else is the builder's default and shared: recorded answers, the open-dialog map, the queue
hand-back, the real event tail (`createEventTail`, so the events route sees the real shape), dispose.
The generated [*Test doubles*](../reference/verification-inventory.md#test-doubles) table counts the
same one builder with its four consumers.

## What fences it

- **The vendor gate** (`test/vendor-gate.test.ts`, #145): only `packages/web/src/host/` and
  `packages/harness/extensions/` may import the runtime's package. The server and the browser reach
  the runtime through this contract and nothing else; a vendor import anywhere else is a gate failure
  with the file named.
- **The glossary gate** (`test/glossary-gate.test.ts`, #165): the seam's own names may not regress —
  `PiSession`, `pi-rpc`, and any `Pi`-prefixed identifier outside the host are refused. The contract
  was called `PiSession` in a module called `pi-rpc.ts` until #166.
- **No allowlist line names this seam** any more: the two L2 rows in the glossary gate's
  `RETIRED_ALLOWED` left with the mapper (under `host/`) and the reader (which reads entries of ours).

## What crosses it that should not

**The steer/follow-up dichotomy is the runtime's, and it does not stop at this seam.**
`StreamingBehavior` (`thread-runtime.ts` line 38) is declared as a Zen schema whose two literals are
pi's own words, with pi's rule attached to the field that carries it: `PromptRequest.streamingBehavior`
is "required by pi when the session is already streaming". It is then a field of `ZenPromptBody`
(`packages/core/src/follow.ts:137`), the declared body of `POST /api/threads/:id/prompt` — so the
browser's `prompt()` sends the literal `followUp` (`follow-connection.ts`), `promptThread` defaults to
the same literal when the body omits it (`server/follow.ts`), the thread route forwards it
(`server/index.ts`), and the host hands the string verbatim to the runtime's `prompt` option of the
same name (`agent-host.ts:471`). `ZenPromptBody` is closed, so a Zen-owned word — `interrupt`,
`enqueue` — is a 400 today: pi's vocabulary is not merely carried across the wire, it is the only
vocabulary the wire accepts. Outbound it is the same dichotomy: `ZenQueue.steering` / `.followUp` on
the follow's SSE stream, and `clearQueue` returning `{ steering, followUp }` from pi's
`AgentSession.clearQueue()`. See `observation.md` → *What crosses it that should not* for the queue
half. The vendor gate cannot see any of it — no import, no vendor word — and #216 is the open
question of whether to rename it.

**`listCommands` returns the runtime's command entries** (`RuntimeCommand`: name, source,
description). The shape is ours by declaration; its `source` values are the runtime's categories
carried as strings. Small, stated.

**Nothing of the runtime's event shape, since L2** (#162 workstream 4). Until then `subscribe` handed
out `RuntimeEvent` — open on purpose, the runtime's own fields carried verbatim — and the mapper that
read those fields sat *above* the host. Now the host maps at delivery: a subscriber receives
`ZenObservation`, the event shape and the mapper (`runtime-event.ts`, `map-events.ts`) are under
`host/`, and the runtime's event types appear nowhere above it — not on the follow, not in the
events route's tail (which records observation kinds), not in a fake (the fakes emit observations).
The persistence-side half of L2 is on the storage page.

Nothing else. Prompt, outcome, answer and delivery are ours, and the runtime's own TYPES do not appear
in this module (the vendor gate holds that). Its vocabulary does, in the two shapes above.

Ordered live crossings first, then the closed receipt: the bold lead of this section is the
architecture table's leak column (`scripts/docs/seams-table.ts`), and this page used to lead with the
closed leak and deny the open one in its last line (#216).

## Pivot cost

Replace the runtime and the files that change are the host's: `agent-host.ts` (build a `ThreadRuntime`
over the new loop; the storage seam lives in the same file — see `storage.md`), `session-events.ts`
and `map-events.ts` (produce the new loop's events and map them to observations — or map the
loop's typed events directly and retire the replicated wire shape), `extension-ui-context.ts` and
`permission-dialog.ts` (or their equivalents, if the new loop has extensions and questions at all).
The server, the registry, the routes, the follow, the browser and every test that drives the server
over the fake do not change — that is what the fake proves today, and it is the whole point of the
seam — with ONE exception: the steer/follow-up vocabulary named above. A runtime with no such
distinction, or with one queue class or three, invalidates `StreamingBehavior`, `ZenQueue` and
`ZenPromptBody.streamingBehavior` in `@zen/core`; the prompt route's default and its `PromptBody`
type; the thread route that forwards it; the browser's send and the queue store the router fills; and
the mapper under `host/`. Measured on `main`: 13 production files and 11 test files name
`streamingBehavior`, `StreamingBehavior` or the queue's `steering`/`followUp` — all four tokens over
`packages/` and `scripts/`, counting SOURCE only, since `dist-types/` carries a generated copy of the
same declarations and would report seven more (PR #297 review reproduced the count and got a different
number from a narrower token set; the recipe is here so the next reader gets this one).
That is a wire-schema change and a browser change, and it is priced here rather than at zero.
