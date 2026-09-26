import { type EnsoLogLine, logLineText } from '@enso/core'

/**
 * One log record, one rendering (#144 slice 3) — shared by the day's tail and a thread's
 * timeline, so a record reads IDENTICALLY on both pages and a reader who follows a thread id
 * from the tail into the timeline finds the same row, not a second dialect of it. The row was
 * the tail's own in slice 2; it moved here unchanged the moment a second page needed it.
 *
 * WHERE A THREAD ID LEADS IS THE PAGE'S DECISION, not the row's: on the tail a thread id
 * drills down into its timeline, on the timeline it is the row's own thread and leads back to
 * the chat. So `threadHref` is a required prop rather than a constant here — the row knows
 * how to show an id, the page knows what an id is for.
 *
 * Nothing here writes, POSTs or decides: it is the one place the shape of a record on screen
 * is spelled.
 */

/** A row is one line — fixed height, so no row has to be measured to place the next one. */
export const ROW_HEIGHT_PX = 22
/** How much of a thread id a row shows. The whole id is the link and the row's tooltip. */
const THREAD_ID_SHOWN_CHARACTERS = 8

/** Tier → how the row reads it. Colour AND the word, never colour alone. */
const LEVEL_CLASS: Readonly<Record<EnsoLogLine['level'], string>> = {
  TRACE: 'w-12 shrink-0 text-muted-foreground',
  DEBUG: 'w-12 shrink-0 text-muted-foreground',
  INFO: 'w-12 shrink-0 text-foreground',
  WARN: 'w-12 shrink-0 font-semibold text-primary',
  ERROR: 'w-12 shrink-0 font-semibold text-destructive',
  FATAL: 'w-12 shrink-0 font-semibold text-destructive',
}

/**
 * A record's clock, time of day only: a page of ISO strings is 24 characters of the same
 * date per row. LOCAL, because the day the file is named for is local — a row stamped in one
 * zone under a heading in another is how a reader mis-reads an incident. A stamp that does
 * not parse is shown as it is — the unreadable clock is the one worth seeing.
 */
export function timeOfDay(stamp: string): string {
  const at = new Date(stamp)
  if (Number.isNaN(at.getTime())) return stamp
  const hours = String(at.getHours()).padStart(2, '0')
  const minutes = String(at.getMinutes()).padStart(2, '0')
  const seconds = String(at.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}.${String(at.getMilliseconds()).padStart(3, '0')}`
}

/**
 * The properties the message did not already say. A record's value is worth a row's width
 * only once: `run {generation} acquired` has spelled `generation`, and repeating it crowds out
 * the ones nothing has mentioned. Matched by NAME against the template on disk, so nothing is
 * hidden by having the same value as something else.
 */
function unsaidProperties(line: EnsoLogLine): Array<[string, unknown]> {
  const template = line.message ?? ''
  // `threadId` is the row's link, so it is already shown — as the one property this page
  // renders as something you can click (#142).
  return Object.entries(line.properties ?? {}).filter(
    ([propertyName]) => propertyName !== 'threadId' && !template.includes(`{${propertyName}}`),
  )
}

/** A property as a row reads it: a string as itself, anything else as the JSON it is on disk. */
function propertyText(propertyName: string, propertyValue: unknown): string {
  return `${propertyName}=${typeof propertyValue === 'string' ? propertyValue : JSON.stringify(propertyValue)}`
}

export interface LogRowProps {
  readonly line: EnsoLogLine
  /** Where the row's thread id leads — the page's decision, see the header. */
  readonly threadHref: (threadId: string) => string
}

/** One record, one line. The full message and the full thread id are the row's `title`. */
export function LogRow({ line, threadHref }: LogRowProps): React.ReactNode {
  const message = logLineText(line)
  const properties = line.properties ?? {}
  const threadId = typeof properties.threadId === 'string' ? properties.threadId : undefined
  const unsaid = unsaidProperties(line)
  return (
    <div className="flex items-center gap-2 px-4 font-mono text-xs" title={message} style={{ height: ROW_HEIGHT_PX }}>
      <span className="shrink-0 text-muted-foreground tabular-nums">{timeOfDay(line['@timestamp'])}</span>
      <span className={LEVEL_CLASS[line.level]}>{line.level.toLowerCase()}</span>
      <span className="w-40 shrink-0 truncate text-muted-foreground">{line.logger.replace(/^enso\.?/, '')}</span>
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {unsaid.length === 0 ? null : (
        <span className="max-w-80 min-w-0 shrink-0 truncate text-muted-foreground">
          {unsaid.map(([propertyName, propertyValue]) => propertyText(propertyName, propertyValue)).join(' ')}
        </span>
      )}
      {threadId === undefined ? null : (
        <a
          className="shrink-0 text-primary underline-offset-2 hover:underline"
          href={threadHref(threadId)}
          title={threadId}
        >
          {threadId.slice(0, THREAD_ID_SHOWN_CHARACTERS)}
          {threadId.length > THREAD_ID_SHOWN_CHARACTERS ? '…' : ''}
        </a>
      )}
    </div>
  )
}
