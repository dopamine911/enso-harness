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
 */

/** The section, or why the page has none. */
export type ModelsSettingsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly settings: EnsoModelsSettings }
  | { readonly kind: 'failed'; readonly detail: string }

/** A save's outcome: written, or the server's reason (an unreadable config file is never overwritten). */
export type ModelsSaveOutcome = { readonly kind: 'saved' } | { readonly kind: 'refused'; readonly reason: string }

export interface ModelsSettingsStore extends Store<ModelsSettingsState> {
  readonly refresh: () => Promise<void>
  readonly save: (models: EnsoModelsConfig) => Promise<ModelsSaveOutcome>
}

const ROUTE = '/api/models/settings'

function readAnswer(response: Response): Promise<EnsoModelsSettings> {
  return checkedPayload(response, EnsoModelsSettings, "the server's models settings did not match their schema")
}

export function createModelsSettingsStore(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ModelsSettingsStore {
  const store = createStore<ModelsSettingsState>({ kind: 'loading' })
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
    save: async (models: EnsoModelsConfig) => {
      try {
        const settings = await readAnswer(
          await fetchImpl(ROUTE, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(models),
          }),
        )
        store.set({ kind: 'loaded', settings })
        return { kind: 'saved' }
      } catch (error) {
        return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
      }
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
