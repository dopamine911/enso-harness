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
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from './components/ai-elements/prompt-input.tsx'
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
 * ⚠ HONESTY RULE. The store is `null` — the chip reads `model: default until the thread runs` —
 * until a live snapshot or observation has said otherwise. A stored thread has no live session
 * and the server does not guess (`EnsoFollowSnapshot.model` is `null` then); a fresh thread
 * has not built one. A snapshot with `null` REPLACES a known state rather than being ignored:
 * a reconnect's snapshot is the resync, and a thread that idled out between two follows has no
 * model this page can vouch for. The permission-mode store keeps its `seed` guard because it
 * seeds from a second source (`/api/mode`); this one has one source, the follow.
 *
 * ⚠ ENABLED WHILE NOT LIVE — ON PURPOSE (#341). The thinking select hides when nothing is known
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
 * only while the store is `null`, prefixed `model (recorded):`. The thinking select still hides
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
 * error for a view that can only say nothing has run. ⚠ Never the model alone (PR #661 review):
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

/** The chip's sentence while the store is `null` — worded so a reader knows a choice is still open, not missing. */
export const MODEL_NOT_LIVE = 'model: default until the thread runs'
/** A live session that resolved no model — pi reports `model` undefined then. */
const MODEL_NONE = 'model: none'
/** The chip's prefix for a cold thread's recorded model (#434) — so it never reads as live. */
export const MODEL_RECORDED = 'model (recorded):'

/** A recorded model as the chip says it: `claude-sonnet-5 · anthropic · medium`, each half only if the branch recorded it. */
export function recordedModelText(recorded: EnsoRecordedModel): string {
  const parts = recorded.model === null ? [] : [recorded.model.modelId, recorded.model.provider]
  if (recorded.thinkingLevel !== null) parts.push(recorded.thinkingLevel)
  return `${MODEL_RECORDED} ${parts.join(' · ')}`
}

export interface ThinkingLevelSelectProps {
  readonly state: EnsoModelState | null
  /** Called with the chosen level; never with the current one (re-selecting it is a no-op here). */
  readonly onSelect: (level: string) => void
}

/**
 * The composer-row `thinking` select over the levels the host offers (`getAvailableThinkingLevels()`
 * — pi's are discrete, so a select is the truthful widget; there is no slider on purpose). Renders
 * NOTHING while the store is `null`: the levels are pi's to declare, not ours to assume.
 *
 * ⓘ `PromptInputSelect*` (ai-elements on shadcn `select`) rather than the native `<select>` the
 * mode control uses: the ports were taken back for this (#31, port before build) and the chip
 * beside it is a dialog, so the chrome row is one visual family. `position="popper"` so the list
 * drops below the trigger inside the composer instead of item-aligned over it.
 */
export function ThinkingLevelSelect({ state, onSelect }: ThinkingLevelSelectProps): React.ReactNode {
  if (state === null) return null
  const { thinkingLevel, availableThinkingLevels } = state
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title="how hard pi thinks — the levels this model offers"
    >
      <span>thinking</span>
      <PromptInputSelect
        value={thinkingLevel}
        onValueChange={(next: string): void => {
          if (next !== thinkingLevel) onSelect(next)
        }}
      >
        <PromptInputSelectTrigger aria-label="thinking level" size="sm" className="h-6 px-1.5 text-xs">
          <PromptInputSelectValue />
        </PromptInputSelectTrigger>
        <PromptInputSelectContent position="popper">
          {availableThinkingLevels.map((level) => (
            <PromptInputSelectItem key={level} value={level}>
              {level}
            </PromptInputSelectItem>
          ))}
          {/* The current level always renders even if the list somehow omitted it — the readout never lies about what it was told. */}
          {availableThinkingLevels.includes(thinkingLevel) ? null : (
            <PromptInputSelectItem value={thinkingLevel}>{thinkingLevel}</PromptInputSelectItem>
          )}
        </PromptInputSelectContent>
      </PromptInputSelect>
    </span>
  )
}

export interface ModelChipProps {
  readonly state: EnsoModelState | null
  /** What a cold thread's branch records (#434); shown only while `state` is `null`. */
  readonly recorded?: EnsoRecordedModel | null
  /** Open the model dialog — the owner renders it (`chat-screen.tsx`), the same one the palette's `/model` row opens. */
  readonly onOpen: () => void
}

/** What the chip reads: the model's name; the no-model sentence; the recorded model; the not-live sentence. */
function chipLabel(state: EnsoModelState | null, recorded: EnsoRecordedModel | null): string {
  if (state === null) return recorded === null ? MODEL_NOT_LIVE : recordedModelText(recorded)
  return state.model === null ? MODEL_NONE : state.model.name
}

/**
 * The composer-row chip: the current model's `name` and its PROVIDER, or the not-live sentence; a
 * button either way (header). The provider is not decoration (#44): the same name runs on several
 * providers, and under multi-account the provider id is WHICH ACCOUNT answers — a failover swap
 * changes it and nothing else on the page would say so.
 */
export function ModelChip({ state, recorded = null, onOpen }: ModelChipProps): React.ReactNode {
  const label = chipLabel(state, recorded)
  const model = state?.model ?? null
  let title = 'the model this thread runs — change it here or with /model'
  if (state === null && recorded !== null) {
    title = 'what this thread last ran on, from its log — not live yet; pick a model now or run it (/model)'
  } else if (state === null) title = 'no live session yet — pick a model now and the first prompt runs on it (/model)'
  else if (model !== null) title = `${model.provider}/${model.id} — ${title}`
  return (
    <button
      type="button"
      aria-label="model"
      title={title}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpen}
    >
      {model === null ? null : <span>model</span>}
      <span className={model === null ? undefined : 'text-foreground'}>{label}</span>
      {model === null ? null : <span className="max-w-provider-label truncate">· {model.provider}</span>}
    </button>
  )
}

