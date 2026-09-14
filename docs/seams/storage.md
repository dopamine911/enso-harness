# Seam: storage

The contract between the runtime's durable log and everything above the host: build or reopen a session
under a thread's id, list what is on disk, read a stored branch without building, report what one live
session contains. Glossary domains: **Record** — the *storage seam* is the mechanism named there, "the
only file that touches the runtime's session manager or its file layout", a later store a one-file
change (#102 §1) — and **Thread** (*stored thread*, *entry*, *branch* are what cross).

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/storage.md`.

## The contract

Three host-side interfaces, all in the one file the seam lives in:

<!-- source: packages/web/src/host/agent-host.ts#AgentHost -->
```ts
export interface AgentHost {
  /**
   * A session for this thread, with its own services, extensions bound, events flowing.
   *
   * ⚠ THE THREAD ID IS PI'S SESSION ID (#95). A session file already under that id is
   * OPENED — the thread idled out, or the server restarted, and the user came back;
   * otherwise a fresh session is CREATED with the id. So resume needs no id mapping and
   * no index file: pi's own listing is the one source, and a page-owned thread finds its
   * own file again across a server restart.
   */
  createSession(threadId: string): Promise<HostedThread>
  /** pi's session files for this workspace, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * The branch of a stored session, read-only — no pi session is built, nothing is
   * written (#86's rule: looking must not build). `undefined` when no file has that id.
   */
  readBranch(threadId: string): Promise<unknown[] | undefined>
}
```

What `createSession` hands back — the runtime (`thread-runtime.md`) plus a read-only view deliberately not on it:

<!-- source: packages/web/src/host/agent-host.ts#HostedThread -->
```ts
export interface HostedThread {
  readonly runtime: ThreadRuntime
  /** How many extensions the loader found — the load receipt a caller may assert. */
  readonly loadedExtensionPaths: readonly string[]
  /**
   * Read-only view of the session as pi holds it. Deliberately here and NOT on
   * `ThreadRuntime`: that is the run contract, pinned by three fakes and the refusal-path
   * tests, and inspection is a host concern.
   */
  inspect(): HostedThreadInspection
  /** The emitted tail (#97): what the host's `emit` funnel saw, with provenance. A fresh copy per call. */
  emittedEvents(): ZenThreadEvent[]
}
```

<!-- source: packages/web/src/host/agent-host.ts#HostedThreadInspection -->
```ts
/**
 * What pi's session for one hosted thread actually contains, read straight off the
 * `SessionManager` (#86). Everything a run shows the browser is derived from the event
 * stream; this is the source those views derive from, for a human or an agent to
 * cross-check against.
 */
export interface HostedThreadInspection {
  readonly sessionId: string
  readonly cwd: string
  readonly sessionDir: string
  /** The session file once pi has flushed it; null while the session lives only in memory. */
  readonly sessionFile: string | null
  /** The branch, root to leaf, verbatim — pi's own entry shapes. */
  readonly entries: readonly unknown[]
  /** Slash commands this session registers. */
  readonly commands: readonly string[]
}
```

What `listSessions` returns, one per file on disk:

<!-- source: packages/web/src/host/agent-host.ts#StoredThread -->
```ts
/** One of pi's session files for this workspace, as pi lists it (#95). */
export interface StoredThread {
  /** pi's session id — the thread id it was created under. */
  readonly id: string
  readonly path: string
  readonly modified: Date
  readonly messageCount: number
  /** The first user message, verbatim; empty for a session with none. */
  readonly firstMessage: string
}
```

The wire shapes the server derives from those, in `@zen/core`. The rail's listing:

<!-- source: packages/core/src/thread-inspection.ts#ZenStoredThread -->
```ts
/**
 * One of pi's session files for this workspace (#95), as the rail lists it: a session the
 * user can come back to. `threadId` IS pi's session id — the host creates every session
 * with the browser's thread id (`NewSessionOptions.id`), so the two never need a mapping,
 * and a page-owned thread finds its own file again after the server restarts.
 */
export const ZenStoredThread = Type.Object(
  {
    threadId: Type.String(),
    /** The first user message, or undefined for a session with none — the rail's title, as deepseek does. */
    title: Type.Optional(Type.String()),
    /** The file's mtime, ISO 8601 — when the session last grew. */
    lastActivityAt: Type.String(),
    messageCount: Type.Integer({ minimum: 0 }),
    /**
     * A thread on THIS server is running it right now — a run in flight or a dialog parked
     * (`ThreadView.busy`). Not "held": a released thread stays cached for the idle window,
     * and a page that reloaded must be able to come back to it before that expires (PR
     * #104 review). While busy, resuming is refused — pi refuses a second concurrent
     * prompt anyway; this is the readable, early form of that refusal.
     */
    busy: Type.Boolean(),
  },
  { additionalProperties: false },
)
```

One live thread in full, on `GET /api/threads/:id` and in the bundle:

<!-- source: packages/core/src/thread-inspection.ts#ZenThreadInspection -->
```ts
/** One live thread, in full: the summary plus the session branch and what it may run. */
export const ZenThreadInspection = Type.Object(
  {
    threadId: Type.String(),
    sessionId: Type.String(),
    cwd: Type.String(),
    sessionDir: Type.String(),
    sessionFile: Type.Union([Type.String(), Type.Null()]),
    permissionMode: ZenPermissionModeState,
    /** Slash commands this session registers — extensions, prompt templates, skills. */
    commands: Type.Array(Type.String()),
    busy: Type.Boolean(),
    /** See {@link ZenThreadSummary}. */
    generation: Type.Integer({ minimum: 0 }),
    lastActivityAt: Type.String(),
    /**
     * The session BRANCH — root to leaf — as pi holds it, verbatim. pi's own entry shapes
     * (`message`, `custom`, `model_change`, …), not zen's: they are carried, not modelled,
     * so a reader sees exactly what pi sees. Consumers read the base fields (`type`, `id`,
     * `parentId`, `timestamp`, `customType`) defensively, like every wire crossing.
     */
    entries: Type.Array(Type.Unknown()),
  },
  { additionalProperties: false },
)
```

A thread's history as the browser mounts it, live or cold: `GET …/history` and every snapshot's `messages`:

<!-- source: packages/core/src/thread-inspection.ts#ZenThreadHistory -->
```ts
/**
 * A thread's history as the browser mounts it (#95): the branch as TanStack `UIMessage`s —
 * built by the server's `branch-to-messages` mapper, the same way the live stream is
 * mapped to AG-UI — plus the opening permission mode the branch persists. Carried as
 * `Unknown` because the shape is TanStack's, not zen's; the durable form is pi's entries.
 */
export const ZenThreadHistory = Type.Object(
  {
    threadId: Type.String(),
    messages: Type.Array(Type.Unknown()),
    permissionMode: ZenPermissionModeState,
    /** Present only when the branch ends inside a turn — see {@link ZenInterruptedTail}. */
    interrupted: Type.Optional(ZenInterruptedTail),
  },
  { additionalProperties: false },
)
```

<!-- source: packages/core/src/thread-inspection.ts#ZenInterruptedTail -->
```ts
/**
 * How a stored branch ends when its last turn did not settle (#109): a prompt the
 * assistant never answered, or an assistant turn that called a tool and never got its
 * result — the server died mid-run, or the run was cut before the reply. Derived on read
 * from the branch, never written to pi's file: deepseek-harness appends a synthetic
 * `turn/end { interrupted }` on resume repair; here the report is the repair, and the
 * next prompt continues from the torn tail as pi would.
 */
export const ZenInterruptedTail = Type.Union([
  Type.Literal('unanswered-prompt'),
  Type.Literal('tool-call-without-result'),
])
```

## Who implements it, who consumes it

**Implemented once**, in `packages/web/src/host/agent-host.ts`, the only file that imports the runtime's
`SessionManager` (line 10). `listSessions` (line 239) goes through the runtime's own listing, never a
directory scan, newest first. `readBranch` (line 256) resolves the id to a path through that listing
and opens the file into memory; nothing is written until an append. `createSession` (line 263)
resolves the same path, then *opens* the file or *creates* one under the thread's id (lines 304–307):
the thread id IS the session id (#95), so resume needs no mapping and no index file. `inspect()`
(line 479) reads branch, ids and directory straight off the session manager. The host is tested
against the real session manager in `host/__tests__/agent-host.test.ts`.

**Consumed by the server.** `packages/web/src/server/index.ts` owns the read routes:
`GET /api/stored-threads` (line 617 → `respondWithStoredThreads`, line 319) maps each `StoredThread` to
a `ZenStoredThread`, marking `busy` by peeking the registry; `GET …/history` (line 655 →
`respondWithThreadHistory`, line 347) reads `inspect().entries` when the thread is live and
`host.readBranch` when it is cold, 404 when neither has it; `GET /api/threads` summarises each live
thread from `inspect()` (line 279). `packages/web/src/server/thread-registry.ts` is the only builder
(index.ts line 260 wires `host.createSession` into it), and its `inspectThread` (line 165) is the one
place a `ZenThreadInspection` is assembled, so the thread route (index.ts line 391) and the bundle
(`bundle-route.ts` line 112) cannot drift. `server/follow.ts` (lines 103–105) does the same
live-or-cold read for the snapshot's `messages`; both rebuild through
`packages/web/src/rpc/branch-to-messages.ts` (`branchToMessages`, line 133; `interruptedTail`,
line 174), the read-side twin of the live mapper. Every server test drives the seam over a fake
`AgentHost`: `server-handler.test.ts` (`listSessions` and `readBranch` over an in-memory table,
lines 134–144), `follow.test.ts` (line 124), `thread-registry.test.ts`, `bundle-route.test.ts`.

## What fences it

- **The storage-seam test**: `packages/core/src/__tests__/no-duplicate-paths.test.ts` line 99 —
  "`SessionManager` is imported ONLY by the web host's agent-host.ts — the storage seam" — a scan of
  every non-test source root; the `.zen` literal is likewise confined to `paths.ts` (line 86).
- **The vendor gate** (`test/vendor-gate.test.ts`, #145): the runtime's package is imported only under
  `packages/web/src/host/` and `packages/harness/extensions/`.
- **Closed wire schemas**: `ZenThreadInspection`, `ZenStoredThread`, `ZenThreadHistory` are
  `additionalProperties: false` (thread-inspection.ts lines 74, 227, 259) — no host internal leaks by
  an accidental spread; `server-handler.test.ts` line 474 checks summaries against the schema.

## What crosses it that should not

**The runtime's persistence format crosses past the host.** Leak **L2**, the persistence-side half
(`.local/refactor/goals.md` §2; #162 workstream 4; the event-side half is on `thread-runtime.md`).
`HostedThreadInspection.entries` and `AgentHost.readBranch` return `readonly unknown[]` — "pi's own
entry shapes" (agent-host.ts line 123) — and `ZenThreadInspection` carries them to the wire as
`Type.Array(Type.Unknown())`, "carried, not modelled" (thread-inspection.ts lines 66–72). Above the
host, three readers know the vendor's field names:

- `packages/web/src/rpc/branch-to-messages.ts` declares `PiSessionEntry`, `PiStoredMessage`,
  `PiAssistantContentPart`, `PiUserContentPart` (lines 22–53) and rebuilds messages from them.
- `describeEntry` in `packages/core/src/thread-inspection.ts` (line 135) formats one entry as a row from
  `type`, `customType`, `message.role` and `data.mode`, for the drawer and `scripts/zen-thread.mjs`.
- `persistedPermissionMode` in core walks the entries for the mode extension's custom entry (leak L3,
  `permission-mode.md`), from `server/index.ts` line 362, `follow.ts` line 136 and the drawer.

`test/glossary-gate.test.ts` allowlists the first (line 62) with the reason: the `Pi` prefix is the
marker, renaming would hide the leak, the line leaves when the host produces a transcript of ours.
Until then every reader reads defensively; an entry kind it does not render is skipped, not invented
(branch-to-messages.ts lines 11–14).

**`sessionFile` is a lagging copy.** The runtime persists lazily — nothing reaches disk until the first
assistant message — so `inspect()` reports the path only once the file exists and `null` before
(agent-host.ts lines 480–488; thread-inspection.ts lines 18–21); a thread that has only run slash
commands has a full branch and no file, and `listSessions` omits it (lines 235–237).
`server-handler.test.ts` line 294 pins the `null`. `sessionDir` and `sessionFile` cross as debug text
only (glossary Decision 1: they name the log); nothing above the host opens them.

## Pivot cost

Replace the store — another file layout, a database, a remote log — and the file that changes is
`packages/web/src/host/agent-host.ts`: `listSessions`, `readBranch`, the open-or-create in
`createSession`, and `inspect()`. That is what the storage-seam test measures: a second importer of
the session manager anywhere else is a failing test with the file named. While L2 stands,
`packages/web/src/rpc/branch-to-messages.ts` changes too, because a new store's entries would not be
the old runtime's shapes — and `describeEntry` in core with it. The server routes, the registry, the
follow's snapshot, the wire schemas, the browser and every server test over a fake host do not change:
the fakes already implement `AgentHost` from plain closures and are the seam's second implementation.
