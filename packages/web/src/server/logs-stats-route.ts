import { readFileSync } from 'node:fs'
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

/**
 * The day's text, or nothing when no process has written it. ONE call, never `exists` then
 * `read` (PR #336 review, round two): a file pruned between the two made the read throw, and
 * the boundary above answered 500 — plus a record — for the condition this route defines as
 * the empty day. Any other failure still throws to that boundary.
 */
function readDayOrNothing(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * A day file's records, and how many lines were not records at all. An absent file is an empty
 * day. `keep` sees each raw line first: a reader after one thread skips the parse for the rest.
 */
export function readLogFile(
  file: string,
  keep: (raw: string) => boolean = () => true,
): { readonly lines: EnsoLogLine[]; readonly malformed: number } {
  const lines: EnsoLogLine[] = []
  let malformed = 0
  for (const raw of readDayOrNothing(file).split('\n')) {
    if (raw.length === 0 || !keep(raw)) continue
    const parsed = parseEnsoLogLine(raw)
    if (typeof parsed === 'string') malformed += 1
    else lines.push(parsed)
  }
  return { lines, malformed }
}

export function createLogStatsRoute(deps: LogStatsRouteDeps): () => EnsoDayStats {
  const now = deps.now ?? ((): Date => new Date())
  return (): EnsoDayStats => {
    const filename = ensoLogFilename(now())
    const day = filename.slice('enso-'.length, -'.jsonl'.length)
    const { lines, malformed } = readLogFile(join(deps.logsDir, filename))
    return dayStats(day, lines, malformed)
  }
}
