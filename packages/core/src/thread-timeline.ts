import type { EnsoLogLine } from './log.ts'
import type { EnsoThreadEvent, EnsoThreadEvents } from './thread-inspection.ts'

/**
 * One thread, one ordering (#144 slice 3).
 *
 * "Why is this thread in this state?" was answered in three places — the `?debug` drawer's
 * two event tails, `bun run logs --thread`, and `enso-thread events` — each in its own order,
 * so the reader did the join by eye across three windows. This is that join, once: what the
 * host emitted, what the server sent, and what was logged (the browser's records included —
 * they arrive at `POST /api/logs` and are re-emitted into the same file as process `browser`),
 * ordered by time.
 *
 * ⚠ ORDER IS BY EACH RECORD'S OWN STAMP, and ties keep their arrival order: the three inputs are
 * concatenated as emitted → sent → log and stably sorted, so two things inside one
 * millisecond read in the order their producers ran. A stamp that does not parse sorts FIRST
 * rather than being dropped — the record whose clock is unreadable is the one worth seeing,
 * the rule `logLineMatches` already keeps.
 *
 * ⚠ THE JOIN KEYS ARE UNEVEN, and this file does not pretend otherwise. A log record carries
 * `threadId`, `generation`, `seq` and `toolCallId` (#132); an event of either tail carries the
 * thread and its own `sequence`, and nothing else to join on. So a row of the timeline can be
 * placed in time beside its neighbours, but only a log row can be traced to a generation. The
 * fix, when it is wanted, is on the tails (one home per fact) — not a guess here.
 *
 * Node-free, deliberately: the debug page does this join in the browser over two reads it
 * already makes, so the server owes it no fourth route and the timeline cannot become the
 * place a side channel accretes.
 */

/**
 * One row of a thread's timeline: an event of one of the two tails, or a log record.
 *
 * @group Thread inspection
 */
export type EnsoTimelineEntry =
  | {
      /** `emitted` — the host's tail, with how each was delivered; `sent` — what the server wrote to a browser. */
      readonly source: 'emitted' | 'sent'
      /** Epoch ms; `0` when the stamp did not parse, so it sorts first and stays visible. */
      readonly at: number
      readonly event: EnsoThreadEvent
    }
  | {
      readonly source: 'log'
      readonly at: number
      readonly line: EnsoLogLine
    }

function instantOf(stamp: string): number {
  const parsed = Date.parse(stamp)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * The join: both tails (when a live session had them) and the thread's records, as one list
 * ordered by time.
 *
 * `events` is `undefined` for a thread with no live session — a stored thread, a server that
 * restarted — and the timeline is then the log alone, which is what remains of such a thread.
 *
 * @group Thread inspection
 */
export function threadTimeline(
  events: EnsoThreadEvents | undefined,
  lines: readonly EnsoLogLine[],
): readonly EnsoTimelineEntry[] {
  const entries: EnsoTimelineEntry[] = []
  for (const event of events?.emitted ?? []) entries.push({ source: 'emitted', at: instantOf(event.at), event })
  for (const event of events?.sent ?? []) entries.push({ source: 'sent', at: instantOf(event.at), event })
  for (const line of lines) entries.push({ source: 'log', at: instantOf(line['@timestamp']), line })
  // `Array.prototype.sort` is stable (ES2019), so a tie keeps the concatenation order above.
  return entries.toSorted((left, right) => left.at - right.at)
}

/**
 * The properties a log row joins on, when it has them — shown beside the row so a reader can
 * follow one generation or one tool call down the list by eye.
 *
 * @group Thread inspection
 */
export function timelineJoinKeys(line: EnsoLogLine): Readonly<Record<string, string>> {
  const properties = line.properties ?? {}
  const keys: Record<string, string> = {}
  for (const key of ['generation', 'seq', 'toolCallId'] as const) {
    const value = properties[key]
    if (typeof value === 'string' || typeof value === 'number') keys[key] = String(value)
  }
  return keys
}
