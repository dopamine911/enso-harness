import type { EnsoRiskThresholds, EnsoThreadIncidents } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import { liveOrStored } from './live-or-stored.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/incidents` (#468): one thread's incident history for
 * `bun run incidents` — each incident's record and the custom entries it rests on as stored, and
 * the branch replayed under the thresholds the guard runs with, or the ones the query names
 * (`?incidentAtSignals=4`): what a threshold change would have opened, and what it would have missed.
 *
 * ⚠ LIVE-OR-COLD (`live-or-stored.ts`), as the eval route reads. ⚠ WRITES NO RECORD.
 */

export interface ThreadIncidentsRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'readStoredIncidentHistory'>
  /** The user's thresholds (`security.incidents`) — what the guard runs with, and the replay's default. */
  readonly riskThresholds: EnsoRiskThresholds
}

const THRESHOLD_KEYS = [
  'windowCalls',
  'highAtSignals',
  'highAtKinds',
  'incidentAtSignals',
] as const satisfies ReadonlyArray<keyof EnsoRiskThresholds>
type ThresholdKey = (typeof THRESHOLD_KEYS)[number]

function isThresholdKey(key: string): key is ThresholdKey {
  return (THRESHOLD_KEYS as readonly string[]).includes(key)
}

/** A threshold as `config.json` takes it: a whole number, at least 1. */
const WHOLE_NUMBER = /^[1-9]\d{0,5}$/

/**
 * The replay's thresholds: `defaults`, with what the query names in their place. A string says
 * why the query is refused — a key no threshold has, or a value that is no whole number from 1.
 */
export function replayThresholdsOf(query: string, defaults: EnsoRiskThresholds): EnsoRiskThresholds | string {
  const thresholds: Record<ThresholdKey, number> = { ...defaults }
  for (const [key, given] of new URLSearchParams(query)) {
    if (!isThresholdKey(key)) return `${key} is no threshold; the thresholds are ${THRESHOLD_KEYS.join(', ')}`
    if (!WHOLE_NUMBER.test(given)) return `${key} must be a whole number from 1, not ${JSON.stringify(given)}`
    thresholds[key] = Number(given)
  }
  return thresholds
}

export function createThreadIncidentsRoute(
  deps: ThreadIncidentsRouteDeps,
): (threadId: string, thresholds: EnsoRiskThresholds) => Promise<EnsoThreadIncidents | undefined> {
  return async (threadId: string, thresholds: EnsoRiskThresholds): Promise<EnsoThreadIncidents | undefined> => {
    const source = await liveOrStored(
      deps.threads,
      threadId,
      (view) => view.hosted.branchIncidentHistory(thresholds),
      () => deps.host.readStoredIncidentHistory(threadId, thresholds),
    )
    if (source === undefined) return undefined
    return { threadId, live: source.live, thresholds, incidents: source.incidents, replay: source.replay }
  }
}
