import type { HostCommandOption } from '@enso/core'
import { useRef, useState } from 'react'
import { ModelPickerDialog } from './model-picker.tsx'
import { ChipButton } from './setting-chip.tsx'

/**
 * The launch panel's Model chip (#877) and the picker it opens (`model-picker.tsx`, #880): the models
 * the session may start on, Recent first, then by provider, the chosen one marked. Choosing one
 * closes the picker; nothing reaches the session until Start (#391).
 */

/** The chip's words for the chosen model: its name, or why there is none yet. */
function modelDisplay(models: readonly HostCommandOption[], chosen: string | undefined, loading: boolean): string {
  if (loading) return 'loading…'
  return models.find((option) => option.id === chosen)?.label ?? chosen ?? 'none'
}

export function LaunchModelChip({
  models,
  recent,
  chosen,
  onChoose,
  loading,
  invalid,
}: {
  readonly models: readonly HostCommandOption[]
  /** The recent model ids, newest first (`useRecentModels`). */
  readonly recent: readonly string[]
  readonly chosen: string | undefined
  readonly onChoose: (option: HostCommandOption) => void
  /** The models are still being read: the chip says so and opens nothing. */
  readonly loading: boolean
  readonly invalid: boolean
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLButtonElement | null>(null)
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
      <ModelPickerDialog
        open={open}
        listing={{ kind: 'loaded', options: models }}
        chosen={chosen}
        recent={recent}
        purpose="the session starts on it"
        onChoose={onChoose}
        onClose={(): void => setOpen(false)}
        returnFocus={(): void => chip.current?.focus()}
      />
    </>
  )
}
