import type { EnsoConfigurationRefusal, EnsoSessionConfiguration, HostCommandOption, RuntimeCommand } from '@enso/core'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { fetchThreadCommands } from './commands-connection.ts'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { SelectItem } from './components/ui/select.tsx'
import type { ConfigureOutcome } from './follow-connection.ts'
import { useFreshRead } from './fresh-read.ts'
import { LaunchModelChip } from './launch-model.tsx'
import {
  LibraryNotes,
  PI_DEFAULT_SYSTEM_PROMPT,
  SavedPromptChip,
  type SystemPromptChoice,
  SystemPromptChip,
  useSystemPromptChoice,
} from './launch-prompts.tsx'
import { useChatContext } from './pane-context.ts'
import { usePermissionMode } from './permission-mode.tsx'
import { SettingChip } from './setting-chip.tsx'
import { useStore, useThreadStores } from './store.ts'

/**
 * The settings a new thread's session starts with (#391, #877): the model, the effort, the mode and
 * the system prompt (#443), chosen on the launch panel's chips, and **Start session**, which applies
 * them and sends the first prompt.
 *
 * ⚠ ALL AT ONCE, ON START (the decision on #391). Nothing here changes the session while the person
 * chooses; Start sends the settings in ONE request (`POST …/configure`), which the server applies in
 * order under one lease and refuses by NAMING the step — the panel stays and says it, the prompt
 * kept. Only then does the first prompt go, through the composer's own send, so the message bubble
 * and the run are exactly the composer's.
 *
 * The effort list is the CHOSEN model's (each `/model` option carries its levels, #391), not the
 * session's current one: that is what "all at once" needs. Nothing is built to offer them: the
 * commands route answers a thread with no session from the host's catalogue (#484).
 */

/**
 * Why a prompt beginning with `/` cannot start a session (#484): the slash commands belong to a
 * running session — pi registers them when one is built — so there is nothing for it to name yet.
 */
export const SLASH_PROMPT_REFUSAL = 'a / command needs a running session — start one with a prompt first'

/** A prompt that would be read as a slash command: the first non-blank character is `/`. */
export function isSlashPrompt(text: string): boolean {
  return text.trimStart().startsWith('/')
}

/**
 * Whether the thread on this pane shows its launch panel (#877): raised for a thread not started,
 * until Start goes through — or until a prompt reaches it some other way (another tab's), when its
 * transcript is what there is to show. ⚠ A PROMPT, not any message: a Start refused at a later
 * step has still built the session, whose first run (the configure's) opens an assistant message
 * for its startup receipts — the panel must stay, saying why Start did not go through.
 */
export function useLaunching(): boolean {
  const launch = useStore(useThreadStores().launch)
  const chat = useChatContext()
  return launch && !chat.messages.some((message) => message.role === 'user')
}

type Catalogue =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded'
      readonly models: readonly HostCommandOption[]
      readonly model: string | undefined
      /** The session's own level, when it has a session: what its own model runs at now. */
      readonly thinking: string | undefined
      /** The CURRENT model's levels — the fallback for an option that carries none. */
      readonly thinkingLevels: readonly string[]
    }
  | { readonly kind: 'failed'; readonly detail: string }

