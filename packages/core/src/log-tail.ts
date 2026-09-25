import { type Static, Type } from 'typebox'
import { EnsoLogLine } from './log.ts'

/**
 * The reader's question, and the tail's answer (#144 slice 2).
 *
 * `bun run logs` had the only implementation of "which records did you ask for": its flags,
 * its level floor, its thread prefix. `GET /api/logs/tail` asks the same question from a
 * query string and the debug page asks it from a form, so the semantics live here — one
 * home per fact — and the CLI now spells its flags into this filter rather than owning a
 * second copy of the comparison.
 *
 * ⚠ NOTHING `node:` HERE, deliberately: the browser imports this module for the frame it
 * validates and for the level names its controls offer, so the filter cannot reach for
 * `fs`. The reader that actually opens a file is `log-process.ts`, which is a subpath.
 *
 * The frame is one shape with a `type`, not a union, because both kinds carry exactly the
 * same fields and differ only in what the client does with `lines`: a `backlog` frame IS
 * the view (replace), a `records` frame is what has landed since (append). The server
 * decides which by one rule — a read that began at byte 0 is the file's whole view.
 */

/**
 * The tiers, lowest first: the vocabulary a `--level` flag, a `?level=` and a control share.
 *
 * @group Logging
 */
export const ENSO_LOG_LEVEL_NAMES = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const

/** @group Logging */
export type EnsoLogLevelName = (typeof ENSO_LOG_LEVEL_NAMES)[number]

/**
 * A tier by NAME → its rank. `warn` is here as well as `warning` because that is the
 * spelling on disk (LogTape writes `WARN`), and a person who types it means the tier.
 *
 * ⚠ NO PROTOTYPE, deliberately (PR #336 review). This table is indexed by a string a URL
 * supplied — `?level=` — and a plain object literal answers `constructor` with `Object` and
 * `__proto__` with `Object.prototype`. Neither is nullish, so a `??` refusal never fired, the
 * rank became a non-number, every comparison against it was `false`, and the whole `trace` day
 * streamed to whoever asked for `level=constructor`. With no prototype, a name that is not a
 * tier is `undefined` and nothing else, here and at the CLI's `--level`.
 *
 * @group Logging
 */
export const ENSO_LOG_LEVEL_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    trace: 0,
    debug: 1,
    info: 2,
    warning: 3,
    warn: 3,
    error: 4,
    fatal: 5,
  }),
)

/** The same ranks against the upper-cased level a line carries — no round trip through a record. */
const RANK_OF_LINE: Readonly<Record<EnsoLogLine['level'], number>> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
}

const SINCE = /^(\d+)(s|m|h|d)$/
/** `--since`/`?since=` units: the suffix at index N is worth `UNIT_MS[N]` milliseconds. */
const UNIT_SUFFIXES = ['s', 'm', 'h', 'd'] as const
const UNIT_MS = [1000, 60_000, 3_600_000, 86_400_000] as const

/**
 * `30s`, `10m`, `2h`, `1d` → milliseconds; `undefined` when the text is not a duration.
 *
 * The caller turns it into the `notBefore` instant, because the CLI resolves it once at
 * startup and a long-lived tail resolves it once per connection — the same grammar, two
 * lifetimes.
 *
 * @group Logging
 */
export function parseLogSince(raw: string): number | undefined {
  const match = SINCE.exec(raw)
  if (match === null) return undefined
  return Number(match[1]) * (UNIT_MS[UNIT_SUFFIXES.indexOf(match[2] as (typeof UNIT_SUFFIXES)[number])] ?? 0)
}

/**
 * A reader's question, resolved: a tier FLOOR, a thread PREFIX, an EXACT process, and an
 * instant before which nothing is wanted (`0` = the whole file).
 *
 * @group Logging
 */
export interface EnsoLogFilter {
  /** From `ENSO_LOG_LEVEL_RANK`: a line ranked below this is not wanted. */
  readonly levelRank: number
  /** A thread id or a prefix of one; `undefined` is every thread, including records with none. */
  readonly thread: string | undefined
  /** `server`, `web`, `pi` — exact, because the writer's name is a closed set, not a search. */
  readonly process: string | undefined
  /** Epoch ms; a line stamped earlier is not wanted. */
  readonly notBefore: number
}

