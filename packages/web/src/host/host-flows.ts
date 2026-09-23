import type { EnsoHostCommandRun, HostCommandOption, RuntimeCommand } from '@enso/core'
import { HostCommandRefused } from './host-commands.ts'

/**
 * The `flow` host commands (#338 slice 3): `/login` and `/logout`, as PURE decisions over what
 * the model runtime reports — the rows the host appends to `listCommands()`, the check a run
 * passes before anything starts, and the sentences the flow says as it goes. The real host and
 * the fake both build on this, for the reason `host-commands.ts` gives: one copy of the row
 * shape and the wording, or the server tests drive a seam the host does not implement.
 *
 * ⚠ A LOGIN IS A DIALOG FLOW, NOT A SETTINGS SCREEN (the #338 design). pi's `modelRuntime.login`
 * asks its questions through an `AuthInteraction` — a text or secret prompt, a select, a code —
 * and reports through `notify` events (a URL to open, a device code, progress). The host lifts
 * each prompt to the SAME blocking dialog an extension would ask (`extension-ui-request`), so
 * the browser renders and answers a login exactly as it renders and answers picc's mode
 * question, and each event to a `notify` line. Nothing here is per-provider: the shape of
 * pi's interaction is the whole contract, and a provider pi adds tomorrow logs in here with no
 * code of ours.
 *
 * A row's option id is `providerId/authType` for login (`anthropic/oauth`, `openai/api_key`) —
 * a provider may offer both, and pi's own selector lists them as two rows — and `providerId`
 * for logout, where the stored credential's type is whatever was saved. Neither row carries a
 * `value`: there is no "current" login.
 */

/**
 * The user declined a flow's question (PR #346 review): typed, so the flow's catch and the prompt's
 * throw are coupled by the compiler, not by a string. pi's OWN cancellation — its abort path — is
 * the string `Login cancelled`, which `isFlowCancelled` also recognises; both are a cancel, not a
 * failure.
 */
export class FlowCancelled extends Error {
  constructor() {
    super('Login cancelled')
    this.name = 'FlowCancelled'
  }
}

export function isFlowCancelled(error: unknown): boolean {
  return error instanceof FlowCancelled || (error instanceof Error && error.message === 'Login cancelled')
}

const HOST_FLOW_LOGIN = 'login'
const HOST_FLOW_LOGOUT = 'logout'
const HOST_ACTION_COMPACT = 'compact'

/** pi's two ways in, as the row labels them. */
export type HostAuthType = 'oauth' | 'api_key'

/** What the host knows about one provider's ways in, read off the model runtime. */
export interface LoginProviderFacts {
  readonly id: string
  readonly name: string
  readonly offersOAuth: boolean
  /** An API-key login pi can RUN — ambient-only providers (env var, AWS profile) have a key but no `login`. */
  readonly offersApiKeyLogin: boolean
  /** How the provider is authenticated now, when it is — pi's `AuthStatus.label ?? source`. */
  readonly configuredVia: string | undefined
}

/** One stored credential pi could remove. */
export interface StoredCredentialFacts {
  readonly providerId: string
  readonly providerName: string
  readonly type: HostAuthType
}

const AUTH_TYPE_LABEL: Readonly<Record<HostAuthType, string>> = { oauth: 'subscription', api_key: 'API key' }

/** The `/login` options: one per provider per way in, sorted by name — pi's own selector's order. */
export function loginOptions(providers: readonly LoginProviderFacts[]): HostCommandOption[] {
  const options: HostCommandOption[] = []
  for (const provider of [...providers].sort((left, right) => left.name.localeCompare(right.name))) {
    const detail = provider.configuredVia === undefined ? 'not configured' : `via ${provider.configuredVia}`
    if (provider.offersOAuth) {
      options.push({ id: `${provider.id}/oauth`, label: `${provider.name} · ${AUTH_TYPE_LABEL.oauth}`, detail })
    }
    if (provider.offersApiKeyLogin) {
      options.push({ id: `${provider.id}/api_key`, label: `${provider.name} · ${AUTH_TYPE_LABEL.api_key}`, detail })
    }
  }
  return options
}

/** The `/logout` options: every stored credential, by provider. Environment variables are not credentials pi saved, so they are not here. */
export function logoutOptions(credentials: readonly StoredCredentialFacts[]): HostCommandOption[] {
  return [...credentials]
    .sort((left, right) => left.providerName.localeCompare(right.providerName))
    .map((credential) => ({
      id: credential.providerId,
      label: credential.providerName,
      detail: `stored ${AUTH_TYPE_LABEL[credential.type]}`,
    }))
}

/**
 * The flow rows, after `/model` and `/thinking`: `/login`, `/logout` when something is stored (a
 * row with no options is a row that lies), and `/compact` (slice 4) — an `action`: no options, no
 * value, and a run that takes a model call, so it starts and is followed like a flow.
 */
