import { type EnsoModelsConfig, EnsoModelsSettings } from '@enso/core'
import type { FetchLike } from './browser-logging.ts'
import { createStore, type Store, useStore } from './store.ts'
import { checkedPayload } from './stored-threads.ts'

/**
 * The user's `models` section (#904) — favorites, hidden providers, roles, presets — as the page
 * holds it: ONE page-level store, read by the model picker, the launch panel and Settings, so a
 * star in the picker shows in Settings at once and a role saved in Settings is offered in the next
 * picker without a reload. Read from `GET /api/models/settings`; every change is the whole section,
 * `PUT` back, and the store takes the server's answer — what the file holds now — never the draft.
 *
 * Saves run one at a time, in the order asked, and a change is a function of the section rather
 * than a section: it is applied when its turn comes, to what the last save left (or, refused, to
 * what the file held before it). Built from what the page rendered, two changes within one round
 * trip would both start from the same section and the second `PUT` would drop the first.
 */

/** The section, or why the page has none. */
export type ModelsSettingsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly settings: EnsoModelsSettings }
  | { readonly kind: 'failed'; readonly detail: string }

/** A save's outcome: written, or the server's reason (an unreadable config file is never overwritten). */
export type ModelsSaveOutcome = { readonly kind: 'saved' } | { readonly kind: 'refused'; readonly reason: string }

/** A change to the section: given the section as the last save left it, the section to write. */
export type ModelsUpdate = (current: EnsoModelsConfig) => EnsoModelsConfig

export interface ModelsSettingsStore extends Store<ModelsSettingsState> {
  readonly refresh: () => Promise<void>
  /** Queue `update`; it runs once every save asked before it has answered. */
  readonly save: (update: ModelsUpdate) => Promise<ModelsSaveOutcome>
}

const ROUTE = '/api/models/settings'

function readAnswer(response: Response): Promise<EnsoModelsSettings> {
  return checkedPayload(response, EnsoModelsSettings, "the server's models settings did not match their schema")
}

export function createModelsSettingsStore(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ModelsSettingsStore {
  const store = createStore<ModelsSettingsState>({ kind: 'loading' })
  const put = async (update: ModelsUpdate): Promise<ModelsSaveOutcome> => {
    const state = store.get()
    // Never written from `{}`: a section the page has not read would replace the file's with nothing.
    if (state.kind !== 'loaded') return { kind: 'refused', reason: 'your models settings are not read yet' }
    try {
      const settings = await readAnswer(
        await fetchImpl(ROUTE, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update(state.settings.models)),
        }),
      )
      store.set({ kind: 'loaded', settings })
      return { kind: 'saved' }
    } catch (error) {
      return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  // `put` never rejects, so a refused save never stops the ones queued after it.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    get: store.get,
    subscribe: store.subscribe,
    refresh: async () => {
      try {
        store.set({ kind: 'loaded', settings: await readAnswer(await fetchImpl(ROUTE)) })
      } catch (error) {
        store.set({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
      }
    },
    save: (update: ModelsUpdate) => {
      const turn = queue.then(() => put(update))
      queue = turn
      return turn
    },
  }
}

/** The page's one store of the section. */
export const modelsSettings = createModelsSettingsStore()

/** The section as the page holds it — read on the page's load (`usePageListings`). */
export function useModelsSettings(): ModelsSettingsState {
  return useStore(modelsSettings)
}

/** The section's values, `{}` while it is not loaded: nothing set is what an absent section means. */
export function modelsConfigOf(state: ModelsSettingsState): EnsoModelsConfig {
  return state.kind === 'loaded' ? state.settings.models : {}
}

/**
 * The section with `id` added to `key`'s list, or taken out of it when it is there — a star or a
 * hide clicked — the key removed when the list is empty: an absent key is none.
 */
export function withToggled(
  models: EnsoModelsConfig,
  key: 'favorites' | 'hiddenProviders',
  id: string,
): EnsoModelsConfig {
  const list = models[key] ?? []
  const next = list.includes(id) ? list.filter((listed) => listed !== id) : [...list, id]
  const { [key]: _dropped, ...rest } = models
  return next.length === 0 ? rest : { ...rest, [key]: next }
}
