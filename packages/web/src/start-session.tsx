import type { EnsoProject, EnsoSessionConfiguration, HostCommandOption, RuntimeCommand } from '@enso/core'
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
import { ChosenMark, OptionDetail, optionKeywords } from './model-state.tsx'
import {
  PI_DEFAULT_SYSTEM_PROMPT,
  PromptLibraryFields,
  type SystemPromptChoice,
  useSystemPromptChoice,
} from './start-session-prompts.tsx'

/**
 * The Start-a-session dialog (#391): a new thread opens on it — the model, the effort, the mode, the
 * system prompt (#443, pi's default or one from the library) and the first prompt, then **Start
 * session**. Before it a new thread was "dead" (Daniel, 2026-09-25):
 * it had no session until its first prompt, so the model chip, the effort and the palette had
 * nothing to read.
 *
 * ⚠ ALL AT ONCE, ON START (the decision on #391). Nothing here changes the session while the person
 * chooses; Start sends the settings in ONE request (`POST …/configure`), which the server
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
  /**
   * The dialog is done, either way: a Start that went through, or a dismissal — Escape, the close
   * button, outside — which first hands a typed prompt to `keepPrompt`.
   */
  readonly onClose: () => void
  /**
   * The dialog dismissed — Escape, the close button, outside — with a prompt typed: the words go to
   * the composer (#638), since nothing reopens this dialog for the thread.
   */
  readonly keepPrompt: (text: string) => void
  /** The thread's permission mode and the modes it offers — the composer's own store. */
  readonly mode: string | undefined
  readonly modes: readonly string[]
  /** `connection.configure`: the settings — system prompt, model, effort, mode — applied together. */
  readonly configure: (configuration: EnsoSessionConfiguration) => Promise<ConfigureOutcome>
  /** The chat's send: false when it refused (disconnected), and the dialog then stays open. */
  readonly send: (text: string) => boolean
  /** The thread's `fetch` — it names the thread's project (#395); injected by tests. */
  readonly fetch?: FetchLike
  /**
   * Where the session runs (#395), shown and NOT chosen here: the session was built for this
   * dialog, in this directory, and a different project is a different thread — the rail's `+`.
   * Undefined until the page has its projects.
   */
  readonly project?: EnsoProject | undefined
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

/**
 * Why a prompt beginning with `/` cannot start a session (#484): the slash commands belong to a
 * running session — pi registers them when one is built — so there is nothing for it to name yet.
 */
export const SLASH_PROMPT_REFUSAL = 'a / command needs a running session — start one with a prompt first'

/** A prompt that would be read as a slash command: the first non-blank character is `/`. */
export function isSlashPrompt(text: string): boolean {
  return text.trimStart().startsWith('/')
}

/** The session's models and current choices, from the host's catalogue — nothing built (#484). */
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
      return `the ${STEP_WORDS[outcome.step]} was refused: ${outcome.reason}`
    case 'failed':
      return `the server failed to apply the settings (${outcome.status}) — see the server log`
    case 'busy':
      return outcome.reason
    case 'unreachable':
      return 'the server could not be reached'
  }
}

const STEP_WORDS = { systemPrompt: 'system prompt', model: 'model', thinking: 'effort', mode: 'mode' } as const

