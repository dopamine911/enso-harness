import type { EnsoModelObservation, EnsoModelState, HostCommandOption, RuntimeCommand } from '@enso/core'
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
 * same list for every session, so the `remembered` list is right for a thread that never ran.
 *
 * ⓘ ONE STORE PER THREAD (#90 PR 3): created by `thread-stores.ts`, read through `useThreadStores()`.
 */

export interface ModelStore extends Store<EnsoModelState | null> {
  /** The snapshot's `model` or a `model` observation's state — validated by the router before it lands here. */
  readonly apply: (state: EnsoModelState | null) => void
  /** A `model` observation: the state after pi applied a change, whoever asked for it. */
  readonly applyObservation: (observation: EnsoModelObservation) => void
}

export function createModelStore(): ModelStore {
  const store = createStore<EnsoModelState | null>(null)
  return {
    get: store.get,
    subscribe: store.subscribe,
    apply: store.set,
    applyObservation: ({ model, thinkingLevel, availableThinkingLevels }: EnsoModelObservation): void =>
      store.set({ model, thinkingLevel, availableThinkingLevels }),
  }
}

/** The rendering thread's model state; `null` until the follow has said. */
export function useModelState(): EnsoModelState | null {
  return useStore(useThreadStores().model)
}

/** The chip's sentence while the store is `null` — worded so a reader knows a choice is still open, not missing. */
export const MODEL_NOT_LIVE = 'model: default until the thread runs'
/** A live session that resolved no model — pi reports `model` undefined then. */
const MODEL_NONE = 'model: none'

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
      className="flex items-center gap-1.5 text-muted-foreground text-xs"
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
  /** Open the model dialog — the owner renders it (`chat-screen.tsx`), the same one the palette's `/model` row opens. */
  readonly onOpen: () => void
}

/** What the chip reads: the model's name; the no-model sentence; the not-live sentence. */
function chipLabel(state: EnsoModelState | null): string {
  if (state === null) return MODEL_NOT_LIVE
  return state.model === null ? MODEL_NONE : state.model.name
}

/** The composer-row chip: the current model's `name`, or the not-live sentence; a button either way (header). */
export function ModelChip({ state, onOpen }: ModelChipProps): React.ReactNode {
  const label = chipLabel(state)
  return (
    <button
      type="button"
      aria-label="model"
      title={
        state === null
          ? 'no live session yet — pick a model now and the first prompt runs on it (/model)'
          : 'the model this thread runs — change it here or with /model'
      }
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
      onClick={onOpen}
    >
      {state === null || state.model === null ? null : <span>model</span>}
      <span className={state === null || state.model === null ? undefined : 'text-foreground'}>{label}</span>
    </button>
  )
}

export interface ModelChoiceDialogProps {
  readonly threadId: string
  /** The `select` host command whose options the dialog lists (`model`), or undefined while closed. */
  readonly command: string | undefined
  readonly onClose: () => void
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
      >
        <ModelSelectorInput placeholder="filter options…" />
        <ModelSelectorList>
          {state.kind === 'loading' ? (
            <div role="status" className="px-2 py-3 text-muted-foreground text-sm">
              loading models…
            </div>
          ) : null}
          {state.kind === 'failed' ? (
            <div role="alert" className="px-2 py-3 text-destructive text-sm">
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
                    keywords={option.detail === undefined ? [option.label] : [option.label, option.detail]}
                    data-checked={option.id === state.row.value}
                    onSelect={(): void => pick(option)}
                  >
                    <ModelSelectorName>{option.label}</ModelSelectorName>
                    {option.detail === undefined ? null : (
                      <span className="text-muted-foreground text-xs">{option.detail}</span>
                    )}
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
