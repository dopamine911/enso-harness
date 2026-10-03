import { type Static, Type } from 'typebox'
import { EnsoPermissionModeState } from './permission-mode.ts'
import { EnsoSessionIncidents } from './session-incident.ts'
import { EnsoSessionRiskChange } from './session-risk.ts'
import { EnsoTranscriptEntry } from './transcript.ts'

/**
 * What a live thread's session ACTUALLY contains, as the server reports it (#86).
 *
 * Everything the web surface shows is a derived view of the stream; these are the shapes
 * that let a human or an agent see the thing they derive from and cross-check. Served by
 * `GET /api/threads` and `GET /api/threads/:threadId`, rendered by the debug drawer and
 * printed by `scripts/enso-thread.ts`.
 *
 * ⚠ READ-ONLY, LOOPBACK-ONLY, DEV-ONLY — the server that serves these binds `127.0.0.1`
 * and says so in its header. `entries` is the session branch itself: conversation, tool
 * output, extension state. That is the point, and it is why this never leaves loopback.
 * Nothing here is read from the agent dir's auth material; the schemas are closed
 * (`additionalProperties: false`) so a host internal cannot leak by an accidental spread.
 *
 * ⚠ THE FILE IS A LAGGING COPY. pi persists a session lazily — nothing reaches disk until
 * the first assistant message — so `sessionFile` is `null` for a thread that has only run
 * slash commands, while its branch is fully populated in memory. The branch is what pi
 * acts on; a reader who wants "the truth" reads `entries`, not the file.
 */

/**
 * One live thread, at a glance.
 *
 * @group Thread inspection
 */
