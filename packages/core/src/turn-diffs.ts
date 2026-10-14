import { type Static, type TObject, type TProperties, Type } from 'typebox'
import { EnsoGitFileChange } from './git-state.ts'

/**
 * The Diff Viewer's wire (#553): a thread's prompts, each with the snapshots of its tree (#551) as it
 * began and as the next turn began, and what differs between two of them. Read-only: every answer
 * is two snapshot commits compared in the thread's store, never the live tree, so it stays what it
 * was however the thread or its tree has moved since.
 *
 * ⚠ OBSERVED, NOT ATTRIBUTED. A turn's changes are what differs between its two snapshots: pi's
 * edits, a formatter `bash` ran, the user's own editor, a restore — whatever happened to the files
 * while the turn ran. Which tool made an edit is the transcript's to say, not this.
 */

/** An object of exactly `properties`: no wire object here admits another key. */
function closed<Properties extends TProperties>(properties: Properties): TObject<Properties> {
  return Type.Object(properties, { additionalProperties: false })
}

/** A snapshot commit: 40 or 64 hex digits, as the store's object format makes it. */
const SnapshotHash = Type.String({ pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' })
const Id = Type.String({ minLength: 1 })

/**
 * One end of a turn, as its branch records it:
 * - `taken`: the snapshot's commit, readable in the thread's store;
 * - `failed`: the run recorded that no snapshot could be taken (the store could not be opened, a git failed);
 * - `unrecorded`: no record names one — a thread from before #551;
 * - `pending`: the turn's result is taken as the NEXT turn begins, and no turn has begun after it yet;
 * - `unavailable`: a recorded commit the store cannot read, with git's words.
 *
 * @group Diff Viewer
 */
export const EnsoTurnSnapshot = Type.Union([
  closed({ kind: Type.Literal('taken'), hash: SnapshotHash }),
  closed({ kind: Type.Literal('failed') }),
  closed({ kind: Type.Literal('unrecorded') }),
  closed({ kind: Type.Literal('pending') }),
  closed({ kind: Type.Literal('unavailable'), hash: SnapshotHash, reason: Id }),
])
/** @group Diff Viewer */
export type EnsoTurnSnapshot = Static<typeof EnsoTurnSnapshot>

/**
 * One turn of the thread: a prompt and everything that ran under it, up to the next prompt. `turn`
 * counts the thread's own prompts (a fork's inherited ones are not); `prompt` counts every prompt on
 * the branch, inherited too — what Chat finds the prompt's bubble by. `text` is the prompt cut to
 * 120 characters (`…`-ended when cut); `start` the tree as the turn began, `end` as the next turn
 * began — the turn's result. `idle`: both ends taken and the files the same. `restored`: the tree
 * was restored to an older snapshot during the turn (#565), so its changes include the restore.
 *
 * @group Diff Viewer
 */
export const EnsoThreadTurn = closed({
  turn: Type.Integer({ minimum: 1 }),
  prompt: Type.Integer({ minimum: 1 }),
  entryId: Id,
  text: Type.String(),
  at: Type.Optional(Type.String()),
  start: EnsoTurnSnapshot,
  end: EnsoTurnSnapshot,
  idle: Type.Boolean(),
  restored: Type.Boolean(),
})
/** @group Diff Viewer */
export type EnsoThreadTurn = Static<typeof EnsoThreadTurn>

/**
 * What the cumulative view compares each turn's result with:
 * - `tree`: the snapshot the thread's tree was made from — for a fork, the snapshot it inherited at
 *   the fork point, with its source (`parentThreadId`, `null` when the server no longer holds its
 *   file) and how many of the branch's prompts it inherited;
 * - `first-snapshot`: a thread in its checkout, with no tree of its own: the first snapshot its
 *   branch records;
 * - `none`: no snapshot on the branch to start from.
 *
 * @group Diff Viewer
 */
export const EnsoTurnBaseline = Type.Union([
  closed({
    kind: Type.Literal('tree'),
    snapshot: EnsoTurnSnapshot,
    fork: Type.Union([
      Type.Null(),
      closed({ parentThreadId: Type.Union([Id, Type.Null()]), inheritedPrompts: Type.Integer({ minimum: 1 }) }),
    ]),
  }),
  closed({ kind: Type.Literal('first-snapshot'), snapshot: EnsoTurnSnapshot }),
  closed({ kind: Type.Literal('none') }),
])
/** @group Diff Viewer */
export type EnsoTurnBaseline = Static<typeof EnsoTurnBaseline>

/**
 * `GET /api/threads/:threadId/prompts` (#553): the thread's own prompts in order, and the cumulative
 * view's baseline.
 *
 * @group Diff Viewer
 */
export const EnsoThreadPromptRuns = closed({
  threadId: Id,
  baseline: EnsoTurnBaseline,
  prompts: Type.Array(EnsoThreadTurn),
})
/** @group Diff Viewer */
export type EnsoThreadPromptRuns = Static<typeof EnsoThreadPromptRuns>

/**
 * `GET /api/threads/:threadId/prompt-runs/changes?from=<hash>&to=<hash>` (#553): every file that differs
 * between two of the thread's snapshots, with its patch; `truncated` when more differ than a page
 * is sent, `files` then the first of them.
 *
 * @group Diff Viewer
 */
export const EnsoTurnChanges = closed({
  threadId: Id,
  from: SnapshotHash,
  to: SnapshotHash,
  files: Type.Array(EnsoGitFileChange),
  truncated: Type.Boolean(),
})
/** @group Diff Viewer */
export type EnsoTurnChanges = Static<typeof EnsoTurnChanges>
