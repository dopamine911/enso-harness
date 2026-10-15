import type {
  EnsoModelObservation,
  EnsoModelState,
  EnsoRecordedModel,
  HostCommandOption,
  RuntimeCommand,
} from '@enso/core'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { fetchThreadCommands } from './commands-connection.ts'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
} from './components/ai-elements/model-selector.tsx'
import { SelectItem } from './components/ui/select.tsx'
import { ChosenMark, ModelPicker, optionKeywords, rankOption } from './model-picker.tsx'
import { ChipButton, SettingChip } from './setting-chip.tsx'
import { createStore, type Store, useStore, useThreadStores } from './store.ts'

/**
 * The model the thread runs and how hard it thinks, as STATE — and the two composer controls
 * that change them (#338 slice 2; the control half of #44).
 *
 * `permission-mode.tsx` is the pattern: one per-thread store, fed by the wire and never by a
 * click, with the widgets beside it reading the store. The feed is the snapshot's `model`
 * (the session's state when the follow opens) and the `model` observation the host emits after
 * a `/model` or `/thinking` run — the change actually made, from pi's own `model_select` event,
 * not the option the user clicked. Invariant 2: a route tells pi; the feed ends the story.
 *
 * ⚠ HONESTY RULE. The store is `null` — the chip reads `Model: default until the thread runs` —
 * until a live snapshot or observation has said otherwise. A stored thread has no live session
 * and the server does not guess (`EnsoFollowSnapshot.model` is `null` then); a fresh thread
 * has not built one. A snapshot with `null` REPLACES a known state rather than being ignored:
 * a reconnect's snapshot is the resync, and a thread that idled out between two follows has no
 * model this page can vouch for. The permission-mode store keeps its `seed` guard because it
 * seeds from a second source (`/api/mode`); this one has one source, the follow.
 *
 * ⚠ ENABLED WHILE NOT LIVE — ON PURPOSE (#341). The Effort chip hides when nothing is known
 * (no levels to offer), but the model chip stays a button: choosing the model BEFORE the first
 * prompt is the case this exists for — "the default is Cursor, I have no Cursor" — and a
 * not-yet-run thread BUILDS on `POST …/command` so the choice lands in the session the first
 * prompt will run in. The dialog's options do not come from this store (which has nothing then):
 * they come from a fresh `GET …/commands`, whose `model` row lists what the host offers — the
 * host's `catalogue` for a thread that never ran (#484), the same models a session would list.
 *
 * ⓘ ONE STORE PER THREAD (#90 PR 3): created by `thread-stores.ts`, read through `useThreadStores()`.
 *
 * ⓘ RECORDED, NOT LIVE (#434). A cold thread's snapshot carries `recordedModel` — what its branch
 * last ran on (the last `model_change` / `thinking_level_change`, what pi restores on open). That
 * is NOT a live state and never enters this store: it rides in `recorded`, and the chip shows it
 * only while the store is `null`, named `Model (recorded)`. The Effort chip still hides
 * then — the levels a model offers are pi's to declare once built. Every snapshot replaces
 * `recorded` too, so a thread that went live (no `recordedModel`) drops it.
 */

export interface ModelStore extends Store<EnsoModelState | null> {
  /** What a cold thread's branch records (#434); `null` when live or when the branch records none. */
  readonly recorded: Store<EnsoRecordedModel | null>
  /** A snapshot's `model` and `recordedModel` — validated by the router before they land here. */
  readonly applySnapshot: (model: EnsoModelState | null, recorded: EnsoRecordedModel | undefined) => void
  /** A `model` observation: the state after pi applied a change, whoever asked for it. */
  readonly applyObservation: (observation: EnsoModelObservation) => void
}

export function createModelStore(): ModelStore {
  const store = createStore<EnsoModelState | null>(null)
  const recorded = createStore<EnsoRecordedModel | null>(null)
  return {
    get: store.get,
    subscribe: store.subscribe,
    recorded: { get: recorded.get, subscribe: recorded.subscribe },
    applySnapshot: (model: EnsoModelState | null, recordedModel: EnsoRecordedModel | undefined): void => {
      recorded.set(recordedModel ?? null)
      store.set(model)
    },
    applyObservation: ({ model, thinkingLevel, availableThinkingLevels }: EnsoModelObservation): void =>
      store.set({ model, thinkingLevel, availableThinkingLevels }),
  }
}

