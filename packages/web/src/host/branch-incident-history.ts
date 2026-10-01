import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  customEntriesOf,
  type EnsoRiskThresholds,
  type EnsoThreadIncidents,
  incidentEntriesOf,
  replayIncidents,
  sessionIncidentsOf,
} from '@enso/core'
import { transcriptOf } from './transcript.ts'

/**
 * The branch's incident history (#468), for `bun run incidents`: each incident's record with the
 * custom entries it rests on as our transcript records them, and the branch replayed under `thresholds`. One
 * function for a live session's memory and a stored file, as `branch-eval.ts` is.
 *
 * ⚠ pi's raw entries go out only as `unknown` — the export's "as stored" — never typed past the
 * seam (leak L2); every reading of them is `@enso/core`'s.
 */
export type BranchIncidentHistory = Pick<EnsoThreadIncidents, 'incidents' | 'replay'>

/** Walk one branch, root to leaf. */
export function branchIncidentHistory(
  branch: readonly SessionEntry[],
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
