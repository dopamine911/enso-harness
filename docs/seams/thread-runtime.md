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
a schema in `@enso/core`") beats a finer rule that needs explaining; the module header says so.

<!-- source: packages/core/src/thread-runtime.ts#ThreadRuntime -->
```ts
/**
 * ⚠ Function-bearing — the one schema the module header's rule is written for.
 */
export const ThreadRuntime = Type.Object({
  /** Fire a prompt. Never awaits the run — see the section header. */
  prompt: Type.Unsafe<(request: PromptRequest, outcome: PromptOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * Continue a torn thread from exactly its stored state (#436): no new user message. Shaped like
   * `prompt` — fire-and-forget, acceptance through `outcome`, completion the thread's own
   * `settled`. Rejected before anything runs when a run is in flight or the stored tail is not
   * one a run can continue from (a completed reply); the reason says which.
   */
  continueRun: Type.Unsafe<(outcome: PromptOutcome) => void>(Type.Function([Type.Unknown()], Type.Void())),
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
  openDialogs: Type.Unsafe<() => EnsoOpenDialog[]>(Type.Function([], Type.Unknown())),
  /**
   * The slash commands this session can run — extension commands, prompt templates, skills, and
   * the host's own (`source: 'host'`, #338 slice 2: `/model`, `/thinking`, each with its current
   * `value` and its `options`). Synchronous: read off the live registry and the session, no
   * round trip.
   */
  listCommands: Type.Unsafe<() => RuntimeCommand[]>(Type.Function([], Type.Unknown())),
  /** The model and thinking level this session runs with now (#338 slice 2). Synchronous. */
  modelState: Type.Unsafe<() => EnsoModelState>(Type.Function([], Type.Unknown())),
  /** What the session has spent and how full its context is, now (#45). Synchronous. */
  sessionUsage: Type.Unsafe<() => EnsoSessionUsage>(Type.Function([], Type.Unknown())),
  /**
   * Run a `host` command (#338 slice 2): `model` with an `options[].id` (`provider/id`),
   * `thinking` with a level. Resolves when applied; the change itself arrives on the feed as a
   * `model` observation, for every follower. REJECTS with a reason a reader can act on — an
   * unknown model, a level this model does not offer, a provider with no credentials (pi's
   * `setModel` refuses that) — and the route says it as 422.
   */
  runHostCommand: Type.Unsafe<(run: EnsoHostCommandRun) => Promise<void>>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /**
   * Start a `flow` host command (#338 slice 3): `login` with a `provider/authType` option,
   * `logout` with a provider. Fire-and-forget like `prompt`, and for the same reason: a login
   * may wait minutes on a device code, and the route must not. `outcome.onAccepted` fires once
   * the flow has begun (the route's 202); `onRejected(reason)` before that for an option the
   * host cannot start (the route's 422); `onSettled` when the work ends. ⚠ THE LEASE FOLLOWS THE
   * KIND. A `flow` (login) is not a run: its lease is released on acceptance, as a mode change's
   * is — holding it marked the thread busy for the whole device-code wait (slice-3 smoke) — and
   * the flow lives on the session until pi's own expiry, Stop (`cancelLogin`, #348), or the
   * session's disposal. An `action`
   * (compaction, slice 4) REWRITES THE BRANCH and is run-shaped: the lease is held until
   * `onSettled`, so the composer is closed, a prompt is 409 (pi itself refuses one mid-compaction,
   * `agent-session.js:1227`), and Stop reaches it (`abort` calls `abortCompaction`). The work's
   * questions are the same blocking dialogs an extension asks (`extension-ui-request`), its
   * progress is `notify` lines, and its result is a `model` observation and a final notify.
   */
  startHostFlow: Type.Unsafe<(run: EnsoHostCommandRun, outcome: HostFlowOutcome) => void>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Void()),
  ),
  /**
   * The login waiting on its provider, if one is (#348). A login holds no lease, so the registry
   * cannot see it as busy: this is what the follow's snapshot carries, and what Stop asks for when
   * no run is in flight. A `login` observation says when it starts and stops waiting.
   */
  loginInProgress: Type.Unsafe<() => EnsoLoginInProgress | undefined>(Type.Function([], Type.Unknown())),
  /**
   * Cancel the login in progress (#348) — Stop, when no run is in flight. `true` when one was:
   * it then settles as a cancelled login ("Login to X cancelled."), its questions withdrawn and
   * nothing stored. `false` when there was none.
   */
  cancelLogin: Type.Unsafe<() => boolean>(Type.Function([], Type.Unknown())),
  /**
   * The permission-mode receipt a run starts with (#84, #496): the session's CURRENT mode,
   * computed the way the permission engine reads it — the last `active_agent` entry among the
   * session's entries, else `default` — and the modes this session may switch to, Enso's set
   * intersected with the commands actually registered.
   * Synchronous: it walks the in-memory entries and registry, no round trip — and it is
   * deliberately NOT `listCommands`, whose call count the refusal path's tests pin.
   */
  permissionModeState: Type.Unsafe<() => EnsoPermissionModeState>(Type.Function([], Type.Unknown())),
  /**
   * Switch the mode (L3 step C, #162 workstream 4). The host translates to whatever its mode
   * extension accepts — the per-mode slash command, run as a prompt the same way
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
   * Fix the session's system prompt to a library prompt (#443) — or to pi's default, `null` — before
   * its first request: the choice is recorded in the thread's log, the next request carries it, and
   * a resume reads it back; until then another choice replaces it. `undefined` when it applied, or
   * when the same prompt is already this session's; else the refusal's reason — a session that has
   * already sent a request keeps the prompt it sent (a system head rewritten mid-session throws the
   * prompt cache away). Synchronous.
   */
  setSystemPrompt: Type.Unsafe<(choice: EnsoSystemPromptChoice | null) => string | undefined>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /**
   * Record a human's resolution of the thread's incident (#466): refused — the reason returned —
   * when `incidentResolutionRefusal` refuses it against the live branch; else its
   * `enso-incident-resolved` record is appended through pi, so it reaches the file and every
   * follower as a custom entry, and it is emitted on `ENSO_INCIDENT_RESOLVED_CHANNEL` so the live
   * guard lifts the suspension at once. `undefined` when recorded. Synchronous.
   *
   * ⚠ The only writer of a resolution: the guard never lifts a suspension on its own, and no tool
   * reaches this.
   */
  resolveIncident: Type.Unsafe<(incidentId: string, resolution: EnsoIncidentResolution) => string | undefined>(
    Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()),
  ),
  /**
   * Receive every observation of this thread (L2, #162 workstream 4): the runtime's events
   * mapped to `EnsoObservation` BELOW this seam, plus what the host itself observes — a
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
  subscribe: Type.Unsafe<(onObservation: (observation: EnsoObservation) => void) => () => void>(
    Type.Function([Type.Unknown()], Type.Unknown()),
  ),
  /** Abort the in-flight run and wait until the agent is idle. The session survives. */
  abort: Type.Unsafe<() => Promise<void>>(Type.Function([], Type.Unknown())),
  /**
   * Drop every prompt waiting behind the run and return the texts, interrupting first (#75,
   * clear-and-restore): the runtime also emits the queue observation every follower reads.
   * The stop route hands the texts back to the tab that stopped, so nothing typed is lost and
   * nothing runs unasked on the next turn. ZEN's two words (#216) — the host maps them.
   */
  clearQueue: Type.Unsafe<() => { interrupting: string[]; enqueued: string[] }>(Type.Function([], Type.Unknown())),
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
  /** How the runtime should take it when a run is already streaming; the host maps it. */
  admission?: EnsoPromptAdmission
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

<!-- source: packages/core/src/thread-runtime.ts#EnsoPromptAdmission -->
```ts
/**
 * What to do when a prompt arrives while the agent is already streaming — ZEN's two words,
 * not the runtime's (#216).
 *
 * ⚠ IT WAS `StreamingBehavior = 'steer' | 'followUp'`: pi's own option name and pi's own
 * literals, declared as an Enso schema and published on `EnsoPromptBody`, so the vendor's model
 * was the only vocabulary the wire accepted — and `docs/seams/thread-runtime.md` said the
 * opposite in the same breath. The vendor gate cannot see that class of leak: no import, no
 * vendor word. pi's spelling is produced in ONE place now, `host/hosted-thread.ts`, which is
 * where a vendor word belongs; a runtime that admits prompts differently becomes a host
 * change, which is this seam's whole promise.
 *
 * `interrupt` — take the prompt at the next step boundary. `enqueue` — after the run settles.
 * Two because the runtime has two; a third is a literal here and a mapping there.
 */
