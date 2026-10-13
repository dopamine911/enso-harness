# Seam: presentation

The browser is two layers with a fixed seam between them. The **state layer** holds messages and
runs and connects through a send/subscribe adapter that is exactly prompt/follow; the **presentation
layer** is components ported file by file from an upstream library, retyped as they cross, holding
component-local state and nothing of ours. Glossary domain: **Surface** (surface, state layer,
presentation layer, pane, transcript, composer, card) and the browser's side of **Observation** (the
adapter, custom event). The contract below is what the state layer exposes to the rest of the page;
the rule is that nothing under `components/` may reach it.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/presentation.md`.

## The contract

The adapter. `createFollowConnection` (`packages/web/src/follow-connection.ts#createFollowConnection`, not fenced
for its length) builds one per thread: `subscribe()` opens `GET /api/threads/:id/follow` once and
turns frames into the state layer's chunks; `send()` POSTs the prompt and answers at admission. Three
methods beside the vendored adapter interface are ours, and each says why the vendored one would not do:

<!-- source: packages/web/src/follow-connection.ts#FollowConnectionOptions -->
```ts
export interface FollowConnectionOptions {
  readonly threadId: string
  /** Test seam: the page's `fetch`. */
  readonly fetch?: FetchLike
  /** Notified for anything the adapter could not deliver. Never silent. */
  readonly onProblem?: (problem: unknown) => void
  /**
   * A finished tool result's #18 descriptor (#411). It rides the AG-UI result as an extra key, and
   * TanStack's processor keeps none (`updateToolResultPart` takes no metadata), so the page would
   * never see it live; this hands it over before the result is pushed, so it is known when the
   * result renders.
   */
  readonly onToolResultDescriptor?: (toolCallId: string, descriptor: EnsoToolResultDescriptor) => void
  /**
   * A turn started on the thread — pi's `turn_start`, the evidence a run is really going (PR #440
   * review). A lease alone (a mode change, `/model`, a refused Continue) raises `busy` but never
   * starts a turn, so what must key on "a run answered this thread" keys on this, not on `busy`.
   */
  readonly onTurnStart?: () => void
  /**
   * Whether the page is going away (#664; `page-leaving.ts` by default): a stream the browser cuts
   * as the page leaves is not a failed follow. Test seam.
   */
  readonly leaving?: () => boolean
}
```

