# Seam: storage

The contract between the runtime's durable log and everything above the host: build or reopen a session
under a thread's id, list what is on disk, read a stored transcript without building, report what one
live session contains — and since #162 workstream 4 (L2), what crosses is the transcript of OURS
(`EnsoTranscriptEntry`): the host decodes the runtime's stored entries below this seam. Glossary domains: **Record** — the *storage seam* is the mechanism named there, "the
only file that touches the runtime's session manager or its file contents", a later store a one-file
change (#102 §1); since #801 that file is `host/thread-log.ts`, and the host reads a thread's log
through `ThreadLog` — and **Thread** (*stored thread*, *entry*, *branch* are what cross).

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/storage.md`.

## The contract

Three host-side interfaces in `agent-host.ts`, the host's entry point, over a fourth in `thread-log.ts`,
the one file the seam's storage lives in:

<!-- source: packages/web/src/host/agent-host.ts#AgentHost -->
```ts
export interface AgentHost {
  /**
   * A session for this thread, with its own services, extensions bound, events flowing.
   *
   * ⚠ THE THREAD ID IS PI'S SESSION ID (#95). A session file already under that id is
   * OPENED, in the directory its header records — the thread idled out, or the server
   * restarted, and the user came back; otherwise a fresh session is CREATED with the id in
   * `newSessionDirectory`. So resume needs no id mapping and no index file: pi's own listing is
   * the one source, and a page-owned thread finds its own file again across a server restart.
   * Either directory must pass `servesDirectory`, or nothing is built: `SessionDirectoryRefused`.
   *
   * `newSessionDirectory` is asked only when there is no session file under the id (PR #399
   * review). A thread that has one never depends on where a NEW thread would go: a project it
   * was once named for can be removed, or its directory deleted, and it still resumes.
   */
  createSession(threadId: string, newSessionDirectory: () => string): Promise<HostedThread>
  /** pi's session files in the directories this host serves, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * The directory of the session file under this id — WHETHER OR NOT this host serves it —
   * `undefined` when there is no file. What lets a reader tell "a thread that was never stored"
   * from "a thread whose project is gone" (PR #399 review): `readStoredThread` answers `undefined`
   * for both.
   */
  storedThreadDirectory(threadId: string): Promise<string | undefined>
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
  /** A stored thread's context, request by request (#361) — one open, nothing built (#86). */
  readStoredThreadContext(threadId: string): Promise<StoredThreadContext | undefined>
  /** One request of a stored thread, element by element (#361 phase 3); undefined for no file or no such turn. */
  readStoredRequestDetail(threadId: string, request: number | 'next'): Promise<BranchRequestDetail | undefined>
  /**
   * A stored thread's fork point (#435): identity and run conditions off its branch, one open,
   * nothing built (#86); undefined for no file in a served project.
   */
  readStoredForkPoint(threadId: string): Promise<EnsoForkPoint | undefined>
  /** A stored thread as the session eval reads it (#441): one open, nothing built (#86); undefined for no file. */
  readStoredThreadEval(threadId: string): Promise<BranchEval | undefined>
  /** A stored thread's incident history (#468): one open, nothing built (#86); undefined for no file. */
  readStoredIncidentHistory(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchIncidentHistory | undefined>
  /** A stored thread's judge cases (#469): one open, nothing built (#86); undefined for no file. */
  readStoredJudgeCases(threadId: string, thresholds: EnsoRiskThresholds): Promise<BranchJudgeCases | undefined>
  /**
   * Whether the id is a deleted thread's (#571): deleted since this host started. Such an id is
   * never given to a new thread; the history route answers it 410.
   */
  threadDeleted(threadId: string): boolean
  /**
   * Fork a stored thread at one of its user messages, as pi's `/fork` does (#433; the module
   * header): a new session file naming the source as its parent, holding everything before that
   * message, and the message's text to prefill with. The source's file is not written; nothing is
   * built for either thread (#86).
   */
  forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome>
  /** Restore the thread's tree to the snapshot recorded at or before `entryId` (#551); the conversation is unchanged. */
  restoreThreadAt(threadId: string, entryId: string): Promise<ThreadRestoreOutcome>
  /** Undo the thread's last restore (#565): its tree back to that restore's safety snapshot, itself recorded as a restore. */
  undoLastRestore(threadId: string, safety: string): Promise<ThreadRestoreOutcome>
  /** Name the thread (#670) — pi's `session_info`, live or stored; the first prompt stays its title otherwise. */
  renameThread(threadId: string, name: string): Promise<ThreadRenameOutcome>
  /**
   * The thread's tree and its snapshot store (#650), live or stored — one open, nothing built
   * (#86); `undefined` for a thread in its checkout, no session in a served project, or a host
   * with no projects folder.
   */
  threadTree(threadId: string): Promise<ThreadTreePlace | undefined>
  /**
   * A copy's files changed since its `base` (#650), read from its store under the host's
   * environment and writing nothing (`readCopyChanges`); throws when the store cannot be read.
   */
  readCopyChanges(copy: ThreadTreePlace): Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>
  /**
   * Delete the thread (#571): its tree through the inventory, its store — the project's object
   * store then collected, its forks' histories kept (#573) — then every session file under its id.
   * A tree holding work is deleted only `force`d AND with `confirmedWork` the sha256 (hex) of the
   * work's words as the user was shown them (PR #572 review): work gained since is refused, named,
   * never taken unseen. `retire` disposes the live session and refuses a busy one: the registry's,
   * which the host does not hold. Hard: nothing is kept to undo it.
   */
  deleteThread(
    threadId: string,
    options: {
      readonly force: boolean
      readonly confirmedWork?: string | undefined
      readonly retire: () => boolean
    },
  ): Promise<ThreadDeleteOutcome>
  /**
   * What deleting the thread would do (#571), deleting nothing and taking no snapshot: its tree,
   * the work in it a delete is refused for, and the forks whose histories keep its snapshots up to
   * where each forked — the delete dialog's text.
   */
  previewThreadDelete(
    threadId: string,
  ): Promise<
    | { readonly kind: 'preview'; readonly preview: EnsoThreadDeletePreview }
    | { readonly kind: 'no-thread'; readonly reason: string }
  >
  /**
   * What thread trees cost on disk (#578), per project this host serves a thread of: each tree —
   * the thread whose branch records it, or none — with its size and the work it holds, and the
   * project's snapshot object store. Reads only; every size under one time cap.
   */
  listTrees(): Promise<EnsoTreesListing>
  /** Whether a NEW thread in `project` gets a tree of its own (#551): a projects folder, and trees not `off` for it. */
  mintsTreesIn(project: string): boolean
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): EnsoPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState
  /**
   * The host rows a thread with no session can be offered (#484): `/model` with every model a
   * session would offer — the latest bound session's list, else a probe session's, built once per
   * process and never a thread (#688: extensions register models on `session_start`, so the agent
   * dir's files alone list models a session refuses) — then `/login`, and `/logout` when something
   * is stored, read from pi's own auth and models files in the agent dir. NO THREAD IS BUILT (#86).
   * No `value` (a thread with no session has no current model), no `/thinking` (its levels are the
   * chosen model's, carried on each `/model` option), and none of a session's rows: `/compact`, the
   * views, pi's extension commands. Read afresh per call, so a login through one thread shows at once.
   */
  catalogue(): Promise<RuntimeCommand[]>
  /**
   * The project a session built for `branch` in `cwd` would answer to, and whether it would read
   * that project's own configuration (#470): the decision a build makes first (`hostedProjectTrust`,
   * keyed as the build keys it, #551), asked without building — so the Start dialog lists a
   * project's prompts for a thread nothing has built yet (#484's rule, #86).
   */
  projectTrust(cwd: string, branch: readonly EnsoTranscriptEntry[]): ProjectTrustState
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
  /** The branch as the session eval reads it (#441): the transcript and the turns' usage. */
  branchEval(): BranchEval
  /** The branch's incident history (#468): records, their entries as stored, and a replay under `thresholds`. */
  branchIncidentHistory(thresholds: EnsoRiskThresholds): BranchIncidentHistory
  /** The branch's judge cases (#469): each call the judge would be asked about, and its redacted state. */
  branchJudgeCases(thresholds: EnsoRiskThresholds): BranchJudgeCases
  /** The branch's context, request by request (#361): what each was assembled from, by pi's own assembly. */
  branchContext(): BranchContext
  /**
   * The system prompt the next request would carry under `candidate` — pi's default for `null` —
   * section by section (#443). Changes nothing: the thread keeps its own choice. `busy` while a run
   * is in flight; `unsplittable` when pi's rendering does not split back into itself.
   */
  previewSystemPrompt(candidate: EnsoSystemPromptChoice | null): SystemPromptPreviewOutcome
  /** One request's context, element by element (#361 phase 3); undefined for a turn the branch does not have. */
  branchRequestDetail(request: number | 'next'): BranchRequestDetail | undefined
  /** The branch's fork point (#435): identity, then what it runs under — the manifest's live half. */
  forkPoint(): Promise<EnsoForkPoint>
  /**
   * What the loaded extensions would say about a tool call, through the runtime's own hook
   * runner — the verdict a model's call would meet, without a model. Inspection, like the
   * rest of this interface: the guards' contract is pinned in their own suite against a
   * hand-built ExtensionAPI; this is the one place the REAL runner, the real load order and
   * the real participants are asked together (docs/flows/guarded-tool-call.md, stated gap).
   * Runs no tool: a pass here is the hook's silence, not an execution.
   */
  probeToolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallVerdict | undefined>
  /**
   * The permission engine's own verdict for a value on a surface, in this thread's mode NOW (#474):
   * what a call carrying it would meet, the pattern that decided it and where that rule came from
   * (`global`, the user's file; `agent`, the mode's preset). Asked of the engine the session runs —
   * never a second matcher. `undefined` when the engine has published no service for the session.
   */
  checkPermission(request: EnsoPermissionCheckRequest): EnsoPermissionVerdict | undefined
  /**
   * The project this session answers to, and whether it reads that project's own configuration NOW
   * (#502): pi's `trust.json`, the thread's "Trust this thread" record, or the default — and true
   * after a Trust answered in this session. What the project's own prompt library is read from and
   * gated on (#470). ⚠ The PROJECT, not the cwd: a thread on a tree (#551) answers with its checkout.
   */
  projectTrust(): ProjectTrustState
}
```

<!-- source: packages/web/src/host/agent-host.ts#HostedThreadInspection -->
```ts
/**
 * What pi's session for one hosted thread actually contains, read straight off its log (#86).
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
  /**
   * The branch, root to leaf, as the transcript of ours (L2): the runtime's entry shapes stay in
   * `transcript.ts`. Built when READ (#739), each read a fresh build: an inspection for the cwd
   * pays nothing for it.
   */
  readonly entries: readonly EnsoTranscriptEntry[]
  /** Slash commands this session registers. */
  readonly commands: readonly string[]
  /** The name a person gave the thread (#670): pi's newest `session_info`; `undefined` when none. */
  readonly name: string | undefined
}
```

What `listSessions` returns, one per file on disk:

<!-- source: packages/web/src/host/agent-host.ts#StoredThread -->
```ts
/** One of pi's session files in a directory this host serves, as pi lists it (#95). */
export interface StoredThread {
  /** pi's session id — the thread id it was created under. */
  readonly id: string
  readonly path: string
  /** The directory the session runs in — pi's header records it at creation, and it never changes (#395). */
  readonly cwd: string
  readonly modified: Date
  readonly messageCount: number
  /** The first user message, verbatim; empty for a session with none. */
  readonly firstMessage: string
  /** The name a person gave it (#670): pi's newest `session_info`; absent when none. */
  readonly name?: string
  /**
   * The thread it was forked from (#433): its header's `parentSession` file, as that file's
   * session id. Absent for a thread that is no fork, and for one whose parent file is gone.
   */
  readonly parentThreadId?: string
}
```

What the host reads and writes a thread's log through (#801), whatever stores it:

<!-- source: packages/web/src/host/thread-log.ts#ThreadLog -->
```ts
/** One thread's log, open in memory. Its facts are read when asked: a fork turns the log it was taken through into the fork. */
export interface ThreadLog {
  readonly threadId: string
  /** The directory the thread runs in, as the log's header records it. */
  readonly cwd: string
  /** The directory the log's file is in. */
  readonly directory: string
  /** The file the log is written to, from creation — even before the runtime has written it. */
  readonly file: string | undefined
  /** The name a person gave the thread (#670): the newest one recorded; `undefined` when none. */
  name(): string | undefined
  /** The branch, root to leaf, as the transcript of ours (L2). */
  transcript(): EnsoTranscriptEntry[]
  /** Every entry on every branch, as the transcript of ours: where the permission mode is read (#496). */
  everyEntry(): EnsoTranscriptEntry[]
  /** Every usage in the log, on every branch, by the runtime's rule (`session-usage.ts`, #45). */
  usage(): EnsoSessionUsage
  /** What the branch records it last ran on (#434). */
  recordedModel(): EnsoRecordedModel | undefined
  /** The branch's incidents (#466), folded as the guard folds them on replay. */
  incidents(): EnsoSessionIncidents
  /** Whether the branch holds a request already (#443): a system prompt is fixed from then on. */
  hasSentRequest(): boolean
  /** The branch analysed (#45 phase 2): per request, per turn, per tool. */
  stats(): BranchStats
  /** The branch's context, request by request (#361). */
  context(): BranchContext
  /** One request's context, element by element (#361 phase 3); undefined for a turn the branch does not have. */
  requestDetail(request: number | 'next'): BranchRequestDetail | undefined
  /** The branch as the session eval reads it (#441). */
  eval(): BranchEval
  /** The branch's incident history (#468), replayed under `thresholds`. */
  incidentHistory(thresholds: EnsoRiskThresholds): BranchIncidentHistory
  /** The branch's judge cases (#469). */
  judgeCases(inputs: JudgeCaseInputs): BranchJudgeCases
  /** The branch's fork point (#435), for the thread these facts name. */
  forkPoint(facts: {
    readonly threadId: string
    readonly cwd: string
    readonly parentThreadId: string | undefined
  }): EnsoForkPoint
  /** The prompt at `entryId` (#433). */
  promptAt(entryId: string): PromptAtEntry
  /** The model and level chosen before the first message (#616); undefined once the branch has a message, or when none was chosen. */
  choiceBeforeFirstMessage(): ChoiceBeforeFirstMessage | undefined
  /** Append a custom entry of ours. */
  record(customType: string, data: unknown): void
  /** Name the thread (#670): the entry the runtime's own `/name` writes and its listing reads back. */
  rename(name: string): void
  /** Write the log's file the way the runtime's first flush does, when it has none yet (#433). A file already there is left alone. */
  writeIfUnflushed(): void
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
    /** The project it belongs to (#395) — the session's own directory decides; an unregistered one is never listed. */
    projectId: Type.String(),
    /** The first user message, or undefined for a session with none — the rail's title, as deepseek does. */
    title: Type.Optional(Type.String()),
    /**
     * The name a person gave the thread (#670) — its newest `session_info` — shown instead of the
     * title; absent when none. Not bounded as a rename is: pi's own `/name` writes it too.
     */
    name: Type.Optional(Type.String({ minLength: 1 })),
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
    /**
     * The thread this one was forked from (#433): the session id its header's `parentSession`
     * file holds. Absent for a thread that is no fork — and for one whose parent file is gone,
     * which no longer names a thread the page could open.
     */
    parentThreadId: Type.Optional(Type.String()),
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
 *
 * ⚠ `messages` IS A PAGE, NOT THE BRANCH (#739): the branch's last messages, or with `?before=<id>`
 * the ones before that message — at most the server's page size either way. A 5,000-turn branch is
 * 15 MB as messages; the page a person reads first is under 0.5 MB. `earlier` says what is left.
 * The other fields are the WHOLE branch's, whichever page is asked for.
 */
export const EnsoThreadHistory = Type.Object(
  {
    threadId: Type.String(),
    /** The project it belongs to (#395), so a resumed thread is grouped under it. */
    projectId: Type.String(),
    messages: Type.Array(Type.Unknown()),
    /** What of the branch comes before `messages` (#739); absent when they start the branch. */
    earlier: Type.Optional(
      Type.Object(
        {
          /** How many of the branch's messages come before this page — "Load earlier" says it. */
          messages: Type.Integer({ minimum: 1 }),
          /** How many of those are prompts: where this page's prompts start counting (`prompt 2401: …`). */
          prompts: Type.Integer({ minimum: 0 }),
          /** The branch's first prompt when it is among them, its text parts only — what the thread's title is read from. */
          firstPrompt: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    ),
    permissionMode: EnsoPermissionModeState,
    /** The session's risk (#464): the replayed level and how many signals it rests on — the status bar's seed. */
    sessionRisk: EnsoSessionRiskChange,
    /** The session's incidents (#466), folded from the branch's records — the incident card's and the suspension's seed. */
    incidents: EnsoSessionIncidents,
    /** Present only when the branch ends inside a turn — see {@link EnsoInterruptedTail}. */
    interrupted: Type.Optional(EnsoInterruptedTail),
    /** Present only when the branch records a stopped run — see {@link EnsoStoppedAfter}. */
    stoppedAfter: Type.Optional(EnsoStoppedAfter),
    /** The name a person gave the thread (#670) — its newest `session_info`, as the listing's `name` — absent when none. */
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
```

<!-- source: packages/core/src/thread-inspection.ts#EnsoInterruptedTail -->
```ts
/**
 * How a stored branch ends when its last turn did not settle (#109): a prompt the
 * assistant never answered, an assistant turn that called a tool and never got its
 * result, or one whose every call got its result and no reply followed (PR #442 review) — the
 * server died mid-run, or the run was cut before the reply. The third is a kill's shape, never a
 * Stop's (PR #438 review): a Stop ends the branch on pi's own error reply to the aborted model
 * call, an assistant message with no call — settled, and not named here.
 *
 * Derived on read from the branch, never written to pi's file: deepseek-harness appends a
 * synthetic `turn/end { interrupted }` on resume repair; here the report is the repair. The
 * browser offers Continue on it (#436: `POST …/continue` runs from exactly the stored state, and
 * closes an orphan call with an error result first); the next prompt also continues from the tail.
 *
 * Never said of a thread whose run is still going here (#412): pi parked on a question ends its
 * branch on the call with no result yet, by construction, and that run has not torn.
 */
export const EnsoInterruptedTail = Type.Union([
  Type.Literal('unanswered-prompt'),
  Type.Literal('tool-call-without-result'),
  Type.Literal('tool-results-without-reply'),
])
```

## Who implements it, who consumes it

**Implemented once**, in `packages/web/src/host/thread-log.ts` (#801), the only file that imports the runtime's
`SessionManager`: `ThreadLog` and the store over it — `openLog`, `createLog`, `forkedLog`, `movedLog`.
`agent-host.ts` reads and writes every log through them. A thread's file is filed under its project's folder,
`ENSO_HOME/projects/<projectIdOf(cwd)>/sessions/` (#552) — the host hands that directory to the runtime at
create, a fork inherits its source's, and `bun run enso` hands the terminal runtime the same directory
(`PI_CODING_AGENT_SESSION_DIR`); a launch first moves the sessions the runtime filed by encoded cwd under
its agent dir into their folders (`migrateSessionsIntoProjects`, never over an existing file).
Since #551 a new thread's cwd — the directory its header records — can be its own tree,
`ENSO_HOME/projects/<id>/trees/<name>`, rather than the checkout. The host builds a new thread in
the checkout and moves it onto its tree at its FIRST RUN: it mints the tree, writes the session — its
`enso-thread-tree` record, a header naming the tree, everything chosen before — as the thread's file,
and builds the runtime again on it (PR #561 review: a thread only built leaves nothing behind). The
folder is still the project's (`treeProjectId` reads the id off a tree's path), a fork's tree is
minted from the source's snapshot at the fork point, and `restoreThreadAt` puts a tree back to the
snapshot an `enso-run-context` record names.
`listSessions` reads the session directories itself (#739): each project folder's, in name order, then
the runtime's own default ones under the agent dir. pi's `SessionManager.listAll` parsed every line of
every file on every call, 590–650 ms at 200 threads of 0.9 MB. Each file is summarized by
`packages/web/src/host/session-files.ts` with pi's own `buildSessionInfo` fields (last message time,
message count, first user text, newest `session_info` name), once per change of the file (its inode,
size and modification time), so a listing after a run re-reads only the file the run wrote. The
listing is newest first and keeps only the sessions whose own directory — the one the runtime's
header records — passes the host's required `servesDirectory` rule: the server's projects (#395). A
session made in any other directory is not listed, not read, and not reopened; building under its id
is refused (`SessionDirectoryRefused`, answered 409 with its reason) rather than creating a second
session beside it. A lookup by id reads the directory listings and opens only the files NAMED for the
id — pi names one `<timestamp>_<id>.jsonl` — and only their header, which confirms the id and gives the
directory; another thread's file is never read, and a file named in another shape is a candidate for
every id, its header deciding. `readStoredThread` resolves the id to a path that way, opens the file into
memory (nothing is written until an append) and converts the branch through
`packages/web/src/host/transcript.ts` — the one place above `session-events.ts` that reads the
runtime's stored message shapes — and, from the same open, sums the spend pi recorded in the file
through `packages/web/src/host/session-usage.ts` (#45): pi's `getSessionStats` rule over every entry,
every branch, pinned equal to pi's own total in `agent-host.test.ts`. `createSession` resolves the same path, then *opens* the file or
*creates* one under the thread's id: the thread id IS the session id (#95), so resume needs no mapping
and no index file. Only a thread with no file asks where a new one goes (`newSessionDirectory` is a
function, called on that branch alone), so a project the thread was once named for can be removed and
the thread still resumes. `inspect()` reads ids and directory straight off the session manager; its
`entries` convert the live branch the same way, built only when read (#739), so an inspection for the
directory alone (`/git`, `/tree`) pays nothing for the transcript. `forkThread` (#433) is pi's `/fork` at its default position `before`,
taken from the file: it opens the source (building nothing), refuses an entry the file lacks or one
that is no user message, and writes a new session file whose header's `parentSession` names the
source — the branch up to the message's parent (`createBranchedSession`), or nothing when the message
is the root (`create` + `newSession({ parentSession })`) — answering the new id and the message's text
to prefill. A fork with no assistant message on its branch is one pi would not flush, so the host
writes its entries as pi's first flush does; the source's file is never written. `listSessions` reads
each fork's `parentSession` back to the parent's session id (`parentThreadId`) off the same listing;
a parent whose file is gone names none. Outside a runtime pi's `session_before_fork` hook does not
fire (no loaded extension handles it). The host is tested against the real session manager in
`host/__tests__/agent-host.test.ts`.

**Consumed by the server.** `packages/web/src/server/index.ts` owns the read routes:
`GET /api/stored-threads` → `respondWithStoredThreads` maps each `StoredThread` to a `EnsoStoredThread`,
marking `busy` by peeking the registry and carrying a fork's `parentThreadId`; `POST …/fork` asks
`host.forkThread` (409 while a run holds the source); `GET /api/threads` summarises each live thread from `inspect()`.
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

- **The storage-seam test**: `no-duplicate-paths.test.ts#STORAGE_SEAM` —
  "`SessionManager` is imported ONLY by the web host's thread-log.ts — the storage seam" — a scan of
  every non-test source root; the `.enso` literal is likewise assembled only in `paths.ts` — plus
  `guard.ts`, where it is corpus data for `guard.ts#ENSO_PERSISTENCE_WRITE_DIRECTORIES`.
- **The vendor gate** (`test/vendor-gate.test.ts`, #145): the runtime's package is imported only under
  `packages/web/src/host/` and `packages/harness/extensions/`.
- **Closed wire schemas**: `EnsoThreadInspection`, `EnsoStoredThread`, `EnsoThreadHistory` are
  `additionalProperties: false` (`thread-inspection.ts#EnsoThreadInspection`, `thread-inspection.ts#EnsoStoredThread`,
  `thread-inspection.ts#EnsoThreadHistory`) — no host internal leaks by
  an accidental spread; `server-handler.test.ts`'s "GET /api/threads lists live threads" test checks summaries against `EnsoThreadSummary`.

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

**And since #557, nothing of the runtime's entry envelope reaches a fold in `core`.** Until then
`recordedPermissionMode`, `lastCustomEntryData`, `incidentEntriesOf`, `replayIncidents` and the
risk and judge replays took `readonly unknown[]` and matched pi's `{ type: 'custom', customType,
data }` and `{ type: 'message', message }` themselves (`durable-room.md`'s pivot item 1). Now every
fold takes `EnsoTranscriptEntry[]`, and the ONE module that names the runtime's envelope is
`packages/core/src/runtime-entries.ts` (`transcriptOf`): the host's `transcript.ts` is that plus
what needs the vendor's types (a provider refusal, a result's descriptor); the harness extensions
call it on `ctx.sessionManager.getBranch()`; the corpus scripts call it on the omp corpus. A
different runtime is a different `runtime-entries.ts`, and the folds do not move.

**`sessionFile` is a lagging copy.** The runtime persists lazily — nothing reaches disk until the first
assistant message — so `inspect()` reports the path only once the file exists and `null` before;
a thread that has only run slash commands has a full branch and no file, and `listSessions` omits it.
`server-handler.test.ts` pins the `null`. `sessionDir` and `sessionFile` cross as debug text only
(glossary Decision 1: they name the log); nothing above the host opens them.

## Pivot cost

Which files may import the runtime is fixed by a gate (#558): `VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS` in `test/vendor-gate.test.ts` lists them, and the list only shrinks, so a new file cannot quietly add to what follows.

Replace the store — another file layout, a database, a remote log — and the files that change are
`packages/web/src/host/thread-log.ts` (`ThreadLog` and its store over the new log),
`packages/web/src/host/session-files.ts` and the listing in `agent-host.ts` (`listSessions`, `locate`:
where the files are), `packages/web/src/host/transcript.ts` (the new store's entries → the
transcript of ours), `packages/web/src/host/branch-stats.ts` (the new store's messages → per-turn stats) and `packages/web/src/host/session-usage.ts` (the new store's recorded spend → pi's
totals). That is what the storage-seam test measures: a second importer of the session
manager anywhere else is a failing test with the file named. The server routes, the registry, the
follow's snapshot, the wire schemas, the reader, the drawer, the browser and every server test over
the fake host do not change: the fake implements `AgentHost` from plain closures over stored
transcripts of ours and is the seam's second implementation.
