import { type EnsoLogLevelName, type EnsoLogTailFrame, EnsoLogTailFrame as EnsoLogTailFrameSchema } from '@enso/core'
import { Compile } from 'typebox/compile'
import { sleep } from '../abortable-sleep.ts'
import type { FetchLike } from '../browser-logging.ts'

/**
 * The browser's connection to `GET /api/logs/tail` (#144 slice 2): the day's file, filtered
 * by the server, arriving as SSE frames.
 *
 * ⚠ IT ONLY READS. A debugging surface is observation — it writes nothing, makes no records,
 * offers no control — so there is one request shape here and it is a GET. Nothing in this
 * module POSTs, and nothing in it can ask the server to do anything; the only thing a reader
 * can change is the question (`logTailUrl`) and whether this page is still listening.
 *
 * THE QUESTION IS THE URL. `logTailUrl` omits every parameter that is at its default, so the
 * address bar of a shared link reads as the question that was asked rather than as a form
 * dump — and the route's own defaults (level `info`, no thread, no process, the whole day)
 * stay the single home of what "unasked" means.
 *
 * RECONNECTING DOES NOT RE-READ THE DAY. Every frame carries the byte the next one continues
 * from, so a stream that ends — the dev proxy's idle timeout, a server restart, a sleeping
 * laptop — is resumed with `?from=<that byte>`, which the route answers with `records` rather
 * than a fresh `backlog`. A reader who was halfway down a trace keeps their place. ⚠ WITHIN A
 * DAY: the byte is a position in one file, so the resume token carries the frame's `day` and
 * the route drops a `from` whose day is not the file's — a page left open
 * across local midnight reconnects to a fresh `backlog` of the new day, never to a silent
 * skip of its head.
 *
 * A REFUSAL IS NOT RETRIED. 400 (a parameter the route would not guess at) and 403 (an
 * untrusted origin) are answers about the QUESTION: asking again changes nothing, and a page
 * that hammers the log route is putting load into the system it was opened to diagnose. Those
 * are reported once and the loop stops; only an ended stream or a 5xx is worth asking again.
 *
 * ⚠ SO IS A READ THE SERVER COULD NOT DO. The route says so on the stream itself — an SSE
 * `event: error` carrying the reason — before it ends. Without
 * that event a failed read looked exactly like a clean end, this loop reconnected every five
 * seconds, and each reconnect made the server fail the read again and RECORD the failure into
 * the very file it could not read: a surface that must not appear in the trace, appearing in
 * it in a loop the loop itself drove. An error event is a refusal: reported once, not retried.
 */

const LOG_TAIL_ROUTE = '/api/logs/tail'

/**
 * The wire validator, compiled once at module load — the `@enso/core` convention
 * (`config.ts:61`, `dialog.ts:96`, `follow-connection.ts:71`).
 *
 * `Compile` rather than `Check` for the same reason the follow connection gives: this runs on
 * EVERY frame, and a `backlog` frame off a `trace` day is an array of thousands of records —
 * the one interpreted walk of that shape would be the most expensive thing the page does.
 */
const logTailFrameValidator = Compile(EnsoLogTailFrameSchema)

/**
 * How long a reconnect waits, by consecutive failure. BOUNDED AT 5 SECONDS: the tail polls
 * the file at 250 ms, so a reader is never more than a few seconds behind a server that came
 * back, and a page left open against a server that is down asks once every five seconds
 * rather than in a loop. A connection that delivered a frame resets the count, so the common
 * case — a stream that simply ended — reconnects at the first step.
 */
const RECONNECT_DELAYS_MS = [250, 1000, 5000] as const

/** How much of an unreadable frame is quoted back — enough to recognise, not a wall of JSON. */
const FRAME_PROBLEM_MAX_CHARACTERS = 200

/**
 * The reader's question as the controls hold it: every field a string, empty meaning "not
 * asked". The route parses these; nothing here decides what a level or a duration means.
 */
export interface LogTailFilter {
  readonly level: EnsoLogLevelName
  /** A thread id or a prefix of one; empty is every thread. */
  readonly thread: string
  /** `server`, `web`, `pi` — exact. Empty is every writer. */
  readonly process: string
  /** `30s`, `10m`, `2h`, `1d`; empty is the whole day. */
  readonly since: string
}

