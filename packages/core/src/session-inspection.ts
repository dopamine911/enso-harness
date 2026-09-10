import { type Static, Type } from 'typebox'
import { PiPermissionModeState } from './permission-mode.ts'

/**
 * What a live thread's session ACTUALLY contains, as the server reports it (#86).
 *
 * Everything the web surface shows is a derived view of the stream; these are the shapes
 * that let a human or an agent see the thing they derive from and cross-check. Served by
 * `GET /api/threads` and `GET /api/threads/:threadId`, rendered by the debug drawer and
 * printed by `scripts/zen-session.mjs`.
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

/** One live thread, at a glance. */
export const ZenThreadSummary = Type.Object(
  {
    threadId: Type.String(),
    sessionId: Type.String(),
    /** Where the session file is or will be. */
    sessionDir: Type.String(),
    /** The session file's path once pi has flushed it to disk; null while it lives only in memory. */
    sessionFile: Type.Union([Type.String(), Type.Null()]),
    /** picc's current mode, computed the way picc restores it. */
    mode: Type.String(),
    /** A run has taken the session and not released it — in flight, or blocked on a question. */
    busy: Type.Boolean(),
    /**
     * How many runs have taken this thread since the server started (#109) — the fence a
     * late run handle is checked against on the server, and the number a run's `zen.run`
     * receipt hands the browser: a difference between the two says another client, or a
     * rebuild after idle, has moved the thread on since this page's last run.
     */
    generation: Type.Integer({ minimum: 0 }),
    /** When the thread was last acquired or released — ISO 8601. */
    lastActivityAt: Type.String(),
  },
  { additionalProperties: false },
)
export type ZenThreadSummary = Static<typeof ZenThreadSummary>

/** One live thread, in full: the summary plus the session branch and what it may run. */
export const ZenThreadInspection = Type.Object(
  {
    threadId: Type.String(),
    sessionId: Type.String(),
    cwd: Type.String(),
    sessionDir: Type.String(),
    sessionFile: Type.Union([Type.String(), Type.Null()]),
    permissionMode: PiPermissionModeState,
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
export type ZenThreadInspection = Static<typeof ZenThreadInspection>

/**
 * Where one recorded event came from (#97) — the axis an ordering bug lives on.
 *
 *   live      the host delivered it to a subscriber as it arrived
 *   held      it arrived before the FIRST subscriber and was buffered (#69)
 *   replayed  the buffer delivered it to the first subscriber — a `held` record's second life
 *   dropped   nobody was listening and the first subscriber had already come and gone
 *   sent      an AG-UI chunk the server wrote to the browser — the wire's own order
 */
export const ZenEventProvenance = Type.Union([
  Type.Literal('live'),
  Type.Literal('held'),
  Type.Literal('replayed'),
  Type.Literal('dropped'),
  Type.Literal('sent'),
])
export type ZenEventProvenance = Static<typeof ZenEventProvenance>

/**
 * One event in a thread's tail. Consecutive events of the same shape coalesce into one
 * record with a `count` — a model turn is hundreds of text deltas, and the tail exists to
 * be read, not scrolled.
 */
export const ZenThreadEvent = Type.Object(
  {
    /** Monotonic per thread — identity, since type + time can collide. */
    sequence: Type.Number(),
    /** pi's rpc event type for the host's tail; the AG-UI event type for the wire's. */
    type: Type.String(),
    /** The inner name when the type alone says nothing: a custom entry's `customType`, a ui request's method, a tool's name, a CUSTOM chunk's name. */
    name: Type.Optional(Type.String()),
    provenance: ZenEventProvenance,
    /** ISO 8601 — when the FIRST of a coalesced run was recorded. */
    at: Type.String(),
    /** How many consecutive same-shaped events this record stands for. */
    count: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
)
export type ZenThreadEvent = Static<typeof ZenThreadEvent>

/** A thread's two tails: what the host emitted (with how), and what the server sent. */
export const ZenThreadEvents = Type.Object(
  {
    threadId: Type.String(),
    emitted: Type.Array(ZenThreadEvent),
    sent: Type.Array(ZenThreadEvent),
  },
  { additionalProperties: false },
)
export type ZenThreadEvents = Static<typeof ZenThreadEvents>

/**
 * One entry of the branch as a row — `12:34:56 custom:modes mode=plan` — read defensively:
 * pi's shapes are carried, not modelled. THE definition (PR #100 review): the drawer and
 * `zen-session.mjs` had one each and they had already drifted apart.
 */
export function describeSessionEntry(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return String(entry)
  const fields = entry as {
    type?: unknown
    customType?: unknown
    timestamp?: unknown
    message?: unknown
    data?: unknown
  }
  const kind = typeof fields.type === 'string' ? fields.type : '?'
  const custom = typeof fields.customType === 'string' ? `:${fields.customType}` : ''
  const role =
    typeof fields.message === 'object' && fields.message !== null && 'role' in fields.message
      ? ` ${String(fields.message.role)}`
      : ''
  const mode =
    fields.customType === 'modes' && typeof fields.data === 'object' && fields.data !== null && 'mode' in fields.data
      ? ` mode=${String(fields.data.mode)}`
      : ''
  const when = typeof fields.timestamp === 'string' ? fields.timestamp.slice(11, 19) : ''
  return `${when} ${kind}${custom}${role}${mode}`.trim()
}

/** The three columns of an event row: `12:34:56` · `held ×3` · `entry_appended modes`. */
export interface ThreadEventColumns {
  readonly when: string
  /** Provenance, with the count when coalesced — the column a reader scans for `held`/`dropped`. */
  readonly provenance: string
  /** Type, with the inner name when there is one. */
  readonly subject: string
}

/**
 * THE definition of what each column holds — a new provenance value or inner name lands
 * here once. How the columns are joined is layout, the surface's own: the drawer joins
 * with a space (`describeThreadEvent`), `zen-session.mjs` pads them into a table.
 */
export function threadEventColumns(event: ZenThreadEvent): ThreadEventColumns {
  return {
    when: event.at.slice(11, 19),
    provenance: event.count > 1 ? `${event.provenance} ×${event.count}` : event.provenance,
    subject: event.name === undefined ? event.type : `${event.type} ${event.name}`,
  }
}

/** One event of a tail as a row — `12:34:56 held ×3 entry_appended modes`. */
export function describeThreadEvent(event: ZenThreadEvent): string {
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
const ZEN_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isZenThreadId(value: unknown): value is string {
  return typeof value === 'string' && ZEN_THREAD_ID_PATTERN.test(value)
}

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
export type ZenStoredThread = Static<typeof ZenStoredThread>

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
export type ZenInterruptedTail = Static<typeof ZenInterruptedTail>

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
    permissionMode: PiPermissionModeState,
    /** Present only when the branch ends inside a turn — see {@link ZenInterruptedTail}. */
    interrupted: Type.Optional(ZenInterruptedTail),
  },
  { additionalProperties: false },
)
export type ZenThreadHistory = Static<typeof ZenThreadHistory>
