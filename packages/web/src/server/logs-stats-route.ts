import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnsoDayFold, EnsoDayStats, EnsoLogLine } from '@enso/core'
import { ensoLogFilename, parseEnsoLogText } from '@enso/core/log-process'
import { followDayFile } from './day-file-fold.ts'

/**
 * `GET /api/logs/stats` (#144 slice 4): the day, derived — `dayStats`'s fold of today's file, as
 * JSON, for the debug page's stats view.
 *
 * ⚠ THE WHOLE DAY, never the tail's capped view. The tail hands a page the last 2000 records
 * and says so; a cost or a denial count folded over "the last 2000" would be a number that
 * silently means "some of". So this route folds every record of the file the way the bundle
 * reads it, and the fold is `@enso/core`'s, so `bun run logs` can fold a bundle someone attached
 * and reach the same figures.
 *
 * ⚠ FOLDED FROM THE LAST OFFSET (#739): today's fold is kept, and a request folds only the lines
 * appended since the last (`day-file-fold.ts`). Re-reading the whole day each time was 1.3 s and
 * +443 MB on a 52 MB day. One day is kept: the clock's, replaced when the day turns.
 *
 * ⚠ WRITES NO RECORD, by the rule the surface rests on (#144, #97): a read of the trace must
 * not appear in the trace; a record per request would be the reader's own presence, on every
 * refresh.
 */

export interface LogStatsRouteDeps {
  /** Where this process's log file is — the same directory the bundle and the tail read. */
  readonly logsDir: string
  /** The clock the day's filename comes from. ⓘ Injectable so a test names its day. */
  readonly now?: () => Date
}

/**
 * The day's text, or nothing when no process has written it. ONE call, never `exists` then
 * `read`: a file pruned between the two made the read throw, and
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
  return parseEnsoLogText(readDayOrNothing(file), keep)
}

export function createLogStatsRoute(deps: LogStatsRouteDeps): () => EnsoDayStats {
  const now = deps.now ?? ((): Date => new Date())
  let followed: { readonly filename: string; readonly fold: () => EnsoDayFold } | undefined
  return (): EnsoDayStats => {
    const filename = ensoLogFilename(now())
    if (followed?.filename !== filename) {
      const day = filename.slice('enso-'.length, -'.jsonl'.length)
      followed = { filename, fold: followDayFile(join(deps.logsDir, filename), day) }
    }
    return followed.fold().stats()
  }
}
