import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayStats, type EnsoDayStats, type EnsoLogLine } from '@enso/core'
import { ensoLogFilename, parseEnsoLogLine } from '@enso/core/log-process'

/**
 * `GET /api/logs/stats` (#144 slice 4): the day, derived — `dayStats` over today's file, as
 * JSON, for the debug page's stats view.
 *
 * ⚠ THE WHOLE DAY, never the tail's capped view. The tail hands a page the last 2000 records
 * and says so; a cost or a denial count folded over "the last 2000" would be a number that
 * silently means "some of". So this route reads the file the way the bundle does — all of
 * it, once per request — and the fold is `@enso/core`'s, so `bun run logs` can fold a bundle
 * someone attached and reach the same figures.
 *
 * ⚠ WRITES NO RECORD, by the rule the surface rests on (#144, #97): a read of the trace must
 * not appear in the trace. Folding the day is a few milliseconds over tens of thousands of
 * lines; a record per request would be the reader's own presence, on every refresh.
 */

export interface LogStatsRouteDeps {
  /** Where this process's log file is — the same directory the bundle and the tail read. */
  readonly logsDir: string
  /** The clock the day's filename comes from. ⓘ Injectable so a test names its day. */
  readonly now?: () => Date
}

export function createLogStatsRoute(deps: LogStatsRouteDeps): () => EnsoDayStats {
  const now = deps.now ?? ((): Date => new Date())
  return (): EnsoDayStats => {
    const filename = ensoLogFilename(now())
    const day = filename.slice('enso-'.length, -'.jsonl'.length)
    const file = join(deps.logsDir, filename)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const lines: EnsoLogLine[] = []
    let malformed = 0
    for (const raw of text.split('\n')) {
      if (raw.length === 0) continue
      const parsed = parseEnsoLogLine(raw)
      if (typeof parsed === 'string') malformed += 1
      else lines.push(parsed)
    }
    return dayStats(day, lines, malformed)
  }
}
