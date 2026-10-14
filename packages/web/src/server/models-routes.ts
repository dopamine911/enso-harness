import { chmodSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type EnsoAddableProvider,
  type EnsoModelsConfig,
  EnsoModelsConfig as EnsoModelsConfigSchema,
  type EnsoModelsSettings,
  type EnsoProvider,
  type EnsoProviderLogin,
  EnsoProviderLoginAnswer,
  type EnsoProviderLoginQuestion,
  EnsoProviderLoginRequest,
  EnsoProviderLogoutRequest,
  type EnsoProvidersListing,
  type EnsoRoleResolution,
  ensoLogger,
  type HostCommandOption,
  parseEnsoConfig,
  resolveModelRole,
} from '@enso/core'
import { readTextIfPresent } from '@enso/core/paths'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { HostAuthQuestion } from '../host/host-flow-runs.ts'
import { authEventText, isFlowCancelled, loginCodeQuestion } from '../host/host-flows.ts'
import type { HostProviderFacts, HostProviders } from '../host/provider-settings.ts'
import { CREDENTIALS_TIMEOUT_MS } from '../host/session-models.ts'
import { answerJson, answerOrFail, MAX_DIALOG_BODY_BYTES, readJsonBody, refuseWith } from './request-plumbing.ts'

/**
 * The models routes (#904): the user's `models` section of `ENSO_HOME/config.json` — favorites,
 * hidden providers, roles, presets — read and written whole; the providers pi knows, for Settings;
 * a login and a logout from Settings; and the role a `…/configure` names, resolved. ⚠
 * `scripts/docs/routes.ts` reads the literal routes off the `request.method === … && url …`
 * conditions below (#174): keep that spelling.
 *
 * ⚠ USER-ONLY (#904 decision 1): the section is read from the user's file alone, fresh on each
 * request — never merged with a project's `.enso/config.json`. A write keeps every other section of
 * the file as it is, and a file that is there and unreadable is NEVER overwritten.
 *
 * ⚠ AN API KEY IS SAID ONCE (#904 decision 3). It arrives in one login body (or one answer), goes
 * to pi's `login` — which stores it in pi's own `auth.json` (`AuthStorage`) — and is then forgotten:
 * no answer, refusal, log line or error repeats it. A body that does not parse is refused in our
 * words, never the parser's (which can quote what it read), and every reason a login ends with has
 * each secret it was given cut out first.
 */

const log = ensoLogger('server', 'http')

/** The models section is a hand-sized object; a quarter megabyte is far past any real one. */
const MAX_MODELS_BODY_BYTES = 256 * 1024

/** What the models routes read from the server. */
export interface ModelsRoutesState {
  /** The user's config file; absent, the server reads no config and the section routes refuse. */
  readonly configPath: string | undefined
  readonly providers: HostProviders
}

export interface ModelsRoutes {
  /** True when the request was a models or providers route. */
  readonly dispatchModelsRoute: (request: IncomingMessage, response: ServerResponse) => boolean
  /** A role resolved from the user's config against the `/model` options on offer (`…/configure`). */
  readonly resolveRole: (name: string, options: readonly HostCommandOption[]) => EnsoRoleResolution
}

type SectionRead =
  | { readonly kind: 'read'; readonly models: EnsoModelsConfig }
  | { readonly kind: 'refused'; readonly reason: string }

/** The `models` section of the user's file, fresh; absent is `{}`. */
function readSection(configPath: string | undefined): SectionRead {
  if (configPath === undefined) return { kind: 'refused', reason: 'this server reads no user config' }
  const parsed = parseEnsoConfig(readTextIfPresent(configPath))
  if (parsed.kind === 'unreadable') return { kind: 'refused', reason: `${configPath} is unreadable: ${parsed.reason}` }
  return { kind: 'read', models: parsed.config.models ?? {} }
}