function hostRow(commands: readonly RuntimeCommand[], name: string): RuntimeCommand | undefined {
  return commands.find((command) => command.source === 'host' && command.name === name)
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

/** A catalogue that holds needs no other read; one that failed is read again at the next showing. */
const catalogueLoaded = (catalogue: Catalogue): boolean => catalogue.kind === 'loaded'

/**
 * The model the session starts on: the one picked, else the session's own (the configured default,
 * #674), else the first offered.
 */
function modelOf(catalogue: Catalogue, picked: string | undefined): string | undefined {
  if (catalogue.kind !== 'loaded') return undefined
  return picked ?? catalogue.model ?? catalogue.models[0]?.id
}

/** The effort levels offered: the chosen model's, or the current model's when its option carries none. */
function levelsOf(catalogue: Catalogue, model: string | undefined): readonly string[] {
  if (catalogue.kind !== 'loaded') return []
  return catalogue.models.find((option) => option.id === model)?.thinkingLevels ?? catalogue.thinkingLevels
}

/**
 * The effort the session will run at (#852): the level picked, while the chosen model offers it;
 * else, on the session's own model, the level it runs at now; else the level the host says the
 * model runs at once chosen (`defaultThinkingLevel`, pi's settings). Never a level guessed here —
 * `undefined` only when the host says none, and the chip then says pi's default applies.
 */
function effortOf(catalogue: Catalogue, model: string | undefined, picked: string | undefined): string | undefined {
  if (catalogue.kind !== 'loaded') return undefined
  if (picked !== undefined && levelsOf(catalogue, model).includes(picked)) return picked
  if (model === catalogue.model && catalogue.thinking !== undefined) return catalogue.thinking
  return catalogue.models.find((option) => option.id === model)?.defaultThinkingLevel
}

/** What Start did not do, and the step it stopped at when the server named one. */
export interface LaunchRefusal {
  readonly text: string
  readonly step?: EnsoConfigurationRefusal['step']
}

const STEP_WORDS = { systemPrompt: 'system prompt', model: 'model', thinking: 'effort', mode: 'mode' } as const

/** What the panel says when the settings did not go through. */
function refusalOf(outcome: Exclude<ConfigureOutcome, { outcome: 'told' }>): LaunchRefusal {
  switch (outcome.outcome) {
    case 'refused':
      return { text: `the ${STEP_WORDS[outcome.step]} was refused: ${outcome.reason}`, step: outcome.step }
    case 'failed':
      return { text: `the server failed to apply the settings (${outcome.status}) — see the server log` }
    case 'busy':
      return { text: outcome.reason }
    case 'unreachable':
      return { text: 'the server could not be reached' }
  }
}

/** The launch panel's form: the settings chosen, and Start's state. */
export interface LaunchForm {
  readonly catalogue: Catalogue
  readonly model: string | undefined
  readonly chooseModel: (option: HostCommandOption) => void
  readonly effort: string | undefined
  readonly levels: readonly string[]
  readonly chooseEffort: (level: string) => void
  readonly mode: string | undefined
  readonly modes: readonly string[]
  readonly chooseMode: (mode: string) => void
  readonly prompts: SystemPromptChoice
  readonly applying: boolean
  readonly refusal: LaunchRefusal | undefined
  /**
   * Start: the settings in one request, then the prompt through `send`. Resolves once the session
   * started — the panel gives way to the transcript — and REJECTS when it did not, the refusal said:
   * the form keeps its draft and its attachments for a retry.
   */
  readonly start: (send: () => boolean) => Promise<void>
}

/**
 * The settings as the configure body (#391): every setting the panel shows, sent as shown. The
 * effort is the level the session runs at (#852) — picked, or the host's — and goes only when there
 * is one. pi's default system prompt is said as `null` (#443): a Start refused at a later step may
 * already have applied a library prompt, and a retry with pi's default must replace it.
 */
function configurationOf(form: Pick<LaunchForm, 'model' | 'effort' | 'mode' | 'prompts'>): EnsoSessionConfiguration {
  const { systemPrompt } = form.prompts
  return {
    ...(form.model === undefined ? {} : { model: form.model }),
    ...(form.effort === undefined ? {} : { thinking: form.effort }),
    ...(form.mode === undefined ? {} : { mode: form.mode }),
    systemPrompt: systemPrompt === PI_DEFAULT_SYSTEM_PROMPT ? null : systemPrompt,
  }
}

/** The disconnected page's refusal: the settings applied, but the prompt had nowhere to go. */
const NOT_SENT: LaunchRefusal = { text: 'the prompt could not be sent — the page is disconnected; reload' }

/**
 * The launch panel's form for the thread on this pane. `active` while the panel is on screen: only
 * then are the models and the prompt libraries read.
 */
export function useLaunchForm(active: boolean): LaunchForm {
  const stores = useThreadStores()
  const permission = usePermissionMode()
  // The session's catalogue, read when the panel is shown (#883: only the pane on screen asks), and
  // again at a later showing until it has loaded — a login made meanwhile is then offered.
  const catalogue = useFreshRead<Catalogue>(
    active,
    stores.threadId,
    () => loadCatalogue(stores.threadId, stores.fetch),
    catalogueLoaded,
  )
  const prompts = useSystemPromptChoice(active, stores.threadId, stores.fetch)
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined)
  const [pickedEffort, setPickedEffort] = useState<string | undefined>(undefined)
  // Only what the user picked is held: until then the chip follows the thread's own mode (#391).
  const [pickedMode, setPickedMode] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const [refusal, setRefusal] = useState<LaunchRefusal | undefined>(undefined)
  const model = modelOf(catalogue, pickedModel)
  const settings = {
    model,
    effort: effortOf(catalogue, model, pickedEffort),
    mode: pickedMode ?? permission.mode ?? permission.available[0],
    prompts,
  }
  const start = async (send: () => boolean): Promise<void> => {
    setApplying(true)
    setRefusal(undefined)
    const outcome = await stores.connection.configure(configurationOf(settings))
    // The settings refused say why; applied, the prompt goes — and a page that cannot send it says so.
    let refused: LaunchRefusal | undefined
    if (outcome.outcome !== 'told') refused = refusalOf(outcome)
    else if (!send()) refused = NOT_SENT
    setApplying(false)
    if (refused !== undefined) {
      setRefusal(refused)
      throw new Error(refused.text)
    }
    stores.launch.set(false)
  }
  return {
    ...settings,
    catalogue,
    chooseModel: (option: HostCommandOption): void => setPickedModel(option.id),
    levels: levelsOf(catalogue, model),
    chooseEffort: setPickedEffort,
    modes: permission.available,
    chooseMode: setPickedMode,
    applying,
    refusal,
    start,
  }
}