/** The rendering thread's model state; `null` until the follow has said. */
export function useModelState(): EnsoModelState | null {
  return useStore(useThreadStores().model)
}

/**
 * Whether the rendering thread can answer a read yet (#620, #659): a live session (its model), or the
 * thread's latch (`ThreadStores.readable`: once seen with a session or messages, for good). A
 * thread just minted has neither, and its routes answer 404 — every read there was a console
 * error for a view that can only say nothing has run. ⚠ Never the model alone:
 * a resync nulls it when the session idles out, and a thread that ran would read as never run.
 */
export function useThreadReadable(): boolean {
  const model = useModelState()
  const readable = useStore(useThreadStores().readable)
  return readable || model !== null
}

/** The rendering thread's recorded model (#434); `null` when live or when its branch records none. */
export function useRecordedModel(): EnsoRecordedModel | null {
  return useStore(useThreadStores().model.recorded)
}

/** The chip's value while the store is `null` — worded so a reader knows a choice is still open, not missing. */
export const MODEL_NOT_LIVE = 'default until the thread runs'
/** A live session that resolved no model — pi reports `model` undefined then. */
const MODEL_NONE = 'none'
/** The chip's name for a cold thread's recorded model (#434) — so it never reads as live. */
const MODEL_RECORDED = 'Model (recorded)'

/** A recorded model as the chip says it: `claude-sonnet-5 · anthropic · medium`, each half only if the branch recorded it. */
function recordedModelText(recorded: EnsoRecordedModel): string {
  const parts = recorded.model === null ? [] : [recorded.model.modelId, recorded.model.provider]
  if (recorded.thinkingLevel !== null) parts.push(recorded.thinkingLevel)
  return parts.join(' · ')
}

export interface EffortChipProps {
  readonly state: EnsoModelState | null
  /** Called with the chosen level; never with the current one (re-selecting it is a no-op here). */
  readonly onSelect: (level: string) => void
}

/**
 * The composer's Effort chip (#878): the thinking level, over the levels the host offers
 * (`getAvailableThinkingLevels()` — pi's are discrete, so a list is the truthful widget; there is no
 * slider on purpose). The launch panel's chip (#877), so the row is one control. Renders NOTHING
 * while the store is `null`: the levels are pi's to declare, not ours to assume.
 */
export function EffortChip({ state, onSelect }: EffortChipProps): React.ReactNode {
  if (state === null) return null
  const { thinkingLevel, availableThinkingLevels } = state
  // The current level always offered even if the list somehow omitted it — the readout never lies about what it was told.
  const levels = availableThinkingLevels.includes(thinkingLevel)
    ? availableThinkingLevels
    : [...availableThinkingLevels, thinkingLevel]
  return (
    <SettingChip
      label="Effort"
      value={thinkingLevel}
      display={thinkingLevel}
      onChoose={(next: string): void => {
        if (next !== thinkingLevel) onSelect(next)
      }}
    >
      {levels.map((level) => (
        <SelectItem key={level} value={level}>
          {level}
        </SelectItem>
      ))}
    </SettingChip>
  )
}

export interface ModelChipProps {
  readonly state: EnsoModelState | null
  /** What a cold thread's branch records (#434); shown only while `state` is `null`. */
  readonly recorded?: EnsoRecordedModel | null
  /** The role the thread runs under (#904): its name leads the chip's value, `review · …`, live or recorded. */
  readonly roleName?: string | null
  /** Open the model dialog — the owner renders it (`composer.tsx`), the same one the palette's `/model` row opens. */
  readonly onOpen: () => void
  /** That dialog is open: the chip is drawn open. */
  readonly open?: boolean
  /** The chip, for the model picker to hang from (#417). */
  readonly ref?: React.Ref<HTMLButtonElement>
}

/** What the chip says: its name and its value — the model and its provider; none; the recorded model, so named; the not-live sentence. */
function chipFace(
  state: EnsoModelState | null,
  recorded: EnsoRecordedModel | null,
): { readonly label: string; readonly display: string } {
  if (state === null) {
    return recorded === null
      ? { label: 'Model', display: MODEL_NOT_LIVE }
      : { label: MODEL_RECORDED, display: recordedModelText(recorded) }
  }
  return {
    label: 'Model',
    display: state.model === null ? MODEL_NONE : `${state.model.name} · ${state.model.provider}`,
  }
}

