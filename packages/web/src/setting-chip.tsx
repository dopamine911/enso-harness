import { ChevronDownIcon, LockIcon } from 'lucide-react'
import { useState } from 'react'
import { Select, SelectContent, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip.tsx'
import { cn } from './lib/utils.ts'

/**
 * A session setting as a chip in the composer (#877): its name dim, its value, a chevron, and what
 * it opens. The launch panel's Model, Effort, Mode and System prompt are chips; the started
 * composer's settings are the same control (#878). Its accessible name says both halves —
 * `Effort: medium` — as the trigger's own text does.
 */

/**
 * The chip, the prototype's `.chip` (#417): a pill on the page's own background, its border the
 * strong one; hover and an open list ring it in the primary, the list's open state filling it with
 * the accent; a refused setting in the refusal's colour. A chip that cannot open — nothing to choose
 * from, or fixed for the session — is dashed, its value dimmed (`ChipFace`'s `group-disabled`).
 */
const CHIP =
  'group flex h-8 items-center gap-2 rounded-full border border-border-strong bg-background px-3 text-detail whitespace-nowrap text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:border-primary aria-expanded:bg-accent aria-invalid:border-refuse aria-invalid:text-refuse aria-invalid:ring-0 disabled:cursor-default disabled:border-dashed disabled:opacity-100 data-invalid:border-refuse data-invalid:text-refuse dark:bg-background'

/** A chip that opens something: the primary's ring under the pointer, the accent's fill while open. */
const OPENS = 'not-disabled:hover:border-primary dark:hover:bg-background dark:aria-expanded:bg-accent'

/**
 * A chip's list, the prototype's `.popover` of `.option`s (#417): lifted by `shadow-pop`, 40px rows
 * the accent fills on the pointer and on the current choice, its check in the primary. Styled from
 * the list so every chip's `SelectItem`s — Effort, Mode, System prompt — read alike.
 */
const CHIP_LIST =
  'min-w-48 rounded-lg p-1 shadow-pop ring-0 **:data-[slot=select-item]:min-h-10 **:data-[slot=select-item]:rounded-sm **:data-[slot=select-item]:pr-9 **:data-[slot=select-item]:pl-3 **:data-[slot=select-item]:data-[state=checked]:bg-accent **:data-[slot=select-item]:[&_svg]:text-primary'

/**
 * The composer's icon buttons — attach, and the `/` palette's trigger (`command-palette.tsx`): the
 * prototype's `.icon-button` (#417), 40px, muted until hovered or open.
 */
export const COMPOSER_ICON_BUTTON =
  'size-10 rounded-sm text-muted-foreground hover:bg-card hover:text-foreground aria-expanded:bg-card aria-expanded:text-foreground dark:hover:bg-card [&_svg:not([class*=size-])]:size-4.5'

/** A chip's two words: the setting, dim and smaller, and its value — dimmed too on a chip that cannot open, or is `fixed`. */
function ChipFace({
  label,
  value,
  fixed,
}: {
  readonly label: string
  readonly value: string
  readonly fixed?: boolean
}): React.ReactNode {
  return (
    <>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-semibold text-foreground group-disabled:font-medium group-disabled:text-muted-foreground',
          fixed === true && 'font-medium text-muted-foreground',
        )}
      >
        {value}
      </span>
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
 * none is chosen, so it is never passed on. ⚠ Radix shows the placeholder, not the children, for
 * `''`: the face is both, or a chip with no choice is an empty box (#852's "Effort: pi's default").
 */
export function SettingChip(props: SettingChipProps): React.ReactNode {
  const { label, display, onChoose } = props
  const face = <ChipFace label={label} value={display} />
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
        className={cn(CHIP, OPENS, '[&>svg]:size-3.5')}
      >
        <SelectValue placeholder={face}>{face}</SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" className={CHIP_LIST}>
        {props.children}
      </SelectContent>
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
  /** What hovering the chip says beyond its name — the Model chip's provider and model id (#44). */
  readonly title?: string
  /** Its picker is open: the chip says so (`aria-expanded`) and is drawn open, as a list chip is. */
  readonly expanded?: boolean
  /** The chip, for its picker to put focus back on when it closes: the picker is not a Radix trigger's. */
  readonly ref?: React.Ref<HTMLButtonElement>
}

/**
 * A setting chosen in a picker of its own: the chip is the button that opens it. A button takes no
 * `aria-invalid`, so a refused setting says so in its name (`Model: Plain, refused`) and is marked
 * as a refused select chip is.
 */
export function ChipButton({
  label,
  display,
  onOpen,
  disabled,
  invalid,
  title,
  expanded,
  ref,
}: ChipButtonProps): React.ReactNode {
  const refused = invalid === true
  return (
    <button
      ref={ref}
      type="button"
      aria-label={refused ? `${label}: ${display}, refused` : `${label}: ${display}`}
      aria-haspopup="dialog"
      aria-expanded={expanded === true}
      title={title}
      data-invalid={refused ? true : undefined}
      disabled={disabled === true}
      onClick={onOpen}
      className={cn(CHIP, OPENS)}
    >
      <ChipFace label={label} value={display} />
      <ChevronDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
    </button>
  )
}

export interface LockedChipProps {
  readonly label: string
  readonly display: string
  /** Why the setting cannot change now, in a sentence: what the chip says when pressed. */
  readonly explanation: string
}

/**
 * A setting fixed for the session's life (#878): the chip with a lock, not a list — nothing opens to
 * choose from. Still a button, so Tab reaches it, and pressing it (click, Enter, Space) says why: the
 * explanation, as a tooltip that focus and hover open too. ⚠ Controlled, and the click PREVENTS
 * Radix's own: its trigger closes the tooltip on every click, the press that should open it.
 */
export function LockedChip({ label, display, explanation }: LockedChipProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${display}, fixed for this session`}
            onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
              event.preventDefault()
              setOpen(true)
            }}
            className={cn(CHIP, 'border-dashed')}
          >
            <ChipFace label={label} value={display} fixed />
            <LockIcon aria-hidden="true" className="size-3 text-muted-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {explanation}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
