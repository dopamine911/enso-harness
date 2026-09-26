/**
 * A closed vocabulary as a control (#45 phase 2 folded the log level's and the stats drawer's
 * copies): a native `<select>` — keyboard- and screen-reader-complete without a dependency, the
 * reasoning the permission-mode control gives — that only ever hands back one of its options.
 *
 * Named by an `id` a page's `<label>` points at, or by `label` when there is no visible one.
 */
export interface OptionSelectProps<Option extends string> {
  readonly value: Option
  /** Each option and the words it shows. */
  readonly options: ReadonlyArray<readonly [Option, string]>
  readonly onChange: (option: Option) => void
  readonly id?: string
  readonly label?: string
  /** Replaces the compact default look — a card's picker is taller. */
  readonly className?: string
}

export function OptionSelect<Option extends string>({
  value,
  options,
  onChange,
  id,
  label,
  className = 'rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground',
}: OptionSelectProps<Option>): React.ReactNode {
  return (
    <select
      id={id}
      aria-label={label}
      className={className}
      value={value}
      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
        const chosen = options.find(([option]) => option === event.target.value)
        if (chosen !== undefined) onChange(chosen[0])
      }}
    >
      {options.map(([option, words]) => (
        <option key={option} value={option}>
          {words}
        </option>
      ))}
    </select>
  )
}
