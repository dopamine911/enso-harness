# Flow: abort — clear the queue, hand it back, let the settle end the run

A stop is one `POST /api/threads/:id/abort` with no body: the thread id is the whole request (#116).
The registry clears the runtime's queue *before* telling it to abort and answers with what was
waiting — **clear-and-restore** (#75), for the composer of the tab that stopped. The route releases
nothing: the run ends on the follow by its own `settled`, as any run does, and the runtime is told
once — a repeat while the abort is pending gets the same answer with nothing restored.

## The sequence

```mermaid
sequenceDiagram
  participant B as composer (chat-screen.tsx)
  participant C as connection (follow-connection.ts)
  participant R as abort route (server/index.ts → server/follow.ts)
  participant G as registry (thread-registry.ts)
  participant P as runtime (ThreadRuntime)
  participant F as feed → every follower

  B->>C: stop click ⇒ abort()
  C->>R: POST …/abort (no body)
  R->>G: abort(threadId)
  Note over G: no live thread ⇒ 404 · not busy ⇒ 409 · abort already in flight ⇒ aborted, restored []
  G->>P: clearQueue() — BEFORE the abort
  P-->>F: queue { steering: [], followUp: [] }
  P-->>G: { steering, followUp }
  G->>P: abort() — kept as abortInFlight; the next acquire awaits it
  G-->>R: { outcome: aborted, restored: [...steering, ...followUp] }
  R-->>C: 200 { threadId, restored }
  C-->>B: { outcome: aborted, restored } ⇒ takeBack: never-asked bubbles leave, draft += restored
  Note over G,F: still busy — the route released nothing
  P-->>F: settled ⇒ the prompt route's settle observer releases the lease
  F-->>C: status { busy: false } ⇒ the run closes in every tab alike
  opt a prompt this tab had queued
    P-->>F: prompt-rejected { messageId }
    C-->>B: said as a problem — no run error, no run to match
  end
```

## The invariants it shows

1. **One abort per run, by thread; the route releases nothing.** The stop is addressed by thread id
   because the lease that took the run lives in the prompt route's closure and a later request
   cannot reach it. `busy` stays true until the settle lands, so a repeat while the abort is pending
   is answered `aborted` with an empty `restored` and the runtime is not told again. No live thread
   is a 404, nothing in flight a 409; neither reaches the runtime.
2. **The queue is cleared before the runtime is told, and comes back steering first.** The runtime's
   loop leaves on abort before its follow-up drain, so anything still queued would ride into the
   next prompt unasked; the registry's `abort` calls `clearQueue()` first, then `abort()`, and
   answers with the steering texts followed by the follow-ups. `clearQueue()` also emits the
   emptied `queue` observation, so every follower's list clears — the texts go only to the caller.
   The stop is an `info` record carrying the *count* handed back, never the texts.
3. **A stop must stop.** If clearing the queue throws, the loss is an `error` record, `restored` is
   empty, and the runtime is still told to abort — never the other way round.
4. **The run ends on the follow by its settle, not by the route.** The runtime's `abort()` resolves
   when the agent is idle again, and the run still settles; the prompt route's settle observer
   (`server/follow.ts#promptThread`) releases the lease. The registry keeps the abort in flight and
   the next `acquire` awaits it, so a prompt straight after a stop starts against an idle session.
   The browser's `abort()` closes no run either; `idle`, `gone`, `unreachable` are outcomes, not throws.
5. **The stopping tab's composer gets the texts back; the bubbles that were never asked leave.**
   `chat-screen.tsx` appends `restored` to the draft after anything already typed and removes the
   user bubbles this composer put in the transcript for prompts the runtime still held; a claimed
   prompt's bubble stays, and deltas that streamed meanwhile are kept. Only texts come back — images
   attached to a queued prompt are not restored, a limit the composer states, not a gap.
6. **A later rejection of a queued prompt is said, not matched to a run.** The connection keeps the
   receipt ids of prompts this tab queued behind a run; a `prompt-rejected` naming one is reported
   where the human looks and opens no run error. `settled` forgets the ids: nothing behind a
   settled run can be refused any more — the runtime claimed it, or a stop cleared it.

## The receipt contract

<!-- source: packages/core/src/follow.ts#ZenAbortReceipt -->
```ts
/**
 * What `POST /api/threads/:id/abort` answers with when pi was told (#116, #75): the prompts
 * that were WAITING behind the stopped run, in order, steering first — cleared from pi's
 * queue and handed back so the stopping tab can put them in its composer (pi's TUI does the
 * same). Never delivered silently on the next turn, never dropped. Empty when nothing waited.
 * The run's own end still arrives on the follow.
 */
export const ZenAbortReceipt = Type.Object(
  {
    threadId: Type.String(),
    restored: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)
```

## The tests that pin it

Each marker below is checked by `test/docs-gate.test.ts`: the file must declare a test with exactly
that title, so a renamed or deleted pin fails this page.

<!-- test: packages/web/src/server/__tests__/follow.test.ts#⚠ POST …/abort tells pi once and answers with the restored queue; the run still ends on the follow by its settle, not by the route (#116, #75) -->
- **Invariants 1, 2 and 4, end to end** — [`follow.test.ts`](../../packages/web/src/server/__tests__/follow.test.ts):
  404 → 200 with the queue steering first, still busy, the emptied `queue` frame, `settled` + `status`, then 409.
<!-- test: packages/web/src/server/__tests__/thread-registry.test.ts#⚠ abort hands back the queued prompts in order and clears pi's queue; a repeat restores nothing -->
- **Invariant 2** — [`thread-registry.test.ts`](../../packages/web/src/server/__tests__/thread-registry.test.ts):
  the order, the one clear, the count-only record, and the repeat's empty `restored`.
<!-- test: packages/web/src/server/__tests__/thread-registry.test.ts#abort stops the run and never disposes; a repeat while it is pending is the same answer, not a second call; the next acquire waits for it (#116) -->
- **Invariants 1 and 4, the registry's half** — one call to the runtime, no dispose, and an
  `acquire` that waits for the abort in flight.
<!-- test: packages/web/src/server/__tests__/thread-registry.test.ts#abort on an idle thread or an unknown one touches nothing, and says which (#116) -->
- **Invariant 1, the refusals** — `idle` and `unknown` clear nothing and abort nothing.
<!-- test: packages/web/src/server/__tests__/thread-registry.test.ts#⚠ a stop must stop: if clearing the queue throws, pi is still told to abort and the loss is said (PR #129 review) -->
- **Invariant 3** — a throwing clear is an error record; the abort still goes.
<!-- test: packages/web/src/__tests__/follow-connection.test.ts#abort is one POST to …/abort and names what the server did; it closes no run itself — the feed does (#116) -->
- **Invariant 4, the browser's half** — [`follow-connection.test.ts`](../../packages/web/src/__tests__/follow-connection.test.ts):
  no `RUN_FINISHED` until the feed's `settled` + `status`; `idle` and `gone` named, not thrown.
<!-- test: packages/web/src/__tests__/follow-connection.test.ts#⚠ abort() hands back what pi had queued; a later rejection of a queued prompt is said, not matched to a run -->
- **Invariant 6** — the receipt's `restored` crosses whole; the queued prompt's later rejection is a
  problem, not a `RUN_ERROR`.
<!-- test: packages/web/src/__tests__/thread-pane.test.tsx#Enter or the button: one POST …/prompt each and the draft clears; DURING a run the prompt goes to pi now, listed above the composer, and a stop hands it back (#75) -->
- **Invariant 5** — [`thread-pane.test.tsx`](../../packages/web/src/__tests__/thread-pane.test.tsx):
  one abort, the words back in the composer, the never-asked bubble gone with the list, the first
  prompt's bubble kept.

## Where it is stated

The route: `packages/web/src/server/follow.ts` (module header, `POST …/abort`) and `#abortThread`;
`server/index.ts#respondToAbort`. The order and the one-abort rule: `thread-registry.ts#abort` and the
module header's *abort-then-prompt race*. The contract: `abort` and `clearQueue` on
[`seams/thread-runtime.md`](../seams/thread-runtime.md). The browser: `follow-connection.ts#abort`,
`stopRun` / `takeBack` in `chat-screen.tsx`, and [`seams/presentation.md`](../seams/presentation.md)
(a stop restores through the receipt, not the `queue` frame). The decisions: `architecture.md` →
*Decided constraints*, *Abort is by thread, not by lease* (#116) and *A stop hands the queue back —
clear-and-restore* (#75), and control-plane invariant 2 (200 with the receipt). The word: [`glossary.md`](../glossary.md) → Control → *abort, stop*.
