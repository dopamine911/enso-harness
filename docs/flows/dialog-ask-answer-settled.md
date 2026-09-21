# Flow: a dialog — asked in the host, answered once, settled for every follower

An extension's `ctx.ui.select` / `confirm` / `input` / `editor` blocks its run until a human answers.
In-process there is no wire for that wait: the host **is** the UI (`extension-ui-context.ts`, header),
so the question is parked in the host's pending map and rides to every follower as a blocking
`extension-ui-request` observation (#27, #112). The answer is one unary `POST /api/threads/:id/dialog`,
checked against the question it names. Every way the wait can end crosses one `finish`, which emits
`dialog-settled` with its outcome — how a tab that did not answer learns the card is stale — and a
follow opened under an open question finds it in the snapshot's `openDialogs` (#114).

## The sequence

```mermaid
sequenceDiagram
  participant X as extension
  participant H as host (extension-ui-context.ts · map-events.ts)
  participant F as feed
  participant R as dialog route (server/follow.ts)
  participant B as browser (custom-event-router.ts · chat-screen.tsx)

  X->>H: ctx.ui.confirm(title, message, { signal?, timeout? })
  H->>H: awaitDialog — mint id, park { resolve, request } in pendingDialogs
  H-->>F: observation extension-ui-request { id, blocking: true, dialog, origin }
  F-->>B: routeUiRequest — { id, dialog } checked against ZenOpenDialog, card rendered
  Note over X,B: the thread is busy (parked); nothing in the server or the browser holds the promise
  B->>R: POST …/dialog { id, value | confirmed | cancelled: true }
  R->>R: peek (404 cold) · openDialogs().find(id) (404 spent) · validateDialogAnswer unless cancel (422)
  R->>H: runtime.answerDialog(answer) — then 204 to B; the response says nothing else
  H->>H: pending.resolve ⇒ finish(value, 'answered'): delete entry, clear timer, unhook signal
  H-->>F: observation dialog-settled { id, outcome } — every follower drops the card for THIS id
  H-->>X: the extension's promise resolves — after the settle is on the stream
  Note over H: browser cancel / dispose ⇒ 'cancelled' · extension's timeout ⇒ 'timeout' · extension's signal ⇒ 'aborted'
  Note over F,B: a follow opened while parked: snapshot.openDialogs lists the question, oldest first
```

## The invariants it shows

1. **The question is parked in the host, and nowhere else.** `awaitDialog` mints the id, keeps
   `{ resolve, request }` in a `Map` keyed by it, and emits the request on the same emitter as the
   session's events, so request and settle sit in stream order. Nothing parks server-side; the
   run keeps going on the follow (`follow.ts` header). The thread is *busy* (`glossary.md` → *parked*).
2. **An answer is checked against the question it names before the runtime sees it.**
   `answerThreadDialog` peeks — never builds — then finds the id in the runtime's `openDialogs()`:
   a cold thread or a spent question is 404; a non-cancel answer the fence below refuses is 422 and
   the question stays open; only then is `answerDialog` called and 204 returned.
3. **Every path that stops the wait goes through `finish`.** Answer, browser cancel, `dispose`'s
   `cancelAllDialogs`, the extension's own `timeout`, the extension's own `signal` — each deletes the
   pending entry first (so a second path is a no-op), emits `extension_ui_settled` with its outcome,
   and *then* resolves the extension. The runtime has no event for a question ending. One exception:
   a `signal` already aborted when asked resolves the cancel value with no request and no settle.
4. **A non-answer resolves the runtime's own cancel value, never a wrong type.** `select`, `input`
   and `editor` see `undefined`; `confirm` sees `false` (`CONFIRM_DISMISSED`). `mapResponse`
   degrades a wrong-shaped answer to that value. An answer naming no pending id is a logged warning.
5. **The settle is for one id, on every follower; the snapshot's list is complete.** The browser
   drops the card only when `dialog-settled` names the id it shows. `openDialogs()` walks the pending
   map in insertion order — oldest first — checking each request with `isZenDialogSpec` rather than
   casting; the snapshot carries that list whole, so a reconnect renders the card and an empty list
   clears one.
6. **Stop stops: the run's abort settles every pending dialog as `aborted`.** `agent-host.ts#abort`
   tells the runtime first — so its loop holds the abort signal when a blocked `tool_call` handler
   returns — then `abortAllDialogs()` resolves each pending question to its cancel value with the
   glossary's outcome for exactly this, `aborted`, and every follower hears `dialog-settled`. Before
   2026-09-16 the host settled nothing on abort, and the vendor's permission prompt passes no signal
   of its own, so Stop during a permission question waited on the card until a human answered it
   (decided: *if the user says stop, it's stop*).

## The validation contract

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
 *
 * @group Dialogs
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

## The tests that pin it

Each marker is checked by `test/docs-gate.test.ts`: a renamed or deleted test with that exact title fails this page.

<!-- test: packages/web/src/server/__tests__/follow.test.ts#⚠ a blocking dialog is an observation on the follow and a unary answer back — nothing parks, nothing expires -->
- **Invariants 1 and 2, end to end** — [`follow.test.ts`](../../packages/web/src/server/__tests__/follow.test.ts):
  422, 404, 204, then 404 on replay; the settle frame precedes the status frame.
<!-- test: packages/web/src/server/__tests__/follow.test.ts#⚠ a question answered in one tab is settled on every follower's feed, and a follow opened under it gets it in the snapshot (#114) -->
- **Invariant 5, over the wire** — one tab answers, two others get the same `dialog-settled` frame.
<!-- test: packages/core/src/__tests__/schemas.test.ts#validateDialogAnswer refuses every answer shape a dialog did not ask for, and names the shape it wanted -->
- **The fence above, every branch** — [`schemas.test.ts`](../../packages/core/src/__tests__/schemas.test.ts).
<!-- test: packages/web/src/host/__tests__/agent-host.test.ts#⚠⚠ a dialog an extension opens reaches the subscriber and its answer resolves the extension -->
- **Invariant 1, through the real runtime** — [`agent-host.test.ts`](../../packages/web/src/host/__tests__/agent-host.test.ts).
<!-- test: packages/web/src/host/__tests__/agent-host.test.ts#a cancelled dialog resolves to pi's cancel value, and dispose cancels what is still pending -->
- **Invariants 3 and 4, the cancel and dispose paths.**
<!-- test: packages/web/src/host/__tests__/extension-ui-context.test.ts#openDialogs lists the pending questions as the browser's dialog specs, oldest first, and nothing once settled (#112, #114) -->
- **Invariants 3 and 5, in the host** — [`extension-ui-context.test.ts`](../../packages/web/src/host/__tests__/extension-ui-context.test.ts).
<!-- test: packages/web/src/host/__tests__/extension-ui-context.test.ts#the caller's abort signal and timeout both resolve to the cancel value, each settled with its own reason (#114) -->
- **Invariant 3, `aborted` and `timeout`, and the never-asked exception.**
<!-- test: packages/web/src/__tests__/custom-event-router.test.ts#dialog-settled drops the card for ITS id and no other (#114) -->
- **Invariant 5, in the browser** — [`custom-event-router.test.ts`](../../packages/web/src/__tests__/custom-event-router.test.ts).

<!-- test: packages/web/src/host/__tests__/agent-host.test.ts#⚠ Stop stops: the run's abort settles a pending dialog as `aborted` — the card drops, the extension resumes with its cancel value -->
- **Invariant 6, at the host** — [`agent-host.test.ts`](../../packages/web/src/host/__tests__/agent-host.test.ts):
  abort → `dialog-settled` with outcome `aborted`; the extension resumes with its cancel value; a
  late answer is reported, not applied.
<!-- test: packages/web/src/host/__tests__/extension-ui-context.test.ts#abortAllDialogs settles every pending dialog as aborted, each blocked call resolving to its cancel value, once -->
- **Invariant 6, the settle itself** — every pending question, once, under the glossary's word.

## Where it is stated

The vocabulary and both schemas: [`seams/dialog.md`](../seams/dialog.md). The host's wait:
`packages/web/src/host/extension-ui-context.ts` (header, `awaitDialog`, `answerDialog`, `openDialogs`,
`cancelAllDialogs`); its binding and `dispose`: `agent-host.ts`. The route: `server/follow.ts#answerThreadDialog`;
the snapshot's list: `follow.ts#followThread`. The settle's mapping: `map-events.ts` → `extension_ui_settled`.
The browser: `custom-event-router.ts#routeUiRequest` and its `dialog-settled` case; `follow-connection.ts#answerDialog`.
*Parked*, *dialog*, *answer*, *outcome*: [`glossary.md`](../glossary.md) → Thread states, Control.