/** The section written over the user's file, every other section kept; atomic. */
function writeSection(configPath: string, models: EnsoModelsConfig): SectionRead {
  const text = readTextIfPresent(configPath)
  const parsed = parseEnsoConfig(text)
  if (parsed.kind === 'unreadable') {
    return {
      kind: 'refused',
      reason: `${configPath} is unreadable (${parsed.reason}); fix or remove it — it is never overwritten`,
    }
  }
  const { models: _previous, ...others } = parsed.config
  const next = Object.keys(models).length === 0 ? others : { ...others, models }
  const checked = parseEnsoConfig(JSON.stringify(next))
  if (checked.kind === 'unreadable') return { kind: 'refused', reason: checked.reason }
  const temporary = `${configPath}.${process.pid}.tmp`
  // The rename installs the temporary file's inode, so it carries the mode: the file's own, else
  // 0600 — never the umask's default, which would open the user's config from the second save on.
  // Set after the write: a mode given to the write is cut by the umask, and ignored for a file left over.
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode })
  chmodSync(temporary, mode)
  renameSync(temporary, configPath)
  return { kind: 'read', models }
}

/** A route's body: its schema, what it is (`capped`, as in "a login request is"), what it must hold, and its cap. */
interface ClosedBody<Schema extends TSchema> {
  readonly schema: Schema
  readonly capped: string
  readonly requirement: string
  readonly maxBytes?: number
}

const SECTION_BODY: ClosedBody<typeof EnsoModelsConfigSchema> = {
  schema: EnsoModelsConfigSchema,
  capped: 'the models settings are',
  requirement:
    'the models settings are `favorites`, `hiddenProviders`, `roles` (each named in lower case: a letter, then letters, digits or -), `defaultEffort` and `presets`',
  maxBytes: MAX_MODELS_BODY_BYTES,
}

const LOGIN_BODY: ClosedBody<typeof EnsoProviderLoginRequest> = {
  schema: EnsoProviderLoginRequest,
  capped: 'a login request is',
  requirement:
    'a login names a `provider` and an `authType` (`api_key` or `oauth`), and for an API key at most the `apiKey`',
}

const ANSWER_BODY: ClosedBody<typeof EnsoProviderLoginAnswer> = {
  schema: EnsoProviderLoginAnswer,
  capped: 'an answer is',
  requirement: 'an answer names the `questionId` and its `value`',
}

const LOGOUT_BODY: ClosedBody<typeof EnsoProviderLogoutRequest> = {
  schema: EnsoProviderLogoutRequest,
  capped: 'a logout request is',
  requirement: 'a logout names the `provider`',
}

/**
 * A JSON body exactly `schema`, at most `maxBytes` (`capped` names it in the refusal); `undefined`
 * once refused. Refused in our words only — a parser's message can quote the body, a key in it.
 */
function readClosedBody<Schema extends TSchema>(
  request: IncomingMessage,
  response: ServerResponse,
  body: ClosedBody<Schema>,
): Promise<Static<Schema> | undefined> {
  const { schema, requirement, maxBytes = MAX_DIALOG_BODY_BYTES } = body
  return readJsonBody(request, response, {
    maxBytes,
    capText: `${body.capped} at most ${maxBytes} bytes`,
    parse: (raw: string): Static<Schema> => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error(`malformed body: not JSON. ${requirement}`)
      }
      if (!Check(schema, parsed)) throw new Error(requirement)
      return parsed
    },
  })
}

/**
 * What a key must look like before pi is given it: printable characters with no space or line
 * break, at most 4 KiB — a paste with a trailing newline or the label copied with it is refused, and
 * the refusal never repeats it.
 */
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/

/** Why a login cannot start, before pi is asked: a provider or a way in it does not offer, or a key no key looks like. */
function loginRefusal(body: EnsoProviderLoginRequest, provider: HostProviderFacts | undefined): string | undefined {
  if (provider === undefined) return `pi knows no provider ${body.provider}`
  if (body.authType === 'oauth' && !provider.offersOAuth) return `${provider.name} offers no subscription login`
  if (body.authType === 'api_key' && !provider.offersApiKey) return `${provider.name} takes no API key here`
  if (body.apiKey === undefined) return undefined
  if (body.authType !== 'api_key') return 'a key goes with an API-key login only'
  if (!KEY_SHAPE.test(body.apiKey)) {
    return 'the key was refused and not stored: it holds a space, a line break or a character no key has'
  }
  return undefined
}