export const EnsoThreadSummary = Type.Object(
  {
    threadId: Type.String(),
    sessionId: Type.String(),
    /** Where the session file is or will be. */
    sessionDir: Type.String(),
    /** The session file's path once pi has flushed it to disk; null while it lives only in memory. */
    sessionFile: Type.Union([Type.String(), Type.Null()]),
    /** The current permission mode, computed the way the permission engine reads it (#496). */
    mode: Type.String(),
    /** A run has taken the session and not released it — in flight, or blocked on a question. */
    busy: Type.Boolean(),
    /**
     * How many runs have taken this thread since the server started (#109) — the fence a
     * late run handle is checked against on the server, and the number the `status`
     * frame hands the browser: a difference between the two says another client, or a
     * rebuild after idle, has moved the thread on since this page's last run.
     */
    generation: Type.Integer({ minimum: 0 }),
    /** When the thread was last acquired or released — ISO 8601. */
    lastActivityAt: Type.String(),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoThreadSummary = Static<typeof EnsoThreadSummary>

/**
 * One live thread, in full: the summary plus the session branch and what it may run.
 *
 * @group Thread inspection
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
/** @group Thread inspection */
export type EnsoThreadInspection = Static<typeof EnsoThreadInspection>

/**
 * Where one recorded event came from (#97) — the axis an ordering bug lives on.
 *
 *   live      the host delivered it to a subscriber as it arrived
 *   held      it arrived before the FIRST subscriber and was buffered (#69)
 *   replayed  the buffer delivered it to the first subscriber — a `held` record's second life
 *   dropped   nobody was listening and the first subscriber had already come and gone
 *   sent      an AG-UI chunk the server wrote to the browser — the wire's own order
 *
 * @group Thread inspection
 */
export const EnsoEventProvenance = Type.Union([
  Type.Literal('live'),
  Type.Literal('held'),
  Type.Literal('replayed'),
  Type.Literal('dropped'),
  Type.Literal('sent'),
])
/** @group Thread inspection */
export type EnsoEventProvenance = Static<typeof EnsoEventProvenance>

/**
 * One event in a thread's tail.
 *
 * Consecutive events of the same shape coalesce into one record with a `count` — a model turn
 * is hundreds of text deltas, and the tail exists to be read, not scrolled.
 *
 * @group Thread inspection
 */
export const EnsoThreadEvent = Type.Object(
  {
    /** Monotonic per thread — identity, since type + time can collide. */
    sequence: Type.Number(),
    /** pi's rpc event type for the host's tail; the AG-UI event type for the wire's. */
    type: Type.String(),
    /** The inner name when the type alone says nothing: a custom entry's `customType`, a ui request's method, a tool's name, a CUSTOM chunk's name. */
    name: Type.Optional(Type.String()),
    provenance: EnsoEventProvenance,
    /** ISO 8601 — when the FIRST of a coalesced run was recorded. */
    at: Type.String(),
    /** How many consecutive same-shaped events this record stands for. */
    count: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoThreadEvent = Static<typeof EnsoThreadEvent>

/**
 * A thread's two tails: what the host emitted (with how), and what the server sent.
 *
 * @group Thread inspection
 */
export const EnsoThreadEvents = Type.Object(
  {
    threadId: Type.String(),
    emitted: Type.Array(EnsoThreadEvent),
    sent: Type.Array(EnsoThreadEvent),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoThreadEvents = Static<typeof EnsoThreadEvents>

/**
 * The three columns of an event row: `12:34:56` · `held ×3` · `entry_appended modes`.
 *
 * @group Thread inspection
 */
export interface ThreadEventColumns {
  readonly when: string
  /** Provenance, with the count when coalesced — the column a reader scans for `held`/`dropped`. */
  readonly provenance: string
  /** Type, with the inner name when there is one. */
  readonly subject: string
}

/**
 * THE definition of what each column holds — a new provenance value or inner name lands
 * here once.
 *
 * How the columns are joined is layout, the surface's own: the drawer joins with a space
 * (`describeThreadEvent`), `enso-thread.ts` pads them into a table.
 *
 * @group Thread inspection
 */
export function threadEventColumns(event: EnsoThreadEvent): ThreadEventColumns {
  return {
    when: event.at.slice(11, 19),
    provenance: event.count > 1 ? `${event.provenance} ×${event.count}` : event.provenance,
    subject: event.name === undefined ? event.type : `${event.type} ${event.name}`,
  }
}

/**
 * One event of a tail as a row — `12:34:56 held ×3 entry_appended modes`.
 *
 * @group Thread inspection
 */
export function describeThreadEvent(event: EnsoThreadEvent): string {
  const columns = threadEventColumns(event)
  return `${columns.when} ${columns.provenance} ${columns.subject}`
}

/**
 * The shape a thread id must have to be trusted (#95, PR #104 review).
 *
 * ⚠ Since #95 the browser's thread id IS pi's session id, and pi puts the id in the session
 * FILENAME (`<timestamp>_<id>.jsonl`). An unconstrained id from a request body or a URL
 * segment is therefore a path component: `../` walks out of the session dir. The browser
 * mints UUIDs (`crypto.randomUUID()`), so the accepted set is a strict superset of those
 * and nothing that means anything to a filesystem — letters, digits, `_`, `-`; a leading
 * alphanumeric so an id can never read as a flag; capped so it cannot be a filename-length
 * attack. Checked by the server at BOTH entry points (the chat body and the thread routes);
 * the host never sees an id that failed here.
 */
const ENSO_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** @group Thread inspection */
export function isEnsoThreadId(value: unknown): value is string {
  return typeof value === 'string' && ENSO_THREAD_ID_PATTERN.test(value)
}

/**
 * One of pi's session files for this workspace (#95), as the rail lists it: a session the
 * user can come back to.
 *
 * `threadId` IS pi's session id — the host creates every session with the browser's thread id
 * (`NewSessionOptions.id`), so the two never need a mapping, and a page-owned thread finds its
 * own file again after the server restarts.
 *
 * @group Thread inspection
 */
export const EnsoStoredThread = Type.Object(
  {
    threadId: Type.String(),
    /** The project it belongs to (#395) — the session's own directory decides; an unregistered one is never listed. */
    projectId: Type.String(),
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
    /**
     * The thread this one was forked from (#433): the session id its header's `parentSession`
     * file holds. Absent for a thread that is no fork — and for one whose parent file is gone,
     * which no longer names a thread the page could open.
     */
    parentThreadId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoStoredThread = Static<typeof EnsoStoredThread>

/**
 * `POST /api/threads/:id/fork` (#433): fork the thread at one of its user messages, pi's `/fork`
 * with its default position `before`. `entryId` is the pi entry id of that user message — the
 * id a stored history's message carries.
 *
 * @group Thread inspection
 */
export const EnsoForkRequest = Type.Object({ entryId: Type.String({ minLength: 1 }) }, { additionalProperties: false })
/** @group Thread inspection */
export type EnsoForkRequest = Static<typeof EnsoForkRequest>

/**
 * The body of `POST …/restore` (#551): the entry whose run-context snapshot the thread's tree is
 * restored to. The conversation is not changed.
 * @group Thread inspection
 */
export const EnsoRestoreRequest = Type.Object(
  { entryId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoRestoreRequest = Static<typeof EnsoRestoreRequest>

/**
 * The body of `POST …/restore/undo` (#565): the safety snapshot the undo puts back — the one the
 * restore's notice promised. The host undoes only the NEWEST restore, and only when this is its
 * safety, so a notice of an older restore can never undo a later one (PR #561 review).
 * @group Thread inspection
 */
export const EnsoRestoreUndoRequest = Type.Object(
  { safety: Type.String({ pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' }) },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoRestoreUndoRequest = Static<typeof EnsoRestoreUndoRequest>

/**
 * What a fork answers (#433): the new thread, and the forked message's text — pi's `/fork` puts it
 * in the editor, so the new thread's composer opens holding it, ready to send again or edit.
 *
 * @group Thread inspection
 */
export const EnsoForkReceipt = Type.Object(
  { threadId: Type.String(), prefill: Type.String() },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoForkReceipt = Static<typeof EnsoForkReceipt>

/**
 * How much a directory takes on disk (#578), as `du` counts it: allocated blocks, every file and
 * directory under it, a hard-linked file once, a symlink never followed.
 * - `measured`: every entry was read;
 * - `partial`: at least `bytes` — the walk hit its time cap, or a directory under it could not be
 *   read; `reason` says which;
 * - `unreadable`: the directory itself could not be read. ⚠ Never a `0` for what was not counted.
 *
 * @group Thread inspection
 */
export const EnsoDiskUsage = Type.Union([
  Type.Object({ kind: Type.Literal('measured'), bytes: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('partial'), bytes: Type.Integer({ minimum: 0 }), reason: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('unreadable'), reason: Type.String() }, { additionalProperties: false }),
])
/** @group Thread inspection */
export type EnsoDiskUsage = Static<typeof EnsoDiskUsage>

/**
 * What deleting a thread would do (#571, `GET …/delete-preview`), read before the dialog asks. It
 * moves nothing — nothing is deleted and no snapshot is taken; its inventory only stages the tree
 * into a scratch index, which leaves loose objects in the thread's store (PR #572 review):
 * - `tree`: the tree a delete removes with its thread, or null for a thread in its checkout;
 * - `size`: what that tree takes on disk, ignored files included — what the delete frees of it
 *   (#578); null with no tree;
 * - `holdsWork`: the work in it a delete is refused for, in the inventory's own words ("the tree
 *   holds work — modified: a.txt"), or null — "Delete anyway" confirms exactly these words (their
 *   sha256 as `If-Match`), so work gained since is named before it is deleted;
 * - `keptFor`: the forks of this thread, at any depth, whose histories keep its snapshots up to
 *   where each forked (#573) — the rest of its snapshots go with it.
 *
 * @group Thread inspection
 */
export const EnsoThreadDeletePreview = Type.Object(
  {
    tree: Type.Union([
      Type.Object(
        {
          kind: Type.Union([Type.Literal('worktree'), Type.Literal('copy')]),
          path: Type.String(),
          branch: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    size: Type.Union([EnsoDiskUsage, Type.Null()]),
    holdsWork: Type.Union([Type.String(), Type.Null()]),
    keptFor: Type.Array(Type.Object({ threadId: Type.String() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoThreadDeletePreview = Static<typeof EnsoThreadDeletePreview>

/**
 * One thread tree on disk (#578), as the trees listing names it:
 * - `threadId`: the served thread whose branch records this tree, or null for a tree directory no
 *   thread records (a mint or a delete that stopped partway) — named, never deletable from here;
 * - `kind`, `branch`: a worktree on its branch, or a copy (null);
 * - `size`: what it takes on disk, ignored files and installs included;
 * - `holdsWork`: what deleting it is refused for, in the delete inventory's own words, or null —
 *   also null for a tree no thread records, which has no store to compare with.
 *
 * @group Thread inspection
 */
export const EnsoTreeOnDisk = Type.Object(
  {
    threadId: Type.Union([Type.String(), Type.Null()]),
    path: Type.String(),
    kind: Type.Union([Type.Literal('worktree'), Type.Literal('copy')]),
    branch: Type.Union([Type.String(), Type.Null()]),
    size: EnsoDiskUsage,
    holdsWork: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoTreeOnDisk = Static<typeof EnsoTreeOnDisk>

/**
 * What thread trees cost on disk (#578, `GET /api/trees`), per project this server serves a thread
 * of: its trees, and its snapshot object store (`snapshots/.objects`, #573; null when it has none).
 * Sizes are bounded — one time cap for the whole listing — so a slow tree is `partial`, never waited
 * on forever.
 *
 * @group Thread inspection
 */
export const EnsoTreesListing = Type.Object(
  {
    projects: Type.Array(
      Type.Object(
        {
          projectId: Type.String(),
          objectStore: Type.Union([EnsoDiskUsage, Type.Null()]),
          trees: Type.Array(EnsoTreeOnDisk),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoTreesListing = Static<typeof EnsoTreesListing>

/**
 * The palette's `/fork` (#433): a `host` row of kind `view` — the page does it, forking at the
 * thread's last user message through the fork route; nothing is posted to `…/command`.
 *
 * @group Thread inspection
 */
export const ENSO_FORK_COMMAND = 'fork'

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
 *
 * @group Thread inspection
 */
export const EnsoInterruptedTail = Type.Union([
  Type.Literal('unanswered-prompt'),
  Type.Literal('tool-call-without-result'),
  Type.Literal('tool-results-without-reply'),
])
/** @group Thread inspection */
export type EnsoInterruptedTail = Static<typeof EnsoInterruptedTail>

/**
 * A thread's history as the browser mounts it (#95): the transcript as TanStack `UIMessage`s —
 * assembled by the server's `transcript-to-messages` reader, the same way the live stream is
 * adapted to AG-UI — plus the opening permission mode the transcript persists.
 *
 * Carried as `Unknown` because the shape is TanStack's, not enso's; the durable form is the
 * runtime's log, decoded by the host into `EnsoTranscriptEntry` (L2).
 *
 * @group Thread inspection
 */
export const EnsoThreadHistory = Type.Object(
  {
    threadId: Type.String(),
    /** The project it belongs to (#395), so a resumed thread is grouped under it. */
    projectId: Type.String(),
    messages: Type.Array(Type.Unknown()),
    permissionMode: EnsoPermissionModeState,
    /** The session's risk (#464): the replayed level and how many signals it rests on — the status bar's seed. */
    sessionRisk: EnsoSessionRiskChange,
    /** The session's incidents (#466), folded from the branch's records — the incident card's and the suspension's seed. */
    incidents: EnsoSessionIncidents,
    /** Present only when the branch ends inside a turn — see {@link EnsoInterruptedTail}. */
    interrupted: Type.Optional(EnsoInterruptedTail),
  },
  { additionalProperties: false },
)
/** @group Thread inspection */
export type EnsoThreadHistory = Static<typeof EnsoThreadHistory>
