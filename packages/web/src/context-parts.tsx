import type { EnsoContextCategory, EnsoContextMakeup } from '@enso/core'
import { cn } from './lib/utils.ts'
import { COMPACT } from './stats-table.tsx'
import { CATEGORY_COLOR, CATEGORY_LABEL, CONTEXT_CATEGORIES, shareOf, totalOf } from './thread-context-analysis.ts'

/**
 * The Context view's shared pieces (#361): its number formats, and the six-category bar and
 * legend — drawn by the Now card and the Context Browser alike. The card and the toggles every
 * analysis view shares are `view-parts.tsx`'s.
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

/**
 * The six categories as one bar — the design's `.makeup-bar`. `scale` is what the full width
 * means — the model's window for the Now card, the request's own total in the browser; what the
 * makeup leaves of it is hatched (dsh's free headroom). A makeup past its scale fills the bar,
 * and what lies past the scale's edge is tinted — past the window, which the full bar alone would
 * not say.
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
    <div role="img" aria-label={label} className="relative flex h-4 w-full gap-px overflow-hidden rounded-sm bg-hatch">
      {CONTEXT_CATEGORIES.map((category) =>
        makeup[category] === 0 ? null : (
          <span
            key={category}
            className="h-full min-w-0.5"
            style={{ width: `${shareOf(makeup[category], width) * 100}%`, background: CATEGORY_COLOR[category] }}
          />
        ),
      )}
      {total > scale && scale > 0 ? (
        <span
          data-slot="scale-edge"
          className="absolute inset-y-0 right-0 border-l-2 border-refuse bg-refuse/35"
          style={{ left: `${shareOf(scale, width) * 100}%` }}
        />
      ) : null}
    </div>
  )
}

/** The category's colour, as a small square beside its name. */
export function Swatch({
  category,
  className,
}: {
  category: EnsoContextCategory
  className?: string
}): React.ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 rounded-xs', className)}
      style={{ background: CATEGORY_COLOR[category] }}
    />
  )
}

/** Each category's estimate and share of the makeup — the design's `.legend`. */
export function MakeupLegend({ makeup }: { makeup: EnsoContextMakeup }): React.ReactNode {
  const total = totalOf(makeup)
  return (
    <dl className="grid grid-cols-legend gap-x-4 gap-y-1 text-sm">
      {CONTEXT_CATEGORIES.map((category) => (
        <div key={category} className="flex items-center gap-2">
          <Swatch category={category} />
          <dt className="min-w-0 flex-1 truncate">{CATEGORY_LABEL[category]}</dt>
          <dd className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {estimateText(makeup[category])} · {PERCENT.format(shareOf(makeup[category], total))}
          </dd>
        </div>
      ))}
    </dl>
  )
}
