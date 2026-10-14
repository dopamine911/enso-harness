import {
  ENSO_THREAD_TREE_ENTRY,
  ENSO_TREE_RESTORED_ENTRY,
  type EnsoThreadTurn,
  type EnsoThreadPromptRuns,
  type EnsoTranscriptEntry,
  type EnsoTurnBaseline,
  type EnsoTurnSnapshot,
  readEnsoRunContext,
  readEnsoThreadTree,
} from '@enso/core'
import { promptText } from './branch-stats.ts'
import { runContextAt } from './thread-trees.ts'

/**
 * A thread's prompts as the Diff Viewer steps through them (#553), from its branch alone: #551's
 * snapshots, never a second store, never the live tree.
 *
 * ⚠ A TURN'S TWO ENDS ARE TWO RUN STARTS. The harness snapshots the tree as each run BEGINS
 * (`enso-run-context`, written only when a field changed — so the newest record at or before a
 * prompt is the tree as that prompt's run began). A turn's result is therefore the snapshot the
 * NEXT turn began from; the last turn's result is `pending` until another prompt is sent. A
 * Continue (#445) inside a turn writes its record inside the span, and the span still ends at the
 * next prompt: the turn's changes are all of what happened under it.
 *
 * ⚠ A FORK'S BASELINE IS WHAT IT INHERITED. A fork's branch holds its source's entries up to the
 * fork point, then its own `enso-thread-tree` record, whose `base` is the snapshot its tree was
 * minted from (`thread-fork.ts`). The prompts before that record are the source's prompts: they are
 * not this thread's, and are left out — counted, so Chat still finds this thread's prompts by their
 * place among every prompt on the branch.
 */

/** A turn as its branch records it, before the store says which commits it can read. */
type RecordedTurn = Omit<EnsoThreadTurn, 'idle'>

/** The thread's prompts and baseline as its branch records them, before the store is asked. */
export interface RecordedPromptRuns {
  readonly threadId: string
  readonly baseline: EnsoTurnBaseline
  readonly prompts: readonly RecordedTurn[]
}

/** The tree as the run before `position` began, as {@link runContextAt} decides it. */
function snapshotBefore(transcript: readonly EnsoTranscriptEntry[], position: number): EnsoTurnSnapshot {
  const snapshot = runContextAt(transcript, position)?.snapshot
  if (snapshot === undefined) return { kind: 'unrecorded' }
  return snapshot === null ? { kind: 'failed' } : { kind: 'taken', hash: snapshot.hash }
}

/** The position of the branch's last `enso-thread-tree` record that reads, and the record; `undefined` for a thread in its checkout. */
function lastTreeRecord(
  transcript: readonly EnsoTranscriptEntry[],
): { readonly position: number; readonly base: string } | undefined {
  for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = transcript[entryIndex]
    if (entry?.kind !== 'custom' || entry.customType !== ENSO_THREAD_TREE_ENTRY) continue
    const record = readEnsoThreadTree(entry.customType, entry.data)
    if (record !== undefined) return { position: entryIndex, base: record.base }
  }
  return undefined
}

/**
 * The thread's own prompts and the cumulative baseline, as its branch records them. `parentThreadId`
 * is the fork's source when the server still holds its file. The snapshots are as recorded: which
 * the store can read is {@link withStoreTrees}'s to say.
 */
export function recordedPromptRunsOf(
  threadId: string,
  transcript: readonly EnsoTranscriptEntry[],
  parentThreadId: string | undefined,
): RecordedPromptRuns {
  const userMessages = transcript.flatMap((entry, position) =>
    entry.kind === 'message' && entry.role === 'user' ? [{ entry, position }] : [],
  )
  const tree = lastTreeRecord(transcript)
  const inheritedPrompts =
    tree === undefined ? 0 : userMessages.filter(({ position }) => position < tree.position).length
  const own = userMessages.slice(inheritedPrompts)
  const prompts = own.map(({ entry, position }, ownIndex): RecordedTurn => {
    const next = own[ownIndex + 1]
    const spanEnd = next?.position ?? transcript.length
    const restored = transcript
      .slice(position, spanEnd)
      .some((spanEntry) => spanEntry.kind === 'custom' && spanEntry.customType === ENSO_TREE_RESTORED_ENTRY)
    return {
      turn: ownIndex + 1,
      prompt: inheritedPrompts + ownIndex + 1,
      entryId: entry.id,
      text: entry.kind === 'message' ? promptText(entry.parts) : '',
      ...(entry.at === undefined ? {} : { at: entry.at }),
      start: snapshotBefore(transcript, position),
      end: next === undefined ? { kind: 'pending' } : snapshotBefore(transcript, next.position),
      restored,
    }
  })
  return { threadId, baseline: baselineOf(transcript, tree, inheritedPrompts, parentThreadId), prompts }
}

function baselineOf(
  transcript: readonly EnsoTranscriptEntry[],
  tree: { readonly position: number; readonly base: string } | undefined,
  inheritedPrompts: number,
  parentThreadId: string | undefined,
): EnsoTurnBaseline {
  if (tree !== undefined) {
    const fork = inheritedPrompts === 0 ? null : { parentThreadId: parentThreadId ?? null, inheritedPrompts }
    return { kind: 'tree', snapshot: { kind: 'taken', hash: tree.base }, fork }
  }
  const first = transcript.findIndex(
    (entry) => entry.kind === 'custom' && readEnsoRunContext(entry.customType, entry.data)?.snapshot != null,
  )
  return first === -1 ? { kind: 'none' } : { kind: 'first-snapshot', snapshot: snapshotBefore(transcript, first) }
}

/**
 * The recorded prompts, each taken snapshot checked against the store (`trees`: commit to tree, the
 * commits it holds): one it lacks is `unavailable`, never compared; a turn whose two ends hold one
 * tree is `idle`. `unreadable` is why the store could not be read at all, when it could not.
 */
export function withStoreTrees(
  recorded: RecordedPromptRuns,
  trees: ReadonlyMap<string, string>,
  unreadable: string | undefined,
): EnsoThreadPromptRuns {
  const checked = (snapshot: EnsoTurnSnapshot): EnsoTurnSnapshot => {
    if (snapshot.kind !== 'taken' || trees.has(snapshot.hash)) return snapshot
    const reason = unreadable ?? "the thread's snapshot store does not hold this snapshot"
    return { kind: 'unavailable', hash: snapshot.hash, reason }
  }
  const { baseline } = recorded
  return {
    threadId: recorded.threadId,
    baseline: baseline.kind === 'none' ? baseline : { ...baseline, snapshot: checked(baseline.snapshot) },
    prompts: recorded.prompts.map((turn) => {
      const start = checked(turn.start)
      const end = checked(turn.end)
      const idle = start.kind === 'taken' && end.kind === 'taken' && trees.get(start.hash) === trees.get(end.hash)
      return { ...turn, start, end, idle }
    }),
  }
}

/** Every commit the prompts and their baseline name, for the store to resolve. */
export function snapshotHashesOf(recorded: RecordedPromptRuns): string[] {
  const hashes = new Set<string>()
  const { baseline } = recorded
  if (baseline.kind !== 'none' && baseline.snapshot.kind === 'taken') hashes.add(baseline.snapshot.hash)
  for (const turn of recorded.prompts) {
    if (turn.start.kind === 'taken') hashes.add(turn.start.hash)
    if (turn.end.kind === 'taken') hashes.add(turn.end.hash)
  }
  return [...hashes]
}
