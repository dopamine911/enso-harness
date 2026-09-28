import { type EnsoForkPoint, type EnsoRunContext, readEnsoRunContext } from '@enso/core'
import { persistedPermissionMode } from './permission-mode-adapter.ts'
import { recordedModelOf } from './transcript.ts'

/**
 * A thread's fork point (#435), assembled from its branch alone — the same walk for a live
 * session's memory and a stored file, so the manifest of a thread reads one way whether it is
 * running. Identity is the session id, the branch's leaf and the parent the listing resolves
 * (#433); the conditions are the branch's recorded model and level (#434), picc's last mode
 * name, the session's cwd, and the latest `enso-run-context` on the branch — the harness's
 * `run-context` extension writes one only when a condition changed, so the last one is current.
 */

interface PiBranchEntry {
  readonly id?: unknown
  readonly type?: unknown
  readonly customType?: unknown
  readonly data?: unknown
}

function latestRunContext(branch: readonly unknown[]): EnsoRunContext | null {
  for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = branch[entryIndex] as PiBranchEntry | undefined
    if (entry?.type !== 'custom' || typeof entry.customType !== 'string') continue
    const recorded = readEnsoRunContext(entry.customType, entry.data)
    if (recorded !== undefined) return recorded
  }
  return null
}

/** The fork point of `branch` (root to leaf), for the session `threadId` in `cwd`. */
export function forkPointOf(
  branch: readonly unknown[],
  session: { readonly threadId: string; readonly cwd: string; readonly parentThreadId: string | undefined },
): EnsoForkPoint {
  const leaf = branch.at(-1) as PiBranchEntry | undefined
  const recorded = recordedModelOf(branch)
  return {
    identity: {
      threadId: session.threadId,
      leafEntryId: typeof leaf?.id === 'string' && leaf.id !== '' ? leaf.id : null,
      ...(session.parentThreadId === undefined ? {} : { parentThreadId: session.parentThreadId }),
    },
    conditions: {
      model: recorded?.model ?? null,
      thinkingLevel: recorded?.thinkingLevel ?? null,
      mode: persistedPermissionMode(branch),
      cwd: session.cwd,
      runContext: latestRunContext(branch),
    },
  }
}
