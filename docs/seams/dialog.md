# Seam: the dialog vocabulary

The contract for a question an extension asks that blocks the run until a human answers: the four
kinds of question, how one is listed while open, what an answer is, how the wait ends. Glossary
domain: **Control** — *dialog*, *dialog kind*, *answer*, *outcome*, *notify* — with the settle and the
origin crossing on the **Observation** side. Rule of the domain: a route tells the runtime, the feed
says what happened (invariant 2); the answer is a unary `POST`, and every follower learns the card is
stale from the feed, not from the response.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/dialog.md`.

## The contract

The question, one shape per kind:

<!-- source: packages/core/src/dialog.ts#ZenDialogSpec -->
```ts
/**
 * One dialog question, per method.
 *
 * `timeout` is pi's OWN deadline (milliseconds), when the requesting extension set one:
 * pi resolves the dialog itself when it lapses, so an answer arriving after it is written
 * to an id nobody is waiting on. Carried so a surface can stop offering a dead question.
 */
export const ZenDialogSpec = Type.Union([
  Type.Object({
    method: Type.Literal('select'),
    title: Type.String(),
    options: Type.Array(Type.String(), { minItems: 1 }),
    /**
     * The detail behind the question — a file preview, a diff, a command. pi's own
     * `select` has none; the host adds it when it lifts a component dialog to a select
     * (#73: picc's permission prompt), because a permission decision needs to see what it
     * is deciding about. Preformatted text: rendered as-is, never as markdown.
     */
    message: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('confirm'),
    title: Type.String(),
    message: Type.String(),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('input'),
    title: Type.String(),
    placeholder: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('editor'),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
])
```

A question while it waits — what the snapshot lists, keyed by the id the answer names:

<!-- source: packages/core/src/dialog.ts#ZenOpenDialog -->
```ts
/**
 * One question pi is blocked on, as the follow's snapshot lists it (#114) — so a follow
 * opened while pi waits renders the card at once, instead of a busy thread with nothing to
 * answer. `id` is the request id the answer is keyed by.
 */
export const ZenOpenDialog = Type.Object({ id: Type.String({ minLength: 1 }), dialog: ZenDialogSpec })
```

The answer, as it crosses `POST /api/threads/:id/dialog` and reaches the runtime:

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

The two checks both sides enforce — is this a question, does this payload answer *this* question:

<!-- source: packages/core/src/dialog.ts#isZenDialogSpec -->
```ts
export function isZenDialogSpec(value: unknown): value is ZenDialogSpec {
  return dialogSpecValidator.Check(value)
}
```

<!-- source: packages/core/src/dialog.ts#validateDialogAnswer -->
```ts
/**
 * Does this payload answer THIS dialog?
 *
 * Returns `undefined` when it does, or a human-readable refusal. Lives beside the schemas
 * so both surfaces enforce the same rule — in particular the select rule: pi hands the
 * answered `value` to the extension verbatim, so a value outside the offered options would
 * put a string the extension never offered into its control flow. That is an injection
 * seam, and it is closed HERE rather than trusted to the renderer.
 */
export function validateDialogAnswer(spec: ZenDialogSpec, payload: unknown): string | undefined {
  if (!dialogAnswerValidator.Check(payload)) {
    return `the payload is not a dialog answer ({ value: string } or { confirmed: boolean })`
  }
  switch (spec.method) {
    case 'confirm':
      return 'confirmed' in payload
        ? undefined
        : `a 'confirm' dialog takes { confirmed: boolean }, got a 'value' answer`
    case 'select':
      if (!('value' in payload)) {
        return `a 'select' dialog takes { value: string }, got a 'confirmed' answer`
      }
      return spec.options.includes(payload.value) ? undefined : `'${payload.value}' is not one of the offered options`
    case 'input':
    case 'editor':
      return 'value' in payload
        ? undefined
        : `an '${spec.method}' dialog takes { value: string }, got a 'confirmed' answer`
  }
}
```

How the wait ended, and where the question was raised — both tagged at the source:

<!-- source: packages/core/src/observation.ts#ZenDialogOutcome -->
```ts
/**
 * How a blocking question stopped waiting (#114). A closed union: `answered` is a human's
 * value, the other three are pi's cancel value delivered for a reason — the browser's
 * cancel or the session's teardown (`cancelled`), the extension's own `timeout`, or the
 * caller's abort signal (`aborted`).
 */
export const ZenDialogOutcome = Type.Union([
  Type.Literal('answered'),
  Type.Literal('cancelled'),
  Type.Literal('timeout'),
  Type.Literal('aborted'),
])
```

<!-- source: packages/core/src/observation.ts#ZenUiRequestOrigin -->
```ts
/**
 * Where a ui request came from (#96) — tagged at the SOURCE, never inferred.
 *
 *   session-start  emitted during the session's own start, before anyone subscribed, and
 *                  replayed to the first run's pump (the host's held buffer, #69/#88). An
 *                  infra fact about the process, true of every thread — the browser groups
 *                  the informational ones.
 *   run            emitted while a run was listening. Rendered as it always was: a guard
 *                  refusal before the first token is a run notice, not startup chatter, and
 *                  a browser-side "notifies before the first assistant message" rule would
 *                  have swallowed it.
 *
 * A closed union: a third origin fails at the mapper, loudly, not silently in a consumer.
 */
export const ZenUiRequestOrigin = Type.Union([Type.Literal('session-start'), Type.Literal('run')])
```

The host's side of it — what `agent-host.ts` binds to a session and what the runtime contract's
`answerDialog` / `openDialogs` delegate to:

<!-- source: packages/web/src/host/extension-ui-context.ts#ZenExtensionUiContext -->
```ts
export interface ZenExtensionUiContext {
  readonly uiContext: ExtensionUIContext
  /** Deliver an answer. Unknown ids are reported, not thrown — the extension is not waiting on them. */
  answerDialog(response: DialogAnswer): void
  /** Every pending question, oldest first, as the follow's snapshot lists them (#114). Empty once settled. */
  openDialogs(): ZenOpenDialog[]
  /** Cancel every pending dialog — session teardown. Each blocked extension call resolves to its cancel value. */
  cancelAllDialogs(): void
  /**
   * Settle every pending dialog as the RUN's abort: each blocked call resolves to its cancel
   * value with outcome `aborted` — the glossary's word for exactly this, produced by no code
   * until Stop was made to stop. The asking extension need not have passed a signal.
   */
  abortAllDialogs(): void
  /** How many dialogs are blocked right now — observable state for tests and for the idle-timeout logic. */
  pendingDialogCount(): number
}
```

## Who implements it, who consumes it

**Implemented once**, by `createZenExtensionUiContext` in `packages/web/src/host/extension-ui-context.ts`
(line 197). The host is the UI: it implements the interface extensions call and turns each call into
the same record the mapper already consumed over the old transport (header lines 31–39). The four
blocking methods — `select`, `confirm`, `input`, `editor` (lines 301–347) — go through one
`awaitDialog` (line 264): mint an id, park the request in a pending map, emit the request, and block
until an answer, a cancel, the caller's abort signal or its own timeout. Every path that stops the wait
goes through `finish` (line 273), which deletes the pending entry, emits the settle record with its
outcome (line 277) and resolves the extension with its value — `undefined` for `select`/`input`/
`editor`, `false` for `confirm`, on every non-answer outcome (lines 256–258). That is why the settle
observation exists at all: the runtime has no event for a question ending (lines 260–262).
`agent-host.ts` binds one context per session (line 344) and delegates the runtime contract's
`answerDialog` and `openDialogs` to it (lines 403–408); `dispose` cancels every pending question
(line 463), so teardown is a settle path too.

**Consumed by the server.** `answerThreadDialog` in `packages/web/src/server/follow.ts` (line 294)
finds the open question by id on the live thread (line 297; 404 when the thread is not live or the
question is spent, lines 296–302), validates a non-cancel answer against the question's kind
(lines 304–306; 422 with the refusal, and the question stays open), then hands it to the runtime
(line 308) and answers 204 (line 309). `server/index.ts` maps that outcome to the response (lines
542–556). The follow's snapshot lists every open question, oldest first, so a reconnect renders the
card at once (`follow.ts` line 139; `openDialogs` at extension-ui-context.ts line 455 checks each
request with `isZenDialogSpec` rather than casting, line 461).

**Consumed by the browser.** The question arrives as an `extension-ui-request` observation whose
`dialog` the mapper checked with `isZenDialogSpec` (`map-events.ts` line 131); the adapter passes the
observation whole on a CUSTOM chunk named by its kind (`to-agui.ts#custom`) and the router checks
`{ id, dialog }` again against `ZenOpenDialog` before it reaches the store (`custom-event-router.ts#routeUiRequest`). `ZenDialogCard` in
`packages/web/src/chat-screen.tsx` (line 406) renders one card and hands `answerDialog` in
`packages/web/src/follow-connection.ts` (line 632) exactly the answer shapes — `{ value }`,
`{ confirmed }`, `{ cancelled: true }` — because the server forwards them verbatim (chat-screen.tsx
lines 333–336). The card drops on `dialog-settled` for its id, whoever answered (router line 123), and
the snapshot's complete list replaces what is shown (`follow-connection.ts` lines 383–387).

**Fakes.** `follow.test.ts` drives the answer route over an inline runtime whose `openDialogs` the test
controls; `extension-ui-context.test.ts` exercises the context against scripted extension calls,
including the fail-closed lift (`ZenExtensionUiContextOptions.liftDialog`, lines 85–90).

## What fences it

- **One validator, both sides**: `validateDialogAnswer` lives beside the schemas so the server and the
  card enforce the same rule (`dialog.ts` lines 93–97) — in particular that a `select` value is one of
  the offered options, since the runtime hands it to the extension verbatim (an injection seam,
  closed at the server: `follow.ts` lines 289–292).
- **The settle funnel**: `finish` is the one place a settle record is emitted (extension-ui-context.ts
  lines 260–262); the mapper turns an outcome the union does not name into `unmapped`, not a guess
  (`map-events.ts` lines 295–304).
- **The kinds agree twice**: the host's `BlockingDialogRequest` (extension-ui-context.ts line 57) and
  the mapper's `DIALOG_UI_METHODS` (`map-events.ts` line 32) name the same four methods, and the
  host's comment says so.
- **The vendor gate** (#145): `extension-ui-context.ts` and `permission-dialog.ts` import the runtime's
  package; nothing above `host/` does.

## What crosses it that should not

**The four kinds are the runtime's extension-UI method names — kept, by decision.** Goals §2 lists
this as **L4** with "probably keep"; the glossary decided it (*dialog kind*, Decision 5): `select`,
`confirm`, `input`, `editor` are ours by adoption, the right set of primitives for a surface,
`ZenDialogSpec` names them, an answer is validated against them, and they are neither renamed nor
mapped. The answer shapes likewise mirror the runtime's response contract minus its envelope
(`dialog.ts` lines 14–24) so the server adds the envelope and nothing else. A decision, not a leak:
a replacement loop would be adapted *to* this vocabulary.

**The permission prompt is lifted inside the host, legitimately.** The mode extension asks its
file-permission question through `custom`, handing the runtime a terminal component; the host's
`custom` (extension-ui-context.ts line 397) builds it and `permission-dialog.ts` lifts the one
component it knows into a `select` (line 416) whose options are the strings the extension reads back
verbatim. That reads a vendor class by `instanceof` and its private fields by name, pinned by
`permission-dialog.test.ts` (permission-dialog.ts lines 10–30) — vendor coupling, but under
`packages/web/src/host/`, where the vendor gate allows it, and nothing above the host sees anything
but a `select`. The mode itself is leak L3, on `permission-mode.md`.

**`notify` rides the same observation.** A one-way notice is emitted by the host as a `notify` request
(extension-ui-context.ts line 349) and mapped as an `extension-ui-request` the mapper marks
non-blocking, since only the four methods block (`map-events.ts` lines 108–113); status-bar and
widget calls are emitted and dropped (extension-ui-context.ts lines 51–53). Not a dialog.

## Pivot cost

Replace the runtime and the vocabulary stays: `ZenDialogSpec`, `ZenOpenDialog`, `DialogAnswer`,
`ZenDialogOutcome`, the validator, the answer route, the snapshot's list, the card and the router do not
change — the answer route's tests in `follow.test.ts` and the card's static renders already run with no
runtime. What changes is `extension-ui-context.ts` (implement the new loop's question interface, or
none if it has no extensions) and `permission-dialog.ts` (or delete it, if the new loop has no
permission prompt to lift). `agent-host.ts` changes only where it binds the context and delegates the
two runtime-contract methods.
