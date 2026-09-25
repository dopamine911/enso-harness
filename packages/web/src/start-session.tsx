import type { EnsoSessionConfiguration, HostCommandOption, RuntimeCommand } from '@enso/core'
import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { fetchThreadCommands } from './commands-connection.ts'
import { Button } from './components/ui/button.tsx'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './components/ui/command.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './components/ui/field.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { Textarea } from './components/ui/textarea.tsx'
import type { ConfigureOutcome } from './follow-connection.ts'
import { OptionDetail, optionKeywords } from './model-state.tsx'

/**
 * The Start-a-session dialog (#391): a new thread opens on it — the model, the effort, the mode and
 * the first prompt, then **Start session**. Before it a new thread was "dead" (Daniel, 2026-09-25):
 * it had no session until its first prompt, so the model chip, the effort and the palette had
 * nothing to read.
 *
 * ⚠ ALL AT ONCE, ON START (the decision on #391). Nothing here changes the session while the person
 * chooses; Start sends the three settings in ONE request (`POST …/configure`), which the server
 * applies in order under one lease and refuses by NAMING the step — the dialog stays open and says
 * it. Only then does the first prompt go, through the chat's own send, so the message bubble and the
 * run are exactly the composer's.
 *
 * The effort list is the CHOSEN model's (each `/model` option carries its levels, #391), not the
 * session's current one: that is what "all at once" needs. Opening the dialog asks the commands
 * route, which builds the thread's session if it is not live (#390) — the only wait, said as
 * "starting the session…".
 */

export interface StartSessionDialogProps {
  readonly threadId: string
  readonly open: boolean
  /** Escape, the close button, or a Start that went through. The composer stays as it is. */
  readonly onClose: () => void
  /** The thread's permission mode and the modes it offers — the composer's own store. */
  readonly mode: string | undefined
  readonly modes: readonly string[]
  /** `connection.configure`: the three settings, applied together. */
  readonly configure: (configuration: EnsoSessionConfiguration) => Promise<ConfigureOutcome>
  /** The chat's send: false when it refused (disconnected), and the dialog then stays open. */
  readonly send: (text: string) => boolean
  /** The connection's `fetch` — injected by tests, the page's global by default. */
  readonly fetch?: FetchLike
}

type Catalogue =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded'
      readonly models: readonly HostCommandOption[]
      readonly model: string | undefined
      readonly thinking: string | undefined
      /** The CURRENT model's levels — the fallback for an option that carries none. */
      readonly thinkingLevels: readonly string[]
    }
  | { readonly kind: 'failed'; readonly detail: string }

function hostRow(commands: readonly RuntimeCommand[], name: string): RuntimeCommand | undefined {
  return commands.find((command) => command.source === 'host' && command.name === name)
}