/**
 * The composer-row chip (#880: the shared chip control, as Effort and Mode are): the current
 * model's `name` and its PROVIDER, or the not-live sentence; a button either way (header). The
 * provider is not decoration (#44): the same name runs on several providers, and under
 * multi-account the provider id is WHICH ACCOUNT answers — a failover swap changes it and nothing
 * else on the page would say so. A cold thread's recorded model is named `Model (recorded)`, so it
 * never reads as live (#434). A thread under a role (#904) has the role's name first,
 * `review · …`, live or recorded alike.
 */
export function ModelChip({
  state,
  recorded = null,
  roleName = null,
  onOpen,
  open,
  ref,
}: ModelChipProps): React.ReactNode {
  const face = chipFace(state, recorded)
  const { label } = face
  const display = roleName === null ? face.display : `${roleName} · ${face.display}`
  const model = state?.model ?? null
  let title = 'the model this thread runs — change it here or with /model'
  if (state === null && recorded !== null) {
    title = 'what this thread last ran on, from its log — not live yet; pick a model now or run it (/model)'
  } else if (state === null) title = 'no live session yet — pick a model now and the first prompt runs on it (/model)'
  else if (model !== null) title = `${model.provider}/${model.id} — ${title}`
  return (
    <ChipButton
      {...(ref === undefined ? {} : { ref })}
      label={label}
      display={display}
      title={title}
      onOpen={onOpen}
      expanded={open === true}
    />
  )
}

/** A flow option's second column, dim beside its name: `/login`'s way in, `/logout`'s stored credential. */
function OptionDetail({ option }: { option: HostCommandOption }): React.ReactNode {
  return option.detail === undefined ? null : <span className="text-xs text-muted-foreground">{option.detail}</span>
}

export interface ModelChoiceDialogProps {
  readonly threadId: string
  /** The host command whose options the dialog lists (`model`, or a flow's: `login`), or undefined while closed. */
  readonly command: string | undefined
  /** The recent model ids, newest first (`useRecentModels`): the model picker's Recent group (#880). */
  readonly recent: readonly string[]
  /** The Model chip the model picker hangs from (#417) — the palette's `/model` opens it there too. */
  readonly anchor: React.RefObject<HTMLElement | null>
  readonly onClose: () => void
  /**
   * Where focus goes once the dialog has closed — the composer (#367). The palette that opened it
   * gave focus up without passing it on, so Radix's own return lands on `<body>`.
   */
  readonly returnFocus: () => void
  /** The user picked an option: `onHost(command, optionId)`. The dialog has closed by then. */
  readonly onPick: (command: string, optionId: string) => void
  /** The user picked a role in the model picker (#904); without it the picker lists no roles. */
  readonly onChooseRole?: (role: string) => void
  /** The role the thread runs under (#904): marked in the picker. */
  readonly chosenRole?: string | undefined
  /** The connection's `fetch` — injected by tests, the page's global by default. */
  readonly fetch?: FetchLike
}

/** The host command the model picker serves (#880); every other `select` or `flow` row lists flat. */
const MODEL_COMMAND = 'model'

type DialogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly row: RuntimeCommand }
  | { readonly kind: 'failed'; readonly detail: string }

/** The row for `command` in a fresh list, or why there is none — the dialog prints either. */
async function loadCommandRow(
  threadId: string,
  command: string,
  fetchImpl: FetchLike | undefined,
): Promise<DialogState> {
  try {
    const commands = await fetchThreadCommands(threadId, fetchImpl)
    const row = commands.commands.find((candidate) => candidate.source === 'host' && candidate.name === command)
    if (row === undefined) return { kind: 'failed', detail: `the host offers no /${command} command` }
    return { kind: 'loaded', row }
  } catch (failure: unknown) {
    return { kind: 'failed', detail: failure instanceof Error ? failure.message : String(failure) }
  }
}