/** The words a `/model` option is found by: its label, and the provider its `detail` names. */
export function optionKeywords(option: HostCommandOption): string[] {
  return option.detail === undefined ? [option.label] : [option.label, option.detail]
}

/** A model option's provider, dim beside its name — the model picker's row and the Start-a-session dialog's (#391). */
export function OptionDetail({ option }: { option: HostCommandOption }): React.ReactNode {
  return option.detail === undefined ? null : <span className="text-xs text-muted-foreground">{option.detail}</span>
}

/**
 * The chosen option, in words for the accessibility tree: the check beside it is drawn by CSS
 * (`data-checked`), and the list's own `aria-selected` is cmdk's keyboard highlight, which starts on
 * the first option — so a reader was told the first model was selected whatever was chosen (found
 * by a Dogfood Arena run reading the Start dialog).
 */
export function ChosenMark({ chosen }: { chosen: boolean }): React.ReactNode {
  return chosen ? <span className="sr-only">, chosen</span> : null
}

export interface ModelChoiceDialogProps {
  readonly threadId: string
  /** The `select` host command whose options the dialog lists (`model`), or undefined while closed. */
  readonly command: string | undefined
  readonly onClose: () => void
  /**
   * Where focus goes once the dialog has closed — the composer (#367). The palette that opened it
   * gave focus up without passing it on, so Radix's own return lands on `<body>`.
   */
  readonly returnFocus: () => void
  /** The user picked an option: `onHost(command, optionId)`. The dialog has closed by then. */
  readonly onPick: (command: string, optionId: string) => void
  /** The connection's `fetch` — injected by tests, the page's global by default. */
  readonly fetch?: FetchLike
}

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

/**
 * Substring-first ranking for the option dialog (#338 slice 3): the typed text must APPEAR in
 * the option's id, label or detail — earlier is better — or the row is hidden. cmdk's default
 * fuzzy score matched `openai` to 22 of 53 login options (any row spelling o-p-e-n-a-i in order);
 * the same reason the palette ranks names first (`command-palette.tsx`, `rankCommand`).
 */
export function rankOption(optionId: string, search: string, keywords?: readonly string[]): number {
  const needle = search.toLowerCase()
  if (needle.length === 0) return 1
  let best = 0
  for (const haystack of [optionId, ...(keywords ?? [])]) {
    const lowered = haystack.toLowerCase()
    const at = lowered.indexOf(needle)
    if (at === -1) continue
    best = Math.max(best, 1 - at / (2 * Math.max(lowered.length, 1)))
  }
  return best
}

/**
 * The `/model` second step: `ModelSelector` (ai-elements: cmdk inside a dialog) filtering over
 * a `select` command's `options` by `label` and `detail` (the model's name and its provider).
 *
 * The options are fetched when the dialog OPENS, from `GET …/commands` — never from the model
 * store, which is `null` before the first run (header), and never cached, for the palette's
 * reason: the list is the session's. The row's `value` marks the current choice. Picking closes
 * the dialog and hands `(command, optionId)` to the owner, who POSTs it; the chip then moves on
 * the `model` observation, not on the pick.
 */
export function ModelChoiceDialog({
  threadId,
  command,
  onClose,
  returnFocus,
  onPick,
  fetch: fetchImpl,
}: ModelChoiceDialogProps): React.ReactNode {
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
  const open = command !== undefined
  const pick = (option: HostCommandOption): void => {
    if (command === undefined) return
    onClose()
    onPick(command, option.id)
  }
  return (
    <ModelSelector
      open={open}
      onOpenChange={(next: boolean): void => {
        if (!next) onClose()
      }}
    >
      <ModelSelectorContent
        title={state.kind === 'loaded' ? (state.row.description ?? `/${state.row.name}`) : 'model'}
        filter={rankOption}
        onCloseAutoFocus={(event: Event): void => {
          event.preventDefault()
          returnFocus()
        }}
      >
        <ModelSelectorInput placeholder="filter options…" />
        <ModelSelectorList>
          {state.kind === 'loading' ? (
            <div role="status" className="px-2 py-3 text-sm text-muted-foreground">
              loading models…
            </div>
          ) : null}
          {state.kind === 'failed' ? (
            <div role="alert" className="px-2 py-3 text-sm text-destructive">
              {state.detail}
            </div>
          ) : null}
          {state.kind === 'loaded' ? (
            <>
              <ModelSelectorEmpty>no model matches</ModelSelectorEmpty>
              <ModelSelectorGroup heading={state.row.description ?? `/${state.row.name}`}>
                {(state.row.options ?? []).map((option) => (
                  <ModelSelectorItem
                    key={option.id}
                    value={option.id}
                    keywords={optionKeywords(option)}
                    data-checked={option.id === state.row.value}
                    onSelect={(): void => pick(option)}
                  >
                    <ModelSelectorName>{option.label}</ModelSelectorName>
                    <OptionDetail option={option} />
                    <ChosenMark chosen={option.id === state.row.value} />
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
            </>
          ) : null}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
