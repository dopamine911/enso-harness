import { ChevronDownIcon } from 'lucide-react'
import { Select, SelectContent, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { cn } from './lib/utils.ts'

/**
 * A session setting as a chip in the composer (#877): its name dim, its value, a chevron, and what
 * it opens. The launch panel's Model, Effort, Mode and System prompt are chips; the started
 * composer's settings are the same control (#878). Its accessible name says both halves —
 * `Effort: medium` — as the trigger's own text does.
 */

const CHIP =
  'h-8 gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-xs aria-invalid:border-destructive disabled:opacity-60'

/** A chip's two words: the setting, dim, and its value. */
function ChipFace({ label, value }: { readonly label: string; readonly value: string }): React.ReactNode {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </>
  )
}

export interface SettingChipProps {
  /** The setting's name: `Effort`. */
  readonly label: string
  /** The chosen choice's value, or `''` when none is. */
  readonly value: string
  /** What the chip says the setting is — the choice's name, or why there is none. */
  readonly display: string
  readonly onChoose: (value: string) => void
  readonly disabled?: boolean
  /** The step a Start was refused at (#391): the chip is marked, beside the refusal's words. */
  readonly invalid?: boolean
  /** The choices: `SelectItem`s, grouped as the setting groups them. */
  readonly children: React.ReactNode
}

/**
 * A setting chosen from a list: a select whose trigger is the chip, its list below it.
 *
 * ⚠ `''` is no choice, but Radix can report it as one: inside a form (the composer is one) it
 * mirrors the select into a hidden native one, which reads `''` while it holds no option for the
 * value. Taken, Start sent `mode: ""` (`launch-panel.test.tsx`). `''` is what `value` says when
 * none is chosen, so it is never passed on.
 */
export function SettingChip(props: SettingChipProps): React.ReactNode {
  const { label, display, onChoose } = props
  return (
    <Select
      value={props.value}
      onValueChange={(value: string): void => {
        if (value !== '') onChoose(value)
      }}
      disabled={props.disabled === true}
    >
      <SelectTrigger
        aria-label={`${label}: ${display}`}
        aria-invalid={props.invalid === true ? true : undefined}
        className={CHIP}
      >
        <SelectValue>
          <ChipFace label={label} value={display} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper">{props.children}</SelectContent>
    </Select>
  )
}

export interface ChipButtonProps {
  readonly label: string
  readonly display: string
  /** Opens the setting's own picker — the model's, a dialog with a filter. */
  readonly onOpen: () => void
  readonly disabled?: boolean
  readonly invalid?: boolean
}

/**
 * A setting chosen in a picker of its own: the chip is the button that opens it. A button takes no
 * `aria-invalid`, so a refused setting says so in its name (`Model: Plain, refused`) and is marked
 * as a refused select chip is.
 */
export function ChipButton({ label, display, onOpen, disabled, invalid }: ChipButtonProps): React.ReactNode {
  const refused = invalid === true
  return (
    <button
      type="button"
      aria-label={refused ? `${label}: ${display}, refused` : `${label}: ${display}`}
      aria-haspopup="dialog"
      data-invalid={refused ? true : undefined}
      disabled={disabled === true}
      onClick={onOpen}
      className={cn(
        CHIP,
        'flex items-center whitespace-nowrap transition-colors outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-invalid:border-destructive',
      )}
    >
      <ChipFace label={label} value={display} />
      <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />
    </button>
  )
}
