# Seam: presentation

The browser is two layers with a fixed seam between them. The **state layer** holds messages and
runs and connects through a send/subscribe adapter that is exactly prompt/follow; the **presentation
layer** is components ported file by file from an upstream library, retyped as they cross, holding
component-local state and nothing of ours. Glossary domain: **Surface** (surface, state layer,
presentation layer, pane, transcript, composer, card) and the browser's side of **Observation** (the
adapter, custom event). The contract below is what the state layer exposes to the rest of the page;
the rule is that nothing under `components/ai-elements/` may reach it.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/presentation.md`.

## The contract

The adapter. `createFollowConnection` (`packages/web/src/follow-connection.ts:224-606`, not fenced
for its length) builds one per thread: `subscribe()` opens `GET /api/threads/:id/follow` once and
turns frames into the state layer's chunks; `send()` POSTs the prompt and answers at admission. Three
methods beside the vendored adapter interface are ours, and each says why the vendored one would not do:

<!-- source: packages/web/src/follow-connection.ts#FollowConnectionOptions -->
```ts
export interface FollowConnectionOptions {
  readonly threadId: string
  /** Test seam: the page's `fetch`. */
  readonly fetch?: typeof fetch
  /** Notified for anything the adapter could not deliver. Never silent. */
  readonly onProblem?: (problem: unknown) => void
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
   * `streamingBehavior: followUp`, so pi queues it and every follower sees it.
   */
  readonly prompt: (text: string, images?: readonly ZenPromptImage[]) => Promise<PromptOutcome>
  /**
   * Switch the permission mode (L3 step C): `POST …/mode`, a control route, never a prompt —
   * the browser says a mode and no command. The change arrives on the follow as `permission-mode`,
   * said by the host once its extension has persisted it; a refusal is reported with the
   * server's reason and moves nothing.
   */
  readonly changeMode: (mode: string) => Promise<ModeChangeOutcome>
}
```

The store primitive every per-thread store is built on — one value, replaced whole, a listener set:

<!-- source: packages/web/src/store.ts#Store -->
```ts
/**
 * The smallest external store React can subscribe to: one value, replaced whole, and a
 * listener set. Every per-thread store (mode, stats, notifications, …) is one of these
 * with domain methods on top — see `thread-stores.ts` for why they are instances rather
 * than module state (#90 PR 3: a page holds several threads, and each needs its own).
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
 * run in one keeps streaming while another is on screen, and its `message-end` must land in
 * ITS cost, not the visible thread's. So each thread gets its own set, created here, and
 * the pane that renders a thread provides them through `ThreadStoresContext`.
 *
 * ⚠ THE PAGE OWNS ITS LIVE LIST. The rail's first section is the threads this page minted
 * or resumed — only those chat instances can be switched to. Stored sessions appear in the
 * second section and become page-owned only after `/history` succeeds. A session another tab
 * is running is refused by both the rail and the server; two pages never drive one pi session.
 */
export interface ThreadStores {
  readonly threadId: string
  /**
   * The messages the thread's chat mounts with (#95): a resumed thread's stored branch,
   * as the server mapped it; empty for a thread minted on this page. Read ONCE, by the
   * chat factory — TanStack owns the messages from there.
   */
  readonly history: readonly UIMessage[]
  readonly permissionMode: PermissionModeStore
  readonly stats: ThreadStatsStore
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
  readonly dialog: WritableStore<ZenPendingDialog | undefined>
  /**
   * The follow ended under this page (#119): the server closed, restarted, or dropped the
   * connection, and nothing here reconnects — the thread's state on this page is as of that
   * moment. Set by `follow-ended`; cleared by the next `status` or `snapshot` frame, which only a live
   * follow delivers. While true the status bar says `disconnected` and no stop is offered,
   * whatever the run flag still holds: the page cannot know what the server is doing.
   */
  readonly disconnected: WritableStore<boolean>
  /**
   * What waits behind the run in flight, as pi holds it (#75): the texts, steering first,
   * from every `queue` frame — one list for every follower, so a second tab sees what
   * the first queued. Empty when nothing waits. Rendered above the composer; a stop hands
   * these back to the composer through the abort receipt, not from here (the frame that
   * empties this can beat the receipt).
   */
  readonly queue: WritableStore<readonly string[]>
  /** The thread's transport: TanStack's connection over prompt/follow, and the dialog answer beside it. */
  readonly connection: FollowConnection
}
```

The one path from a custom event to those stores is `routeZenCustomEvent` (`custom-event-router.ts:40-101`,
in prose): it records every event in `recentChunks`, then dispatches on the name, which is the
observation's `kind` or the frame's `type` (#162 workstream 5) — a `snapshot` to the mode stores, the
dialog slot and `generation`; a `status` to `generation` (and clears `disconnected`);
`permission-mode` to the current mode and the mode lines; a blocking `extension-ui-request` to the
dialog slot when it is free (the oldest question holds it, #271) and a notify to `notifications`;
`dialog-settled` to the slot; `message-end` to `stats`;
`queue` to `queue`; `permission-mode-rejected` to a warning notice; `follow-ended` to `disconnected`
plus a notice. Every value is validated against its schema: a malformed one moves no store rather than
throwing inside the state layer's stream loop, where a throw would end the run.

## Who implements it, who consumes it

**The state layer's side is built once per thread.** `createThreadStores` (`thread-stores.ts:88-108`)
creates every store above and the thread's `connection` (`createFollowConnection` at lines 102-106,
with `onProblem` routed into the thread's notifications). `chat-screen.tsx:171-185` (`threadChatOptions`)
hands that connection, the stored history and an `onCustomEvent` closure over the thread's stores to the
state layer's chat factory (`createThreadChatHook`, line 207-209) — one factory per thread, because
the state layer passes `onCustomEvent` no thread id (lines 153-161).

**The presentation layer is consumed by two files.** `chat-screen.tsx`'s imports at lines 23-49 pull
`attachments`, `conversation`, `message`, `prompt-input` and `queue` from `components/ai-elements/`;
`selected-message-part.tsx:7` pulls `reasoning`. The six ported files and their pins are the generated
table in [`ported-provenance.md`](./ported-provenance.md).
The renderers that stay ours are outside the ported directory: the dialog card is `ZenDialogCard` in
`chat-screen.tsx` itself (`#ZenDialogCard`), and the tool-result descriptor renderer, notices, the mode select
and the status bar are the `SelectedMessagePart`, `ThreadNotifications`, `PermissionModeSelect`,
`ThreadStatusBar` and `ZenRendererMap` imports at lines 55-81.

