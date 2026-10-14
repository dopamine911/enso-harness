import {
  type EnsoAddableProvider,
  type EnsoModelsConfig,
  type EnsoProvider,
  EnsoProviderLogin,
  type EnsoProviderLoginAnswer,
  type EnsoProviderLoginQuestion,
  type EnsoProviderLoginRequest,
  EnsoProvidersListing,
} from '@enso/core'
import { EyeIcon, EyeOffIcon, LogInIcon, LogOutIcon, PlusIcon, StarIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { type ModelsSettingsStore, modelsSettings } from './models-settings.ts'
import { OptionSelect } from './option-select.tsx'
import { PAGE_INPUT, PAGE_OUTLINE_BUTTON, PAGE_PRIMARY_BUTTON, SUB_TITLE } from './page-styles.ts'
import { type ListingRead, type ListingRoute, type ListingState, useListing } from './settings-listing.ts'
import { useStore } from './store.ts'
import { checkedPayload, describeFailedResponse } from './stored-threads.ts'

/**
 * Settings' Providers (#904): each provider pi knows that is set up or registered — logged in or
 * not, how, whether it is an account slot — with its models to star, Log in (pi's own flow, a
 * subscription or an API key), Log out of a credential pi stored, and Hide from the model picker.
 * "Add a provider" reaches pi's built-ins nobody set up.
 *
 * ⚠ AN API KEY IS NEVER HELD OR SHOWN: its field is uncontrolled (the key is never React state, so
 * never a `value` attribute), read once on submit, emptied before the request goes, and sent once in
 * its body. The page only ever says "a key is set".
 */

export type ProvidersRead = ListingRead<EnsoProvidersListing>

/** A login request's answer: the login as it stands, or why the server refused to run it. */
type LoginAnswer =
  | { readonly kind: 'login'; readonly login: EnsoProviderLogin }
  | { readonly kind: 'refused'; readonly reason: string }

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `POST` `body` as JSON. */
const postJson = (fetchImpl: FetchLike, path: string, body?: unknown): Promise<Response> =>
  fetchImpl(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** A `POST` to one of the login routes, its answer checked as a login. */
async function postLogin(fetchImpl: FetchLike, path: string, body?: unknown): Promise<LoginAnswer> {
  try {
    const response = await postJson(fetchImpl, path, body)
    return {
      kind: 'login',
      login: await checkedPayload(response, EnsoProviderLogin, "the server's login did not match its schema"),
    }
  } catch (error) {
    return { kind: 'refused', reason: reasonOf(error) }
  }
}

/** `GET /api/providers`, checked against its schema. */
const PROVIDERS_ROUTE: ListingRoute<typeof EnsoProvidersListing> = {
  route: '/api/providers',
  schema: EnsoProvidersListing,
  mismatch: "the server's providers did not match their schema",
}

/** `GET /api/providers` (`useListing`); `replace` takes a listing the server answered otherwise (a logout's). */
export function useProvidersListing(fetchImpl: FetchLike | undefined): ListingState<EnsoProvidersListing> {
  return useListing(fetchImpl, PROVIDERS_ROUTE)
}

/** `list` set on the section, or the key removed when it is empty: an absent key is none. */
export function withList(
  models: EnsoModelsConfig,
  key: 'favorites' | 'hiddenProviders',
  list: readonly string[],
): EnsoModelsConfig {
  const { [key]: _dropped, ...rest } = models
  return list.length === 0 ? rest : { ...rest, [key]: [...list] }
}

/** How a logged-in provider is, in words: never what the credential is. */
const VIA_WORDS: Readonly<Record<NonNullable<EnsoProvider['via']>, string>> = {
  'api-key': 'a key is set',
  subscription: 'subscription',
  environment: 'from the environment',
}

/** Every `http(s)` URL in a notice as a link that opens apart from the page. */
function LinkedText({ text }: { text: string }): React.ReactNode {
  const parts = text.split(/(https?:\/\/\S+)/)
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      // react-doctor-disable-next-line no-array-index-as-key -- the parts of one fixed string, in order
      <a key={index} href={part} target="_blank" rel="noreferrer" className="break-all text-primary underline">
        {part}
      </a>
    ) : (
      // react-doctor-disable-next-line no-array-index-as-key -- the parts of one fixed string, in order
      <span key={index}>{part}</span>
    ),
  )
}

