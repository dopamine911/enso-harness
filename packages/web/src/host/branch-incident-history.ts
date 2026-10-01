import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  type EnsoRiskThresholds,
  type EnsoThreadIncidents,
  incidentEntriesOf,
  replayIncidents,
  sessionIncidentsOf,
} from '@enso/core'

/**
 * The branch's incident history (#468), for `bun run incidents`: each incident's record with the
 * custom entries it rests on as pi stored them, and the branch replayed under `thresholds`. One
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
  const custom = branch.flatMap((sessionEntry) =>
    sessionEntry.type === 'custom' ? [{ customType: sessionEntry.customType, data: sessionEntry.data }] : [],
  )
  return {
    incidents: sessionIncidentsOf(custom).incidents.map((record) => ({
      record,
      entries: incidentEntriesOf(branch, record.opened),
    })),
    replay: replayIncidents(branch, thresholds),
  }
}