<!-- source: packages/web/src/follow-connection.ts#FollowConnection -->
```ts
export interface FollowConnection extends SubscribeConnectionAdapter {
  /** Answer the thread's open question. A non-`answered` outcome is also reported with the server's reason. */
  readonly answerDialog: (answer: DialogAnswer) => Promise<DialogAnswerOutcome>
  /**
   * Stop the run in flight (#116). ⚠ Not TanStack's `stop()`: that aborts this client's
   * in-flight POST, which returned at admission long ago, and touches nothing on the server.
   * The answer carries what was queued behind the run, for the composer (#75).
   */
  readonly abort: () => Promise<AbortResult>
  /**
   * Send a prompt while a run is in flight (#75). ⚠ Not `chat.sendMessage`: TanStack holds a
   * send in its own queue while the run it started is open, and delivers it at settle — the
   * browser's queue, invisible to other tabs and lost on reload. This POSTs now with
   * `admission: enqueue`, so the runtime queues it and every follower sees it.
   */
  readonly prompt: (text: string, images?: readonly EnsoPromptImage[]) => Promise<PromptOutcome>
  /**
   * Switch the permission mode (L3 step C): `POST …/mode`, a control route, never a prompt —
   * the browser says a mode and no command. The change arrives on the follow as `permission-mode`,
   * said by the host once its extension has persisted it; a refusal is reported with the
   * server's reason and moves nothing.
   */
  readonly changeMode: (mode: string) => Promise<ModeChangeOutcome>
  /**
   * Run a `host` command (#338 slice 2): `POST …/command`, `/model` with an `options[].id` or
   * `/thinking` with a level — the same control shape as `changeMode`, and the same failure
   * path: `busy` (409) and `refused` (422, the host's reason) are recorded through `problem`
   * and said once, the way a refused mode change is. The store moves on the
   * feed's `model` observation, never on the answer.
   */
  readonly runHostCommand: (run: EnsoHostCommandRun) => Promise<HostCommandOutcome>
  /**
   * Apply a new session's model, effort and mode together (#391): `POST …/configure`, the
   * Start-a-session dialog's Start. The server applies them in order under one lease; a refusal
   * comes back with its step and reason for the dialog to show.
   */
  readonly configure: (configuration: EnsoSessionConfiguration) => Promise<ConfigureOutcome>
  /**
   * Fork the thread at one of its user messages (#433): `POST …/fork` with the message's pi entry
   * id. The receipt names the new thread and the words to prefill it with; a refusal — the thread
   * running (409), an entry it does not have (404), one that is no user message (400) — is
   * recorded through `problem` and said once, as a refused control is, and answers `undefined`.
   */
  readonly fork: (entryId: string) => Promise<EnsoForkReceipt | undefined>
  /**
   * Continue the thread's torn tail from its stored state (#436): `POST …/continue`, no prompt and
   * no new user message. The run arrives on the follow as a run another tab started would; a refusal
   * — the thread running (409), nothing to continue (422) — is recorded through `problem` and said
   * once, as a refused control is.
   */
  readonly continueRun: () => Promise<ContinueOutcome>
  /**
   * Resolve the thread's incident (#466): `POST …/incidents/:incidentId/resolve`, the human's
   * classification and outcome. The resolution arrives on the follow as its `custom-entry`; the
   * answer only says whether the server took it — and, when not, why, because the card that asked
   * shows the reason where the person is looking (as `configure` does for its dialog).
   */
  readonly resolveIncident: (incidentId: string, resolution: EnsoIncidentResolution) => Promise<IncidentResolveOutcome>
  /**
   * Release the thread's follow (#272): the socket closes and nothing else opens one on
   * this connection. The page calls it when a thread leaves its live list — a thread whose
   * pane is gone must not keep a stream the browser counts against its six-per-origin
   * budget. Idempotent, and LATCHING: a later `subscribe` ends at once rather than
   * reconnecting a thread the page has let go.
   *
   * ⚠ Not the server going away: a close from this side emits no `follow-ended` and no
   * problem. `disconnected` states a server that dropped the page, which this is not.
   */
  readonly close: () => void
  /**
   * The assistant message of the chunk TanStack is processing now, in STREAM order (#382) — the
   * last `TEXT_MESSAGE_START` this adapter has handed over, which a run opens and a rotation moves.
   * Undefined until the first. A line the router adds while processing a chunk follows this
   * message: React's committed transcript lags the stream, and a line placed by it would land in
   * the bubble before a rotation the same batch made.
   */
  readonly streamMessageId: () => string | undefined
}
```

The store primitive every per-thread store is built on — one value, replaced whole, a listener set:

<!-- source: packages/web/src/store.ts#Store -->
```ts
/**
 * The smallest external store React can subscribe to: one value, replaced whole, and a
 * listener set.
 *
 * Every per-thread store (mode, stats, notifications, …) is one of these with domain methods on
 * top — see `thread-stores.ts` for why they are instances rather than module state (#90 PR 3: a
 * page holds several threads, and each needs its own).
 *
 * A leaf module on purpose: the domain modules import `useThreadStores` from here, and
 * `thread-stores.ts` imports the domain factories, so the type import above is the only
 * edge back — a type, erased, no cycle at runtime.
 */
export interface Store<T> {
  readonly get: () => T
  readonly subscribe: (listener: () => void) => () => void
}
```

<!-- source: packages/web/src/store.ts#WritableStore -->
```ts
export interface WritableStore<T> extends Store<T> {
  readonly set: (next: T) => void
}
```

Everything the page holds about one thread beyond its messages, created per thread so a second
thread on the page gets its own:

<!-- source: packages/web/src/thread-stores.ts#ThreadStores -->
```ts
/**
 * Everything the browser knows about one thread beyond its messages (#90 PR 3).
 *
 * ⚠ WHY INSTANCES, NOT MODULE STATE. Until this, every store was a module singleton — one
 * mode, one cost, one notification list per PAGE — which was correct only while a page
 * held exactly one thread. The sessions rail holds several and switches between them; a
 * run in one keeps streaming while another is on screen, and its `session-usage` must land in
 * ITS cost, not the visible thread's. So each thread gets its own set, created here, and
 * the pane that renders a thread provides them through `ThreadStoresContext`.
 *
 * ⚠ THE PAGE OWNS ITS LIVE LIST. The rail's first section is the threads this page minted
 * or resumed — only those chat instances can be switched to. Stored sessions appear in the
 * second section and become page-owned only after `/history` succeeds. A session another tab
 * is running is refused by both the rail and the server; two pages never drive one pi session.
 *
 * ⚠ AND IT IS BOUNDED (#272). A live thread holds a follow — one SSE connection — for as
 * long as its pane is mounted, and a browser gives an origin six HTTP/1.1 connections; the
 * server is plain `Bun.serve` over loopback, so there is no h2 multiplexing to hide behind.
 * Past the budget the newest follow AND every unary `/api` call the page makes (`prompt`,
 * `/history`, `/api/mode`) queue behind the open streams, silently. So the page holds at
 * most `MAX_LIVE_THREADS`: minting or adopting past it drops the least recently active idle
 * thread, which closes its follow. Neither a thread with a run in flight nor the one ON
 * SCREEN is ever the victim — a follow the page is showing or streaming is not spare
 * capacity — so a page made only of those goes over budget and records it. The session is
 * the server's, not the page's, so a dropped thread comes back through the rail's earlier threads —
 * the rail and `popstate` already resume a thread this page does not hold.
 */
export interface ThreadStores {
  readonly threadId: string
  /**
   * The messages the thread's chat mounts with (#95): a resumed thread's stored branch,
   * as the server mapped it; empty for a thread minted on this page. Read ONCE, by the
   * chat factory — TanStack owns the messages from there.
   */
  readonly history: readonly UIMessage[]
  /**
   * What of the branch is before the messages this page holds (#739): `/history` sends a long
   * thread's last page, and the transcript offers "Load earlier" while this is set. Undefined once
   * the page holds the branch from its start — and for a thread minted here, which it always does.
   */
  readonly earlier: WritableStore<EarlierMessages | undefined>
  /**
   * What the composer opens holding (#433): a fork's prefill — the forked prompt's words, to send
   * again or edit, as pi's `/fork` puts them in its editor — and empty otherwise. Read ONCE, when
   * the composer mounts; the composer owns its draft from there.
   */
  readonly initialDraft: string
  readonly permissionMode: PermissionModeStore
  /** The session's model and thinking level (#338 slice 2); `null` until a live snapshot or `model` observation says. */
  readonly model: ModelStore
  /** The tree pi runs this thread in (#44), from every snapshot; undefined until the follow's first one. */
  readonly cwd: WritableStore<string | undefined>
  /** Whether the thread runs on a tree of its own (#551), from every snapshot — what makes "Restore files to here" an offer. */
  readonly tree: WritableStore<boolean>
  /**
   * Whether the server can answer this thread's reads (#659): it has been seen with a session or
   * messages — stored history, a snapshot's model or messages, a `model` observation. ⚠ LATCHED,
   * never reset: a snapshot nulls the model when the session idles out, and a
   * thread minted on this page has no stored history, yet the thread ran and its routes answer.
   */
  readonly readable: WritableStore<boolean>
  /**
   * What the session has spent and how full its context is (#45): the snapshot's `usage`, then
   * each `session-usage` observation, each the WHOLE state from pi's session totals — so a
   * reload, a resume or a second tab shows what the first tab saw accumulate. Undefined until
   * the follow's first snapshot.
   */
  readonly usage: WritableStore<EnsoSessionUsage | undefined>
  readonly notifications: NotificationsStore
  readonly modeLines: ModeLines
  readonly recentChunks: RecentChunksStore
  /**
   * The server-side acquisition this page's LAST run on the thread held, from its
   * `status` frame's `generation` (#109); undefined until a run starts. The debug pane compares it
   * with the server's current `generation`: a difference names a run this page did not
   * make — another tab, or a rebuild after the idle window.
   */
  readonly generation: WritableStore<number | undefined>
  /**
   * The question this page shows pi blocked on; undefined when none. Fed by three chunks
   * (#112, #114): `extension-ui-request` opens it when the slot is free, `dialog-settled`
   * clears it by id, and a snapshot's `openDialogs` replaces it wholesale. ONE slot is the
   * browser's choice, not pi's — extensions can hold several questions at once
   * (`openDialogs()` lists them); this page shows the OLDEST, so no later ask displaces the
   * question being read (#271, the router's `routeUiRequest`), and a second becomes visible
   * only once a snapshot lists it first (the router's `snapshot` branch) — until then it
   * waits on the server, answerable from this thread after a reload. Also cleared by an
   * answer this page sends that the server takes or reports gone.
   */
  readonly dialog: WritableStore<EnsoPendingDialog | undefined>
  /**
   * The follow ended under this page (#119): the server closed, restarted, or dropped the
   * connection, and nothing here reconnects — the thread's state on this page is as of that
   * moment. Set by `follow-ended`; cleared by the next `status` or `snapshot` frame, which only a live
   * follow delivers. While true the status bar says `disconnected` and no stop is offered,
   * whatever the run flag still holds: the page cannot know what the server is doing.
   */
  readonly disconnected: WritableStore<boolean>
  /**
   * What waits behind the run in flight (#75): the texts, the interrupting ones first,
   * from every `queue` frame — one list for every follower, so a second tab sees what
   * the first queued. Empty when nothing waits. Rendered above the composer; a stop hands
   * these back to the composer through the abort receipt, not from here (the frame that
   * empties this can beat the receipt).
   */
  readonly queue: WritableStore<readonly string[]>
  /**
   * The provider's last refusal (#340) while nothing has succeeded since: its class word, and the
   * session's output tokens when it came. A `session-usage` whose output has grown past that clears
   * it — pi's own accounting is what says a reply got through. The status bar reads it, so `$0.0000`
   * next to `idle` is never read as "free" when it means "nothing ran".
   */
  readonly refusal: WritableStore<ProviderRefusalMark | undefined>
  /**
   * The calls something refused (#387, #407, #523), by tool-call id, with who refused each: Enso's
   * guard and its rule, the user's permission rule, `auto`'s classifier, or the person. pi hands
   * the page a refusal as an error result shaped like any failed command; this is what tells them
   * apart. Seeded from the history's results (the server joined the refusing entry onto each),
   * then fed by the live `custom-entry` chunk the entry crosses as — one store either way, so a
   * refusal reads the same live, reloaded and resumed.
   */
  readonly refusals: WritableStore<ReadonlyMap<string, EnsoToolRefusal>>
  /**
   * The session's risk (#464): its level and how many observed signals it rests on — seeded from
   * the history and the follow's snapshot (the server's replay of the branch), raised live by the
   * guard's `enso-session-risk` entry. Observed evidence, not a verdict.
   */
  readonly sessionRisk: WritableStore<EnsoSessionRiskChange>
  /**
   * The Stats view is to open at the session risk's signals (#727): raised by the status bar's risk
   * word as it asks for Stats, lowered by the session eval once it has landed there — or once its
   * read failed — so the next visit to Stats opens at the top.
   */
  readonly landOnRiskSignals: WritableStore<boolean>
  /**
   * The session's incidents (#466): every one opened, each with its resolutions, the tool families
   * suspended now, and whether a resolution ended the thread. Seeded from the history and the
   * follow's snapshot (the server's fold of the branch), folded live with the same
   * `sessionIncidentsStep` over the guard's opening and the host's resolution entries.
   */
  readonly incidents: WritableStore<EnsoSessionIncidents>
  /**
   * Finished tool results' #18 descriptors, by tool-call id, as they arrive LIVE (#411): TanStack
   * drops the one the AG-UI result carries, so the follow connection hands it over here. A stored
   * result carries its descriptor in its own metadata, so nothing is seeded; `EnsoToolResult`
   * reads this first, then the result.
   */
  readonly toolResultDescriptors: WritableStore<ReadonlyMap<string, EnsoToolResultDescriptor>>
  /**
   * The Start-a-session dialog is open (#391). Raised when the page MINTS the thread — New Thread,
   * a page with no thread in its URL — and lowered by Start or Escape; a thread adopted from
   * history never raises it.
   */
  readonly startSession: WritableStore<boolean>
  /**
   * Whether a prompt is typed and not sent (#875), by where it is typed: the composer, and the
   * Start-a-session dialog, which holds its own until it starts or hands it to the composer. A draft
   * holding neither is discarded when the page leaves it (`discardEmptyDraft`).
   */
  readonly typed: { readonly composer: WritableStore<boolean>; readonly startDialog: WritableStore<boolean> }
  /**
   * How many compactions pi has said it finished on this thread (#348): each rewrote the branch
   * under the transcript this page holds. The pane re-reads the thread once it is idle and has
   * seen fewer than this.
   */
  readonly branchCompacted: WritableStore<number>
  /**
   * How many of the thread's stopped runs this page has said (#766): each live `enso-run-stopped`
   * entry, and each stop the history or a snapshot listed. A snapshot lists every stop on the
   * branch, oldest first, so the page says only those past this count — a reconnect never says a
   * stop twice. Counted, not matched by message: a live line follows the stream's own message id,
   * which is not the id the branch gives that message.
   */
  readonly runStops: WritableStore<number>
  /** The login waiting on its provider (#348): what the composer's Stop can end. Undefined when none is. */
  readonly login: WritableStore<EnsoLoginInProgress | undefined>
  /**
   * The project this thread runs in (#395): the one its `+` named when minted, or its stored
   * session's when adopted. `undefined` for a thread minted before the page knew its projects (a
   * fresh page's first thread) — the server builds it in the launch directory, which is where the
   * rail files it.
   */
  readonly projectId: string | undefined
  /**
   * Every thread-scoped request's fetch: the #118 seam's (or the page's), naming `projectId` in
   * `X-Enso-Project` so the server builds a new thread's session there. The server reads the header
   * only until the session exists; after that, the session's own directory decides.
   */
  readonly fetch: FetchLike
  /** The thread's transport: TanStack's connection over prompt/follow, and the dialog answer beside it. */
  readonly connection: FollowConnection
}
```