/** An uncontrolled field's text, read once and emptied at once; `undefined` when blank. */
function takeOnce(field: React.RefObject<HTMLInputElement | null>): string | undefined {
  const input = field.current
  if (input === null) return undefined
  const value = input.value
  input.value = ''
  return value.trim() === '' ? undefined : value
}

/** A field `takeOnce` reads: uncontrolled, so what is typed — a secret — is never React state. */
function OnceInput({
  field,
  secret,
  id,
  label,
  placeholder,
}: {
  field: React.RefObject<HTMLInputElement | null>
  secret: boolean
  id?: string | undefined
  label?: string | undefined
  placeholder: string | undefined
}): React.ReactNode {
  return (
    <input
      id={id}
      ref={field}
      type={secret ? 'password' : 'text'}
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      className={cn(PAGE_INPUT, 'w-auto min-w-48 flex-1')}
    />
  )
}

/**
 * An answer typed for a login's question: read once on submit and emptied at once — uncontrolled,
 * so a secret is never React state. A `select` question chooses one of its options.
 */
function QuestionForm({
  question,
  busy,
  onAnswer,
}: {
  question: EnsoProviderLoginQuestion
  busy: boolean
  onAnswer: (answer: EnsoProviderLoginAnswer) => void
}): React.ReactNode {
  const field = useRef<HTMLInputElement>(null)
  const options = question.options ?? []
  const [chosen, setChosen] = useState(options[0]?.id ?? '')
  const id = `provider-question-${question.id}`
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (question.kind !== 'select') {
          const value = takeOnce(field)
          if (value !== undefined) onAnswer({ questionId: question.id, value })
        } else if (chosen !== '') onAnswer({ questionId: question.id, value: chosen })
      }}
    >
      <label htmlFor={id} className="text-sm font-semibold">
        <LinkedText text={question.message} />
      </label>
      {question.link === undefined ? null : (
        <a
          href={question.link.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm break-all text-primary underline"
        >
          {question.link.label}
        </a>
      )}
      <div className="flex flex-wrap gap-2">
        {question.kind === 'select' ? (
          <OptionSelect
            id={id}
            value={chosen}
            options={options.map((option) => [option.id, option.label] as const)}
            onChange={setChosen}
            className={cn(PAGE_INPUT, 'w-auto min-w-48 flex-1')}
          />
        ) : (
          <OnceInput field={field} secret={question.kind === 'secret'} id={id} placeholder={question.placeholder} />
        )}
        <Button type="submit" className={PAGE_PRIMARY_BUTTON} disabled={busy}>
          Answer
        </Button>
      </div>
    </form>
  )
}

