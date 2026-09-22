import type { ServerResponse } from 'node:http'
import {
  ENSO_LOG_LEVEL_RANK,
  type EnsoLogFilter,
  type EnsoLogTailFrame,
  isEnsoThreadId,
  parseLogSince,
} from '@enso/core'
import { LOG_TAIL_MAX_RECORDS, openLogTail } from '@enso/core/log-process'
import { SSE_HEADERS, startSseKeepalive } from './sse.ts'

/**
 * `GET /api/logs/tail` (#144 slice 2): the day's file, filtered server-side, as SSE — what
 * the debug page reads instead of a terminal.
 *
 * ⚠ THIS ROUTE WRITES NO RECORD, and that is the rule rather than an omission (#144, #97):
 * a surface that exists to read the trace must not appear in the trace it is reading. A
 * record per connection would arrive in the tail the connection is serving, and a record
 * per frame would put the reader's own activity on top of whatever it was sent to find.
 * `GET /api/about` and `POST /api/logs` already hold that line; this is the third.
 *
 * ⚠ FILTERED AND CAPPED HERE, not in the browser. A `trace` day is tens of thousands of
 * lines; shipping them so a page can hide most is the shape that makes a debugging surface
 * the slowest thing in the system. The filter is `@enso/core`'s — the same comparison
 * `bun run logs` runs — so the page and the terminal cannot disagree about what `--thread`
 * means.
 *
 * ⚠ POLLED, not watched. `fs.watch` is per-platform (and on some it fires before the write
 * is visible), the file is appended to by three processes, and the CLI has polled at 250 ms
 * since #132 without anyone noticing latency. One `statSync` per tick per connection, on a
 * loopback server with a handful of tabs, is not the cost worth a platform matrix.
 */

/** How often an open tail looks for new bytes. The CLI's `--follow` interval, for the same reason. */
const LOG_TAIL_POLL_MS = 250

export interface LogTailRouteDeps {
  /** Where this process's log file is — the same directory the bundle route reads. */
  readonly logsDir: string
  readonly sseKeepaliveMs: number
  /** Defaults to `LOG_TAIL_POLL_MS`. ⓘ Injectable so a test does not wait a quarter second per assertion. */
  readonly pollMs?: number
  /** Defaults to `LOG_TAIL_MAX_RECORDS`. ⓘ Injectable so a test can reach the cap in five records. */
  readonly maxRecords?: number
  /** The clock the day's filename comes from. ⓘ Injectable so a test can cross local midnight. */
  readonly now?: () => Date
}

/** The question a query string asked, or why it is not one. */
export type LogTailQuery =
  | { readonly filter: EnsoLogFilter; readonly from: number | undefined }
  | { readonly reason: string }

/**
 * The query string as the filter the reader runs.
 *
 * Every parameter is optional and every bad one is REFUSED rather than defaulted: a page
 * that asked for `level=infp` and was quietly given `info` would show a filtered log while
 * claiming to show another, which is the one failure a debugging surface must not have. The
 * defaults apply only when the parameter is absent.
 */
export function parseLogTailQuery(query: URLSearchParams, now: () => Date): LogTailQuery {
  const level = query.get('level')
  let levelRank = ENSO_LOG_LEVEL_RANK.info ?? 2
  if (level !== null && level.length > 0) {
    const wanted = ENSO_LOG_LEVEL_RANK[level.toLowerCase()]
    if (wanted === undefined) return { reason: `level must be one of ${Object.keys(ENSO_LOG_LEVEL_RANK).join(', ')}` }
    levelRank = wanted
  }
  const threadParameter = query.get('thread')
  const thread = threadParameter === null || threadParameter.length === 0 ? undefined : threadParameter
  // The same check the bundle route makes, for the same reason: a prefix of a valid id is
  // itself a valid id, and nothing shaped otherwise should reach a filter (#95).
  if (thread !== undefined && !isEnsoThreadId(thread)) {
    return { reason: 'thread must be a thread id or a prefix of one' }
  }
  const processParameter = query.get('process')
  const processName = processParameter === null || processParameter.length === 0 ? undefined : processParameter
  const since = query.get('since')
  let notBefore = 0
  if (since !== null && since.length > 0) {
    const window = parseLogSince(since)
    if (window === undefined) return { reason: 'since wants a duration like 30s, 10m, 2h, 1d' }
    notBefore = now().getTime() - window
  }
  const fromParameter = query.get('from')
  let from: number | undefined
  if (fromParameter !== null && fromParameter.length > 0) {
    const offset = Number(fromParameter)
    if (!Number.isSafeInteger(offset) || offset < 0) return { reason: 'from wants a byte offset' }
    from = offset
  }
  return { filter: { levelRank, thread, process: processName, notBefore }, from }
}

/**
 * Open the tail on one response and keep it open.
 *
 * A step is written only when it carries something — records, malformed lines, or a day the
 * client has not been told about. Otherwise a quiet log would be four empty frames a second,
 * and the keepalive already says the connection is alive.
 */
export function followLogTail(deps: LogTailRouteDeps, url: string, response: ServerResponse): void {
  const now = deps.now ?? ((): Date => new Date())
  const parsed = parseLogTailQuery(new URL(url, 'http://enso').searchParams, now)
  if ('reason' in parsed) {
    response.writeHead(400, { 'Content-Type': 'text/plain' })
    response.end(parsed.reason)
    return
  }
  const tail = openLogTail({
    logsDir: deps.logsDir,
    filter: parsed.filter,
    maxRecords: deps.maxRecords ?? LOG_TAIL_MAX_RECORDS,
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
    now,
  })
  response.writeHead(200, SSE_HEADERS)
  const stopKeepalive = startSseKeepalive(response, deps.sseKeepaliveMs)
  let announcedDay = ''
  const pump = (): void => {
    if (response.destroyed || response.writableEnded) return
    const found = tail.step()
    const worthSending = found.lines.length > 0 || found.malformed > 0 || found.day !== announcedDay
    if (!worthSending) return
    announcedDay = found.day
    const frame: EnsoLogTailFrame = {
      type: found.type,
      day: found.day,
      offset: found.offset,
      lines: [...found.lines],
      matched: found.matched,
      malformed: found.malformed,
    }
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  // The day so far, before the first tick: a page that opens with nothing on it while a
  // quarter second passes reads as a broken stream.
  pump()
  const timer = setInterval(pump, deps.pollMs ?? LOG_TAIL_POLL_MS)
  timer.unref?.()
  response.once('close', () => {
    clearInterval(timer)
    stopKeepalive()
    tail.close()
  })
}
