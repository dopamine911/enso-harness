import type { EnsoDurationSummary } from '@enso/core'

/**
 * The table and the number formats the two stats surfaces share (#45 phase 2): the day's
 * (`debug/day-stats-screen.tsx`, #144) and one thread's (`thread-stats.tsx`). One spelling of a
 * cost, a count and a duration, so the same fact reads the same on both.
 */

/** The cell for a fact the schema does not have. */
export const ABSENT = '—'

/** Dollars, to the tenth of a cent: a day's cost is small and a model's share of it smaller. */
export function costText(cost: number): string {
  return `$${cost.toFixed(4)}`
}

/** A count as a short number — `5.4K`, `200K`: the charts' ticks and the context's figures. */
export const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** A count with thousands separators — a `trace` day's record count is six digits. */
export function countText(quantity: number): string {
  return quantity.toLocaleString('en-US')
}

/** Whole milliseconds, separated; `—` for a span the fold could not close. */
export function millisecondsText(milliseconds: number | undefined): string {
  return milliseconds === undefined ? ABSENT : Math.round(milliseconds).toLocaleString('en-US')
}

/** `n, min/mean/max ms` — or `none`, the caller's word for it, when nothing was summarised. */
export function durationsText(summary: EnsoDurationSummary, none: string): string {
  if (summary.count === 0) return none
  const spread = [summary.minMs, summary.meanMs, summary.maxMs].map(millisecondsText).join('/')
  return `${countText(summary.count)}, ${spread} ms`
}

/** A column: its heading and whether its cells are numbers, which read right-aligned. */
export interface Column {
  readonly heading: string
  readonly numeric?: boolean
}

interface StatsTableProps {
  readonly caption: string
  readonly columns: readonly Column[]
  /** Each row keyed by what it is a row of, so a refresh reuses the same row for the same thread or tool. */
  readonly rows: ReadonlyArray<{ readonly key: string; readonly cells: readonly React.ReactNode[] }>
  /** What an empty table says instead of headings over nothing. */
  readonly empty: string
}

/**
 * One section: a caption, headings, rows. A `<table>` because that is what these are — a
 * screen reader walks a column by heading — and compact because each surface is a glance.
 */
export function StatsTable({ caption, columns, rows, empty }: StatsTableProps): React.ReactNode {
  return (
    <table className="mb-4 w-full border-collapse text-xs">
      <caption className="pb-1 text-left font-semibold text-foreground">{caption}</caption>
      {rows.length === 0 ? (
        <tbody>
          <tr>
            <td className="py-0.5 text-muted-foreground" colSpan={columns.length}>
              {empty}
            </td>
          </tr>
        </tbody>
      ) : (
        <>
          <thead>
            <tr className="border-b text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.heading}
                  className={
                    column.numeric === true ? 'px-2 py-0.5 text-right font-normal' : 'px-2 py-0.5 text-left font-normal'
                  }
                  scope="col"
                >
                  {column.heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-dashed">
                {row.cells.map((cell, cellIndex) => {
                  const column = columns[cellIndex]
                  return (
                    <td
                      key={column?.heading ?? String(cellIndex)}
                      className={
                        column?.numeric === true
                          ? 'px-2 py-0.5 text-right tabular-nums'
                          : 'whitespace-nowrap px-2 py-0.5 text-left'
                      }
                    >
                      {cell}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </>
      )}
    </table>
  )
}
