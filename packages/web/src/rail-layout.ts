import type { EnsoStoredThread } from '@enso/core'
import type { ThreadSummary } from './thread-stores.ts'

/**
 * How a project's section of the rail lays its threads out (#875): under **Today**, **Yesterday**
 * and **Earlier** by last activity, in the browser's local day, and inside each, the threads that
 * share a title folded into one row with a count. Pure: the threads and the clock in, the rows out.
 *
 * Within a day the section keeps the rail's order — the page's open threads, then its stored ones,
 * newest first — so opening a thread (which counts as activity) never reorders the rows around it.
 */

/** A day group, in the order the rail shows them. */
export type RailDay = 'today' | 'yesterday' | 'earlier'

const RAIL_DAYS: readonly RailDay[] = ['today', 'yesterday', 'earlier']

export const RAIL_DAY_LABELS: Readonly<Record<RailDay, string>> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

/** Local midnight at the start of `at`'s day — the browser's day, daylight saving included. */
export function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/**
 * Which day group a thread last active `at` is in, seen at `now`: since local midnight is Today, the
 * local day before is Yesterday, anything older is Earlier. A time ahead of `now` (another clock's)
 * is Today, never lost.
 */
export function railDayOf(at: Date, now: Date): RailDay {
  const today = startOfLocalDay(now)
  if (at >= today) return 'today'
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  return at >= yesterday ? 'yesterday' : 'earlier'
}

/** Some of a section's threads: the page's open ones, then stored ones — the shape a section and a fold share. */
export interface RailThreads {
  readonly threads: readonly ThreadSummary[]
  readonly earlier: readonly EnsoStoredThread[]
}

/** One row of a day group: a thread on its own, or the threads that share its title, folded. */
export type RailRow =
  | { readonly kind: 'open'; readonly thread: ThreadSummary }
  | { readonly kind: 'stored'; readonly thread: EnsoStoredThread }
  | ({ readonly kind: 'fold'; readonly key: string; readonly title: string } & RailThreads)

export interface RailDayGroup {
  readonly day: RailDay
  readonly rows: readonly RailRow[]
}

export interface SectionLayout {
  readonly days: readonly RailDayGroup[]
  /** How many rows of stored threads alone the cap left out — what "show N more" says. */
  readonly hidden: number
}

/** The title a thread reads as, folds by and is searched by: the name a person gave it, else its first prompt. */
function railTitleOf(thread: ThreadSummary | EnsoStoredThread): string | undefined {
  return thread.name ?? thread.title
}

type Single = Extract<RailRow, { kind: 'open' | 'stored' }>

/**
 * One day's threads as rows: each untitled thread — a draft, or a stored session with no prompt —
 * on its own; titled ones that share a title folded, at the place of the first of them.
 */
function foldDay(day: RailDay, singles: readonly Single[]): RailRow[] {
  const buckets: Single[][] = []
  const byTitle = new Map<string, Single[]>()
  for (const single of singles) {
    const title = railTitleOf(single.thread)
    const bucket = title === undefined ? undefined : byTitle.get(title)
    if (bucket !== undefined) {
      bucket.push(single)
      continue
    }
    const fresh = [single]
    buckets.push(fresh)
    if (title !== undefined) byTitle.set(title, fresh)
  }
  return buckets.map((bucket) => asRow(day, bucket))
}

function asRow(day: RailDay, bucket: readonly Single[]): RailRow {
  const [first] = bucket
  if (first === undefined) throw new Error('foldDay: an empty bucket')
  const title = railTitleOf(first.thread)
  if (bucket.length === 1 || title === undefined) return first
  return {
    kind: 'fold',
    key: `${day}:${title}`,
    title,
    threads: bucket.flatMap((single) => (single.kind === 'open' ? [single.thread] : [])),
    earlier: bucket.flatMap((single) => (single.kind === 'stored' ? [single.thread] : [])),
  }
}

/**
 * The section's day groups and folds. `cap` is how many rows of stored threads alone are shown (the
 * rest are "show N more"); `undefined` shows every row — asked for, or searching.
 */
export function sectionLayout(section: RailThreads, now: Date, cap: number | undefined): SectionLayout {
  const singles = [
    ...section.threads.map((thread): Single => ({ kind: 'open', thread })),
    ...section.earlier.map((thread): Single => ({ kind: 'stored', thread })),
  ].map((single) => ({
    single,
    day: railDayOf(single.kind === 'open' ? single.thread.lastActivityAt : new Date(single.thread.lastActivityAt), now),
  }))
  let storedRows = 0
  let hidden = 0
  // A row of stored threads alone is what the cap counts: a row holding an open thread is always shown.
  const shown = (row: RailRow): boolean => {
    if (row.kind === 'open' || (row.kind === 'fold' && row.threads.length > 0)) return true
    storedRows += 1
    if (cap === undefined || storedRows <= cap) return true
    hidden += 1
    return false
  }
  const days = RAIL_DAYS.flatMap((day): RailDayGroup[] => {
    const rows = foldDay(
      day,
      singles.flatMap((dated) => (dated.day === day ? [dated.single] : [])),
    ).filter(shown)
    return rows.length === 0 ? [] : [{ day, rows }]
  })
  return { days, hidden }
}

/** What a row of threads the reader cannot see says for them, and for how many of them. */
export interface HiddenSignal {
  readonly state: 'waiting' | 'running'
  readonly count: number
}

/**
 * What a row of threads the reader cannot see says for them — a collapsed project's header (#876),
 * a collapsed fold: the questions waiting on you first (only an open thread can hold one, and it is
 * busy too), else the runs in flight — the order a row's own dot uses — with how many.
 */
export function hiddenSignal(rows: RailThreads): HiddenSignal | undefined {
  const waiting = rows.threads.filter((thread) => thread.waiting).length
  if (waiting > 0) return { state: 'waiting', count: waiting }
  const running =
    rows.threads.filter((thread) => thread.busy).length + rows.earlier.filter((thread) => thread.busy).length
  return running > 0 ? { state: 'running', count: running } : undefined
}

/** The threads whose title holds `query`, case aside (#875); everything when `query` is blank. An untitled thread holds nothing. */
export function matchingThreads<Threads extends RailThreads>(section: Threads, query: string): Threads {
  const needle = query.trim().toLowerCase()
  if (needle === '') return section
  const holds = (thread: ThreadSummary | EnsoStoredThread): boolean =>
    railTitleOf(thread)?.toLowerCase().includes(needle) ?? false
  return { ...section, threads: section.threads.filter(holds), earlier: section.earlier.filter(holds) }
}
