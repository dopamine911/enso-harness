# Seam: the dialog vocabulary

The contract for a question an extension asks that blocks the run until a human answers: the five
kinds of question — pi's four and the agent's questionnaire — how one is listed while open, what an
answer is, how the wait ends. Glossary
domain: **Control** — *dialog*, *dialog kind*, *answer*, *outcome*, *notify* — with the settle and the
origin crossing on the **Observation** side. Rule of the domain: a route tells the runtime, the feed
says what happened (invariant 2); the answer is a unary `POST`, and every follower learns the card is
stale from the feed, not from the response.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/dialog.md`.

## The contract

The question, one shape per kind:

<!-- source: packages/core/src/dialog.ts#EnsoDialogSpec -->
```ts
/**
 * One dialog question, per method.
 *
 * `timeout` is pi's OWN deadline (milliseconds), when the requesting extension set one:
 * pi resolves the dialog itself when it lapses, so an answer arriving after it is written
 * to an id nobody is waiting on. Carried so a surface can stop offering a dead question.
 */
export const EnsoDialogSpec = Type.Union([
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
    /**
     * The answer is a credential (#338 slice 3): an API key typed into `/login`. The browser
     * masks the field and the answer is never echoed into a transcript line. pi's own
     * `input` has no such flag — its login flow asks through `AuthPrompt.type: 'secret'` — so
     * the host sets it when it lifts that prompt to a dialog.
     */
    secret: Type.Optional(Type.Literal(true)),
    /**
     * What the answer is and where it comes from (#388): a login's code prompt says that the
     * login completes by itself when finished in a browser on this machine, and what to paste
     * when it does not. Plain text, never markdown. pi's own `input` has none; the host sets it.
     */
    message: Type.Optional(Type.String()),
    /** The page to open to get the answer (#388): the login's authorization URL. The host sets it. */
    link: Type.Optional(EnsoDialogLink),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('editor'),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
  Type.Object({
    method: Type.Literal('questionnaire'),
    title: Type.String(),
    questions: Type.Array(EnsoQuestion, { minItems: 1 }),
  }),
])
```

A question while it waits — what the snapshot lists, keyed by the id the answer names:

<!-- source: packages/core/src/dialog.ts#EnsoOpenDialog -->
```ts
/**
 * One question pi is blocked on, as the follow's snapshot lists it (#114) — so a follow
 * opened while pi waits renders the card at once, instead of a busy thread with nothing to
 * answer.
 *
 * `id` is the request id the answer is keyed by.
 */