The one path from a custom event to those stores is `routeEnsoCustomEvent` (`custom-event-router.ts#routeEnsoCustomEvent`,
in prose): it records every event in `recentChunks`, then dispatches on the name, which is the
observation's `kind` or the frame's `type` (#162 workstream 5) — a `snapshot` to the mode stores, the
model, the project, the session's `usage`, the dialog slot and `generation`; a `status` to `generation`
(and clears `disconnected`); `permission-mode` to the current mode and the mode lines; a `model` to the
model store; a blocking `extension-ui-request` to the dialog slot when it is free (the oldest question
holds it, #271) and a notify to `notifications` — each line anchored, as it is pushed, to the message it
follows (`streamMessageId`, else the transcript's last; #382), so it renders after that message's bubble
rather than after the whole transcript; `dialog-settled` to the slot; `session-usage` to
`usage`, whole (#45);
`queue` to `queue`; `permission-mode-rejected` to a warning notice; `follow-ended` to `disconnected`
plus a notice. Every value is validated against its schema: a malformed one moves no store rather than
throwing inside the state layer's stream loop, where a throw would end the run.

## Who implements it, who consumes it

**The state layer's side is built once per thread.** `createThreadStores` (`thread-stores.ts#createThreadStores`)
creates every store above and the thread's `connection` (`createFollowConnection`,
with `onProblem` routed into the thread's notifications and `onToolResultDescriptor` into `toolResultDescriptors`, #411). `thread-pane.tsx#threadChatOptions`
hands that connection, the stored history and an `onCustomEvent` closure over the thread's stores to the
state layer's chat factory (`thread-pane.tsx#createThreadChatHook`) — one factory per thread, because
the state layer passes `onCustomEvent` no thread id.

**The presentation layer is consumed by the surface's own components.** The pane's modules pull
`attachments`, `prompt-input` and `queue` (`composer.tsx`), `conversation` (`chat-layout.tsx`,
`transcript.tsx`) and `message` (`message-row.tsx`) from `components/ai-elements/`;
`selected-message-part.tsx` pulls `reasoning`. Those ai-elements files and their commit pins are
the generated table in [`ported-provenance.md`](./ported-provenance.md); the eight `ui/` shadcn
primitives beneath the same fence are receipted by [`components/ui/README.md`](../../packages/web/src/components/ui/README.md)
instead, because the shadcn registry is re-fetched by style and version rather than by commit.
The renderers that stay ours are outside the ported directory: the dialog card is
`dialog-card.tsx#EnsoDialogCard`, and the tool-result descriptor renderer, notices, the mode select
and the status bar are the `SelectedMessagePart`, `NotificationLines`, `PermissionModeSelect`,
`ThreadStatusBar` and `EnsoRendererMap` imports.

**The page announces its own state (#737).** A component that renders a state a listener could act
on dispatches it as a DOM `CustomEvent` on `document`, named and shaped by core's `ui-events.ts`
(`packages/core/src/ui-events.ts#ENSO_UI_EVENTS`) and sent through `packages/web/src/ui-events.ts#announceUiEvent`
from an effect, after the commit. The first is `enso:thread-status`, from `ThreadStatusBar`
(`thread-status.tsx#threadStatusKind`): on mount and at each change of `running | question | idle |
disconnected`, the open question's id and title, or `shown`. Dogfood Arena (`dopamine911/dogfood-arena`,
which tests Enso from outside through a pinned submodule and is not part of Enso's gate) listens for
it in its `wait until attention` instead of sampling the accessibility tree, so a change to this
contract or to the words (`THREAD_STATUS_WORDS`, which stay for readers) is a heads-up for the
arena, not a blocker. From the render, never from the server: an event cannot fire for a state the
page failed to show.

**A second connection today: the fixture.** `?fixture` swaps the live adapter for the scripted
conversation in `fixture-conversation.ts` (`thread-pane.tsx#threadChatOptions`, `connection: isFixtureMode ?
createFixtureChat().transport() : stores.connection`), and the option's type admits both (`pane-context.ts#ThreadChatOptions`).
Everything downstream of the connection is identical on both paths, which is what the fixture is for
(the styling dev loop, #31). The swap covers only the client's send, so a fixture page's threads are
also minted with `fixtureFetch`, which refuses every request by name (#404): a prompt queued
mid-reply, Stop, a mode change or the Start dialog's model list reached the real server and ran a
real model before. The presentation components themselves have no second implementation and
need none: an upstream re-port is the second implementation, and the gate is what keeps it possible.

## What fences it

- **The presentation gate** (`test/presentation-gate.test.ts`, #121 item 4, #31, #253) holds three
  lines about all of `packages/web/src/components/` — the path at which three separate exclusions are
  drawn (`oxlint.config.ts` → `ignorePatterns`, `bunfig.toml` → `coveragePathIgnorePatterns`,
  `.fallowrc.jsonc` → `ignoreFindings`), which is why the fence is that path and not a subdirectory
  of it. Until #253 it scanned `components/ai-elements` non-recursively, so the eight `ui/*.tsx`
  primitives were unlinted, unmeasured, exempt from dead-code findings, carried no provenance and were
  held to no state-layer rule; `import { useStore } from "@/store.ts"` in `ui/card.tsx` passed every
  gate in the repo. The three lines, in its header:
  1. *Every vendored subdirectory has a receipt, and every receipt a subdirectory* — checked against
     what is on disk in both directions (`PROVENANCE_RECEIPTS`), so a new vendored subdirectory fails
     until it arrives with one rather than inheriting the three exclusions in silence.
  2. *Every file names its subdirectory's receipt* — `ai-elements` the pinned upstream commit, `ui`
     the registry style — so a port that drifts can be diffed against its receipt, and a file at the
     fence's root, belonging to no receipted port, fails as well.
  3. *Nothing under it holds APPLICATION state* — component-local `useState`/`useRef` is what a
     presentation component is; what may not cross is the state layer: our stores, the follow
     connection, the wire schemas, the vendored client. The gate matches imports, not hooks, and
     it does not spell them: `presentation-gate.test.ts#stateLayerTarget` RESOLVES every specifier a ported file
     writes — `@/x` through the `@/*` → `./src/*` map, a relative path from the file — and refuses
     anything landing under `packages/web/src` outside `components/` and `lib/`
     (`presentation-gate.test.ts#PRESENTATION_DIRECTORIES`), plus `@enso/core` and any `@tanstack/*`
     (`presentation-gate.test.ts#FORBIDDEN_PACKAGE`), which are not ours to resolve. Both spellings, because PR
     #152's review found the alias row missing. Derived, because the hand-written
     list it replaced had gone stale in silence: it named `session-stats`, renamed to
     `thread-stats.tsx` long before, and its hard-coded `.ts` suffix could not match a `.tsx`
     module at all — so `@/permission-mode.tsx`, a hook over the thread's stores, passed
     (#273). The proof that it cannot go stale again is a test, not a comment: every module
     sitting beside `chat-screen.tsx` is read off the directory and must be refused under both
     spellings.
- **The rule** the gate enforces is each ported directory's README (`components/ai-elements/README.md`
  rules 1-4, `components/ui/README.md` rules 1-3): a provenance receipt per file; a standing fork
  updated by diff against that receipt; presentation only — state, the stream protocol, the dialog
  renderer and the tool-result renderer live outside it; and, for the ai-elements port,
  `import … from "ai"` never survives the crossing. `architecture.md` → Presentation states the same
  as *port before you build*: hand-rolling needs its reason in the file header.
- **`page-scoped-stores.test.ts`** (`packages/web/src/__tests__/`) walks every non-test, non-component
  source under `packages/web/src` for a store created at column zero and requires the list to equal
  exactly five page-scoped stores, each with its reason (`page-scoped-stores.test.ts#PAGE_SCOPED_BY_DESIGN`):
  `thread-stores.ts:threadList` (the rail's list), `page-listings.ts:storedThreads` (the server's
  stored-threads listing), `page-listings.ts:projectList` (the server's projects, #395),
  `thread-stores.ts:browserLogging` (the page's log ring and shipper) and `page-clock.ts:pageClock`
  (the page's clock, #278). A sixth module-level store is
  thread state shared across threads — the bug class the mounted two-threads test observes — and
  fails here by name.
- **Invariant 1** (`architecture.md`: *the feed is the only source of run state in the browser*) is
  held inside the adapter. A run opens in `follow-connection.ts#openRun` (`RUN_STARTED`)
  and closes in `follow-connection.ts#closeRun`. The feed drives both: a `status` or snapshot frame reaches
  `follow-connection.ts#observeStatus`, which closes every run the server has moved past
  (`follow-connection.ts#finishRunsThrough`) or opens an `external-<generation>` run another client started; a `settled`
  observation closes the runs through the server's generation, and a `prompt-rejected` closes
  the run it names with `RUN_ERROR` (both in `follow-connection.ts#observe`); the follow ending closes every open run
  (`follow-connection.ts#subscribe`). The one
  place a returning POST touches a run is `follow-connection.ts#send`, and only when admission failed — an image
  refused on this side before any request, the fetch that threw, a status that is not 202, a receipt that fails its schema —
  or when the receipt lands on a run the follow has already spoken for: a rejection that crossed it,
  or a server that released the run before the receipt came back. Never on
  success.

## What crosses it that should not

**The state layer's message shape crosses two wire payloads.** `EnsoThreadHistory.messages`
(`core/src/thread-inspection.ts#EnsoThreadHistory`) and `EnsoFollowSnapshot.messages` (`core/src/follow.ts#EnsoFollowSnapshot`) are both
`Type.Array(Type.Unknown())` on purpose — core must not own the client's transport shape — and both
carry the client's `UIMessage`s. They are built by `transcriptToMessages` in
`server/transcript-to-messages.ts`, the read-side twin of `to-agui.ts`, which imports `MessagePart`
and `UIMessage` from `@tanstack/ai-client` on its first line; the history route (`server/thread-read-routes.ts`)
and the follow's opening snapshot (`server/follow.ts`) each call it and put the result on the wire.
`Unknown` here is a deliberate hole, not an absence: the shape crosses with nothing to diff, so a
partially-deployed change to it raises no schema error on either side. Of the two, only the history
payload is read — `reviveHistoryMessages` (`thread-stores.ts#reviveHistoryMessages`) restores the `Date` that JSON
flattened and drops rows that cannot be UI messages, and `ThreadStores.history` is typed as the
client's `UIMessage` (`thread-stores.ts#ThreadStores`). The snapshot's copy is written and read by nobody: the router's
`snapshot` branch takes `permissionMode`, `openDialogs` and `generation` off the frame and never
looks at `messages`. Not a vendor-of-the-loop leak and not numbered in goals §2, but it is where the
state layer's shape exists outside the page, and a pivot pays for it (below).

**Nothing else of the vendor kind.** The state layer (TanStack AI) and the stream vocabulary its
processor consumes (AG-UI) are vendored by decision, not leaked: `architecture.md` → Presentation
names the client as the state layer, and the glossary's vendor map carries both. Apart from the
message shape above, their vocabulary is derived in memory, in the browser, and never on the wire or
stored — `to-agui.ts`'s header says where it runs (the adapter calls it on each observation before
handing chunks to the client; *nothing serialises the output of this module and nothing stores it*),
and its only production importer is `follow-connection.ts`.

**Two vendored words are kept in the adapter by decision.** The glossary's Retired table keeps
`chunk` and `step` legitimate in "the adapter that derives the state layer's stream" and nowhere
else; `RecordedCustomEvent` and `ToolCallRow` are the names on our side.

**One copy of each state-layer package.** Every `@tanstack/*` and `@ag-ui/*` package a source file
imports directly is pinned once in the root `package.json` `overrides` (#223), and `bunfig.toml`'s
hoisted linker installs one tree. Two copies are not harmless: two `@ag-ui/core` directories gave
`EventType` two module identities, and tsc failed with "`EventType.RUN_FINISHED` is not assignable to
`EventType.RUN_FINISHED`" (measured 2026-09-03). Since `@tanstack/ai` 0.59 TanStack declares the same
`@ag-ui/core` itself, so that pin agrees with it rather than overruling it (#770).
`test/dependency-gate.test.ts` holds the rule and the agreement.

Ordered live-crossing-first on purpose: the bold lead of this section is the architecture table's leak
column (`scripts/docs/seams-table.ts`), and this page used to open "nothing of the vendor kind" and
admit the opposite three paragraphs later (#219).

## Pivot cost

Which files may import the runtime is fixed by a gate (#558): `VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS` in `test/vendor-gate.test.ts` lists them, and the list only shrinks, so a new file cannot quietly add to what follows.

Replace the state layer and the files that change are the adapter and its two neighbours:
`follow-connection.ts` (a new send/subscribe shape, or none), `custom-event-router.ts` (the client's
`onCustomEvent` is the entry; the dispatch to stores stays), `to-agui.ts` (deleted — its header
says so: *a renderer that stops speaking AG-UI deletes it and the adapter*), the chat factory in
`thread-pane.tsx` (`threadChatOptions` and `createThreadChatHook`, and the widget map
written against the client's `ChatUIHost`), plus the message-shape crossing, which is seven sites and
not three: `ThreadStores.history` and `reviveHistoryMessages` in the browser,
`server/transcript-to-messages.ts` as the producer, its two callers in `server/follow.ts` (the follow
snapshot) and `server/thread-read-routes.ts` (the history route), and the two schema fields that carry the result,
`core/src/follow.ts#EnsoFollowSnapshot` and `core/src/thread-inspection.ts#EnsoThreadHistory`.
The per-thread stores, the router's dispatch, and the fixture path are shaped by the thread, not the
client, and survive.

What does not change: the fourteen ported components — the gate proves none imports a store, the
connection, `@enso/core` or the client, so a state layer they have never seen cannot reach them — and
every shape in `@enso/core` EXCEPT the two named above, because the wire otherwise carries observations
and the client's stream vocabulary was only ever made in memory from them. `EnsoThreadHistory.messages`
and `EnsoFollowSnapshot.messages` are the exception, and the cheapest kind to miss: their declarations
need not change at all, since `Unknown` admits a new message shape as silently as the old one — which
is why the pivot has to find their two producers and the reviver by hand, with no schema diff and no
type error pointing at them.