/** The question nobody asked — the route's own defaults, spelled so `logTailUrl` can omit them. */
export const DEFAULT_LOG_TAIL_FILTER: LogTailFilter = { level: 'info', thread: '', process: '', since: '' }

/**
 * Where a tail left off: the byte after the last complete record, and the day whose file that
 * byte is a position in. Both travel to the route, which honours the byte only for that day.
 */
export interface LogTailResume {
  readonly day: string
  readonly offset: number
}

/**
 * The route's address for this question. A parameter at its default is LEFT OUT, so
 * `/api/logs/tail` is the unasked question and `/api/logs/tail?level=trace&thread=abc` is the
 * whole of what a reader changed.
 */
export function logTailUrl(filter: LogTailFilter, resume?: LogTailResume): string {
  const parameters = new URLSearchParams()
  if (filter.level !== DEFAULT_LOG_TAIL_FILTER.level) parameters.set('level', filter.level)
  if (filter.thread !== '') parameters.set('thread', filter.thread)
  if (filter.process !== '') parameters.set('process', filter.process)
  if (filter.since !== '') parameters.set('since', filter.since)
  if (resume !== undefined) {
    parameters.set('from', String(resume.offset))
    parameters.set('day', resume.day)
  }
  const query = parameters.toString()
  return query === '' ? LOG_TAIL_ROUTE : `${LOG_TAIL_ROUTE}?${query}`
}

export interface LogTailStreamOptions {
  readonly filter: LogTailFilter
  /** Where to continue from — a resumed view. Undefined asks for the day's head. */
  readonly from?: LogTailResume | undefined
  /** Test seam: the page's `fetch`. */
  readonly fetch?: FetchLike | undefined
  /** The page's own leaving: aborting it closes the socket and ends the loop. */
  readonly signal: AbortSignal
  /**
   * A connection is delivering: fired before the FIRST message of each attempt, valid or not.
   * The moment a page clears the last alert — and the one moment that satisfies both races:
   * clearing on every frame let a bad frame and a good
   * one in the same chunk batch into one render that showed nothing; clearing when the
   * response merely OPENED blinked the alert on every reconnect of a connection that dropped
   * before its first frame. The first message of an attempt is after the open and before any
   * frame's own verdict.
   */
  readonly onOpen?: (() => void) | undefined
  readonly onFrame: (frame: EnsoLogTailFrame) => void
  /** Anything that could not be delivered, in words a reader can act on. NEVER silent. */
  readonly onError: (problem: string) => void
}

/** How one connection ended, and therefore whether asking again is worth anything. */
type TailOutcome =
  /** The caller left. Nothing to report, nothing to retry. */
  | 'aborted'
  /** The route answered about the question itself (4xx): the reader must change a control. */
  | 'refused'
  /** The stream closed, or never opened for a reason time might fix. Resume from the last byte. */
  | 'ended'

interface TailAttempt {
  readonly outcome: TailOutcome
  /** Where the next connection continues from, when a frame said so. */
  readonly resume: LogTailResume | undefined
  /** Whether any frame arrived: a connection that worked resets the backoff. */
  readonly delivered: boolean
}

const pageFetch: FetchLike = (input: string, init?: RequestInit) => fetch(input, init)

/**
 * Read the tail until it ends, reconnecting from the last byte received.
 *
 * Resolves when the caller aborts, or when the route refused the question — the two states in
 * which there is nothing left for this page to read.
 */
export async function openLogTailStream(options: LogTailStreamOptions): Promise<void> {
  let resume = options.from
  let failures = 0
  while (!options.signal.aborted) {
    const attempt = await readOneTail(options, logTailUrl(options.filter, resume))
    if (attempt.outcome !== 'ended') return
    if (attempt.resume !== undefined) resume = attempt.resume
    failures = attempt.delivered ? 0 : failures + 1
    const step = Math.min(failures, RECONNECT_DELAYS_MS.length - 1)
    await sleep(
      RECONNECT_DELAYS_MS[step] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] ?? 5000,
      options.signal,
    )
  }
}

/** What one connection has delivered so far; kept when the read throws mid-stream. */
interface TailProgress {
  resume: LogTailResume | undefined
  delivered: boolean
}