export const EnsoOpenDialog = Type.Object({ id: Type.String({ minLength: 1 }), dialog: EnsoDialogSpec })
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
  | { cancelled: true; value?: never; confirmed?: never; answers?: never }
  | { value: string; cancelled?: never; confirmed?: never; answers?: never }
  | { confirmed: boolean; cancelled?: never; value?: never; answers?: never }
  | { answers: EnsoQuestionAnswer[]; cancelled?: never; value?: never; confirmed?: never }
)
```

The two checks both sides enforce — is this a question, does this payload answer *this* question:

<!-- source: packages/core/src/dialog.ts#isEnsoDialogSpec -->
```ts
export function isEnsoDialogSpec(value: unknown): value is EnsoDialogSpec {
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
export function validateDialogAnswer(spec: EnsoDialogSpec, payload: unknown): string | undefined {
  if (!dialogAnswerValidator.Check(payload)) {
    return `the payload is not a dialog answer ({ value: string }, { confirmed: boolean } or { answers: [...] })`
  }
  switch (spec.method) {
    case 'confirm':
      return 'confirmed' in payload ? undefined : `a 'confirm' dialog takes { confirmed: boolean }`
    case 'select':
      if (!('value' in payload)) return `a 'select' dialog takes { value: string }`
      return spec.options.includes(payload.value) ? undefined : `'${payload.value}' is not one of the offered options`
    case 'input':
    case 'editor':
      return 'value' in payload ? undefined : `an '${spec.method}' dialog takes { value: string }`
    case 'questionnaire':
      if (!('answers' in payload)) return `a 'questionnaire' dialog takes { answers: [...] }`
      return questionnaireRefusal(spec.questions, payload.answers)
  }
}
```

How the wait ended, and where the question was raised — both tagged at the source:

<!-- source: packages/core/src/observation.ts#EnsoDialogOutcome -->
```ts
/**
 * How a blocking question stopped waiting (#114).
 *
 * A closed union: `answered` is a human's value, the other three are pi's cancel value
 * delivered for a reason — the browser's cancel or the session's teardown (`cancelled`), the
 * extension's own `timeout`, or the caller's abort signal (`aborted`).
 */
export const EnsoDialogOutcome = Type.Union([
  Type.Literal('answered'),
  Type.Literal('cancelled'),
  Type.Literal('timeout'),
  Type.Literal('aborted'),
])
```

<!-- source: packages/core/src/observation.ts#EnsoUiRequestOrigin -->
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
export const EnsoUiRequestOrigin = Type.Union([Type.Literal('session-start'), Type.Literal('run')])
```

The host's side of it — what `agent-host.ts` binds to a session and what the runtime contract's
`answerDialog` / `openDialogs` delegate to:

<!-- source: packages/web/src/host/extension-ui-context.ts#EnsoExtensionUiContext -->
```ts
export interface EnsoExtensionUiContext {
  readonly uiContext: ExtensionUIContext
  /**
   * A notice with its sender (#387): what an extension's tagged context calls in place of
   * `notify` (`notice-sender.ts`), and what the host's own lines say themselves with, as `Enso`.
   */
  readonly notifyFrom: (sender: string, message: string, type?: 'info' | 'warning' | 'error') => void
  /** Deliver an answer. Unknown ids are reported, not thrown — the extension is not waiting on them. */
  readonly answerDialog: (response: DialogAnswer) => void
  /** Every pending question, oldest first, as the follow's snapshot lists them (#114). Empty once settled. */
  readonly openDialogs: () => EnsoOpenDialog[]
  /** Cancel every pending dialog — session teardown. Each blocked extension call resolves to its cancel value. */
  readonly cancelAllDialogs: () => void
  /**
   * Settle every pending dialog as the RUN's abort: each blocked call resolves to its cancel
   * value with outcome `aborted` — the glossary's word for exactly this, produced by no code
   * until Stop was made to stop. The asking extension need not have passed a signal.
   */
  readonly abortAllDialogs: () => void
  /**
   * Refuse every question asked before `settled` settles: it resolves at once to its cancel
   * value, outcome `aborted`, and no card is shown. For the window while a stopped run winds
   * down — a tool that asks from its `execute` and ignores the abort signal (ask_user's
   * multi-select loop asks the next option) would otherwise open a question after the stop,
   * and the stop would wait on it (#376 review).
   */
  readonly refuseDialogsUntil: (settled: Promise<unknown>) => void
  /** How many dialogs are blocked right now — observable state for tests and for the idle-timeout logic. */
  readonly pendingDialogCount: () => number
  /**
   * The HOST's own questions, lifted to an `input` dialog: a credential (#338 slice 3: pi's
   * `AuthPrompt.type: 'secret'`, masked by the browser) and a login's code (#388: with what to
   * paste and a link to the login page). Not on `uiContext` — pi's interface has no such method,
   * and an extension must not be able to ask a masked question the transcript then fails to show,
   * or put a link on the card. Same wait, same settle record, same cancel value as `input`.
   */
  readonly askHostInput: (question: HostInputQuestion, signal: AbortSignal | undefined) => Promise<string | undefined>
}
```

## Who implements it, who consumes it

**Implemented once**, by `createEnsoExtensionUiContext` in `packages/web/src/host/extension-ui-context.ts`
(line 250). The host is the UI: it implements the interface extensions call and turns each call into
the same record the mapper already consumed over the old transport (header lines 38–40). The four
blocking methods — `select`, `confirm`, `input`, `editor` (lines 386–432) — go through one
`awaitDialog` (line 326): mint an id, park the request in a pending map, emit the request, and block
until an answer, a cancel, the caller's abort signal or its own timeout. Every path that stops the wait
goes through `finish` (line 352), which deletes the pending entry, emits the settle record with its
outcome (line 339) and resolves the extension with its value — `undefined` for `select`/`input`/
`editor`, `false` for `confirm`, on every non-answer outcome (lines 312–313). That is why the settle
observation exists at all: the runtime has no event for a question ending (lines 316–317).
`agent-host.ts` binds one context per session (line 951) and delegates the runtime contract's
`answerDialog` and `openDialogs` to it (lines 1358–1363); `cancelAllDialogs` cancels every pending
question at session teardown (line 579, called from `agent-host.ts:1513`), so teardown is a settle
path too.

**Consumed by the server.** `answerThreadDialog` in `packages/web/src/server/follow.ts` (line 363)
finds the open question by id on the live thread (line 366; 404 when the thread is not live or the
question is spent, lines 365–372), validates a non-cancel answer against the question's kind
(lines 373–376; 422 with the refusal, and the question stays open), then hands it to the runtime
(line 377) and answers 204 (line 378). `server/index.ts` maps that outcome to the response (lines
840–862). The follow's snapshot lists every open question, oldest first, so a reconnect renders the
card at once (`follow.ts` line 200; `openDialogs` at extension-ui-context.ts line 526 checks each
request with `isEnsoDialogSpec` rather than casting, line 532).

**Consumed by the browser.** The question arrives as an `extension-ui-request` observation whose
`dialog` the mapper checked with `isEnsoDialogSpec` (`map-events.ts` line 137); the adapter passes the
observation whole on a CUSTOM chunk named by its kind (`to-agui.ts#custom`) and the router checks
`{ id, dialog }` again against `EnsoOpenDialog` before it reaches the store (`custom-event-router.ts#routeUiRequest`). `EnsoDialogCard` in
`packages/web/src/chat-screen.tsx` (`#EnsoDialogCard`) renders one card and hands `answerDialog` in
`packages/web/src/follow-connection.ts` (line 690) exactly the answer shapes — `{ value }`,
`{ confirmed }`, `{ answers }`, `{ cancelled: true }` — because the server forwards them verbatim (chat-screen.tsx
lines 631–632). The card drops on `dialog-settled` for its id, whoever answered (router lines 148–153), and
the snapshot's list replaces what is shown (router line 105).

**Asked by the agent (#12).** The model reaches this channel through one tool, `ask_user`
(`packages/harness/extensions/ask-user/index.ts`, ours; its parameters are `core/src/ask-user.ts`):
one to four questions, each a short `header`, the `question`, two to four options (a label and what
choosing it means) and `multiSelect`. The whole set is asked as ONE question of the fifth kind,
`questionnaire`, because pi has no method for it:

- **The tool** hands `custom` a component carrying the questionnaire under
  `QUESTIONNAIRE_COMPONENT_KEY` (`dialog.ts`), a registered symbol, so neither side imports the other.
- **The host** lifts it (`host/questionnaire-dialog.ts#liftQuestionnaire`): the carried value is
  validated against `EnsoDialogSpec` and rebuilt from the schema's own fields, at every level, so
  nothing else it carried reaches a follower. A malformed one is no dialog at all, and `custom`
  resolves `undefined`. So is one that repeats a question's header, or an option label within
  a question (`dialog.ts#questionnaireRepeat`): its tabs or rows could not be told apart. The tool
  refuses such a call itself before asking, with an error naming what repeated so the model can re-ask.
- **The card** (`questionnaire-card.tsx#QuestionnaireControls`) shows a tab per question; a radio or
  checkbox row per option, with its label and description; an "Other" row taking the user's own
  words; and one "Submit answers", enabled once every question is answered. Picking a single choice
  moves to the next tab.
- **The answer** is `{ answers }`, one `{ selected, other? }` per question in order.
  `validateDialogAnswer` refuses a label the question never offered, an unanswered question, more
  than one answer to a single choice, and a blank "Other".
- **Declining.** The card's Cancel is a real decline for every kind of question: the tool gets
  `{ cancelled: true }`, never `undefined`, which means "this host could not show it".
- **What the model reads** is the answers in plain words, or that the user declined.

Where no card can be shown — pi's own terminal, or pi's rpc mode, whose `custom` resolves `undefined`
— the tool asks one plain `select` or `input` at a time. A multi-choice question is a toggle list
closed by "✓ Done", so dismissing any prompt is a decline there too. **Stop** while the tool waits
stops the run and leaves no card: the host settles pending questions as the stop begins and refuses
any asked until it has finished (`agent-host.ts#stopRunSettlingDialogs`, `refuseDialogsUntil`). What
the model must do after a decline — halt rather than route around — is not this seam's (#4). Pinned
end to end, faux model to tool result, by `agent-host.test.ts#⚠⚠ the agent asks through ask_user: its questionnaire is one dialog, and the answers are its tool result (#12)`,
with its siblings for the decline and Stop.

**Fakes.** `follow.test.ts` drives the answer route over an inline runtime whose `openDialogs` the test
controls; `extension-ui-context.test.ts` exercises the context against scripted extension calls,
including the fail-closed lift (`EnsoExtensionUiContextOptions.liftDialog`, lines 99–103).

## What fences it

- **One validator, both sides**: `validateDialogAnswer` lives beside the schemas so the server and the
  card enforce the same rule (`dialog.ts#validateDialogAnswer`) — in particular that a `select` value
  is one of the offered options (lines 176–179), since the runtime hands it to the extension verbatim
  (an injection seam, closed at the server: `follow.ts` lines 359–360).
- **The settle funnel**: `finish` is the one place a settle record is emitted (extension-ui-context.ts
  line 324); the mapper turns an outcome the union does not name into `unmapped`, not a guess
  (`map-events.ts` lines 327–336).
- **The kinds agree twice**: the host's `BlockingDialogRequest` (extension-ui-context.ts line 65) and
  the mapper's `DIALOG_UI_METHODS` (`map-events.ts` line 38) name the same five methods, and the
  host's comment says so.
- **The vendor gate** (#145): `extension-ui-context.ts` and `permission-dialog.ts` import the runtime's
  package; nothing above `host/` does.

## What crosses it that should not

**The four kinds are the runtime's extension-UI method names — kept, by decision.** Goals §2 lists
this as **L4** with "probably keep"; the glossary decided it (*dialog kind*, Decision 5): `select`,
`confirm`, `input`, `editor` are ours by adoption, the right set of primitives for a surface,
`EnsoDialogSpec` names them, an answer is validated against them, and they are neither renamed nor
mapped. The answer shapes likewise mirror the runtime's response contract minus its envelope
(`dialog.ts` lines 14–24) so the server adds the envelope and nothing else. A decision, not a leak:
a replacement loop would be adapted *to* this vocabulary.

**The fifth kind, `questionnaire`, is ours, not the runtime's** (#12). pi has no method for a set of
questions, so the host lifts it from `ask_user`'s component the way it lifts the permission prompt
below, and its `{ answers }` go to the tool, not to pi's response contract. A replacement runtime
keeps it unchanged: nothing about it is pi's.

**The permission prompt is lifted inside the host, legitimately.** The mode extension asks its
file-permission question through `custom`, handing the runtime a terminal component; the host's
`custom` (extension-ui-context.ts line 443) builds it and `permission-dialog.ts` lifts the one
component it knows into a `select` (line 475) whose options are the strings the extension reads back
verbatim. That reads a vendor class by `instanceof` and its private fields by name, pinned by
`permission-dialog.test.ts` (permission-dialog.ts lines 10–30) — vendor coupling, but under
`packages/web/src/host/`, where the vendor gate allows it, and nothing above the host sees anything
but a `select`. The mode itself is leak L3, on `permission-mode.md`.

**`notify` rides the same observation.** A one-way notice is emitted by the host as a `notify` request
(extension-ui-context.ts line 394) and mapped as an `extension-ui-request` the mapper marks
non-blocking, since only the five dialog methods block (`map-events.ts` line 160); status-bar and
widget calls are emitted and dropped (extension-ui-context.ts header lines 54–56). Not a dialog.

## Pivot cost

Replace the runtime and the vocabulary stays: `EnsoDialogSpec`, `EnsoOpenDialog`, `DialogAnswer`,
`EnsoDialogOutcome`, the validator, the answer route, the snapshot's list, the card and the router do not
change — the answer route's tests in `follow.test.ts` and the card's static renders already run with no
runtime. What changes is `extension-ui-context.ts` (implement the new loop's question interface, or
none if it has no extensions) and `permission-dialog.ts` (or delete it, if the new loop has no
permission prompt to lift). `agent-host.ts` changes only where it binds the context and delegates the
two runtime-contract methods.
