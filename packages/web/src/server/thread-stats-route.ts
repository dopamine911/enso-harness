import { join } from 'node:path'
import { type EnsoDayFold, type EnsoThreadStats, mergeDurationSummaries } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import { followDayFile } from './day-file-fold.ts'
import { liveOrStored } from './live-or-stored.ts'
import { localDayOf, logDaysOnDisk } from './thread-log-days.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/stats` (#45 phase 2): one thread, analysed — the chat's stats
 * drawer reads it. The session half comes from pi (`branch-stats.ts`, `session-usage.ts`), the
 * log half from the day files this thread's branch spans (`EnsoThreadStats` says which holds what).
 *
 * ⚠ LIVE-OR-COLD (`live-or-stored.ts`): pi's memory for a live thread, the file otherwise.
 *
 * ⚠ EACH DAY IS FOLDED ON ITS OWN, then merged. `dayStats` joins a run by `threadId#generation`,
 * and the generation restarts with the server: two days concatenated could join Monday's run 3
 * to Tuesday's. A tool call that straddles midnight loses its duration — a stated loss, not a
 * wrong one.
 *
 * ⚠ WRITES NO RECORD — the log-stats route's rule: a read of the trace must not appear in it.
 *
 * ⚠ EACH THREAD-DAY IS FOLDED ONCE, THEN EXTENDED (#359, #739). With the drawer open this runs once
 * per `session-usage` — each turn, run, compaction, model change or cache warm — and it used to
 * read every day file since the branch began, synchronously, each time (PR #358 review); then it
 * kept past days and re-read today whole, 1.3 s and +443 MB on a 52 MB day. Now each day's fold is
 * kept with the offset it reached, and a request folds only what was appended since
 * (`day-file-fold.ts`): a past day costs an `fstat`, today its new lines. The keep is bounded two
 * ways: a day the prune deleted is forgotten on the next read (it is no longer on disk, so it is no
 * longer asked for), and at most `DAYS_HELD` thread-days are held, the least recently read going
 * first — without both it would grow with every thread this server ever served.
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

/**
 * Thread-days kept (see the header). A day's fold is one thread's runs and calls that day — small;
 * the bound is against a server that lives for months.
 */
const DAYS_HELD = 256

interface FollowedDays {
  /** Forget every kept day that is no longer on disk — the prune's deletions. */
  readonly keepOnly: (daysOnDisk: readonly string[]) => void
  /** The thread's fold of each day, extended to the day file's end. */
  readonly foldsOf: (days: readonly string[], threadId: string) => EnsoDayFold[]
}

/** The kept folds of each thread-day, least recently read first. */
function createFollowedDays(logsDir: string): FollowedDays {
  const held = new Map<string, { readonly day: string; readonly fold: () => EnsoDayFold }>()
  return {
    keepOnly: (daysOnDisk: readonly string[]): void => {
      const onDisk = new Set(daysOnDisk)
      for (const [key, kept] of held) if (!onDisk.has(kept.day)) held.delete(key)
    },
    foldsOf: (days: readonly string[], threadId: string): EnsoDayFold[] =>
      days.map((day) => {
        const key = `${day} ${threadId}`
        const fold = held.get(key)?.fold ?? followDayFile(join(logsDir, `enso-${day}.jsonl`), day, threadId)
        // Re-inserted, so it is the most recently read; the oldest goes past the bound.
        held.delete(key)
        held.set(key, { day, fold })
        const oldest = held.keys().next()
        if (held.size > DAYS_HELD && oldest.done !== true) held.delete(oldest.value)
        return fold()
      }),
  }
}

export function createThreadStatsRoute(
  deps: ThreadStatsRouteDeps,
): (threadId: string) => Promise<EnsoThreadStats | undefined> {
  const now = deps.now ?? ((): Date => new Date())
  const followedDays = createFollowedDays(deps.logsDir)

  return async (threadId: string): Promise<EnsoThreadStats | undefined> => {
    const source = await liveOrStored(
      deps.threads,
      threadId,
      (view) => ({ usage: view.hosted.runtime.sessionUsage(), branch: view.hosted.branchStats() }),
      () => deps.host.readStoredThreadStats(threadId),
    )
    if (source === undefined) return undefined
    const { branch } = source
    // From the branch's first entry's day; a branch with none has only today to look in.
    const firstDay = localDayOf(branch.firstAt === undefined ? now() : new Date(branch.firstAt))
    const daysOnDisk = logDaysOnDisk(deps.logsDir)
    followedDays.keepOnly(daysOnDisk)
    const days = daysOnDisk.filter((day) => day >= firstDay)
    // ONE fold per day, for both halves (PR #358 review), each kept and extended (the header).
    const folded = followedDays.foldsOf(days, threadId).map((fold) => ({
      totals: fold.stats().totals,
      callDurations: fold.callDurations,
    }))
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
        prompts: mergeDurationSummaries(folded.map((fold) => fold.totals.prompts)),
        firstDelta: mergeDurationSummaries(folded.map((fold) => fold.totals.firstDelta)),
      },
      logDays: days,
    }
  }
}