/** One connection: open it, deliver every frame it carries, and say how it ended. */
async function readOneTail(options: LogTailStreamOptions, url: string): Promise<TailAttempt> {
  const request = options.fetch ?? pageFetch
  const progress: TailProgress = { resume: undefined, delivered: false }
  try {
    const response = await request(url, { signal: options.signal, headers: { accept: 'text/event-stream' } })
    if (!response.ok) {
      // The status is the fact; the route's body is the reason it wrote in plain text — a
      // named parameter for a 400, an origin for a 403 — and a reader needs the words.
      const reason = await response.text().catch(() => '')
      options.onError(`the log tail refused: ${response.status} ${reason}`.trimEnd())
      return { outcome: response.status >= 500 ? 'ended' : 'refused', ...progress }
    }
    if (response.body === null) {
      options.onError('the log tail answered with no body')
      return { outcome: 'ended', ...progress }
    }
    if ((await deliverTailFrames(options, response.body, progress)) === 'refused') {
      return { outcome: 'refused', ...progress }
    }
  } catch (error) {
    // The caller's own abort rejects the read; that is this page leaving, not a failure.
    if (options.signal.aborted) return { outcome: 'aborted', ...progress }
    options.onError(`the log tail stopped: ${String(error)}`)
  }
  return { outcome: options.signal.aborted ? 'aborted' : 'ended', ...progress }
}

/**
 * Deliver every frame of one open body, recording each into `progress`. `refused` when the
 * server said it stopped; `undefined` when the body ran out.
 */
async function deliverTailFrames(
  options: LogTailStreamOptions,
  body: ReadableStream<Uint8Array>,
  progress: TailProgress,
): Promise<'refused' | undefined> {
  let opened = false
  for await (const { event, data: payload } of readSseData(body, options.signal)) {
    if (!opened) {
      opened = true
      options.onOpen?.()
    }
    if (event === 'error') {
      // The server could not read the file and said so. Not a stream that ended: asking
      // again makes it fail — and record the failure — again.
      options.onError(`the log tail stopped: ${payload}`)
      return 'refused'
    }
    const frame = parseFrame(payload, options.onError)
    if (frame === undefined) continue
    progress.resume = { day: frame.day, offset: frame.offset }
    progress.delivered = true
    options.onFrame(frame)
  }
  return undefined
}

/** One SSE message: its `data:` payload and the `event:` name that preceded it, if any. */
interface SseMessage {
  readonly event: string | undefined
  readonly data: string
}

/**
 * The messages of an SSE body, one at a time: each `data:` line with the `event:` line that
 * named it, or no name for a plain frame.
 *
 * A `: keepalive` comment is neither, so it is skipped by the same test that finds the
 * frames. The unterminated tail of each chunk is carried forward, which is what makes a frame
 * split across two network chunks one frame rather than two halves of unreadable JSON.
 *
 * The grammar followed is the spec's block rule, not this route's emission: an `event:` name applies until the blank line that ends its block, the space
 * after a field's colon is optional, and a trailing `\r` is not part of a line. The route
 * writes one `data:` per block with `\n` line ends, so none of that is reachable today — but
 * an intermediary on this path has rewritten bytes before (#98/#99), and a name that leaked
 * past a blank line onto the next frame would have made that frame read as a failure.
 */
async function* readSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let event: string | undefined
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') event = undefined
        else if (line.startsWith('event:')) event = fieldValue(line, 'event:')
        else if (line.startsWith('data:')) yield { event, data: fieldValue(line, 'data:') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** A field's value: what follows the colon, less the one optional space the grammar allows. */
function fieldValue(line: string, field: string): string {
  const value = line.slice(field.length)
  return value.startsWith(' ') ? value.slice(1) : value
}

/**
 * One payload as a frame, or undefined with the reason reported.
 *
 * A frame this page cannot read is REPORTED, never dropped: the page exists to show what the
 * system wrote, and silently discarding a line of it would be the one failure that makes the
 * surface worse than the file.
 */
function parseFrame(payload: string, onError: (problem: string) => void): EnsoLogTailFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    onError(`a log tail frame is not JSON: ${String(error)}`)
    return undefined
  }
  if (!logTailFrameValidator.Check(parsed)) {
    onError(`a log tail frame fails EnsoLogTailFrame: ${payload.slice(0, FRAME_PROBLEM_MAX_CHARACTERS)}`)
    return undefined
  }
  return parsed
}