export const EnsoPromptAdmission = Type.Union([Type.Literal('interrupt'), Type.Literal('enqueue')])
```

<!-- source: packages/core/src/thread-runtime.ts#PromptImageContent -->
```ts
/**
 * Base64 image content, accepted by `prompt`, `steer` and `follow_up`.
 */
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
  | { cancelled: true; value?: never; confirmed?: never; answers?: never }
  | { value: string; cancelled?: never; confirmed?: never; answers?: never }
  | { confirmed: boolean; cancelled?: never; value?: never; answers?: never }
  | { answers: EnsoQuestionAnswer[]; cancelled?: never; value?: never; confirmed?: never }
)
```

What crosses it outward — an observation of ours, and nothing of the runtime's (L2, #162 workstream
4): the host maps its runtime's events below this seam, so a subscriber's callback receives
`EnsoObservation` (the union on `observation.md`). The runtime's own event shape is the host's
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
  /** pi's three, plus `host` — ours, declared by kind (#338 slice 2). */
  source: Type.Union([Type.Literal('extension'), Type.Literal('prompt'), Type.Literal('skill'), Type.Literal('host')]),
  description: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  /**
   * `host` rows only (#338): what the row IS, not what widget draws it. `select` — one of many
   * `options`, the second step filters them (`/model`); `level` — one of a few ordered `options`,
   * chosen in place (`/thinking`); `flow` — chosen like a `select`, but the choice STARTS
   * something rather than applying it: `/login` and `/logout` (slice 3) run as dialog flows,
   * their questions and progress arriving on the feed, the route answering 202 when the flow has
   * begun; `action` — runs with no value (`/compact`, slice 4); `view` — the PAGE does it: opens
   * what the row names over the chat (`/context`, #361) or forks at the last prompt (`/fork`,
   * #433) through its own route, and nothing is posted to `…/command`. The palette
   * renders by kind; nothing is per-command UI.
   */
  kind: Type.Optional(
    Type.Union([
      Type.Literal('select'),
      Type.Literal('level'),
      Type.Literal('flow'),
      Type.Literal('action'),
      Type.Literal('view'),
    ]),
  ),
  /** `host` rows: the current choice, as an `options[].id`. In the `catalogue`, a thread with no session has no current choice: `/model`'s is the configured default when it is offered (#674), the one the Start dialog preselects. */
  value: Type.Optional(Type.String()),
  /** `host` rows with `kind: 'select' | 'level'`: what may be chosen. */
  options: Type.Optional(Type.Array(HostCommandOption)),
})
```