/** One login started from Settings, as it runs. */
interface SettingsLogin {
  state: EnsoProviderLogin
  /** Every secret it was given: cut out of any reason it ends with. */
  readonly secrets: string[]
  readonly abort: AbortController
  /** The question's answer, while one is open. */
  answer: ((value: string) => void) | undefined
  authUrl: string | undefined
  /** Whoever waits for its next change. */
  readonly waiting: (() => void)[]
}

/** The login's state moved on; `question: undefined` takes the question away. Whoever waits is woken. */
function changed(
  login: SettingsLogin,
  next: Pick<Partial<EnsoProviderLogin>, 'status' | 'notices' | 'reason'> & {
    readonly question?: EnsoProviderLoginQuestion | undefined
  },
): void {
  const { question: _asked, ...state } = login.state
  const { question: nextQuestion, ...rest } = next
  const question = 'question' in next ? nextQuestion : login.state.question
  login.state = { ...state, ...rest, ...(question === undefined ? {} : { question }) }
  for (const wake of login.waiting.splice(0)) wake()
}

/** Resolves at the login's next change, or at once when it already waits on a question or has ended. */
function nextChange(login: SettingsLogin): Promise<void> {
  if (login.state.status !== 'running' || login.state.question !== undefined) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  login.waiting.push(resolve)
  return promise
}

/** Resolves once the login has ended, whatever it asked on the way. */
async function ended(login: SettingsLogin): Promise<void> {
  while (login.state.status === 'running') {
    const { promise, resolve } = Promise.withResolvers<void>()
    login.waiting.push(resolve)
    await promise
  }
}

/** The login's state, answered once `moment` has come. */
async function answerAt(moment: Promise<void>, login: SettingsLogin, response: ServerResponse): Promise<void> {
  await moment
  answerJson(response, login.state)
}

/** A reason with every secret cut out. */
function withoutSecrets(reason: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => (secret.length === 0 ? text : text.split(secret).join('[the key]')), reason)
}

/** pi's question as the page asks it. */
function questionOf(prompt: HostAuthQuestion, id: string, login: SettingsLogin): EnsoProviderLoginQuestion {
  switch (prompt.type) {
    case 'secret':
      return {
        id,
        kind: 'secret',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      }
    case 'select':
      return {
        id,
        kind: 'select',
        message: prompt.message,
        options: prompt.options.map(({ id: optionId, label }) => ({ id: optionId, label })),
      }
    case 'manual_code': {
      const asked = loginCodeQuestion(login.state.providerName, login.authUrl, prompt.placeholder)
      return {
        id,
        kind: 'code',
        message: asked.message ?? asked.title,
        ...(asked.placeholder === undefined ? {} : { placeholder: asked.placeholder }),
        ...(asked.link === undefined
          ? {}
          : { link: { url: asked.link.url, label: asked.link.label ?? 'Open login page' } }),
      }
    }
    default:
      return {
        id,
        kind: 'text',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      }
  }
}

/** The Settings listing (#904): providers set up or registered by an extension; pi's other built-ins are addable. */
function providersListing(
  facts: readonly HostProviderFacts[],
  hidden: readonly string[],
): Pick<EnsoProvidersListing, 'providers' | 'addable'> {
  const byName = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name)
  const setUp = facts.filter((provider) => provider.loggedIn || provider.stored || provider.registered)
  const setUpIds = new Set(setUp.map((provider) => provider.id))
  const hiddenIds = new Set(hidden)
  const providers: EnsoProvider[] = setUp.toSorted(byName).map((provider) => ({
    id: provider.id,
    name: provider.name,
    loggedIn: provider.loggedIn,
    ...(provider.via === undefined ? {} : { via: provider.via }),
    stored: provider.stored,
    offersOAuth: provider.offersOAuth,
    offersApiKey: provider.offersApiKey,
    accountSlot: provider.registered,
    hidden: hiddenIds.has(provider.id),
    models: provider.models.map(({ id, name }) => ({ id, name })),
  }))
  const addable: EnsoAddableProvider[] = facts
    .filter((provider) => !setUpIds.has(provider.id) && (provider.offersOAuth || provider.offersApiKey))
    .toSorted(byName)
    .map(({ id, name, offersOAuth, offersApiKey }) => ({ id, name, offersOAuth, offersApiKey }))
  return { providers, addable }
}

