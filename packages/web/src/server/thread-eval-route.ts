import { type EnsoSessionEval, sessionEvalOf } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import { liveOrStored } from './live-or-stored.ts'
import { localDayOf, logDaysOnDisk, threadLines } from './thread-log-days.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/eval` (#441): one thread's session eval — the mechanical timeline
 * and scorecard `session-eval.ts` computes. The branch half comes from pi (`branch-eval.ts`), the
 * log half from the day files the branch spans: a queued prompt and an interrupt are facts only
 * the server recorded.
 *
 * ⚠ LIVE-OR-COLD (`live-or-stored.ts`): pi's memory for a live thread, the file otherwise — so the
 * scorecard reads the same from the route, the CLI (which calls the route) and a stored file.
 *
 * ⚠ THE LOG IS READ WHOLE, EVERY TIME. The stats route keeps a past day's fold because the drawer
 * re-reads on every usage change; the eval is asked for on demand, and its log half is a filter,
 * not a fold. A thread whose days the prune has deleted reports its log-side counts unknown
 * (`logDays` says which days were read).
 *
 * ⚠ WRITES NO RECORD — a read of the trace must not appear in it.
 */

export interface ThreadEvalRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'readStoredThreadEval'>
  readonly logsDir: string
  /** ⓘ Injectable so a test names its day. */
  readonly now?: () => Date
  /** A canary token to look for in the transcript; unchecked when absent. */
  readonly canary?: string
}

export function createThreadEvalRoute(
  deps: ThreadEvalRouteDeps,
): (threadId: string) => Promise<EnsoSessionEval | undefined> {
  const now = deps.now ?? ((): Date => new Date())
  return async (threadId: string): Promise<EnsoSessionEval | undefined> => {
    const source = await liveOrStored(
      deps.threads,
      threadId,
      (view) => view.hosted.branchEval(),
      () => deps.host.readStoredThreadEval(threadId),
    )
    if (source === undefined) return undefined
    const firstAt = source.transcript.find((entry) => entry.at !== undefined)?.at
    const firstDay = localDayOf(firstAt === undefined ? now() : new Date(firstAt))
    const logDays = logDaysOnDisk(deps.logsDir).filter((day) => day >= firstDay)
    const log = logDays.flatMap((day) => threadLines(deps.logsDir, day, threadId))
    const evaluated = sessionEvalOf({
      transcript: source.transcript,
      turnStats: source.turnStats,
      log,
      logDays,
      ...(deps.canary === undefined ? {} : { canary: deps.canary }),
    })
    return { threadId, live: source.live, ...evaluated }
  }
}
