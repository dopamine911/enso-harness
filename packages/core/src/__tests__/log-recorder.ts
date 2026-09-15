import { AsyncLocalStorage } from 'node:async_hooks'
import { configure, type LogRecord, reset } from '@logtape/logtape'
import { createLogRecorder, type LogRecorder } from '@logtape/testing/recorder'
import { ZEN_LOG_ROOT } from '../log.ts'

/**
 * The tests' sink (#132), one for every package (#178): every `zen` record, at every level,
 * into memory — a guard's verdict, an audit line or a route's problem is asserted as the
 * record it is, the way a bundle reader would read it, not as a line on stderr. Replaces
 * the `problems: unknown[]` arrays the `onProblem` seams fed: a module logs through
 * `zenLogger` at module level, so there is nothing to inject, and this is how a test hears it.
 *
 * `reset: true` because every test file runs in one bun process: the second file's
 * `configure` replaces the first's, whose recorder is finished with by then. The meta logger
 * is routed nowhere so LogTape's own notes never leak into a test's output.
 *
 * Lives under `__tests__` on purpose: the logging gate's inventory of files that name LogTape
 * is three production files, and this is not one of them.
 */
export async function recordZenLogs(): Promise<LogRecorder> {
  const recorder = createLogRecorder()
  await configure({
    reset: true,
    sinks: { recorder: recorder.sink },
    loggers: [
      { category: [ZEN_LOG_ROOT], lowestLevel: 'trace', sinks: ['recorder'] },
      { category: ['logtape', 'meta'], sinks: [] },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  })
  return recorder
}

/** Back to "no configuration, no logs" for whatever runs next in the process. */
export const releaseZenLogs: () => Promise<void> = reset

/** The audit records an extension wrote — `audit: …` under `zen.extension.<name>`. */
export function auditRecords(recorder: LogRecorder, extension: string): readonly LogRecord[] {
  return recorder.filter({ category: [ZEN_LOG_ROOT, 'extension', extension], rawMessage: /^audit:/ })
}
