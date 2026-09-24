import type { EnsoContextMakeup } from '@enso/core'
import { COMPACT } from './stats-table.tsx'
import { CATEGORY_COLOR, CATEGORY_LABEL, CONTEXT_CATEGORIES, shareOf, totalOf } from './thread-context-analysis.ts'

/**
 * The Context view's shared pieces (#361): its number formats, its card, and the six-category bar
 * and legend — drawn by the Current Context, the trend's detail and the Context Browser alike.
 */

// ── formats ──────────────────────────────────────────────────────────────────────────────────

export const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 })

/** An estimate: `≈15.9k`. */
export const estimateText = (tokens: number): string => `≈${COMPACT.format(tokens)}`

/** A signed change: `+1.2k`, `−5k`, `±0`. */
export function changeText(tokens: number): string {
  if (tokens === 0) return '±0'
  return tokens > 0 ? `+${COMPACT.format(tokens)}` : `−${COMPACT.format(-tokens)}`
}

export function timeText(at: string): string {
  const moment = new Date(at)
  return Number.isNaN(moment.getTime()) ? '' : moment.toLocaleTimeString([], { hour12: false })
}

// ── building blocks ──────────────────────────────────────────────────────────────────────────

export function Card({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-foreground text-sm">{title}</h2>
        {aside === undefined ? null : <div className="text-muted-foreground text-xs">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/**
 * The six categories as one bar. `scale` is what the full width means — the model's window for
 * the Current Context, the request's own total in the trend's detail; what the makeup leaves of
 * it is hatched (dsh's free headroom). A makeup past its scale fills the bar, and what lies past
 * the scale's edge is tinted — past the window, which the full bar alone would not say.
 */
export function MakeupBar({
  makeup,
  scale,
  label,
}: {
  makeup: EnsoContextMakeup
  scale: number
  label: string
}): React.ReactNode {
  const total = totalOf(makeup)
  const width = Math.max(scale, total)
  return (
    <div role="img" aria-label={label} className="relative flex h-3 w-full overflow-hidden rounded-sm bg-hatch">
      {CONTEXT_CATEGORIES.map((category) => (
        <span
          key={category}
          className="h-full"
          style={{ width: `${shareOf(makeup[category], width) * 100}%`, background: CATEGORY_COLOR[category] }}
        />
      ))}
      {total > scale && scale > 0 ? (
        <span
          data-slot="scale-edge"
          className="absolute inset-y-0 right-0 border-destructive border-l-2 bg-destructive/35"
          style={{ left: `${shareOf(scale, width) * 100}%` }}
        />
      ) : null}
    </div>
  )
}

/** Each category's estimate and share of the makeup, dsh's legend row. */
export function MakeupLegend({
  makeup,
  change,
}: {
  makeup: EnsoContextMakeup
  change?: EnsoContextMakeup | undefined
}): React.ReactNode {
  const total = totalOf(makeup)
  return (
    <dl className="mt-2 grid grid-cols-legend gap-x-4 gap-y-1 text-xs">
      {CONTEXT_CATEGORIES.map((category) => (
        <div key={category} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-sm"
            style={{ background: CATEGORY_COLOR[category] }}
          />
          <dt className="min-w-0 flex-1 truncate text-muted-foreground">{CATEGORY_LABEL[category]}</dt>
          {change === undefined || change[category] === 0 ? null : (
            <span className="font-mono text-muted-foreground tabular-nums">{changeText(change[category])}</span>
          )}
          <dd className="font-mono tabular-nums">{estimateText(makeup[category])}</dd>
          <span className="w-9 text-right font-mono text-muted-foreground tabular-nums">
            {PERCENT.format(shareOf(makeup[category], total))}
          </span>
        </div>
      ))}
    </dl>
  )
}

/** One of a few, as pressed buttons — dsh's `Step | Turn` and `Total | Delta` pills; every card's toggle. */
export function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: ReadonlyArray<readonly [Value, string]>
  onChange: (value: Value) => void
}): React.ReactNode {
  return (
    <fieldset aria-label={label} className="inline-flex rounded-md bg-muted p-0.5 text-xs">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          // The ring keeps the pressed option visible in a theme whose background is near its muted (Nord, Gruvbox).
          className={
            option === value
              ? 'rounded bg-background px-2 py-0.5 text-foreground ring-1 ring-border'
              : 'px-2 py-0.5 text-muted-foreground'
          }
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  )
}