/**
 * Does this line answer the question? The one comparison `bun run logs` and the tail route
 * both run.
 *
 * ⚠ A line whose `@timestamp` does not parse is KEPT: `NaN < notBefore` is false, which is
 * the behaviour the CLI has always had, and dropping a record because its clock is unreadable
 * would hide exactly the record worth seeing.
 *
 * @group Logging
 */
export function logLineMatches(filter: EnsoLogFilter, line: EnsoLogLine): boolean {
  if (RANK_OF_LINE[line.level] < filter.levelRank) return false
  if (Date.parse(line['@timestamp']) < filter.notBefore) return false
  const properties = line.properties ?? {}
  const threadId = typeof properties.threadId === 'string' ? properties.threadId : ''
  if (filter.thread !== undefined && !threadId.startsWith(filter.thread)) return false
  if (filter.process !== undefined && properties.process !== filter.process) return false
  return true
}

/**
 * The most records one tail step hands back — the newest.
 *
 * A `trace` day is tens of thousands of lines and a browser tab does not want them; the cap
 * is the bundle's honesty in a different place, with `matched` beside it so "the last 2000
 * of 31417" never reads as the whole day. Lower than `BUNDLE_MAX_RECORDS` (5000) because a
 * bundle is read once in an editor and this is re-rendered on every frame. Here, node-free,
 * because the BROWSER keeps the same bound (PR #336 review): the server caps each frame, and
 * a page that appended every `records` frame forever grew without limit on a `trace` day.
 *
 * @group Logging
 */
export const LOG_TAIL_MAX_RECORDS = 2000

const PLACEHOLDER = /\{([^{}]+)\}/g

/**
 * The message a line holds, as LogTape's alternating text/value shape: the TEMPLATE on disk
 * with each `{name}` replaced by the property of that name.
 *
 * `"run {generation} acquired"` + `{ generation: 1 }` → `["run ", 1, " acquired"]`.
 *
 * A placeholder with no property renders as itself, so a template that outgrew its record
 * still reads. `log-process.ts`'s `logRecordOf` wraps this into a record for a LogTape
 * formatter; the browser, which has no formatter, joins it with `logLineText`.
 *
 * @group Logging
 */
export function logLineMessageParts(line: EnsoLogLine): unknown[] {
  const properties = line.properties ?? {}
  const template = line.message ?? ''
  const parts: unknown[] = []
  let cursor = 0
  for (const match of template.matchAll(PLACEHOLDER)) {
    const placeholder = match[1] ?? ''
    parts.push(template.slice(cursor, match.index), placeholder in properties ? properties[placeholder] : match[0])
    cursor = match.index + match[0].length
  }
  parts.push(template.slice(cursor))
  return parts
}

/**
 * The message as one string — the template with its values in place, for a surface with no
 * LogTape formatter (the browser).
 *
 * A non-string value is JSON, not `[object Object]`: a record whose value is a shape is
 * usually the record worth reading.
 *
 * @group Logging
 */
export function logLineText(line: EnsoLogLine): string {
  return logLineMessageParts(line)
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join('')
}

/**
 * One frame of `GET /api/logs/tail`.
 *
 * `backlog` — the file as it stands, oldest first: the client REPLACES its view. Sent as the
 * first frame, and again after the local-midnight rotation puts a new file under the tail.
 * `records` — what has landed since `offset`: the client APPENDS.
 *
 * `matched` is how many lines answered the filter before the cap, so `matched > lines.length`
 * reads as the bundle's "the last N of M" rather than as a complete day. `malformed` counts
 * the lines that were not records at all — the file is the honest place, and a count is
 * enough to send a reader to it.
 *
 * `offset` is the byte after the last COMPLETE record this tail has read — never the byte
 * after the last read, which may sit mid-record in a carry only this tail holds. A client
 * that reconnects passes it as `?from=` with the frame's `day` beside it, and is not re-sent
 * the day; a `from` handed to another day's file is dropped by the route.
 *
 * @group Logging
 */
export const EnsoLogTailFrame = Type.Object(
  {
    type: Type.Union([Type.Literal('backlog'), Type.Literal('records')]),
    /** `2026-09-22` — the local day the file is named for, so a rotation is visible. */
    day: Type.String(),
    offset: Type.Integer({ minimum: 0 }),
    lines: Type.Array(EnsoLogLine),
    matched: Type.Integer({ minimum: 0 }),
    malformed: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
/** @group Logging */
export type EnsoLogTailFrame = Static<typeof EnsoLogTailFrame>