export function hostFlowRows(
  login: readonly HostCommandOption[],
  logout: readonly HostCommandOption[],
): RuntimeCommand[] {
  const rows: RuntimeCommand[] = [
    { name: HOST_FLOW_LOGIN, source: 'host', kind: 'flow', description: 'log in to a provider', options: [...login] },
  ]
  if (logout.length > 0) {
    rows.push({
      name: HOST_FLOW_LOGOUT,
      source: 'host',
      kind: 'flow',
      description: 'remove a stored credential',
      options: [...logout],
    })
  }
  rows.push({
    name: HOST_ACTION_COMPACT,
    source: 'host',
    kind: 'action',
    description: 'compact the context into a summary',
  })
  return rows
}

/** A flow the host will start, or the refusal the route says as 422. */
export type HostFlowDecision =
  | { readonly kind: 'login'; readonly providerId: string; readonly authType: HostAuthType }
  | { readonly kind: 'logout'; readonly providerId: string }
  | { readonly kind: 'compact' }

export function decideHostFlow(
  run: EnsoHostCommandRun,
  login: readonly HostCommandOption[],
  logout: readonly HostCommandOption[],
): HostFlowDecision {
  switch (run.name) {
    case HOST_FLOW_LOGIN: {
      if (run.value === undefined) throw new HostCommandRefused('login needs a value: a provider and a way in')
      if (!login.some((option) => option.id === run.value)) {
        throw new HostCommandRefused(`login ${run.value} is not offered here`)
      }
      // ⚠ Split at the LAST slash: the auth type never contains one, a provider id might.
      const slash = run.value.lastIndexOf('/')
      const authType = run.value.slice(slash + 1)
      if (authType !== 'oauth' && authType !== 'api_key') {
        throw new HostCommandRefused(`login ${run.value} names no way in`)
      }
      return { kind: 'login', providerId: run.value.slice(0, slash), authType }
    }
    case HOST_FLOW_LOGOUT: {
      if (run.value === undefined) throw new HostCommandRefused('logout needs a value: a provider')
      if (!logout.some((option) => option.id === run.value)) {
        throw new HostCommandRefused(`no stored credential for ${run.value}`)
      }
      return { kind: 'logout', providerId: run.value }
    }
    case HOST_ACTION_COMPACT:
      if (run.value !== undefined) throw new HostCommandRefused('compact takes no value')
      return { kind: 'compact' }
    default:
      throw new HostCommandRefused(`no host flow named ${run.name}`)
  }
}

/** pi's `AuthEvent`, as the host needs it — structural, so no vendor type crosses this module. */
export type HostAuthEvent =
  | { readonly type: 'info'; readonly message: string; readonly links?: readonly { url: string; label?: string }[] }
  | { readonly type: 'auth_url'; readonly url: string; readonly instructions?: string }
  | {
      readonly type: 'device_code'
      readonly userCode: string
      readonly verificationUri: string
      readonly expiresInSeconds?: number
    }
  | { readonly type: 'progress'; readonly message: string }

/** One `notify` line per auth event: the URL and the code are the whole point, so they are in the text. */
export function authEventText(event: HostAuthEvent): string {
  switch (event.type) {
    case 'auth_url':
      return `${event.instructions ?? 'Open this URL to authenticate:'} ${event.url}`
    case 'device_code': {
      const expiry =
        event.expiresInSeconds === undefined ? '' : ` (expires in ${Math.round(event.expiresInSeconds / 60)} min)`
      return `Enter code ${event.userCode} at ${event.verificationUri}${expiry}`
    }
    case 'info': {
      const links = (event.links ?? []).map((link) =>
        link.label === undefined ? link.url : `${link.label}: ${link.url}`,
      )
      return links.length === 0 ? event.message : `${event.message} ${links.join(' ')}`
    }
    case 'progress':
      return event.message
  }
}

/** The sentence a finished login says. */
export function loginDoneText(providerName: string, authType: HostAuthType, selectedModel: string | undefined): string {
  const action = authType === 'oauth' ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`
  return selectedModel === undefined ? `${action}.` : `${action}. Selected ${selectedModel}.`
}

/** What a finished compaction says: the numbers pi measured, and the one thing the page cannot do for itself yet. */
export function compactDoneText(tokensBefore: number, estimatedTokensAfter: number | undefined): string {
  const after = estimatedTokensAfter === undefined ? 'fewer' : estimatedTokensAfter.toLocaleString('en-US')
  return `Compacted the context: ${tokensBefore.toLocaleString('en-US')} → ${after} tokens. Reload the page to see the compacted transcript.`
}

/** The sentence a finished logout says — pi's own two, by credential type; a neutral one when the type is not known (the cache moved under the flow). */
export function logoutDoneText(providerName: string, type: HostAuthType | undefined): string {
  if (type === undefined) return `Removed the stored credential for ${providerName}.`
  return type === 'oauth'
    ? `Logged out of ${providerName}.`
    : `Removed stored API key for ${providerName}. Environment variables and models.json are unchanged.`
}
