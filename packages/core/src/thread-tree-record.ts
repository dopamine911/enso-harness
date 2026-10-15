import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * A thread's own tree (#551 slice 2), as its session log records it: where the thread works and
 * what it was minted at. The minting itself is node-only (`@enso/core/thread-tree`); these are the
 * entries a host appends and a reader — any surface — reads back.
 *
 * ⚠ AN ENTRY IN pi's LOG. The host appends {@link ENSO_THREAD_TREE_ENTRY} once, when it mints the
 * thread's tree, and {@link ENSO_TREE_RESTORED_ENTRY} each time the tree's files are put back to a
 * snapshot. pi's context builder skips `custom` entries: the model never sees either. A restore
 * changes files only; the conversation is not touched, and `safety` names the snapshot of the
 * files as they were just before, so a restore is itself undoable.
 *
 * @module
 */

/**
 * The `customType` a thread's tree is persisted under.
 *
 * @group Thread tree
 */
export const ENSO_THREAD_TREE_ENTRY = 'enso-thread-tree' as const

/**
 * The `customType` a restore of a thread's tree is persisted under.
 *
 * @group Thread tree
 */
export const ENSO_TREE_RESTORED_ENTRY = 'enso-tree-restored' as const

/**
 * A snapshot commit: 40 or 64 hex digits, as the store's object format (sha1 or sha256) makes it.
 * The one pattern every record, wire field and route query that names a snapshot is held to.
 *
 * @group Thread tree
 */
export const EnsoSnapshotHash = Type.String({ pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' })

const snapshotHashValidator = Compile(EnsoSnapshotHash)

/**
 * Whether `value` names a snapshot commit ({@link EnsoSnapshotHash}): lowercase hex, 40 or 64 digits.
 *
 * @group Thread tree
 */
export function isSnapshotHash(value: unknown): value is string {
  return snapshotHashValidator.Check(value)
}

/**
 * How a thread's tree is made: a `git worktree` of the project on the thread's own branch, or a
 * plain directory (a project that is no repository's top level, or one configured so) — no `.git`.
 *
 * @group Thread tree
 */
export const EnsoThreadTreeKind = Type.Union([Type.Literal('worktree'), Type.Literal('copy')])
/** @group Thread tree */
export type ThreadTreeKind = Static<typeof EnsoThreadTreeKind>

/**
 * A minted tree: its kind, the project it was minted from, where it is, its branch (`null` for a
 * copy) and `base`, the snapshot its content was made from.
 *
 * @group Thread tree
 */
export const EnsoThreadTreeRecord = Type.Object(
  {
    kind: EnsoThreadTreeKind,
    /** The checkout the tree was minted from (canonical path). */
    project: Type.String({ minLength: 1 }),
    /** The tree: the thread's cwd. */
    path: Type.String({ minLength: 1 }),
    /** The worktree's branch; `null` for a copy. */
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** The snapshot the tree's content was made from. */
    base: EnsoSnapshotHash,
  },
  { additionalProperties: false },
)
/** @group Thread tree */
export type ThreadTreeRecord = Static<typeof EnsoThreadTreeRecord>

const threadTreeValidator = Compile(EnsoThreadTreeRecord)

/**
 * The tree a custom entry records, or undefined when the entry is another extension's or
 * malformed — an entry is a wire crossing, and a bad one records nothing.
 *
 * @group Thread tree
 */
export function readEnsoThreadTree(customType: string, data: unknown): ThreadTreeRecord | undefined {
  return customType === ENSO_THREAD_TREE_ENTRY && threadTreeValidator.Check(data) ? data : undefined
}

/**
 * A restore of a thread's tree: the snapshot its files were put back to, and `safety`, the
 * snapshot of the files as they were just before.
 *
 * @group Thread tree
 */
export const EnsoTreeRestored = Type.Object(
  { hash: EnsoSnapshotHash, safety: EnsoSnapshotHash },
  { additionalProperties: false },
)
/** @group Thread tree */
export type EnsoTreeRestored = Static<typeof EnsoTreeRestored>

const treeRestoredValidator = Compile(EnsoTreeRestored)

/**
 * The restore a custom entry records, or undefined when the entry is another extension's or malformed.
 *
 * @group Thread tree
 */
export function readEnsoTreeRestored(customType: string, data: unknown): EnsoTreeRestored | undefined {
  return customType === ENSO_TREE_RESTORED_ENTRY && treeRestoredValidator.Check(data) ? data : undefined
}
