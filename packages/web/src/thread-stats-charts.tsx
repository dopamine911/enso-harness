import type { EnsoTurnStats } from '@enso/core'
import { useState } from 'react'
// This module is the on-demand chunk (`thread-stats.tsx` loads it with `lazy`): recharts is static
// here by design, and the main bundle does not carry it (vite build: 1,498 kB → 910 kB).
// react-doctor-disable-next-line prefer-dynamic-import
import {
  Area,
  AreaChart,
  CartesianGrid,
  type DotItemDotProps,
  Bar,
  BarChart,
  type MouseHandlerDataParam,
  XAxis,
  YAxis,
} from 'recharts'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.tsx'
import { cn } from './lib/utils.ts'
import { COMPACT, costText } from './stats-table.tsx'
import { isUnpriced } from './thread-stats-analysis.ts'
import { toggleMember } from './toggle-member.ts'

/**
 * The stats drawer's two turn charts (`thread-stats.tsx` says what they show). Its own module, and
 * the only one that imports recharts: the drawer loads it with `lazy`, so the chat screen's bundle
 * does not carry a charting library for a drawer most sessions never open (#747).
 */

export type TurnPoint = EnsoTurnStats & { readonly label: string }
/** A cost point; `null` for a turn on a model with no price — a gap in the line, not a $0 (#692). */
type CostPoint = Omit<TurnPoint, 'cost'> & { readonly cost: number | null }

/** Opens a turn in the transcript; absent where there is nowhere to go (a static render). */
export type OnTurn = ((turn: number) => void) | undefined

/** A chart tooltip's heading: the turn its point is. */
const turnLabel = (label: unknown): string => `turn ${String(label)}`
const dollarTick = (value: number): string => `$${value.toFixed(3)}`
const tokenTick = (value: number): string => COMPACT.format(value)

/** Three ticks on a value axis, as livecraft draws: nothing, half, the most. */
const AXIS_TICKS = 3

/**
 * The grid, the turn axis, a value axis and the tooltip every turn chart shares — returned as
 * elements, not a component, so recharts finds them as its chart's direct children.
 */
function turnAxes(tick: (value: number) => string, width: number): React.ReactNode[] {
  return [
    <CartesianGrid key="grid" vertical={false} />,
    <XAxis key="turn" dataKey="label" tickLine={false} axisLine={false} minTickGap={8} />,
    <YAxis key="value" tickLine={false} axisLine={false} width={width} tickCount={AXIS_TICKS} tickFormatter={tick} />,
    <ChartTooltip key="tooltip" content={<ChartTooltipContent labelFormatter={turnLabel} />} />,
  ]
}

/** A chart's click props: a click → the turn under the pointer, or none without somewhere to go. */
type ChartClick = { onClick: (state: MouseHandlerDataParam) => void; className: string } | Record<never, never>

/**
 * The chart's click → the turn under the pointer. Recharts reports the hovered point's index,
 * which is the one its tooltip shows, so a click anywhere in the column goes where the tooltip says.
 */
function turnClick(data: readonly { readonly turn: number }[], onTurn: OnTurn): ChartClick {
  if (onTurn === undefined) return {}
  return {
    className: 'cursor-pointer',
    onClick: (state: MouseHandlerDataParam): void => {
      const index = state.activeTooltipIndex
      if (index === undefined || index === null) return
      const point = data[Number(index)]
      if (point !== undefined) onTurn(point.turn)
    },
  }
}

/**
 * A cost point as a control (livecraft's `role="button"` points): focusable, and Enter or Space
 * opens its turn — the keyboard's way in, where the click above is the pointer's.
 */
function turnDot(onTurn: OnTurn): ((props: DotItemDotProps) => React.ReactNode) | boolean {
  if (onTurn === undefined) return true
  return function TurnDot(dot: DotItemDotProps): React.ReactNode {
    const point = dot.payload as CostPoint
    if (point.cost === null) return null
    const open = (): void => onTurn(point.turn)
    return (
      <circle
        key={`turn-${dot.index}`}
        cx={dot.cx}
        cy={dot.cy}
        r={3}
        fill="var(--background)"
        stroke={dot.stroke}
        strokeWidth={2}
        role="button"
        tabIndex={0}
        aria-label={`turn ${point.turn}, ${costText(point.cost)} — show it in the transcript`}
        className="cursor-pointer outline-none focus-visible:stroke-foreground"
        // The chart's own `onClick` (`turnClick`) sits on recharts' wrapper, above this point, and
        // names the same hovered turn: bubbling would open it twice.
        onClick={(event: React.MouseEvent<SVGCircleElement>): void => {
          event.stopPropagation()
          open()
        }}
        onKeyDown={(event: React.KeyboardEvent<SVGCircleElement>): void => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        }}
      />
    )
  }
}