## Who implements it, who consumes it

**Implemented once**, in the host: `packages/web/src/host/hosted-thread.ts` builds a `ThreadRuntime` per
thread in `buildHostedThread` (the object literal at `const runtime: ThreadRuntime`) and hands it out
as `HostedThread.runtime`. Three host modules do the adapting behind it: `session-events.ts` turns
the runtime's session events into the open `RuntimeEvent` shape (replicated from the vendor's own
JSON-event mapping, so the mapper's 29 tests kept consuming exactly what they consumed over the pipe);
`extension-ui-context.ts` is the dialog side (an extension's `select` / `confirm` / `input` / `editor`
becomes an open dialog; `answerDialog` resolves it, the permission engine's prompt included);
`questionnaire-dialog.ts` lifts `ask_user`'s component into a questionnaire.

**Consumed by the server only.** `packages/web/src/server/thread-registry.ts` holds one per live
thread (`ThreadEntry.hosted.runtime`), subscribes it to the feed, and hands a `ThreadLease.runtime` to
the run that acquired the thread. `server/follow.ts` calls `prompt`, `continueRun` (#436),
`resolveIncident` (#466), `listCommands`, `answerDialog`, `openDialogs`, `permissionModeState` from the
unary routes; the abort route goes through the registry, whose `abort` is the one caller of `clearQueue`
and `abort`.
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
| `server-handler.test.ts` (`fakeHost`) | a scripted `prompt` that emits through the fake's `emit`, a literal `listCommands` / `permissionModeState`, an `inspect` whose entries record a mode (`modeShapedInspection`) | the whole HTTP surface: prompt, follow, dialog, abort, history, bundle |
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

**The admission vocabulary is ours now, and the mapping is one table (#216, closed).** It was not:
`StreamingBehavior = 'steer' | 'followUp'` was pi's own option name and pi's own literals, declared
as a Enso schema and published on `EnsoPromptBody` — and because that body is closed, a Enso-owned word
was a 400. The vendor's model was not merely carried across the wire, it was **the only vocabulary
the wire accepted**, while this page's last line said the opposite. The vendor gate could not see it:
no import, no vendor word.

What replaced it: `EnsoPromptAdmission = 'interrupt' | 'enqueue'` (`thread-runtime.ts`),
`EnsoPromptBody.admission` on the wire, `EnsoQueue.interrupting` / `.enqueued` on the follow's SSE
stream, and `clearQueue` returning `{ interrupting, enqueued }`. pi's two spellings are produced in
exactly two places, both under `host/`: `hosted-thread.ts#STREAMING_BEHAVIOR_OF` inbound (whose value
type is pi's own `PromptOptions['streamingBehavior']`, so a vendor rename is a compile error in the
table) and `map-events.ts` outbound, where `queue_update`'s `steering`/`followUp` are read. A runtime
that admits prompts differently is a literal in `@enso/core` and a row in that table.

⚠ It is a BREAKING wire change, deliberately and once: `EnsoPromptBody` is closed and its union is
closed, so there was no overlap window in either direction — an old tab posting `followUp` gets a 400
against the new server exactly as a new tab posting `enqueue` would have against the old one. The
alternative was to delete the field (no consumer uses the distinction: `steer` was sent by nothing,
and the two queue lists are concatenated on arrival), but that removes the HTTP steering #75 exposed
on purpose, so the rename preserves the capability and leaves that decision open.

**`listCommands` returns the runtime's command entries** (`RuntimeCommand`: name, source,
description). The shape is ours by declaration; its `source` values are the runtime's categories
carried as strings — plus `host`, which is not the runtime's at all (#338 slice 2): the host appends
its own rows — `/model`, `/thinking`, `/login`, `/logout`, `/compact`, `/context` — each declaring a
**kind** (`select`, `level`, `flow`, `action`, `view`), its current `value` and its `options`, so the
palette renders them by kind with no
per-command UI. A `view` (`/context`, #361) is the one kind the host never runs: the page opens the
view it names, and a run of it is refused as 422. Small, stated.

**Which requests build a session** (#86, #390, #484). A run does (`POST …/prompt`, `…/continue`),
and a person's explicit CONTROL of a thread that has not run does (`POST …/command` choosing its
model or thinking level, `…/flow` starting a login, the system-prompt preview, a permission check —
`ThreadRegistry.ensure`). Nothing else: every GET is `peek`, and `GET …/commands` for a thread the
server does not hold answers the host's `catalogue()` — `/model`, `/login`, `/logout`, with no
thread built. Its models are a SESSION's (#688): the latest bound thread's, else a probe's — one
in-memory pi session per process, built on the first read and released once `session_start` ran,
which only the extensions that register providers see (`host/session-models.ts`). The agent dir's
files alone are not a session's list: pi-multi-account replaces `openai-codex`'s models with the
account's live catalog on `session_start`, and a list without that offered models the session
refused. The Start dialog reads its models there, so opening the page builds no thread, and
preselects the `/model` row's value: pi's configured default (`defaultProvider`/`defaultModel` in
the agent dir's settings), when the list offers it (#674), else the first model. The palette shows a
`catalogue` list as none, because the slash commands belong to a running session (a prompt beginning
with `/` cannot start one, and the dialog says so).

**`modelState` and `runHostCommand` are the control half of #44** (#338 slice 2). The state is what
the session runs with now — model, thinking level, the levels that model offers — on the snapshot
frame and as the `model` observation whenever it changes, by whichever hand: the palette's `POST
…/command`, an extension's failover swap, pi restoring a session. `runHostCommand` is the one way
the browser changes it: the host validates (an unknown model, a level the model does not offer, a
provider pi has no credentials for) and REJECTS with a reason the route says as 422, and the change
itself is never the route's answer — it is the observation every follower reads.

**`startHostFlow` is a login as a dialog flow** (#338 slice 3). pi's `modelRuntime.login` asks its
questions through an interaction — a text or secret prompt, a select, a code — and the host lifts
each to the SAME blocking dialog an extension asks, so the browser renders and answers a login as
it renders and answers a permission prompt; a secret is an `input` dialog with `secret: true`, which
the browser masks and never echoes. Fire-and-forget like `prompt`, for the same reason: a device code
may wait minutes, so the route answers 202 on acceptance — and releases the lease then, because a
lease IS the registry's busy and a login is not a run (the smoke showed a held lease locking the
composer for the device-code wait). The flow lives on the session; disposing the session aborts it,
and so does **Stop** while it waits (#348): with no lease the registry reads the thread idle, so the
host says `login` (waiting, then not) and `loginInProgress` for the snapshot, and the abort route
calls `cancelLogin` when no run is in flight. One flow runs at a time per
session, a second start is refused by name. `/compact` (slice 4) is an `action` on the same path
with one difference: it REWRITES THE BRANCH, so the route holds the lease until it settles — the
thread is busy, a setting is 409, Stop reaches it through `abortCompaction` — where a login's lease
is released on acceptance. No option, a model call pi makes to summarise the branch, a notify with
the token counts when it ends; pi's `compaction_end` becomes `branch-compacted` (#348), and the
pane re-reads the branch once the thread is idle. The stored
credentials `/logout` offers are a cache — pi lists them asynchronously and `listCommands` is
synchronous — refreshed at build and after every flow the host itself ran.

**Nothing of the runtime's event shape, since L2** (#162 workstream 4). Until then `subscribe` handed
out `RuntimeEvent` — open on purpose, the runtime's own fields carried verbatim — and the mapper that
read those fields sat *above* the host. Now the host maps at delivery: a subscriber receives
`EnsoObservation`, the event shape and the mapper (`runtime-event.ts`, `map-events.ts`) are under
`host/`, and the runtime's event types appear nowhere above it — not on the follow, not in the
events route's tail (which records observation kinds), not in a fake (the fakes emit observations).
The persistence-side half of L2 is on the storage page.

Nothing else. Prompt, outcome, answer and delivery are ours, and the runtime's own TYPES do not appear
in this module (the vendor gate holds that). Its vocabulary does, in the two shapes above.

Ordered live crossings first, then the closed receipt: the bold lead of this section is the
architecture table's leak column (`scripts/docs/seams-table.ts`), and this page used to lead with the
closed leak and deny the open one in its last line (#216).

## Pivot cost

Which files may import the runtime is fixed by a gate (#558): `VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS` in `test/vendor-gate.test.ts` lists them, and the list only shrinks, so a new file cannot quietly add to what follows.

Replace the runtime and the files that change are the host's: `hosted-thread.ts` (build a `ThreadRuntime`
over the new loop), `thread-log.ts` (the new loop's log — see `storage.md`), `session-events.ts`
and `map-events.ts` (produce the new loop's events and map them to observations — or map the
loop's typed events directly and retire the replicated wire shape), `extension-ui-context.ts` and
`questionnaire-dialog.ts` (or their equivalents, if the new loop has extensions and questions at all).
The server, the registry, the routes, the follow, the browser and every test that drives the server
over the fake do not change — that is what the fake proves today, and it is the whole point of the
seam. The steer/follow-up exception this section used to carry is gone with #216: a runtime with no
such distinction, or with one queue class or three, is now `EnsoPromptAdmission`'s literals, the two
host-side tables that map them, and whatever the page renders — not the wire schema, not the prompt
route, not the browser's send. The rename itself cost 24 files (13 production, 11 test) plus five doc
pages, measured over `packages/` and `scripts/`, SOURCE only — `dist-types/` carries a generated copy
of the same declarations and would report seven more (PR #297 review reproduced the old count from a
narrower token set; the recipe is here so the next reader gets the same number).
