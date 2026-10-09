import {
  customEntriesOf,
  type EnsoRiskThresholds,
  type EnsoThreadIncidents,
  incidentEntriesOf,
  replayIncidents,
  sessionIncidentsOf,
} from '@enso/core'
import type { LogEntry } from './log-entry.ts'
import { transcriptOf } from './transcript.ts'

/**
 * The branch's incident history (#468), for `bun run incidents`: each incident's record with the
 * custom entries it rests on as our transcript records them, and the branch replayed under `thresholds`. One
 * function for a live session's memory and a stored file, as `branch-eval.ts` is.
 *
 * ⚠ The entries go out as our records (`EnsoTranscriptCustom`, #557), each stored `data` untouched
 * — never the runtime's envelope past the seam; every reading of them is `@enso/core`'s.
 */
export type BranchIncidentHistory = Pick<EnsoThreadIncidents, 'incidents' | 'replay'>

/** Walk one branch, root to leaf. */
export function branchIncidentHistory(
  branch: readonly LogEntry[],
  thresholds: EnsoRiskThresholds,
): BranchIncidentHistory {
  const transcript = transcriptOf(branch)
  return {
    incidents: sessionIncidentsOf(customEntriesOf(transcript)).incidents.map((record) => ({
      record,
      entries: incidentEntriesOf(transcript, record.opened),
    })),
    replay: replayIncidents(transcript, thresholds),
  }
}
