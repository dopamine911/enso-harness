import { type Static, type TObject, type TProperties, Type } from 'typebox'
import { EnsoGitFileChange } from './git-state.ts'
import { EnsoSnapshotHash } from './thread-tree-record.ts'

/**
 * The Diff Viewer's wire (#553): a thread's prompt runs, each with the snapshots of its tree (#551)
 * as it began and as the next one began, and what differs between two of them. Read-only: every
 * answer is two snapshot commits compared in the thread's store, never the live tree, so it stays
 * what it was however the thread or its tree has moved since.
 *
 * A PROMPT RUN, NOT A TURN. A prompt run is one of the thread's own prompts and everything that ran
 * under it, up to the next prompt. A turn is one model request (glossary, Decision 6): a prompt run
 * holds several, and `EnsoTurnStats.turn` / the Stats tab's "turn 3" count those, not these.
 *
 * ⚠ OBSERVED, NOT ATTRIBUTED. A prompt run's changes are what differs between its two snapshots:
 * pi's edits, a formatter `bash` ran, the user's own editor, a restore — whatever happened to the
 * files while it ran. Which tool made an edit is the transcript's to say, not this.
 */

/** An object of exactly `properties`: no wire object here admits another key. */
function closed<Properties extends TProperties>(properties: Properties): TObject<Properties> {
  return Type.Object(properties, { additionalProperties: false })
}

const Id = Type.String({ minLength: 1 })

/**
 * One end of a prompt run, as its branch records it:
 * - `taken`: the snapshot's commit, readable in the thread's store;
 * - `failed`: the run recorded that no snapshot could be taken (the store could not be opened, a git failed);
 * - `unrecorded`: no record names one — a thread from before #551;
 * - `pending`: the prompt run's result is taken as the NEXT prompt's run begins, and none has begun after it yet;
 * - `unavailable`: a recorded commit the store cannot read, with git's words.
 *
 * @group Diff Viewer
 */
export const EnsoPromptRunSnapshot = Type.Union([
  closed({ kind: Type.Literal('taken'), hash: EnsoSnapshotHash }),
  closed({ kind: Type.Literal('failed') }),
  closed({ kind: Type.Literal('unrecorded') }),
  closed({ kind: Type.Literal('pending') }),
  closed({ kind: Type.Literal('unavailable'), hash: EnsoSnapshotHash, reason: Id }),
])
/** @group Diff Viewer */
export type EnsoPromptRunSnapshot = Static<typeof EnsoPromptRunSnapshot>

/**
 * One prompt run of the thread: a prompt and everything that ran under it, up to the next prompt.
 * `promptRun` counts the thread's own prompts (a fork's inherited ones are not), from 1 — never a
 * turn number; `prompt` counts every prompt on the branch, inherited too — what Chat finds the
 * prompt's bubble by. `text` is the prompt cut to 120 characters (`…`-ended when cut); `start` the
 * tree as the prompt's run began, `end` as the next prompt's run began — its result. `idle`: both
 * ends taken and the files the same. `restored`: the tree was restored to an older snapshot while it
 * ran (#565), so its changes include the restore.
 *
 * @group Diff Viewer
 */
export const EnsoPromptRun = closed({
  promptRun: Type.Integer({ minimum: 1 }),
  prompt: Type.Integer({ minimum: 1 }),
  entryId: Id,
  text: Type.String(),
  at: Type.Optional(Type.String()),
  start: EnsoPromptRunSnapshot,
  end: EnsoPromptRunSnapshot,
  idle: Type.Boolean(),
  restored: Type.Boolean(),
})
/** @group Diff Viewer */
export type EnsoPromptRun = Static<typeof EnsoPromptRun>

/**
 * What the cumulative view compares each prompt run's result with:
 * - `tree`: the snapshot the thread's tree was made from — for a fork, the snapshot it inherited at
 *   the fork point, with its source (`parentThreadId`, `null` when the server no longer holds its
 *   file) and how many of the branch's prompts it inherited;
 * - `first-snapshot`: a thread in its checkout, with no tree of its own: the first snapshot its
 *   branch records;
 * - `none`: no snapshot on the branch to start from.
 *
 * @group Diff Viewer
 */
export const EnsoPromptRunBaseline = Type.Union([
  closed({
    kind: Type.Literal('tree'),
    snapshot: EnsoPromptRunSnapshot,
    fork: Type.Union([
      Type.Null(),
      closed({ parentThreadId: Type.Union([Id, Type.Null()]), inheritedPrompts: Type.Integer({ minimum: 1 }) }),
    ]),
  }),
  closed({ kind: Type.Literal('first-snapshot'), snapshot: EnsoPromptRunSnapshot }),
  closed({ kind: Type.Literal('none') }),
])
/** @group Diff Viewer */
export type EnsoPromptRunBaseline = Static<typeof EnsoPromptRunBaseline>

/**
 * `GET /api/threads/:threadId/prompt-runs` (#553): the thread's own prompt runs in order, and the
 * cumulative view's baseline.
 *
 * @group Diff Viewer
 */
export const EnsoThreadPromptRuns = closed({
  threadId: Id,
  baseline: EnsoPromptRunBaseline,
  promptRuns: Type.Array(EnsoPromptRun),
})
/** @group Diff Viewer */
export type EnsoThreadPromptRuns = Static<typeof EnsoThreadPromptRuns>

/**
 * `GET /api/threads/:threadId/prompt-runs/changes?from=<hash>&to=<hash>` (#553): every file that
 * differs between two of the thread's snapshots, with its patch; `truncated` when more differ than a
 * page is sent, `files` then the first of them.
 *
 * @group Diff Viewer
 */
export const EnsoPromptRunChanges = closed({
  threadId: Id,
  from: EnsoSnapshotHash,
  to: EnsoSnapshotHash,
  files: Type.Array(EnsoGitFileChange),
  truncated: Type.Boolean(),
})
/** @group Diff Viewer */
export type EnsoPromptRunChanges = Static<typeof EnsoPromptRunChanges>
