import type { EnsoProviderAuth } from '@enso/core'
import { modelOptionId } from './host-commands.ts'
import type { HostAuthQuestion } from './host-flow-runs.ts'
import type { HostAuthEvent, HostAuthType } from './host-flows.ts'
import { agentDirModelRuntime, type HostModelRuntime, type SessionModels } from './session-models.ts'

/**
 * The host's providers, for Settings (#904): what pi knows about each one, and logging in and out of
 * it outside any thread. Read from the runtime the model list is read from (`SessionModels.runtime`),
 * so the account slots an extension registers are listed and log in through their own flow; after a
 * login or logout every live session's runtime is re-read (`refreshAll`), so a thread's `/model` and
 * the launch panel offer the change at once — no restart.
 *
 * ⚠ What crosses this port says HOW a provider is authenticated, never with what: no key, token or
 * pi status label (a label can name where a key came from in the key's own words).
 */

/** One provider as pi knows it. */
export interface HostProviderFacts {
  readonly id: string
  readonly name: string
  readonly loggedIn: boolean
  readonly via: EnsoProviderAuth | undefined
  /** pi holds a credential it stored, which a logout removes. */
  readonly stored: boolean
  readonly offersOAuth: boolean
  readonly offersApiKey: boolean
  /** Registered by an extension (an account slot), not one of pi's built-ins. */
  readonly registered: boolean
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** A login's conversation with the person on the Settings page. */
export interface ProviderLoginInteraction {
  readonly signal: AbortSignal
  readonly ask: (question: HostAuthQuestion) => Promise<string>
  readonly notify: (event: HostAuthEvent) => void
}

export interface HostProviders {
  list(): Promise<HostProviderFacts[]>
  logIn(providerId: string, authType: HostAuthType, interaction: ProviderLoginInteraction): Promise<void>
  logOut(providerId: string, signal: AbortSignal): Promise<void>
}

export function hostProviders(agentDir: string, models: SessionModels): HostProviders {
  // No session could be had: pi's runtime over the agent dir alone, as the catalogue falls back to.
  const runtimeOf = async (): Promise<HostModelRuntime> =>
    (await models.runtime()) ?? (await agentDirModelRuntime(agentDir))
  return {
    async list() {
      const runtime = await runtimeOf()
      await runtime.refresh({ allowNetwork: false })
      const credentials = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) })
      const registered = new Set(runtime.getRegisteredProviderIds())
      return runtime.getProviders().map((provider) => {
        const stored = credentials.find((credential) => credential.providerId === provider.id)
        const loggedIn = runtime.hasConfiguredAuth(provider.id)
        let via: EnsoProviderAuth | undefined
        if (stored !== undefined) via = stored.type === 'oauth' ? 'subscription' : 'api-key'
        else if (loggedIn) via = 'environment'
        return {
          id: provider.id,
          name: provider.name,
          loggedIn,
          via,
          stored: stored !== undefined,
          offersOAuth: provider.auth.oauth !== undefined,
          offersApiKey: provider.auth.apiKey?.login !== undefined,
          registered: registered.has(provider.id),
          models: runtime.getModels(provider.id).map((model) => ({ id: modelOptionId(model), name: model.name })),
        }
      })
    },
    async logIn(providerId, authType, interaction) {
      const runtime = await runtimeOf()
      await runtime.login(providerId, authType, {
        signal: interaction.signal,
        prompt: (prompt): Promise<string> => interaction.ask(prompt),
        notify: (event): void => interaction.notify(event),
      })
      await models.refreshAll()
    },
    async logOut(providerId, signal) {
      const runtime = await runtimeOf()
      await runtime.logout(providerId, { signal })
      await models.refreshAll()
    },
  }
}