export function createModelsRoutes(state: ModelsRoutesState): ModelsRoutes {
  const { configPath, providers } = state
  let login: SettingsLogin | undefined
  let questions = 0

  const answerSection = (response: ServerResponse, read: SectionRead): void => {
    if (read.kind === 'refused' || configPath === undefined) {
      refuseWith(response, {
        status: 422,
        reason: read.kind === 'refused' ? read.reason : 'this server reads no user config',
      })
      return
    }
    const settings: EnsoModelsSettings = { path: configPath, models: read.models }
    answerJson(response, settings)
  }

  async function listing(): Promise<EnsoProvidersListing> {
    const section = readSection(configPath)
    const hidden = section.kind === 'read' ? (section.models.hiddenProviders ?? []) : []
    const listed = providersListing(await providers.list(), hidden)
    return { ...listed, ...(login === undefined ? {} : { login: login.state }) }
  }

  /** The provider pi knows by `id` now, or `undefined`. */
  const providerOf = async (id: string): Promise<HostProviderFacts | undefined> =>
    (await providers.list()).find((candidate) => candidate.id === id)

  async function respondToSectionWrite(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const models = await readClosedBody(request, response, SECTION_BODY)
    if (models === undefined) return
    if (configPath === undefined) {
      refuseWith(response, { status: 422, reason: 'this server reads no user config, so it keeps no models settings' })
      return
    }
    const written = writeSection(configPath, models)
    if (written.kind === 'refused') log.warn('models settings not saved: {reason}', { reason: written.reason })
    else log.info('models settings saved to {path}', { path: configPath, roles: Object.keys(models.roles ?? {}) })
    answerSection(response, written)
  }

  /** Start pi's login, the one `/login` runs, outside any thread; the answer once it settles or asks. */
  async function respondToLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readClosedBody(request, response, LOGIN_BODY)
    if (body === undefined) return
    // The providers are read BEFORE the running-login check, and nothing awaits between that check
    // and `login = started`: two logins sent together cannot both pass it, the second overwriting
    // the first and leaving its question unanswerable.
    const provider = await providerOf(body.provider)
    if (login?.state.status === 'running') {
      refuseWith(response, {
        status: 409,
        reason: `a login to ${login.state.providerName} is running; finish or cancel it first`,
      })
      return
    }
    const refusal = loginRefusal(body, provider)
    if (refusal !== undefined || provider === undefined) {
      log.warn('provider login refused: {reason}', {
        provider: body.provider,
        authType: body.authType,
        reason: refusal,
      })
      refuseWith(response, { status: 422, reason: refusal ?? 'no such provider' })
      return
    }
    const started: SettingsLogin = {
      state: {
        id: crypto.randomUUID(),
        provider: provider.id,
        providerName: provider.name,
        authType: body.authType,
        status: 'running',
        notices: [],
      },
      secrets: body.apiKey === undefined ? [] : [body.apiKey],
      abort: new AbortController(),
      answer: undefined,
      authUrl: undefined,
      waiting: [],
    }
    login = started
    let keyGiven = body.apiKey
    log.info('provider login started: {provider} ({authType})', { provider: provider.id, authType: body.authType })
    void providers
      .logIn(provider.id, body.authType, {
        signal: started.abort.signal,
        ask: (prompt) => {
          // The key typed into the page answers pi's first key prompt, once.
          if (prompt.type === 'secret' && keyGiven !== undefined) {
            const key = keyGiven
            keyGiven = undefined
            return Promise.resolve(key)
          }
          questions += 1
          const question = questionOf(prompt, `q${questions}`, started)
          const { promise, resolve, reject } = Promise.withResolvers<string>()
          const withdraw = (): void => reject(new Error('Login cancelled'))
          prompt.signal?.addEventListener('abort', withdraw, { once: true })
          started.abort.signal.addEventListener('abort', withdraw, { once: true })
          started.answer = (value: string): void => {
            started.answer = undefined
            if (prompt.type === 'secret') started.secrets.push(value)
            changed(started, { question: undefined })
            resolve(value)
          }
          changed(started, { question })
          return promise
        },
        notify: (event) => {
          if (event.type === 'auth_url') started.authUrl = event.url
          changed(started, { notices: [...started.state.notices, authEventText(event, provider.name)] })
        },
      })
      .then(
        () => {
          log.info('provider login done: {provider}', { provider: provider.id })
          changed(started, { status: 'done', question: undefined })
        },
        (error: unknown) => {
          if (started.abort.signal.aborted || isFlowCancelled(error)) {
            log.info('provider login cancelled: {provider}', { provider: provider.id })
            changed(started, { status: 'cancelled', question: undefined })
            return
          }
          const reason = withoutSecrets(error instanceof Error ? error.message : String(error), started.secrets)
          log.warn('provider login failed: {provider}: {reason}', { provider: provider.id, reason })
          changed(started, { status: 'failed', question: undefined, reason })
        },
      )
      .finally(() => {
        // Said once; the secrets go with it.
        started.secrets.splice(0)
      })
    await answerAt(nextChange(started), started, response)
  }

  async function respondToAnswer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readClosedBody(request, response, ANSWER_BODY)
    if (body === undefined) return
    const current = login
    if (current?.answer === undefined || current.state.question?.id !== body.questionId) {
      refuseWith(response, { status: 409, reason: 'no login asks that question now' })
      return
    }
    current.answer(body.value)
    await answerAt(nextChange(current), current, response)
  }

  async function respondToLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readClosedBody(request, response, LOGOUT_BODY)
    if (body === undefined) return
    const provider = await providerOf(body.provider)
    if (provider?.stored !== true) {
      refuseWith(response, {
        status: 422,
        reason: `pi stores no credential for ${provider?.name ?? body.provider}; a key from the environment is not pi's to remove`,
      })
      return
    }
    await providers.logOut(provider.id, AbortSignal.timeout(CREDENTIALS_TIMEOUT_MS))
    log.info('provider logged out: {provider}', { provider: provider.id })
    answerJson(response, await listing())
  }

  /** The latest Settings login; 204 when there has been none. */
  function respondWithLogin(response: ServerResponse): void {
    if (login === undefined) {
      response.writeHead(204)
      response.end()
      return
    }
    answerJson(response, login.state)
  }

  /** End the running login; the answer once it has ended. */
  async function respondToCancel(response: ServerResponse): Promise<void> {
    const current = login
    if (current === undefined) {
      refuseWith(response, { status: 409, reason: 'no login is running' })
      return
    }
    current.abort.abort()
    await answerAt(ended(current), current, response)
  }

  /** Answer through `work`, a throw or failure the handler's 500; always true: the request was this group's. */
  function answered(response: ServerResponse, work: () => void | Promise<void>): true {
    answerOrFail(Promise.resolve().then(work), response)
    return true
  }

  /** The section and the listing routes. */
  function dispatchSettingsRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/api/models/settings')
      return answered(response, () => answerSection(response, readSection(configPath)))
    if (request.method === 'PUT' && url === '/api/models/settings')
      return answered(response, () => respondToSectionWrite(request, response))
    if (request.method === 'GET' && url === '/api/providers')
      return answered(response, async () => answerJson(response, await listing()))
    if (request.method === 'POST' && url === '/api/providers/logout')
      return answered(response, () => respondToLogout(request, response))
    return false
  }

  /** A Settings login's routes. */
  function dispatchLoginRoute(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? ''
    if (request.method === 'POST' && url === '/api/providers/login')
      return answered(response, () => respondToLogin(request, response))
    if (request.method === 'GET' && url === '/api/providers/login')
      return answered(response, () => respondWithLogin(response))
    if (request.method === 'POST' && url === '/api/providers/login/answer')
      return answered(response, () => respondToAnswer(request, response))
    if (request.method === 'POST' && url === '/api/providers/login/cancel')
      return answered(response, () => respondToCancel(response))
    return false
  }

  /** True when the request was a models or providers route. */
  function dispatchModelsRoute(request: IncomingMessage, response: ServerResponse): boolean {
    return dispatchSettingsRoute(request, response) || dispatchLoginRoute(request, response)
  }

  return {
    dispatchModelsRoute,
    resolveRole(name, options) {
      const section = readSection(configPath)
      if (section.kind === 'refused') return { kind: 'refused', role: name, reason: section.reason }
      return resolveModelRole(name, section.models, options)
    },
  }
}