**A second connection today: the fixture.** `?fixture` swaps the live adapter for the scripted
conversation in `fixture-conversation.ts` (`chat-screen.tsx:176`, `connection: isFixtureMode ?
createFixtureChat().transport() : stores.connection`), and the option's type admits both (line 191).
Everything downstream of the connection is identical on both paths, which is what the fixture is for
(the styling dev loop, #31). The presentation components themselves have no second implementation and
need none: an upstream re-port is the second implementation, and the gate is what keeps it possible.

## What fences it

- **The presentation gate** (`test/presentation-gate.test.ts`, #121 item 4, #31) holds two lines
  about `components/ai-elements/`, in its header (lines 12-21):
  1. *Every file names its origin* — the pinned upstream commit in a provenance header, so a port that
     drifts can be diffed against the pin (`UPSTREAM_PIN`, line 32).
  2. *Nothing under it holds APPLICATION state* — component-local `useState`/`useRef` is what a
     presentation component is; what may not cross is the state layer: our stores, the follow
     connection, the wire schemas, the vendored client. The gate matches imports, not hooks, and
     it does not spell them: `stateLayerTarget` (line 68) RESOLVES every specifier a ported file
     writes — `@/x` through the `@/*` → `./src/*` map, a relative path from the file — and refuses
     anything landing under `packages/web/src` outside `components/` and `lib/`
     (`PRESENTATION_DIRECTORIES`, line 58), plus `@zen/core` and any `@tanstack/*`
     (`FORBIDDEN_PACKAGE`, line 59), which are not ours to resolve. Both spellings, because PR
     #152's review found the alias row missing (lines 46-48). Derived, because the hand-written
     list it replaced had gone stale in silence: it named `session-stats`, renamed to
     `thread-stats.tsx` long before, and its hard-coded `.ts` suffix could not match a `.tsx`
     module at all — so `@/permission-mode.tsx`, a hook over the thread's stores, passed
     (#273). The proof that it cannot go stale again is a test, not a comment: every module
     sitting beside `chat-screen.tsx` is read off the directory and must be refused under both
     spellings (line 154).
- **The rule** the gate enforces is the ported directory's README (`components/ai-elements/README.md`,
  rules 1-4): provenance header; a standing fork updated by diff against the pin; presentation only —
  state, the stream protocol, the dialog renderer and the tool-result renderer live outside it; and
  `import … from "ai"` never survives the crossing. `architecture.md` → Presentation states the same
  as *port before you build*: hand-rolling needs its reason in the file header.
- **`page-scoped-stores.test.ts`** (`packages/web/src/__tests__/`) walks every non-test, non-component
  source under `packages/web/src` for a store created at column zero and requires the list to equal
  exactly three page-scoped stores, each with its reason (lines 19-26): `thread-stores.ts:threadList`
  (the rail's list), `chat-screen.tsx:storedThreads` (the server's stored-threads listing) and
  `thread-stores.ts:browserLogging` (the page's log ring and shipper). A fourth module-level store is
  thread state shared across threads — the bug class the mounted two-threads test observes — and
  fails here by name.
- **Invariant 1** (`architecture.md`: *the feed is the only writer of run state in the browser*) is
  held inside the adapter. A run opens in `openRun` (`follow-connection.ts:259-268`, `RUN_STARTED`)
  and closes in `closeRun` (270-274). The feed drives both: a `status` or snapshot frame reaches
  `observeStatus` (326-338), which closes every run the server has moved past (`finishRunsThrough`,
  313-318) or opens an `external-<generation>` run another client started (337); a `settled`
  observation closes the runs through the server's generation (361-366); a `prompt-rejected` closes
  the run it names with `RUN_ERROR` (385); the follow ending closes every open run (418-424). The one
  place a returning POST touches a run is `send`, and only when admission failed (467-518) or the
  receipt arrives after the server has already released the run (521-526) — never on success.

## What crosses it that should not

**The state layer's message shape crosses two wire payloads.** `ZenThreadHistory.messages`
(`thread-inspection.ts` line 228) and `ZenFollowSnapshot.messages` (`follow.ts` line 35) are both
`Type.Array(Type.Unknown())` on purpose — core must not own the client's transport shape — and both
carry the client's `UIMessage`s. They are built by `transcriptToMessages` in
`server/transcript-to-messages.ts`, the read-side twin of `to-agui.ts`, which imports `MessagePart`
and `UIMessage` from `@tanstack/ai-client` on its first line; the history route (`server/index.ts`)
and the follow's opening snapshot (`server/follow.ts`) each call it and put the result on the wire.
`Unknown` here is a deliberate hole, not an absence: the shape crosses with nothing to diff, so a
partially-deployed change to it raises no schema error on either side. Of the two, only the history
payload is read — `reviveHistoryMessages` (`thread-stores.ts:165-191`) restores the `Date` that JSON
flattened and drops rows that cannot be UI messages, and `ThreadStores.history` is typed as the
client's `UIMessage` (line 34). The snapshot's copy is written and read by nobody: the router's
`snapshot` branch takes `permissionMode`, `openDialogs` and `generation` off the frame and never
looks at `messages`. Not a vendor-of-the-loop leak and not numbered in goals §2, but it is where the
state layer's shape exists outside the page, and a pivot pays for it (below).

**Nothing else of the vendor kind.** The state layer (TanStack AI) and the stream vocabulary its
processor consumes (AG-UI) are vendored by decision, not leaked: `architecture.md` → Presentation
names the client as the state layer, and the glossary's vendor map carries both. Apart from the
message shape above, their vocabulary is derived in memory, in the browser, and never on the wire or
stored — `to-agui.ts:17-28` says where it runs (the adapter calls it on each observation before
handing chunks to the client; *nothing serialises the output of this module and nothing stores it*),
and its only production importer is `follow-connection.ts`.

**Two vendored words are kept in the adapter by decision.** The glossary's Retired table keeps
`chunk` and `step` legitimate in "the adapter that derives the state layer's stream" and nowhere
else; `RecordedCustomEvent` and `ToolCallRow` are the names on our side.

Ordered live-crossing-first on purpose: the bold lead of this section is the architecture table's leak
column (`scripts/docs/seams-table.ts`), and this page used to open "nothing of the vendor kind" and
admit the opposite three paragraphs later (#219).

## Pivot cost

Replace the state layer and the files that change are the adapter and its two neighbours:
`follow-connection.ts` (a new send/subscribe shape, or none), `custom-event-router.ts` (the client's
`onCustomEvent` is the entry; the dispatch to stores stays), `to-agui.ts` (deleted — its header
says so: *a renderer that stops speaking AG-UI deletes it and the adapter*), the chat factory in
`chat-screen.tsx` (`threadChatOptions` and `createThreadChatHook`, lines 171-209, and the widget map
written against the client's `ChatUIHost`), plus the message-shape crossing, which is seven sites and
not three: `ThreadStores.history` and `reviveHistoryMessages` in the browser,
`server/transcript-to-messages.ts` as the producer, its two callers in `server/follow.ts` (the follow
snapshot) and `server/index.ts` (the history route), and the two schema fields that carry the result,
`packages/core/src/follow.ts:35` and `packages/core/src/thread-inspection.ts:228`.
The per-thread stores, the router's dispatch, and the fixture path are shaped by the thread, not the
client, and survive.

What does not change: the six ported components — the gate proves none imports a store, the
connection, `@zen/core` or the client, so a state layer they have never seen cannot reach them — and
every shape in `@zen/core` EXCEPT the two named above, because the wire otherwise carries observations
and the client's stream vocabulary was only ever made in memory from them. `ZenThreadHistory.messages`
and `ZenFollowSnapshot.messages` are the exception, and the cheapest kind to miss: their declarations
need not change at all, since `Unknown` admits a new message shape as silently as the old one — which
is why the pivot has to find their two producers and the reviver by hand, with no schema diff and no
type error pointing at them.
