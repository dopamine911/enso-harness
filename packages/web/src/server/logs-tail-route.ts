import type { ServerResponse } from 'node:http'
import {
  ENSO_LOG_LEVEL_RANK,
  type EnsoLogFilter,
  type EnsoLogTailFrame,
  ensoLogger,
  isEnsoThreadId,
  LOG_TAIL_MAX_RECORDS,
  parseLogSince,
} from '@enso/core'
import { type EnsoLogTailStep, ensoLogFilename, openLogTail } from '@enso/core/log-process'
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

const log = ensoLogger('server', 'logs')

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
/** A resume point: the byte, and the day it was validated against — the tail re-checks it against the file it opens. */
export interface LogTailResumePoint {
  readonly offset: number
  readonly day: string
}

export type LogTailQuery =
  | { readonly filter: EnsoLogFilter; readonly from: LogTailResumePoint | undefined }
  | { readonly reason: string }

/** A refusal, as every reader below spells one. */
interface Refused {
  readonly reason: string
}

/** A parameter's text when it was given, or `undefined` when absent or empty — the two cases the defaults cover. */
function given(query: URLSearchParams, parameter: string): string | undefined {
  const raw = query.get(parameter)
  return raw === null || raw.length === 0 ? undefined : raw
}

function readLevel(query: URLSearchParams): number | Refused {
  const level = given(query, 'level')
  if (level === undefined) return ENSO_LOG_LEVEL_RANK.info ?? 2
  return (
    ENSO_LOG_LEVEL_RANK[level.toLowerCase()] ?? {
      reason: `level must be one of ${Object.keys(ENSO_LOG_LEVEL_RANK).join(', ')}`,
    }
  )
}

/**
 * The same check the bundle route makes, for the same reason: a prefix of a valid id is itself
 * a valid id, and nothing shaped otherwise should reach a filter (#95).
 */
function readThread(query: URLSearchParams): string | undefined | Refused {
  const thread = given(query, 'thread')
  if (thread !== undefined && !isEnsoThreadId(thread))
    return { reason: 'thread must be a thread id or a prefix of one' }
  return thread
}

function readNotBefore(query: URLSearchParams, now: () => Date): number | Refused {
  const since = given(query, 'since')
  if (since === undefined) return 0
  const window = parseLogSince(since)
  if (window === undefined) return { reason: 'since wants a duration like 30s, 10m, 2h, 1d' }
  return now().getTime() - window
}

/**
 * `from` is a byte of ONE file, and `day` says which. A page left open across
 * local midnight that then reconnected handed today's file yesterday's final offset, and
 * unless today's file was still shorter than that, its head was skipped silently as
 * `records`. A `day` that is not the file's day makes `from` mean nothing; a `from` with no
 * `day` is honoured as given, for a caller that knows what it is doing.
 */
function readFrom(query: URLSearchParams, today: string): LogTailResumePoint | undefined | Refused {
  const from = given(query, 'from')
  if (from === undefined) return undefined
  const offset = Number(from)
  if (!Number.isSafeInteger(offset) || offset < 0) return { reason: 'from wants a byte offset' }
  const day = given(query, 'day')
  return day === undefined || day === today ? { offset, day: today } : undefined
}

function isRefused(value: unknown): value is Refused {
  return typeof value === 'object' && value !== null && 'reason' in value
}

/**
 * The query string as the filter the reader runs.
 *
 * Every parameter is optional and every bad one is REFUSED rather than defaulted: a page
 * that asked for `level=infp` and was quietly given `info` would show a filtered log while
 * claiming to show another, which is the one failure a debugging surface must not have. The
 * defaults apply only when the parameter is absent. One reader per parameter, each answering
 * its value or its refusal, so the parse reads as the list of questions it is.
 */
export function parseLogTailQuery(query: URLSearchParams, now: () => Date): LogTailQuery {
  const levelRank = readLevel(query)
  if (isRefused(levelRank)) return levelRank
  const thread = readThread(query)
  if (isRefused(thread)) return thread
  const notBefore = readNotBefore(query, now)
  if (isRefused(notBefore)) return notBefore
  const from = readFrom(query, ensoLogFilename(now()).slice('enso-'.length, -'.jsonl'.length))
  if (isRefused(from)) return from
  return { filter: { levelRank, thread, process: given(query, 'process'), notBefore }, from }
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
    // The day the offset was validated against goes with it: the tail asks `now()` again to
    // pick its file, and a midnight between the two calls would otherwise apply yesterday's
    // byte to today's file.
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
    now,
  })
  response.writeHead(200, SSE_HEADERS)
  const stopKeepalive = startSseKeepalive(response, deps.sseKeepaliveMs)
  // ⚠ The close hook is attached BEFORE the first pump: a step can throw
  // (EACCES on the directory, EISDIR under the name), and a throw from the priming pump
  // escaped past `writeHead(200)` with the keepalive timer and the descriptor leaked for the
  // life of the process — the hook that would have released them was registered two lines later.
  let timer: ReturnType<typeof setInterval> | undefined
  response.once('close', () => {
    clearInterval(timer)
    stopKeepalive()
    tail.close()
  })
  let announcedDay = ''
  const pump = (): void => {
    if (response.destroyed || response.writableEnded) return
    let found: EnsoLogTailStep
    try {
      found = tail.step()
    } catch (error) {
      // A read that failed ends THIS stream, not the server — and SAYS SO ON THE STREAM, as
      // an SSE `error` event the page treats as a refusal and does not retry. A bare `end`
      // reads as a clean close: the page would reconnect every five seconds, and every
      // reconnect would fail the read again and record the failure into the file it could
      // not read, in a loop. With
      // the page told, this record is written once per connection a reader opened; the
      // failure is the file's own business, the reader's presence never is. `end` fires
      // `close`, which releases the rest.
      //
      // ⚠ EVERY read failure is terminal for the connection, the transient ones included
      // (`EMFILE` under descriptor pressure, round three). Telling them apart would mean a
      // bare end for the transient class, and a bare end is what the page retries — which
      // under a *persistent* shortage is the loop above, one record per attempt. The page
      // recovers a transient failure with its next question or a reload; that is the price
      // of never looping into the file, and it is paid knowingly.
      const reason = error instanceof Error ? error.message : String(error)
      log.error('the tail could not read the file: {reason}', { reason, error })
      response.write(`event: error\ndata: ${reason.replaceAll('\n', ' ')}\n\n`)
      response.end()
      return
    }
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
  if (response.writableEnded) return
  timer = setInterval(pump, deps.pollMs ?? LOG_TAIL_POLL_MS)
  timer.unref?.()
}