// ── context and tokens ───────────────────────────────────────────────────────────────────────

/**
 * livecraft's series — what missed the cache, what it served, what the model wrote — plus what
 * was written to it, which Anthropic bills apart and a long first turn is mostly made of.
 */
type TokenSeries = 'input' | 'cacheRead' | 'cacheWrite' | 'output'
const TOKEN_SERIES: Readonly<Record<TokenSeries, { readonly label: string; readonly color: string }>> = {
  input: { label: 'cache miss', color: 'var(--chart-1)' },
  cacheRead: { label: 'cache read', color: 'var(--chart-2)' },
  cacheWrite: { label: 'cache write', color: 'var(--chart-4)' },
  output: { label: 'output', color: 'var(--chart-3)' },
}

/**
 * Tokens per turn, the series stacked in one bar — what the cache served at the base, then what
 * was written to it, what missed it, and what the model wrote — each toggled from its legend
 * button (#407: four crossing lines read as a zig-zag). ⓘ No animation on any chart here: the
 * drawer refetches after each turn, and a chart re-drawing from zero every time would replay the
 * thread's history as if it were happening again.
 */
/** The stack, base first: a long thread is mostly cache reads, and the rarer series sit on top where they show. */
const STACK_ORDER: readonly TokenSeries[] = ['cacheRead', 'cacheWrite', 'input', 'output']

export function TokenChart({
  data,
  onTurn,
}: {
  readonly data: readonly TurnPoint[]
  readonly onTurn: OnTurn
}): React.ReactNode {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  // The legend reads in the stack's order, base first.
  const series = STACK_ORDER.map((key) => [key, TOKEN_SERIES[key]] as const)
  const stacked = STACK_ORDER.filter((key) => !hidden.has(key))
  const toggle = (key: string): void => setHidden((current) => toggleMember(current, key))
  return (
    <>
      <fieldset aria-label="token series shown" className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
        {series.map(([key, { label, color }]) => (
          <button
            key={key}
            type="button"
            aria-pressed={!hidden.has(key)}
            className={cn(
              'whitespace-nowrap',
              hidden.has(key) ? 'text-muted-foreground line-through' : 'text-foreground',
            )}
            onClick={() => toggle(key)}
          >
            <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full" style={{ background: color }} />
            {label}
          </button>
        ))}
      </fieldset>
      <ChartContainer config={TOKEN_SERIES} className="aspect-auto h-36 w-full">
        <BarChart data={[...data]} accessibilityLayer {...turnClick(data, onTurn)}>
          {turnAxes(tokenTick, 40)}
          {stacked.map((key) => (
            <Bar key={key} dataKey={key} stackId="tokens" fill={`var(--color-${key})`} isAnimationActive={false} />
          ))}
        </BarChart>
      </ChartContainer>
    </>
  )
}

// ── cost per turn ────────────────────────────────────────────────────────────────────────────

const COST_SERIES: ChartConfig = { cost: { label: 'cost ($)', color: 'var(--chart-1)' } }

export function CostChart({
  data,
  onTurn,
}: {
  readonly data: readonly TurnPoint[]
  readonly onTurn: OnTurn
}): React.ReactNode {
  const points: CostPoint[] = data.map((point) => (isUnpriced(point) ? { ...point, cost: null } : point))
  return (
    <ChartContainer config={COST_SERIES} className="aspect-auto h-36 w-full">
      <AreaChart data={points} accessibilityLayer {...turnClick(points, onTurn)}>
        {turnAxes(dollarTick, 48)}
        <Area
          dataKey="cost"
          type="linear"
          stroke="var(--color-cost)"
          fill="var(--color-cost)"
          fillOpacity={0.2}
          strokeWidth={2}
          dot={turnDot(onTurn)}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