function ModelField({
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
  return (
    <Field>
      <FieldLabel>Model</FieldLabel>
      {/* ⚠ cmdk sets the input's id itself, after ours: a `FieldLabel htmlFor` named nothing, and the
          filter read as a bare `combobox`. cmdk's own label is the one it wires to the input. */}
      <Command className="rounded-md border" label="Model">
        <CommandInput placeholder="filter models…" value={filter} onValueChange={onFilter} />
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
              <ChosenMark chosen={option.id === chosen} />
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
export function configurationOf(choices: {
  model: string | undefined
  thinking: string | undefined
  mode: string | undefined
  systemPrompt: string
}): EnsoSessionConfiguration {
  const configuration: { model?: string; thinking?: string; mode?: string; systemPrompt?: string | null } = {}
  for (const key of ['model', 'thinking', 'mode'] as const) {
    const chosen = choices[key]
    if (chosen !== undefined) configuration[key] = chosen
  }
  // Always said, pi's default as `null` (#443): a Start refused at a later step may already have
  // applied a library prompt, and a retry with pi's default must replace it, not leave it running.
  configuration.systemPrompt = choices.systemPrompt === PI_DEFAULT_SYSTEM_PROMPT ? null : choices.systemPrompt
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

/** The dialog's header, and why there are no fields when loading the session failed. */
function SessionStatus({
  catalogue,
  project,
}: {
  catalogue: Catalogue
  project: EnsoProject | undefined
}): React.ReactNode {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Start a session</DialogTitle>
        <DialogDescription>
          {project === undefined ? null : (
            <span title={project.path}>
              in <span className="font-medium text-foreground">{project.title}</span> ·{' '}
            </span>
          )}
          {catalogue.kind === 'loading' ? 'starting the session…' : 'applied together when you start'}
        </DialogDescription>
      </DialogHeader>
      {catalogue.kind === 'failed' ? <FieldError>{catalogue.detail}</FieldError> : null}
    </>
  )
}

/**
 * The composer's draft once a dismissed dialog hands it a prompt (#638): the prompt itself in an
 * empty composer, after what is there otherwise — neither the composer's words nor the dialog's lost.
 */
export function draftWithKeptPrompt(draft: string, prompt: string): string {
  return draft.trim().length > 0 ? `${draft}\n\n${prompt}` : prompt
}

interface SessionFieldsProps {
  readonly models: readonly HostCommandOption[]
  readonly model: string | undefined
  readonly onChooseModel: (option: HostCommandOption) => void
  readonly modelFilter: string
  readonly onModelFilter: (filter: string) => void
  readonly thinking: string | undefined
  readonly levels: readonly string[]
  readonly onThinking: (level: string) => void
  readonly mode: string | undefined
  readonly modes: readonly string[]
  readonly onMode: (mode: string) => void
  readonly promptChoice: SystemPromptChoice
  readonly fetch: FetchLike | undefined
  readonly text: string
  readonly onText: (text: string) => void
  /** The prompt box, focused by the dialog once the fields exist. */
  readonly promptField: React.RefObject<HTMLTextAreaElement | null>
  readonly onStart: () => Promise<void>
  readonly slash: boolean
  readonly refusal: string | undefined
}

/** The fields of a loaded session: model, effort and mode, the prompt libraries, the prompt, and why Start is held. */
function SessionFields(props: SessionFieldsProps): React.ReactNode {
  return (
    <FieldGroup>
      <ModelField
        models={props.models}
        chosen={props.model}
        onChoose={props.onChooseModel}
        filter={props.modelFilter}
        onFilter={props.onModelFilter}
      />
      <div className="grid grid-cols-2 gap-3">
        <ChoiceField field={EFFORT_FIELD} value={props.thinking} choices={props.levels} onChoose={props.onThinking} />
        <ChoiceField field={MODE_FIELD} value={props.mode} choices={props.modes} onChoose={props.onMode} />
      </div>
      <PromptLibraryFields choice={props.promptChoice} fetch={props.fetch} onPick={props.onText} />
      <Field>
        <FieldLabel htmlFor="start-session-prompt">Prompt</FieldLabel>
        {/* Capped (#679): the Textarea grows with its text, and a long prompt pushed the dialog's
            footer below the window; past this height it scrolls inside itself. */}
        <Textarea
          className="max-h-40"
          ref={props.promptField}
          id="start-session-prompt"
          value={props.text}
          rows={4}
          placeholder="ask pi something"
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => props.onText(event.target.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>): void => startOnEnter(event, props.onStart)}
        />
      </Field>
      {props.slash ? <FieldError>{SLASH_PROMPT_REFUSAL}</FieldError> : null}
      {props.refusal === undefined ? null : <FieldError>{props.refusal}</FieldError>}
    </FieldGroup>
  )
}

/** Close dismisses; Start session is held until the prompt is ready, and says so while it starts. */
function SessionFooter({
  ready,
  applying,
  onDismiss,
  onStart,
}: {
  readonly ready: boolean
  readonly applying: boolean
  readonly onDismiss: () => void
  readonly onStart: () => Promise<void>
}): React.ReactNode {
  return (
    // Opaque while pinned: the footer's own `bg-muted/50` would show the fields scrolling under it;
    // `bg-dialog-footer` is that same tint mixed over the dialog's background.
    <DialogFooter className="sticky bottom-0 bg-dialog-footer">
      <Button variant="ghost" onClick={onDismiss}>
        Close
      </Button>
      <Button disabled={!ready} onClick={(): void => void onStart()}>
        {applying ? 'Starting…' : 'Start session'}
      </Button>
    </DialogFooter>
  )
}

export function StartSessionDialog(props: StartSessionDialogProps): React.ReactNode {
  const { threadId, open, onClose, fetch: fetchImpl } = props
  const catalogue = useSessionCatalogue(open, threadId, fetchImpl)
  const promptChoice = useSystemPromptChoice(open, threadId, fetchImpl)
  const [model, setModel] = useState<string | undefined>(undefined)
  const [thinking, setThinking] = useState<string | undefined>(undefined)
  // Only what the user picked is held: until then the field follows the thread's own mode (#391).
  const [chosenMode, setMode] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const [modelFilter, setModelFilter] = useState('')
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
  // The mode to offer: the one chosen, else the thread's, else the first it offers.
  const mode = chosenMode ?? props.mode ?? props.modes[0]

  const levels = levelsOf(catalogue, model)
  const chooseModel = (option: HostCommandOption): void => {
    setModel(option.id)
    setThinking((wanted) => effortFor(option.thinkingLevels ?? levels, wanted))
  }
  const slash = isSlashPrompt(text)
  const ready = !applying && catalogue.kind === 'loaded' && text.trim().length > 0 && !slash
  const start = async (): Promise<void> => {
    if (!ready) return
    setApplying(true)
    setRefusal(undefined)
    const refused = await startWith(
      props,
      configurationOf({ model, thinking, mode, systemPrompt: promptChoice.systemPrompt }),
      text,
    )
    setApplying(false)
    if (refused === undefined) onClose()
    else setRefusal(refused)
  }

  // Any close but a Start (#638): a typed prompt is the composer's now, not gone with the dialog.
  const dismiss = (): void => {
    if (text.trim().length > 0) props.keepPrompt(text)
    setText('')
    setModelFilter('')
    onClose()
  }
  // ⚠ Escape in the model filter is the filter's (#638): Radix closes the dialog from a capture
  // listener on the document, so the input cannot stop it — prevented here, as the command
  // palette's pages do. It clears the filter; with nothing left to clear it closes, like Escape
  // anywhere else, as the palette's Backspace does. The filter is the dialog's
  // one `cmdk-input` (cmdk overrides any id we give it).
  const escapeFromFilter = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('input[cmdk-input]')) return
    if (modelFilter.length === 0) return
    event.preventDefault()
    setModelFilter('')
  }

  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => (next ? undefined : dismiss())}>
      {/* The dialog scrolls once it is taller than the window (`DialogContent`, #679); the footer stays
          pinned to its bottom so Start session never scrolls out of reach, and the scroll padding keeps
          a focused field — the prompt's caret — from being revealed underneath it. */}
      <DialogContent className="scroll-pb-20 sm:max-w-lg" onEscapeKeyDown={escapeFromFilter}>
        <SessionStatus catalogue={catalogue} project={props.project} />
        {catalogue.kind === 'loaded' ? (
          <SessionFields
            models={catalogue.models}
            model={model}
            onChooseModel={chooseModel}
            modelFilter={modelFilter}
            onModelFilter={setModelFilter}
            thinking={thinking}
            levels={levels}
            onThinking={setThinking}
            mode={mode}
            modes={props.modes}
            onMode={setMode}
            promptChoice={promptChoice}
            fetch={fetchImpl}
            text={text}
            onText={setText}
            promptField={promptField}
            onStart={start}
            slash={slash}
            refusal={refusal}
          />
        ) : null}
        <SessionFooter ready={ready} applying={applying} onDismiss={dismiss} onStart={start} />
      </DialogContent>
    </Dialog>
  )
}
