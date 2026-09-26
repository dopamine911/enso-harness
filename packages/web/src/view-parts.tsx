import { cn } from './lib/utils.ts'

/**
 * The analysis views' building blocks — the Context and Stats tabs (#361), in the design
 * direction's card language (`Enso-Design-Direction`, `.card`, `.seg`, `.filter`, `.kind`): a card
 * with a head (title, a muted line saying how to read it, its controls on the right) over its
 * body, a segmented choice, a small button, a filter pill and a row's kind label. Colours are the
 * theme's roles, so every theme draws them; Ledger's cards title in mono capitals.
 */

export function Card({
  title,
  sub,
  tools,
  children,
  className,
}: {
  title: string
  /** How to read the card, beside its title. */
  sub?: React.ReactNode
  /** The card's controls, on the right of its head. */
  tools?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.ReactNode {
  return (
    <section
      aria-label={title}
      className={cn('grid min-w-0 grid-cols-1 content-start rounded-lg border bg-card', className)}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <h2 className="font-heading text-base font-semibold ledger:font-mono ledger:text-sm ledger:tracking-widest ledger:uppercase">
          {title}
        </h2>
        {sub === undefined ? null : <span className="text-xs text-muted-foreground">{sub}</span>}
        {tools === undefined ? null : <div className="ml-auto flex flex-wrap items-center gap-2">{tools}</div>}
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-3 px-4 pt-3 pb-4">{children}</div>
    </section>
  )
}

/** One of a few, as pressed buttons in one bordered strip — the design's `.seg`; every card's toggle. */
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
    <fieldset aria-label={label} className="inline-flex divide-x overflow-hidden rounded-md border">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          className="min-h-8 px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-popover aria-pressed:text-foreground"
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  )
}

/** The design's `.button-small`: a card's own action, an icon and a word. */
export function SmallButton({ className, ...props }: React.ComponentProps<'button'>): React.ReactNode {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-8 items-center justify-center gap-2 rounded-md border bg-card px-2 text-xs font-semibold transition-colors hover:bg-popover disabled:opacity-55 disabled:hover:bg-card [&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}

/** A kind a list can show or hide — the design's `.filter` pill: pressed is shown. */
function FilterPill({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground [&_svg]:size-4"
      onClick={onToggle}
    >
      {children}
    </button>
  )
}

/**
 * The kinds a list shows, as pills — each pressed while shown, with its icon and how many there
 * are: `read · 3`. The caller holds which kinds are hidden.
 */
interface KindFiltersProps<Kind extends string> {
  readonly label: string
  readonly kinds: readonly Kind[]
  readonly hidden: ReadonlySet<Kind>
  readonly onToggle: (kind: Kind) => void
  readonly icon: (kind: Kind) => React.ReactNode
  readonly count: (kind: Kind) => number
}

export function KindFilters<Kind extends string>(props: KindFiltersProps<Kind>): React.ReactNode {
  const { label, kinds, hidden, onToggle, icon, count } = props
  return (
    <fieldset aria-label={label} className="flex flex-wrap gap-2">
      {kinds.map((kind) => (
        <FilterPill key={kind} pressed={!hidden.has(kind)} onToggle={() => onToggle(kind)}>
          {icon(kind)}
          {kind} · {count(kind)}
        </FilterPill>
      ))}
    </fieldset>
  )
}

/** A row's kind at its start: an icon and the word, in capitals — the design's `.kind`. */
export function KindLabel({ className, children }: { className?: string; children: React.ReactNode }): React.ReactNode {
  return (
    <span
      className={cn(
        'inline-flex w-21 shrink-0 items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase [&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A list row that opens what it names — the design's `.row-button`: kind, the main two lines, the figures at the end. */
export const ROW_BUTTON =
  'flex min-h-11 w-full items-center gap-3 border-b p-2 text-left transition-colors last:border-b-0 hover:bg-popover disabled:opacity-60 disabled:hover:bg-transparent'
