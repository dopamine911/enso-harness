import type { EnsoRiskThresholds, EnsoThreadIncidents, EnsoThreadJudgeCases } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import { liveOrStored } from './live-or-stored.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * The thread's security reads (#468, #469), live or cold as `live-or-stored.ts` reads; each writes
 * no record and builds nothing (#86).
 *
 * - `GET /api/threads/:threadId/incidents` (#468): the incident history for `bun run incidents` —
 *   each incident's record and the custom entries it rests on as stored, and the branch replayed
 *   under the thresholds the guard runs with, or the ones the query names (`?incidentAtSignals=4`):
 *   what a threshold change would have opened, and what it would have missed.
 * - `GET /api/threads/:threadId/judge-cases` (#469): the command judge's cases for `bun run judge`
 *   — each call the live guard would have judged, selected under the same thresholds, with the
 *   REDACTED state a backend would be sent. ⚠ Sends nothing anywhere: it is what the user reads
 *   before anything leaves the machine.
 */

export interface ThreadIncidentsRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'readStoredIncidentHistory' | 'readStoredJudgeCases'>
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
 * why the query is refused — a key no threshold has, one named twice (which is meant is a guess),
 * or a value that is no whole number from 1.
 */
export function replayThresholdsOf(query: string, defaults: EnsoRiskThresholds): EnsoRiskThresholds | string {
  const thresholds: Record<ThresholdKey, number> = { ...defaults }
  const named = new Set<string>()
  for (const [key, given] of new URLSearchParams(query)) {
    if (!isThresholdKey(key)) return `${key} is no threshold; the thresholds are ${THRESHOLD_KEYS.join(', ')}`
    if (named.has(key)) return `${key} is named twice`
    if (!WHOLE_NUMBER.test(given)) return `${key} must be a whole number from 1, not ${JSON.stringify(given)}`
    named.add(key)
    thresholds[key] = Number(given)
  }
  return thresholds
}

/** The thread's two security reads; undefined for a thread held neither live nor on disk (a 404). */
export interface ThreadSecurityReads {
  incidents(threadId: string, thresholds: EnsoRiskThresholds): Promise<EnsoThreadIncidents | undefined>
  judgeCases(threadId: string): Promise<EnsoThreadJudgeCases | undefined>
}

export function createThreadSecurityReads(deps: ThreadIncidentsRouteDeps): ThreadSecurityReads {
  return {
    async incidents(threadId: string, thresholds: EnsoRiskThresholds): Promise<EnsoThreadIncidents | undefined> {
      const source = await liveOrStored(
        deps.threads,
        threadId,
        (view) => view.hosted.branchIncidentHistory(thresholds),
        () => deps.host.readStoredIncidentHistory(threadId, thresholds),
      )
      if (source === undefined) return undefined
      return { threadId, live: source.live, thresholds, incidents: source.incidents, replay: source.replay }
    },
    // Under the server's thresholds always: the cases are the live guard's selection, as it ran.
    async judgeCases(threadId: string): Promise<EnsoThreadJudgeCases | undefined> {
      const source = await liveOrStored(
        deps.threads,
        threadId,
        (view) => view.hosted.branchJudgeCases(deps.riskThresholds),
        () => deps.host.readStoredJudgeCases(threadId, deps.riskThresholds),
      )
      return source === undefined ? undefined : { threadId, live: source.live, cases: source.cases }
    },
  }
}
