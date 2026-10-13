import type { HostCommandOption } from '@enso/core'
import { useRef, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './components/ui/command.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx'
import { ChosenMark, OptionDetail, optionKeywords } from './model-state.tsx'
import { ChipButton } from './setting-chip.tsx'

/**
 * The launch panel's Model chip (#877) and the picker it opens: the models the session may start
 * on, filtered by name or provider, the chosen one marked. Choosing one closes the picker; nothing
 * reaches the session until Start (#391).
 */

function ModelList({
  models,
  chosen,
  onChoose,
  filter,
  onFilter,
}: {
  models: readonly HostCommandOption[]
  chosen: string | undefined
  onChoose: (option: HostCommandOption) => void
  filter: string
  onFilter: (filter: string) => void
}): React.ReactNode {
  // ⚠ cmdk highlights (`aria-selected`) its first row unless told which, and Enter in the filter
  // commits the highlighted row (#846): the highlight is the chosen model's until the arrows or the
  // filter move it, and a new choice takes it back. Held with the choice it moved from, so a
  // highlight cmdk set before the choice arrived does not outlive it. A chosen model the list does
  // not offer is no row to highlight: the highlight is left to cmdk, on its first row, so Enter
  // still has one to commit.
  const [moved, setMoved] = useState<{ readonly from: string | undefined; readonly value: string } | undefined>(
    undefined,
  )
  const offered = models.some((option) => option.id === chosen) ? chosen : undefined
  const highlighted = moved !== undefined && moved.from === chosen ? moved.value : offered
  return (
    // ⚠ cmdk sets the input's id itself, after ours: a label `htmlFor` named nothing, and the
    // filter read as a bare `combobox`. cmdk's own label is the one it wires to the input.
    <Command
      className="rounded-md border"
      label="Model"
      {...(highlighted === undefined ? {} : { value: highlighted })}
      onValueChange={(modelId: string): void => setMoved({ from: chosen, value: modelId })}
    >
      <CommandInput placeholder="filter models…" value={filter} onValueChange={onFilter} />
      <CommandList className="max-h-72">
        <CommandEmpty>no model matches</CommandEmpty>
        {models.map((option) => (
          <CommandItem
            key={option.id}
            value={option.id}
            keywords={optionKeywords(option)}
            data-checked={option.id === chosen}
            onSelect={(): void => onChoose(option)}
          >
            <span>{option.label}</span>
            <OptionDetail option={option} />
            <ChosenMark chosen={option.id === chosen} />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}

/** The chip's words for the chosen model: its name, or why there is none yet. */
function modelDisplay(models: readonly HostCommandOption[], chosen: string | undefined, loading: boolean): string {
  if (loading) return 'loading…'
  return models.find((option) => option.id === chosen)?.label ?? chosen ?? 'none'
}

export function LaunchModelChip({
  models,
  chosen,
  onChoose,
  loading,
  invalid,
}: {
  readonly models: readonly HostCommandOption[]
  readonly chosen: string | undefined
  readonly onChoose: (option: HostCommandOption) => void
  /** The models are still being read: the chip says so and opens nothing. */
  readonly loading: boolean
  readonly invalid: boolean
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const chip = useRef<HTMLButtonElement | null>(null)
  const close = (): void => {
    setOpen(false)
    setFilter('')
  }
  // ⚠ Escape in the filter is the filter's (#638): Radix closes the dialog from a capture listener
  // on the document, so the input cannot stop it — prevented here, as the command palette's pages
  // do. It clears the filter; with nothing left to clear it closes, like Escape anywhere else. The
  // filter is the picker's one `cmdk-input` (cmdk overrides any id we give it).
  const escapeFromFilter = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('input[cmdk-input]')) return
    if (filter.length === 0) return
    event.preventDefault()
    setFilter('')
  }
  return (
    <>
      <ChipButton
        ref={chip}
        label="Model"
        display={modelDisplay(models, chosen, loading)}
        onOpen={(): void => setOpen(true)}
        disabled={loading || models.length === 0}
        invalid={invalid}
      />
      <Dialog open={open} onOpenChange={(next: boolean): void => (next ? setOpen(true) : close())}>
        {/* ⚠ Closed, focus goes back to the chip: Radix returns it to a trigger of its own, and the
            chip is not one, so a keyboard user was left on the page's body. */}
        <DialogContent
          className="sm:max-w-lg"
          onEscapeKeyDown={escapeFromFilter}
          onCloseAutoFocus={(event: Event): void => {
            event.preventDefault()
            chip.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Model</DialogTitle>
            <DialogDescription>the session starts on it; each row names its provider</DialogDescription>
          </DialogHeader>
          <ModelList
            models={models}
            chosen={chosen}
            onChoose={(option: HostCommandOption): void => {
              onChoose(option)
              close()
            }}
            filter={filter}
            onFilter={setFilter}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
