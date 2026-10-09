import type { EnsoTranscriptEntry, EnsoTurnStats } from '@enso/core'
import { branchStats } from './branch-stats.ts'
import type { LogEntry } from './log-entry.ts'
import { transcriptOf } from './transcript.ts'

/**
 * The branch as the session eval reads it (#441): the transcript as ours (leak L2) and the turns'
 * usage from the same walk the stats drawer uses. One function for a live session's memory and a
 * stored file, so the eval of a thread reads one way whether it is running.
 */
export interface BranchEval {
  readonly transcript: EnsoTranscriptEntry[]
  readonly turnStats: EnsoTurnStats[]
}

/** Walk one branch, root to leaf. */
export function branchEval(branch: readonly LogEntry[]): BranchEval {
  return { transcript: transcriptOf(branch), turnStats: branchStats(branch).turnStats }
}
