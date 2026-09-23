# Seam: storage

The contract between the runtime's durable log and everything above the host: build or reopen a session
under a thread's id, list what is on disk, read a stored transcript without building, report what one
live session contains — and since #162 workstream 4 (L2), what crosses is the transcript of OURS
(`EnsoTranscriptEntry`): the host decodes the runtime's stored entries below this seam. Glossary domains: **Record** — the *storage seam* is the mechanism named there, "the
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
  /** The tree every session this host builds runs in — the launch argument, one per server (`server/index.ts`). */
  readonly cwd: string
  /** pi's session files for this workspace, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * A stored session, read-only — no pi session is built, nothing is written (#86's rule:
   * looking must not build): its branch as the transcript of ours, and pi's totals over the
   * whole file (#45). `undefined` when no file has that id.
   */
  readStoredThread(threadId: string): Promise<StoredThreadRead | undefined>
  /**
   * A stored thread analysed (#45 phase 2) — pi's totals over the whole file and the branch's
   * per-turn stats, from one open, building nothing (#86). `undefined` when no file has that id.
   */
  readStoredThreadStats(threadId: string): Promise<StoredThreadStats | undefined>
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): EnsoPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState
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
   * `ThreadRuntime`: that is the run contract, pinned by the one fake and the refusal-path
   * tests, and inspection is a host concern.
   */
  inspect(): HostedThreadInspection
  /** The emitted tail (#97): what the host's `emit` funnel saw, with provenance. A fresh copy per call. */
  emittedEvents(): EnsoThreadEvent[]
  /** The branch analysed (#45 phase 2): per request, per turn, per tool, off pi's own entries. */
  branchStats(): BranchStats
  /**
   * What the loaded extensions would say about a tool call, through the runtime's own hook
   * runner — the verdict a model's call would meet, without a model. Inspection, like the
   * rest of this interface: the guards' contract is pinned in their own suite against a
   * hand-built ExtensionAPI; this is the one place the REAL runner, the real load order and
   * the real participants are asked together (docs/flows/guarded-tool-call.md, stated gap).
   * Runs no tool: a pass here is the hook's silence, not an execution.
   */
  probeToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallVerdict | undefined>
}
```

<!-- source: packages/web/src/host/agent-host.ts#HostedThreadInspection -->
```ts
/**
 * What pi's session for one hosted thread actually contains, read straight off the
 * `SessionManager` (#86).
 *
 * Everything a run shows the browser is derived from the event stream; this is the source those
 * views derive from, for a human or an agent to cross-check against.
 */