/** The session's models and current choices, from the thread's own command list (built on ask, #390). */
async function loadCatalogue(threadId: string, fetchImpl: FetchLike | undefined): Promise<Catalogue> {
  try {
    const listed = await fetchThreadCommands(threadId, fetchImpl)
    const model = hostRow(listed.commands, 'model')
    const thinking = hostRow(listed.commands, 'thinking')
    const models = model?.options ?? []
    if (models.length === 0) {
      return { kind: 'failed', detail: 'no model to run on — log in to a provider first (/login)' }
    }
    return {
      kind: 'loaded',
      models,
      model: model?.value,
      thinking: thinking?.value,
      thinkingLevels: (thinking?.options ?? []).map((option) => option.id),
    }
  } catch (failure: unknown) {
    return { kind: 'failed', detail: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * The effort to keep when the model changes: the chosen one if the new model offers it, else
 * `medium` if it does, else its highest. The server checks it against the model all the same.
 */
export function effortFor(levels: readonly string[], wanted: string | undefined): string | undefined {
  if (wanted !== undefined && levels.includes(wanted)) return wanted
  if (levels.includes('medium')) return 'medium'
  return levels.at(-1)
}

/** What the dialog says when Start did not go through. */
function refusalText(outcome: Exclude<ConfigureOutcome, { outcome: 'told' }>): string {
  switch (outcome.outcome) {
    case 'refused':
      return outcome.step === undefined
        ? outcome.reason
        : `the ${STEP_WORDS[outcome.step]} was refused: ${outcome.reason}`
    case 'busy':
      return outcome.reason
    case 'unreachable':
      return 'the server could not be reached'
  }
}

const STEP_WORDS = { model: 'model', thinking: 'effort', mode: 'mode' } as const

function ModelField({
  models,
  chosen,
  onChoose,
}: {
  models: readonly HostCommandOption[]
  chosen: string | undefined
  onChoose: (option: HostCommandOption) => void
}): React.ReactNode {
  return (
    <Field>
      <FieldLabel htmlFor="start-session-model">Model</FieldLabel>
      <Command className="rounded-md border">
        <CommandInput id="start-session-model" placeholder="filter models…" />
        <CommandList className="max-h-48">
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
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </Field>
  )
}

/** A labelled select's words: its id (the label's target), its label, and the line under it. */
interface FieldText {
  readonly id: string
  readonly label: string
  readonly description: string
}

const EFFORT_FIELD: FieldText = {
  id: 'start-session-effort',
  label: 'Effort',
  description: 'the levels this model offers',
}
const MODE_FIELD: FieldText = { id: 'start-session-mode', label: 'Mode', description: 'what pi may do without asking' }

function ChoiceField(props: {
  field: FieldText
  value: string | undefined
  choices: readonly string[]
  onChoose: (value: string) => void
}): React.ReactNode {
  const { field, choices } = props
  return (
    <Field>
      <FieldLabel htmlFor={field.id}>{field.label}</FieldLabel>
      <Select value={props.value ?? ''} onValueChange={props.onChoose} disabled={choices.length === 0}>
        <SelectTrigger id={field.id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{field.description}</FieldDescription>
    </Field>
  )
}

/** The session's catalogue, read afresh each time the dialog opens (the read builds the session, #390). */
function useSessionCatalogue(open: boolean, threadId: string, fetchImpl: FetchLike | undefined): Catalogue {
  const [catalogue, setCatalogue] = useState<Catalogue>({ kind: 'loading' })
  useEffect(() => {
    if (!open) return
    let current = true
    setCatalogue({ kind: 'loading' })
    void loadCatalogue(threadId, fetchImpl).then((loaded) => {
      if (current) setCatalogue(loaded)
    })
    return (): void => {
      current = false
    }
  }, [open, threadId, fetchImpl])
  return catalogue
}

/**
 * Start: the settings together, then the prompt through the chat's send. `undefined` when the
 * session started; otherwise what the dialog says, and nothing was sent.
 */
async function startWith(
  props: Pick<StartSessionDialogProps, 'configure' | 'send'>,
  configuration: EnsoSessionConfiguration,
  text: string,
): Promise<string | undefined> {
  const outcome = await props.configure(configuration)
  if (outcome.outcome !== 'told') return refusalText(outcome)
  return props.send(text) ? undefined : 'the prompt could not be sent — the page is disconnected; reload'
}

/** The chosen settings as the configure body: a choice not made is not sent (the server keeps what it has). */
function configurationOf(choices: {
  model: string | undefined
  thinking: string | undefined
  mode: string | undefined
}): EnsoSessionConfiguration {
  const configuration: { model?: string; thinking?: string; mode?: string } = {}
  for (const key of ['model', 'thinking', 'mode'] as const) {
    const chosen = choices[key]
    if (chosen !== undefined) configuration[key] = chosen
  }
  return configuration
}

/** The effort the dialog offers: the chosen model's levels, or the current model's when its option carries none. */
function levelsOf(catalogue: Catalogue, model: string | undefined): readonly string[] {
  if (catalogue.kind !== 'loaded') return []
  return catalogue.models.find((option) => option.id === model)?.thinkingLevels ?? catalogue.thinkingLevels
}

/** Enter starts, as the composer sends; Shift+Enter is a new line. */
function startOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>, start: () => Promise<void>): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void start()
}

/** The mode to offer: the one already chosen, else the thread's, else the first it offers. */
function initialMode(
  chosen: string | undefined,
  current: string | undefined,
  offered: readonly string[],
): string | undefined {
  return chosen ?? current ?? offered[0]
}

/** The dialog's header, and why there are no fields when loading the session failed. */
function SessionStatus({ catalogue }: { catalogue: Catalogue }): React.ReactNode {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Start a session</DialogTitle>
        <DialogDescription>
          {catalogue.kind === 'loading' ? 'starting the session…' : 'applied together when you start'}
        </DialogDescription>
      </DialogHeader>
      {catalogue.kind === 'failed' ? <FieldError>{catalogue.detail}</FieldError> : null}
    </>
  )
}

export function StartSessionDialog(props: StartSessionDialogProps): React.ReactNode {
  const { threadId, open, onClose, fetch: fetchImpl } = props
  const catalogue = useSessionCatalogue(open, threadId, fetchImpl)
  const [model, setModel] = useState<string | undefined>(undefined)
  const [thinking, setThinking] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const [applying, setApplying] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const promptField = useRef<HTMLTextAreaElement | null>(null)
  // The choices start from the session's own state; the prompt takes focus once the fields exist —
  // the dialog opened before they did, so Radix could only focus the footer's Close.
  useEffect(() => {
    if (catalogue.kind !== 'loaded') return
    setModel(catalogue.model ?? catalogue.models[0]?.id)
    setThinking(catalogue.thinking)
    promptField.current?.focus()
  }, [catalogue])
  useEffect(() => setMode((chosen) => initialMode(chosen, props.mode, props.modes)), [props.mode, props.modes])

  const levels = levelsOf(catalogue, model)
  const chooseModel = (option: HostCommandOption): void => {
    setModel(option.id)
    setThinking((wanted) => effortFor(option.thinkingLevels ?? levels, wanted))
  }
  const ready = !applying && catalogue.kind === 'loaded' && text.trim().length > 0
  const start = async (): Promise<void> => {
    if (!ready) return
    setApplying(true)
    setRefusal(undefined)
    const refused = await startWith(props, configurationOf({ model, thinking, mode }), text)
    setApplying(false)
    if (refused === undefined) onClose()
    else setRefusal(refused)
  }

  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <SessionStatus catalogue={catalogue} />
        {catalogue.kind === 'loaded' ? (
          <FieldGroup>
            <ModelField models={catalogue.models} chosen={model} onChoose={chooseModel} />
            <div className="grid grid-cols-2 gap-3">
              <ChoiceField field={EFFORT_FIELD} value={thinking} choices={levels} onChoose={setThinking} />
              <ChoiceField field={MODE_FIELD} value={mode} choices={props.modes} onChoose={setMode} />
            </div>
            <Field>
              <FieldLabel htmlFor="start-session-prompt">Prompt</FieldLabel>
              <Textarea
                ref={promptField}
                id="start-session-prompt"
                value={text}
                rows={4}
                placeholder="ask pi something"
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => setText(event.target.value)}
                onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>): void => startOnEnter(event, start)}
              />
            </Field>
            {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
          </FieldGroup>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!ready} onClick={(): void => void start()}>
            {applying ? 'Starting…' : 'Start session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