/**
 * What the Effort chip says when the host names no level: the session takes pi's own. Not while the
 * models are read: the host may yet name one, so the chip says it is loading, as the Model chip does.
 */
const PI_DEFAULT_EFFORT = "pi's default"

/** The launch panel's chips, inside the composer: Model, Effort, Mode, System prompt — and a saved prompt for the box. */
export function LaunchChips({
  form,
  onSavedPrompt,
}: {
  readonly form: LaunchForm
  /** A saved prompt's text, for the composer. */
  readonly onSavedPrompt: (text: string) => void
}): React.ReactNode {
  const stores = useThreadStores()
  const { catalogue } = form
  const refusedAt = form.refusal?.step
  return (
    <div role="group" aria-label="Session settings" className="flex flex-wrap items-center gap-2 px-1 pb-1">
      <LaunchModelChip
        models={catalogue.kind === 'loaded' ? catalogue.models : []}
        chosen={form.model}
        onChoose={form.chooseModel}
        loading={catalogue.kind === 'loading'}
        invalid={refusedAt === 'model'}
      />
      <SettingChip
        label="Effort"
        value={form.effort ?? ''}
        display={catalogue.kind === 'loading' ? 'loading…' : (form.effort ?? PI_DEFAULT_EFFORT)}
        onChoose={form.chooseEffort}
        disabled={form.levels.length === 0}
        invalid={refusedAt === 'thinking'}
      >
        {form.levels.map((level) => (
          <SelectItem key={level} value={level}>
            {level}
          </SelectItem>
        ))}
      </SettingChip>
      <SettingChip
        label="Mode"
        value={form.mode ?? ''}
        display={form.mode ?? 'not known yet'}
        onChoose={form.chooseMode}
        disabled={form.modes.length === 0}
        invalid={refusedAt === 'mode'}
      >
        {form.modes.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {mode}
          </SelectItem>
        ))}
      </SettingChip>
      <SystemPromptChip choice={form.prompts} invalid={refusedAt === 'systemPrompt'} />
      <SavedPromptChip choice={form.prompts} fetch={stores.fetch} onPick={onSavedPrompt} />
    </div>
  )
}

/** Under the chips: why there are no models, what the libraries refused, and why the last Start did not go through. */
export function LaunchNotes({ form }: { readonly form: LaunchForm }): React.ReactNode {
  return (
    <>
      {form.catalogue.kind === 'failed' ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {form.catalogue.detail}
        </p>
      ) : null}
      <LibraryNotes choice={form.prompts} />
      {form.refusal === undefined ? null : (
        <Alert variant="destructive" className="mb-2">
          <AlertTitle>The session didn’t start</AlertTitle>
          <AlertDescription>{form.refusal.text}</AlertDescription>
        </Alert>
      )}
    </>
  )
}