/** A flow's options, flat, filtered substring-first (`rankOption`), the current one marked. */
function OptionChoices({
  state,
  onPick,
}: {
  readonly state: DialogState
  readonly onPick: (option: HostCommandOption) => void
}): React.ReactNode {
  if (state.kind === 'loading') {
    return (
      <div role="status" className="px-2 py-3 text-sm text-muted-foreground">
        loading models…
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div role="alert" className="px-2 py-3 text-sm text-destructive">
        {state.detail}
      </div>
    )
  }
  return (
    <>
      <ModelSelectorEmpty>no model matches</ModelSelectorEmpty>
      <ModelSelectorGroup heading={state.row.description ?? `/${state.row.name}`}>
        {(state.row.options ?? []).map((option) => (
          <ModelSelectorItem
            key={option.id}
            value={option.id}
            keywords={optionKeywords(option)}
            data-checked={option.id === state.row.value}
            onSelect={(): void => onPick(option)}
          >
            <ModelSelectorName>{option.label}</ModelSelectorName>
            <OptionDetail option={option} />
            <ChosenMark chosen={option.id === state.row.value} />
          </ModelSelectorItem>
        ))}
      </ModelSelectorGroup>
    </>
  )
}

/** The command's row, read from `GET …/commands` each time the dialog opens on it. */
function useCommandRow(
  threadId: string,
  command: string | undefined,
  fetchImpl: ModelChoiceDialogProps['fetch'],
): DialogState {
  const [state, setState] = useState<DialogState>({ kind: 'loading' })
  useEffect(() => {
    if (command === undefined) return
    let current = true
    setState({ kind: 'loading' })
    void loadCommandRow(threadId, command, fetchImpl).then((loaded) => {
      if (current) setState(loaded)
    })
    return (): void => {
      current = false
    }
  }, [threadId, command, fetchImpl])
  return state
}

/**
 * A host command's second step, for the composer's chip and the palette alike: `/model` opens the
 * model picker (`model-picker.tsx`, #880, #904 — Roles and Favorites, then Recent, then providers,
 * each row's effort range); a flow (`/login`, `/logout`) opens `ModelSelector` (ai-elements: cmdk
 * inside a dialog), its options flat, filtered by `label` and `detail`.
 *
 * The options are fetched when the dialog OPENS, from `GET …/commands` — never from the model
 * store, which is `null` before the first run (header), and never cached, for the palette's
 * reason: the list is the session's. The row's `value` marks the current choice. Picking a model
 * or a flow's option closes the dialog and hands `(command, optionId)` to the owner, who POSTs it;
 * picking a role hands its name to `onChooseRole` instead (no Roles group without one). The chip
 * then moves on the `model` observation, not on the pick.
 */
export function ModelChoiceDialog({
  threadId,
  command,
  recent,
  anchor,
  onClose,
  returnFocus,
  onPick,
  onChooseRole,
  chosenRole,
  fetch: fetchImpl,
}: ModelChoiceDialogProps): React.ReactNode {
  const state = useCommandRow(threadId, command, fetchImpl)
  const pick = (option: HostCommandOption): void => {
    if (command === undefined) return
    onClose()
    onPick(command, option.id)
  }
  const closeAutoFocus = (event: Event): void => {
    event.preventDefault()
    returnFocus()
  }
  const loaded = state.kind === 'loaded' ? state.row : undefined
  return (
    <>
      <ModelPicker
        open={command === MODEL_COMMAND}
        anchor={anchor}
        listing={state.kind === 'loaded' ? { kind: 'loaded', options: state.row.options ?? [] } : state}
        chosen={loaded?.value}
        recent={recent}
        purpose={loaded?.description ?? 'switch the model'}
        onChoose={(option: HostCommandOption): void => onPick(MODEL_COMMAND, option.id)}
        {...(onChooseRole === undefined ? {} : { onChooseRole })}
        chosenRole={chosenRole}
        onClose={onClose}
        returnFocus={returnFocus}
      />
      <ModelSelector
        open={command !== undefined && command !== MODEL_COMMAND}
        onOpenChange={(next: boolean): void => {
          if (!next) onClose()
        }}
      >
        <ModelSelectorContent
          title={loaded === undefined ? 'model' : (loaded.description ?? `/${loaded.name}`)}
          filter={rankOption}
          onCloseAutoFocus={closeAutoFocus}
        >
          <ModelSelectorInput placeholder="filter options…" />
          <ModelSelectorList>
            <OptionChoices state={state} onPick={pick} />
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>
    </>
  )
}