/** The login started here, as it goes: what it said, the question it waits on, how it ended. */
function LoginPanel({
  login,
  busy,
  onAnswer,
  onCancel,
  onDismiss,
}: {
  login: EnsoProviderLogin
  busy: boolean
  onAnswer: (answer: EnsoProviderLoginAnswer) => void
  onCancel: () => void
  onDismiss: () => void
}): React.ReactNode {
  const running = login.status === 'running'
  const way = login.authType === 'api_key' ? 'an API key' : 'a subscription'
  const heading: Readonly<Record<EnsoProviderLogin['status'], string>> = {
    running: `Logging in to ${login.providerName} with ${way}`,
    done: `Logged in to ${login.providerName}`,
    cancelled: `Login to ${login.providerName} cancelled`,
    failed: `Login to ${login.providerName} failed`,
  }
  return (
    <section
      aria-label={`logging in to ${login.providerName}`}
      className="grid gap-3 rounded-sm border border-border-strong bg-card p-4"
    >
      <h3 className={SUB_TITLE}>{heading[login.status]}</h3>
      {login.notices.length === 0 ? null : (
        <ul className="grid gap-1 text-sm">
          {login.notices.map((notice, index) => (
            // react-doctor-disable-next-line no-array-index-as-key -- notices only grow, in order
            <li key={index}>
              <LinkedText text={notice} />
            </li>
          ))}
        </ul>
      )}
      {login.status === 'failed' && login.reason !== undefined ? (
        <p role="alert" className="text-sm text-refuse">
          {login.reason}
        </p>
      ) : null}
      {running && login.question !== undefined ? (
        <QuestionForm key={login.question.id} question={login.question} busy={busy} onAnswer={onAnswer} />
      ) : null}
      {running && login.question === undefined ? (
        <p className="text-sm text-muted-foreground">Waiting for pi…</p>
      ) : null}
      <div className="flex gap-2">
        {running ? (
          <Button type="button" variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button type="button" variant="outline" className={PAGE_OUTLINE_BUTTON} onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </section>
  )
}

/**
 * The API key field: a password field, autocomplete off, uncontrolled — read once on submit and
 * emptied before the key is sent. Replacing a key is entering a new one; the old one is never shown.
 */
function ApiKeyForm({
  ways,
  replacing,
  actions,
}: {
  ways: LoginWays
  replacing: boolean
  actions: RowActions
}): React.ReactNode {
  const field = useRef<HTMLInputElement>(null)
  return (
    // react-doctor-disable-next-line no-prevent-default -- the key goes by fetch, once; a native submit would put it in a URL
    <form
      aria-label={`API key for ${ways.name}`}
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const apiKey = takeOnce(field)
        if (apiKey !== undefined) actions.startLogin({ provider: ways.id, authType: 'api_key', apiKey })
      }}
    >
      <OnceInput
        field={field}
        secret
        label={`${replacing ? 'new ' : ''}API key for ${ways.name}`}
        placeholder={replacing ? 'A new key replaces the one set' : 'API key'}
      />
      <Button type="submit" className={PAGE_PRIMARY_BUTTON} disabled={actions.busy}>
        Save key
      </Button>
      <Button type="button" variant="ghost" className="h-10" onClick={() => actions.openKeyForm(undefined)}>
        Close
      </Button>
    </form>
  )
}

/** A provider's ways in, as Log in buttons: a subscription and/or an API key. */
interface LoginWays {
  readonly id: string
  readonly name: string
  readonly offersOAuth: boolean
  readonly offersApiKey: boolean
}

/** What a provider row or an addable row needs from the section. */
interface RowActions {
  readonly busy: boolean
  readonly keyFormFor: string | undefined
  readonly openKeyForm: (provider: string | undefined) => void
  readonly startLogin: (request: EnsoProviderLoginRequest) => void
}

function LoginButtons({
  ways,
  loggedIn,
  actions,
}: {
  ways: LoginWays
  loggedIn: boolean
  actions: RowActions
}): React.ReactNode {
  return (
    <>
      {ways.offersOAuth ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={actions.busy}
          aria-label={`log in to ${ways.name} with a subscription`}
          onClick={() => actions.startLogin({ provider: ways.id, authType: 'oauth' })}
        >
          <LogInIcon aria-hidden="true" />
          {loggedIn ? 'Log in again' : 'Log in'}
        </Button>
      ) : null}
      {ways.offersApiKey ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={actions.busy}
          aria-expanded={actions.keyFormFor === ways.id}
          aria-label={`enter an API key for ${ways.name}`}
          onClick={() => actions.openKeyForm(actions.keyFormFor === ways.id ? undefined : ways.id)}
        >
          {loggedIn ? 'Replace key' : 'Enter API key'}
        </Button>
      ) : null}
    </>
  )
}

/** A row's API key field, while it is open, and the refusal said on the row. */
function RowFooter({
  ways,
  replacing,
  actions,
  refusal,
}: {
  ways: LoginWays
  replacing: boolean
  actions: RowActions
  refusal: string | undefined
}): React.ReactNode {
  return (
    <>
      {actions.keyFormFor === ways.id ? <ApiKeyForm ways={ways} replacing={replacing} actions={actions} /> : null}
      {refusal === undefined ? null : (
        <p role="alert" className="text-xs text-refuse">
          {refusal}
        </p>
      )}
    </>
  )
}