export interface HostedThreadInspection {
  readonly sessionId: string
  readonly cwd: string
  readonly sessionDir: string
  /** The session file once pi has flushed it; null while the session lives only in memory. */
  readonly sessionFile: string | null
  /** The branch, root to leaf, as the transcript of ours (L2): the runtime's entry shapes stay in `transcript.ts`. */
  readonly entries: readonly EnsoTranscriptEntry[]
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

The wire shapes the server derives from those, in `@enso/core`. The rail's listing:

<!-- source: packages/core/src/thread-inspection.ts#EnsoStoredThread -->
```ts
/**
 * One of pi's session files for this workspace (#95), as the rail lists it: a session the
 * user can come back to.
 *
 * `threadId` IS pi's session id — the host creates every session with the browser's thread id
 * (`NewSessionOptions.id`), so the two never need a mapping, and a page-owned thread finds its
 * own file again after the server restarts.
 */
export const EnsoStoredThread = Type.Object(
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

<!-- source: packages/core/src/thread-inspection.ts#EnsoThreadInspection -->
```ts
/**
 * One live thread, in full: the summary plus the session branch and what it may run.
 */
export const EnsoThreadInspection = Type.Object(
  {
    threadId: Type.String(),
    sessionId: Type.String(),
    cwd: Type.String(),
    sessionDir: Type.String(),
    sessionFile: Type.Union([Type.String(), Type.Null()]),
    permissionMode: EnsoPermissionModeState,
    /** Slash commands this session registers — extensions, prompt templates, skills. */
    commands: Type.Array(Type.String()),
    busy: Type.Boolean(),
    /** See {@link EnsoThreadSummary}. */
    generation: Type.Integer({ minimum: 0 }),
    lastActivityAt: Type.String(),
    /**
     * The session BRANCH — root to leaf — as the transcript of ours (#162 workstream 4, L2):
     * the host decoded the runtime's stored entries below the seam, so a reader sees
     * messages with their parts, tool results with their descriptors, an extension's custom
     * entries, and `other` for every kind the host does not model — counted, never invented.
     */
    entries: Type.Array(EnsoTranscriptEntry),
  },
  { additionalProperties: false },
)
```

A thread's history as the browser mounts it, live or cold: `GET …/history` and every snapshot's `messages`:

<!-- source: packages/core/src/thread-inspection.ts#EnsoThreadHistory -->
```ts
/**
 * A thread's history as the browser mounts it (#95): the transcript as TanStack `UIMessage`s —
 * assembled by the server's `transcript-to-messages` reader, the same way the live stream is
 * adapted to AG-UI — plus the opening permission mode the transcript persists.
 *
 * Carried as `Unknown` because the shape is TanStack's, not enso's; the durable form is the
 * runtime's log, decoded by the host into `EnsoTranscriptEntry` (L2).
 */
export const EnsoThreadHistory = Type.Object(
  {
    threadId: Type.String(),
    messages: Type.Array(Type.Unknown()),
    permissionMode: EnsoPermissionModeState,
    /** Present only when the branch ends inside a turn — see {@link EnsoInterruptedTail}. */
    interrupted: Type.Optional(EnsoInterruptedTail),
  },
  { additionalProperties: false },
)
```

<!-- source: packages/core/src/thread-inspection.ts#EnsoInterruptedTail -->
```ts
/**
 * How a stored branch ends when its last turn did not settle (#109): a prompt the
 * assistant never answered, or an assistant turn that called a tool and never got its
 * result — the server died mid-run, or the run was cut before the reply.
 *
 * Derived on read from the branch, never written to pi's file: deepseek-harness appends a
 * synthetic `turn/end { interrupted }` on resume repair; here the report is the repair, and the
 * next prompt continues from the torn tail as pi would.
 */
export const EnsoInterruptedTail = Type.Union([
  Type.Literal('unanswered-prompt'),
  Type.Literal('tool-call-without-result'),
])
```

## Who implements it, who consumes it

**Implemented once**, in `packages/web/src/host/agent-host.ts`, the only file that imports the runtime's
`SessionManager`. `listSessions` goes through the runtime's own listing, never a directory scan,
newest first. `readStoredThread` resolves the id to a path through that listing, opens the file into
memory (nothing is written until an append) and converts the branch through
`packages/web/src/host/transcript.ts` — the one place above `session-events.ts` that reads the
runtime's stored message shapes — and, from the same open, sums the spend pi recorded in the file
through `packages/web/src/host/session-usage.ts` (#45): pi's `getSessionStats` rule over every entry,
every branch, pinned equal to pi's own total in `agent-host.test.ts`. `createSession` resolves the same path, then *opens* the file or
*creates* one under the thread's id: the thread id IS the session id (#95), so resume needs no mapping
and no index file. `inspect()` reads ids and directory straight off the session manager and converts
the live branch the same way. The host is tested against the real session manager in
`host/__tests__/agent-host.test.ts`.

**Consumed by the server.** `packages/web/src/server/index.ts` owns the read routes:
`GET /api/stored-threads` → `respondWithStoredThreads` maps each `StoredThread` to a `EnsoStoredThread`,
marking `busy` by peeking the registry; `GET /api/threads` summarises each live thread from `inspect()`.
`packages/web/src/server/thread-registry.ts` is the only builder (it is handed `host.createSession`),
and its `inspectThread` is the one place a `EnsoThreadInspection` is assembled, so the thread route and
the bundle cannot drift. The LIVE-OR-COLD read — `inspect().entries` when the thread is live,
`host.readStoredThread` when it is cold — is `packages/web/src/server/thread-read.ts`
(`readThreadMount`), and it has one caller shape: `GET …/history` (404 when the server holds neither)
and the follow's snapshot (an empty snapshot instead). ⚠ It was written twice until #214, and the two
copies disagreed: the follow re-peeked the registry after the awaited file read and the history route
did not, so a thread built DURING the read was served the file's messages and the file's mode by
`/history` under a follow that already reported it live. The reader assembles through
`packages/web/src/server/transcript-to-messages.ts`
(`transcriptToMessages`, `interruptedTail`), the read-side twin of the live adapter — and since L2 it
assembles from entries of ours and decodes nothing. Every server test drives the seam over the fake
`AgentHost` (`server/__tests__/fake-hosted-thread.ts`), whose stored threads carry transcripts of ours;
`server-handler.test.ts`'s fixtures are written as the file holds them and cross through the host's own
converter, so the test reads what the real host would hand out.

## What fences it

- **The storage-seam test**: `packages/core/src/__tests__/no-duplicate-paths.test.ts` line 99 —
  "`SessionManager` is imported ONLY by the web host's agent-host.ts — the storage seam" — a scan of
  every non-test source root; the `.enso` literal is likewise assembled only in `paths.ts` — plus
  `guard.ts`, where it is corpus data for `ENSO_PERSISTENCE_WRITE_DIRECTORIES` (line 192).
- **The vendor gate** (`test/vendor-gate.test.ts`, #145): the runtime's package is imported only under
  `packages/web/src/host/` and `packages/harness/extensions/`.
- **Closed wire schemas**: `EnsoThreadInspection`, `EnsoStoredThread`, `EnsoThreadHistory` are
  `additionalProperties: false` (thread-inspection.ts lines 84, 239, 280) — no host internal leaks by
  an accidental spread; `server-handler.test.ts` line 444 checks summaries against `EnsoThreadSummary`.

## What crosses it that should not

**Nothing of the runtime's persistence format, since L2** (#162 workstream 4). Until then
`AgentHost.readBranch` and `HostedThreadInspection.entries` returned `readonly unknown[]` — the
runtime's own entry shapes — and `EnsoThreadInspection` carried them to the wire "carried, not
modelled", with three readers above the host knowing the vendor's field names. Now the host converts
the branch in `packages/web/src/host/transcript.ts` — the one place above `session-events.ts` that
reads a stored entry — and hands out `EnsoTranscriptEntry[]` from `readStoredThread` and `inspect()`;
`server/transcript-to-messages.ts` assembles messages from ours and decodes nothing;
`describeTranscriptEntry` in core formats ours for the drawer and `enso-thread.ts`; the stored mode
walk reads our `custom` entries. The glossary gate's row for the old reader is gone, and the gate
now refuses an allowlisted file it cannot find, so it cannot come back unnoticed.

**`sessionFile` is a lagging copy.** The runtime persists lazily — nothing reaches disk until the first
assistant message — so `inspect()` reports the path only once the file exists and `null` before;
a thread that has only run slash commands has a full branch and no file, and `listSessions` omits it.
`server-handler.test.ts` pins the `null`. `sessionDir` and `sessionFile` cross as debug text only
(glossary Decision 1: they name the log); nothing above the host opens them.

## Pivot cost

Replace the store — another file layout, a database, a remote log — and the files that change are
`packages/web/src/host/agent-host.ts` (`listSessions`, `readStoredThread`, the open-or-create in
`createSession`, `inspect()`), `packages/web/src/host/transcript.ts` (the new store's entries → the
transcript of ours), `packages/web/src/host/branch-stats.ts` (the new store's messages → per-turn stats) and `packages/web/src/host/session-usage.ts` (the new store's recorded spend → pi's
totals). That is what the storage-seam test measures: a second importer of the session
manager anywhere else is a failing test with the file named. The server routes, the registry, the
follow's snapshot, the wire schemas, the reader, the drawer, the browser and every server test over
the fake host do not change: the fake implements `AgentHost` from plain closures over stored
transcripts of ours and is the seam's second implementation.
