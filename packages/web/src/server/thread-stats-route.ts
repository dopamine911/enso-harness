import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnsoLogLine,
  type EnsoSessionUsage,
  type EnsoThreadStats,
  foldDay,
  mergeDurationSummaries,
} from '@enso/core'
import { ensoLogDay, ensoLogFilename } from '@enso/core/log-process'
import type { AgentHost } from '../host/agent-host.ts'
import type { BranchStats } from '../host/branch-stats.ts'
import { readLogFile } from './logs-stats-route.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/stats` (#45 phase 2): one thread, analysed — the chat's stats
 * drawer reads it. The session half comes from pi (`branch-stats.ts`, `session-usage.ts`), the
 * log half from the day files this thread's branch spans (`EnsoThreadStats` says which holds what).
 *
 * ⚠ LIVE-OR-COLD, READ THE WAY `thread-read.ts` READS: peek, read the file if not live, re-peek —
 * a thread built during the read is answered from pi's memory, which is fresher than the file.
 * Neither live nor stored is `undefined`, the route's 404. Looking builds nothing (#86).
 *
 * ⚠ EACH DAY IS FOLDED ON ITS OWN, then merged. `dayStats` joins a run by `threadId#generation`,
 * and the generation restarts with the server: two days concatenated could join Monday's run 3
 * to Tuesday's. A tool call that straddles midnight loses its duration — a stated loss, not a
 * wrong one.
 *
 * ⚠ WRITES NO RECORD — the log-stats route's rule: a read of the trace must not appear in it.
 *
 * ⚠ THE COST, STATED (PR #358 review). With the drawer open this runs once per `session-usage` —
 * each turn, run, compaction, model change or cache warm — and each run reads every day file
 * since the branch began (up to the 14 the prune leaves), synchronously, as the day's stats route
 * does; each day is folded once. At `info` a day file is a few hundred kilobytes and this is not
 * felt; at `trace` on a long thread it would be. The fix is not written yet, and is a design, not
 * a line: a day before today no longer changes once the rotation moves on, so it could be read
 * once per thread — but that cache must forget a day the prune deletes, and must be bounded, or
 * it grows with every thread this server has served.
 */

export interface ThreadStatsRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'readStoredThreadStats'>
  /** Where the day files are — the same directory the bundle, the tail and the day's stats read. */
  readonly logsDir: string
  /** ⓘ Injectable so a test names its day. */
  readonly now?: () => Date
}

interface ThreadSource {
  readonly live: boolean
  readonly usage: EnsoSessionUsage
  readonly branch: BranchStats
}

/** The day files present, oldest first — whatever the 14-day prune left. A missing directory has none. */
function logDaysOnDisk(logsDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(logsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.flatMap((filename) => ensoLogDay(filename) ?? []).sort()
}

/** The local day a moment falls on, as the day files name it. */
function localDayOf(moment: Date): string {
  return ensoLogDay(ensoLogFilename(moment)) ?? ''
}

/** This thread's records in one day file. The raw id test first, so most lines are never parsed. */
function threadLines(logsDir: string, day: string, threadId: string): EnsoLogLine[] {
  const { lines } = readLogFile(join(logsDir, `enso-${day}.jsonl`), (raw) => raw.includes(threadId))
  return lines.filter((line) => line.properties?.threadId === threadId)
}

export function createThreadStatsRoute(
  deps: ThreadStatsRouteDeps,
): (threadId: string) => Promise<EnsoThreadStats | undefined> {
  const now = deps.now ?? ((): Date => new Date())

  async function sourceOf(threadId: string): Promise<ThreadSource | undefined> {
    const stored =
      deps.threads.peek(threadId) === undefined ? await deps.host.readStoredThreadStats(threadId) : undefined
    const nowLive = deps.threads.peek(threadId)
    if (nowLive !== undefined) {
      return { live: true, usage: nowLive.hosted.runtime.sessionUsage(), branch: nowLive.hosted.branchStats() }
    }
    return stored === undefined ? undefined : { live: false, ...stored }
  }

  return async (threadId: string): Promise<EnsoThreadStats | undefined> => {
    const source = await sourceOf(threadId)
    if (source === undefined) return undefined
    const { branch } = source
    // From the branch's first entry's day; a branch with none has only today to look in.
    const firstDay = localDayOf(branch.firstAt === undefined ? now() : new Date(branch.firstAt))
    const days = logDaysOnDisk(deps.logsDir).filter((day) => day >= firstDay)
    // ONE fold per day, for both halves (PR #358 review).
    const folded = days.map((day) => foldDay(day, threadLines(deps.logsDir, day, threadId), 0))
    // A toolCallId is unique across the thread, so the days' per-call maps merge without a clash.
    const durationOf = new Map(folded.flatMap((fold) => [...fold.callDurations]))
    return {
      threadId,
      live: source.live,
      usage: source.usage,
      branchCost: branch.branchCost,
      turnStats: branch.turnStats,
      promptStats: branch.promptStats,
      callStats: branch.callStats.map((call) => {
        const durationMs = durationOf.get(call.toolCallId)
        return durationMs === undefined ? call : { ...call, durationMs }
      }),
      latency: {
        prompts: mergeDurationSummaries(folded.map((fold) => fold.stats.totals.prompts)),
        firstDelta: mergeDurationSummaries(folded.map((fold) => fold.stats.totals.firstDelta)),
      },
      logDays: days,
    }
  }
}