/** A provider's name, id, and how it is logged in. */
function ProviderHeader({ provider, hidden }: { provider: EnsoProvider; hidden: boolean }): React.ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 font-semibold">{provider.name}</span>
      <span className="font-mono text-meta text-muted-foreground">{provider.id}</span>
      {provider.accountSlot ? (
        <span className="rounded-full border px-2 py-px font-mono text-meta text-muted-foreground">account slot</span>
      ) : null}
      <span className={cn('text-xs', provider.loggedIn ? 'text-foreground' : 'text-muted-foreground')}>
        {provider.loggedIn
          ? `logged in${provider.via === undefined ? '' : ` · ${VIA_WORDS[provider.via]}`}`
          : 'not logged in'}
      </span>
      {hidden ? <span className="text-xs text-muted-foreground">hidden from the picker</span> : null}
    </div>
  )
}

/** A provider's models, each with a star. */
function ProviderModels({
  provider,
  favorites,
  editable,
  onToggleFavorite,
}: {
  provider: EnsoProvider
  favorites: readonly string[]
  editable: boolean
  onToggleFavorite: (model: string) => void
}): React.ReactNode {
  if (provider.models.length === 0) return null
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none">
        {provider.models.length} {provider.models.length === 1 ? 'model' : 'models'}
      </summary>
      <ul aria-label={`models of ${provider.name}`} className="mt-1 grid gap-0.5">
        {provider.models.map((model) => {
          // react-doctor-disable-next-line js-set-map-lookups -- a handful of favorites
          const starred = favorites.includes(model.id)
          return (
            <li key={model.id} className="flex items-center gap-2">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={!editable}
                aria-pressed={starred}
                aria-label={`favorite ${model.name}`}
                onClick={() => onToggleFavorite(model.id)}
              >
                <StarIcon aria-hidden="true" className={cn(starred && 'fill-current text-chart-3')} />
              </Button>
              <span className="min-w-0 truncate">{model.name}</span>
              <span className="truncate font-mono text-meta text-muted-foreground">{model.id}</span>
            </li>
          )
        })}
      </ul>
    </details>
  )
}

/** One provider: how it is logged in, its actions, and (`children`) its models to star. */
function ProviderRow({
  provider,
  hidden,
  editable,
  refusal,
  actions,
  on,
  children,
}: {
  provider: EnsoProvider
  hidden: boolean
  editable: boolean
  refusal: string | undefined
  actions: RowActions
  on: { readonly toggleHidden: () => void; readonly logout: () => void }
  children: React.ReactNode
}): React.ReactNode {
  return (
    <li aria-label={provider.name} className="grid gap-2 border-b px-3 py-3 text-sm last:border-b-0">
      <ProviderHeader provider={provider} hidden={hidden} />
      <div className="flex flex-wrap gap-2">
        <LoginButtons ways={provider} loggedIn={provider.loggedIn} actions={actions} />
        {provider.stored ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={actions.busy}
            aria-label={`log out of ${provider.name}`}
            onClick={on.logout}
          >
            <LogOutIcon aria-hidden="true" />
            Log out
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!editable}
          aria-pressed={hidden}
          aria-label={`hide ${provider.name} from the model picker`}
          onClick={on.toggleHidden}
        >
          {hidden ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
          {hidden ? 'Hidden from picker' : 'Hide from picker'}
        </Button>
      </div>
      <RowFooter ways={provider} replacing={provider.via === 'api-key'} actions={actions} refusal={refusal} />
      {children}
    </li>
  )
}

/** "Add a provider": pi's built-ins nobody set up, searchable, each with its ways in. */
function AddProvider({
  addable,
  actions,
  refusals,
}: {
  addable: readonly EnsoAddableProvider[]
  actions: RowActions
  refusals: Readonly<Record<string, string>>
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  if (!open)
    return (
      <div>
        <Button type="button" variant="outline" className={PAGE_OUTLINE_BUTTON} onClick={() => setOpen(true)}>
          <PlusIcon aria-hidden="true" />
          Add a provider
        </Button>
      </div>
    )
  const needle = query.trim().toLowerCase()
  const shown = addable.filter(
    (provider) => needle === '' || provider.name.toLowerCase().includes(needle) || provider.id.includes(needle),
  )
  return (
    <section aria-label="add a provider" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={SUB_TITLE}>Add a provider</h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      <input
        type="search"
        aria-label="search providers to add"
        placeholder="Search providers"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className={PAGE_INPUT}
      />
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No provider to add matches.</p>
      ) : (
        <ul className="grid overflow-hidden rounded-sm border bg-card">
          {shown.map((provider) => (
            <li
              key={provider.id}
              aria-label={provider.name}
              className="grid gap-2 border-b px-3 py-2 text-sm last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-semibold">{provider.name}</span>
                <span className="font-mono text-meta text-muted-foreground">{provider.id}</span>
                <span className="flex flex-1 flex-wrap justify-end gap-2">
                  <LoginButtons ways={provider} loggedIn={false} actions={actions} />
                </span>
              </div>
              <RowFooter ways={provider} replacing={false} actions={actions} refusal={refusals[provider.id]} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** How often a login with no open question is asked how it goes. */
export const LOGIN_POLL_MS = 1500

/** A ref that always holds the latest `value`, updated after each render — for a timer's callback. */
function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/** A login already running when the section opened is shown once, so it can be answered or cancelled. */
function useAdoptedLogin(
  running: EnsoProviderLogin | undefined,
  setLogin: React.Dispatch<React.SetStateAction<EnsoProviderLogin | undefined>>,
): void {
  useEffect(() => {
    // react-doctor-disable-next-line no-adjust-state-on-prop-change -- adopted once, never replacing the login on screen
    if (running?.status === 'running') setLogin((shown) => shown ?? running)
  }, [running, setLogin])
}

/** A running login with no question is asked how it goes until it asks one or settles. */
function useLoginPolling({
  login,
  fetchNow,
  reload,
  setLogin,
  settleRef,
}: {
  login: EnsoProviderLogin | undefined
  fetchNow: (path: string) => Promise<Response>
  reload: () => void
  setLogin: (login: EnsoProviderLogin | undefined) => void
  settleRef: { readonly current: (next: EnsoProviderLogin) => void }
}): void {
  const polling = login?.status === 'running' && login.question === undefined
  useEffect(() => {
    if (!polling) return
    let current = true
    const tick = async (): Promise<void> => {
      // react-doctor-disable-next-line async-defer-await -- the guard is whether the poll outlived its effect, known only after the read
      const response = await fetchNow('/api/providers/login')
      if (!current) return
      if (response.status === 204) {
        setLogin(undefined)
        reload()
        return
      }
      if (!response.ok) return
      const payload: unknown = await response.json()
      if (current && Check(EnsoProviderLogin, payload)) settleRef.current(payload)
    }
    const timer = setInterval(() => {
      // A failed tick is retried by the next one.
      tick().catch(() => undefined)
    }, LOGIN_POLL_MS)
    return (): void => {
      current = false
      clearInterval(timer)
    }
  }, [polling, fetchNow, reload, setLogin, settleRef])
}

function ProvidersList({
  providers,
  config,
  refusals,
  actions,
  save,
  onLogout,
}: {
  providers: readonly EnsoProvider[]
  config: EnsoModelsConfig | undefined
  refusals: Readonly<Record<string, string>>
  actions: RowActions
  save: (provider: string, next: EnsoModelsConfig) => Promise<void>
  onLogout: (provider: EnsoProvider) => void
}): React.ReactNode {
  if (providers.length === 0)
    return <p className="text-sm text-muted-foreground">No provider is set up yet. Add one below.</p>
  const favorites = config?.favorites ?? []
  const hiddenProviders = config?.hiddenProviders ?? []
  return (
    <ul aria-label="providers" className="grid overflow-hidden rounded-sm border bg-card">
      {providers.map((provider) => {
        // The file once read decides; before then, the listing's word.
        // react-doctor-disable-next-line js-set-map-lookups -- a handful of hidden providers
        const hidden = config === undefined ? provider.hidden : hiddenProviders.includes(provider.id)
        return (
          <ProviderRow
            key={provider.id}
            provider={provider}
            hidden={hidden}
            editable={config !== undefined}
            refusal={refusals[provider.id]}
            actions={actions}
            on={{
              toggleHidden: () => {
                if (config === undefined) return
                const next = hidden
                  ? hiddenProviders.filter((hiddenId) => hiddenId !== provider.id)
                  : [...hiddenProviders, provider.id]
                void save(provider.id, withList(config, 'hiddenProviders', next))
              },
              logout: () => onLogout(provider),
            }}
          >
            <ProviderModels
              provider={provider}
              favorites={favorites}
              editable={config !== undefined}
              onToggleFavorite={(model) => {
                if (config === undefined) return
                // react-doctor-disable-next-line js-set-map-lookups -- one lookup per click
                const next = favorites.includes(model)
                  ? favorites.filter((favorite) => favorite !== model)
                  : [...favorites, model]
                void save(provider.id, withList(config, 'favorites', next))
              }}
            />
          </ProviderRow>
        )
      })}
    </ul>
  )
}

export function ProvidersSection({
  fetch: fetchImpl,
  store = modelsSettings,
}: {
  fetch?: FetchLike | undefined
  /** The page's models section (favorites, hidden providers); a test passes its own. */
  store?: ModelsSettingsStore
}): React.ReactNode {
  const { read, fetchNow, reload, replace } = useProvidersListing(fetchImpl)
  const models = useStore(store)
  const [login, setLogin] = useState<EnsoProviderLogin | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [keyFormFor, setKeyFormFor] = useState<string | undefined>(undefined)
  /** A refusal said on its provider's row, by provider id. */
  const [refusals, setRefusals] = useState<Readonly<Record<string, string>>>({})
  const refuse = (provider: string, reason: string | undefined): void =>
    setRefusals(({ [provider]: _old, ...rest }) => (reason === undefined ? rest : { ...rest, [provider]: reason }))

  // A login running from Settings when the section opened is shown, so it can be answered or cancelled.
  const running = read.kind === 'read' ? read.listing.login : undefined
  useAdoptedLogin(running, setLogin)

  /** Take a login's new state; a login that settled is followed by the listing read again. */
  const settle = (next: EnsoProviderLogin): void => {
    setLogin(next)
    if (next.status === 'running') return
    if (next.status === 'done') setKeyFormFor(undefined)
    reload()
  }
  const settleRef = useLatest(settle)

  useLoginPolling({ login, fetchNow, reload, setLogin, settleRef })

  const request = async (path: string, body: unknown, provider: string): Promise<void> => {
    setBusy(true)
    refuse(provider, undefined)
    const answer = await postLogin(fetchNow, path, body).finally(() => setBusy(false))
    if (answer.kind === 'refused') refuse(provider, answer.reason)
    else settle(answer.login)
  }

  const actions: RowActions = {
    busy,
    keyFormFor,
    openKeyForm: setKeyFormFor,
    startLogin: (body) => void request('/api/providers/login', body, body.provider),
  }

  if (read.kind === 'loading') return <p className="text-sm text-muted-foreground">Reading providers…</p>
  if (read.kind === 'failed')
    return (
      <p role="alert" className="text-sm text-destructive">
        {read.reason}
      </p>
    )

  const config = models.kind === 'loaded' ? models.settings.models : undefined
  const save = async (provider: string, next: EnsoModelsConfig): Promise<void> => {
    refuse(provider, undefined)
    const outcome = await store.save(next)
    if (outcome.kind === 'refused') refuse(provider, outcome.reason)
  }

  const logout = async (provider: EnsoProvider): Promise<void> => {
    setBusy(true)
    refuse(provider.id, undefined)
    try {
      const response = await postJson(fetchNow, '/api/providers/logout', { provider: provider.id })
      if (!response.ok) refuse(provider.id, await describeFailedResponse(response))
      else {
        const payload: unknown = await response.json()
        if (Check(EnsoProvidersListing, payload)) replace(payload)
        else reload()
      }
    } catch (error) {
      refuse(provider.id, reasonOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-muted-foreground">
        Logins go to pi's own credential store; a key typed here is sent once and never shown again. Favorites and
        hidden providers are saved with your models settings.
      </p>
      {models.kind === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          Favorites and hiding can't be changed: {models.detail}
        </p>
      ) : null}
      {login === undefined ? null : (
        <LoginPanel
          login={login}
          busy={busy}
          onAnswer={(answer) => void request('/api/providers/login/answer', answer, login.provider)}
          onCancel={() => void request('/api/providers/login/cancel', undefined, login.provider)}
          onDismiss={() => setLogin(undefined)}
        />
      )}
      <ProvidersList
        providers={read.listing.providers}
        config={config}
        refusals={refusals}
        actions={actions}
        save={save}
        onLogout={(provider) => void logout(provider)}
      />
      <AddProvider addable={read.listing.addable} actions={actions} refusals={refusals} />
    </div>
  )
}
