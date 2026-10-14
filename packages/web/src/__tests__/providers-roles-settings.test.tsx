import { afterAll, afterEach, expect, test } from 'bun:test'
import type {
  EnsoModelsConfig,
  EnsoModelsSettings,
  EnsoProviderLogin,
  EnsoProviderLoginQuestion,
  EnsoProviderLoginRequest,
  EnsoProvidersListing,
} from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { FetchLike } from '../browser-logging.ts'
import type * as ModelsSettingsModule from '../models-settings.ts'
import type * as ProvidersModule from '../providers-settings.tsx'
import type * as RolesModule from '../roles-settings.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'

// ⚠ A DOM before react-dom/client evaluates — `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { createModelsSettingsStore }: typeof ModelsSettingsModule = await import('../models-settings.ts')
const { ProvidersSection, LOGIN_POLL_MS }: typeof ProvidersModule = await import('../providers-settings.tsx')
const { RolesSection }: typeof RolesModule = await import('../roles-settings.tsx')

/**
 * Settings' Providers and Roles (#904), MOUNTED under happy-dom over a scripted server: an API key
 * typed into the page is sent once and is gone from the page the moment it is (decision 3), and
 * switching to a preset replaces every role in one save (decision 4).
 */

afterAll(releaseDom)

const settle = (): Promise<void> =>
  act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve()
  })

async function eventually<T>(probe: () => T): Promise<T> {
  for (let round = 0; ; round += 1) {
    try {
      return probe()
    } catch (failure) {
      if (round >= 50) throw failure
      await settle()
    }
  }
}

interface Sent {
  readonly request: string
  readonly body: unknown
}

const LISTING: EnsoProvidersListing = {
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      loggedIn: true,
      via: 'subscription',
      stored: true,
      offersOAuth: true,
      offersApiKey: true,
      accountSlot: false,
      hidden: false,
      models: [
        { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5' },
        { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ],
    },
  ],
  addable: [{ id: 'openrouter', name: 'OpenRouter', offersOAuth: false, offersApiKey: true }],
}

const mountedRoots = new Set<{ root: Root; container: HTMLElement }>()
afterEach(async () => {
  for (const mounted of mountedRoots) {
    await act(async () => mounted.root.unmount())
    mounted.container.remove()
  }
  mountedRoots.clear()
})

/** A scripted server for the two sections: the listing, a login, the models section read and written. */
function scripted(
  models: EnsoModelsConfig,
  login: (request: EnsoProviderLoginRequest) => EnsoProviderLogin,
): { readonly sent: Sent[]; readonly fetchImpl: FetchLike } {
  const sent: Sent[] = []
  let file = models
  const fetchImpl: FetchLike = (input, init) => {
    const request = `${init?.method ?? 'GET'} ${requestedUrl(input)}`
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    sent.push({ request, body })
    const settings = (): EnsoModelsSettings => ({ path: '/home/person/.enso/config.json', models: file })
    if (request === 'GET /api/providers') return Promise.resolve(Response.json(LISTING))
    if (request === 'POST /api/providers/login')
      return Promise.resolve(Response.json(login(body as EnsoProviderLoginRequest)))
    if (request === 'GET /api/models/settings') return Promise.resolve(Response.json(settings()))
    if (request === 'PUT /api/models/settings') {
      file = body as EnsoModelsConfig
      return Promise.resolve(Response.json(settings()))
    }
    return Promise.resolve(new Response('not scripted', { status: 404 }))
  }
  return { sent, fetchImpl }
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.add({ root, container })
  await act(async () => root.render(node))
  await settle()
  return container
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name,
  )
  if (found === undefined) throw new Error(`expected the ${name} button`)
  return found
}

async function click(container: HTMLElement, name: string): Promise<void> {
  const button = await eventually(() => buttonNamed(container, name))
  await act(async () => button.click())
  await settle()
}

test('⚠ an API key is a password field with autocomplete off, sent once, and gone from the page once sent', async () => {
  const KEY = 'sk-or-v1-0123456789abcdef-never-shown'
  const { sent, fetchImpl } = scripted({}, (request) => ({
    id: 'login-1',
    provider: request.provider,
    providerName: 'OpenRouter',
    authType: 'api_key',
    status: 'done',
    notices: [],
  }))
  const store = createModelsSettingsStore(fetchImpl)
  await store.refresh()
  const container = await mount(<ProvidersSection fetch={fetchImpl} store={store} />)
  await click(container, 'Add a provider')
  await click(container, 'enter an API key for OpenRouter')
  const field = await eventually(() => {
    const found = container.querySelector<HTMLInputElement>('input[aria-label="API key for OpenRouter"]')
    if (found === null) throw new Error('expected the key field')
    return found
  })
  expect(field.getAttribute('type')).toBe('password')
  expect(field.getAttribute('autocomplete')).toBe('off')

  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', KEY, field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(container, 'Save key')

  const logins = sent.filter((entry) => entry.request === 'POST /api/providers/login')
  expect(logins).toEqual([
    { request: 'POST /api/providers/login', body: { provider: 'openrouter', authType: 'api_key', apiKey: KEY } },
  ])
  // Emptied as it was sent, and nowhere on the page after — not a value, not an attribute, not a word.
  expect(field.value).toBe('')
  await eventually(() => expect(container.textContent).toContain('Logged in to OpenRouter'))
  expect(document.body.innerHTML).not.toContain(KEY)
  for (const input of document.querySelectorAll('input')) expect(input.value).not.toContain(KEY)
  // The listing is read again once the login is done.
  expect(sent.filter((entry) => entry.request === 'GET /api/providers').length).toBe(2)
})

test("a subscription login's questions are answered in the page — a choice, a secret, a code — and the poll picks up the login once it settles", async () => {
  const TOKEN = 'tok-904-secret-never-shown'
  const running = (question?: EnsoProviderLoginQuestion): EnsoProviderLogin => ({
    id: 'login-2',
    provider: 'anthropic',
    providerName: 'Anthropic',
    authType: 'oauth',
    status: 'running',
    notices: ['Log in at https://login.example/start to go on'],
    ...(question === undefined ? {} : { question }),
  })
  const questions: Readonly<Record<string, EnsoProviderLoginQuestion | undefined>> = {
    q1: { id: 'q2', kind: 'secret', message: 'Paste the token', placeholder: 'tok-…' },
    q2: {
      id: 'q3',
      kind: 'code',
      message: 'Paste the code the page shows',
      link: { url: 'https://login.example/device', label: 'Open login page' },
    },
    q3: undefined,
  }
  const base = scripted({}, () =>
    running({
      id: 'q1',
      kind: 'select',
      message: 'Choose an account',
      options: [
        { id: 'work', label: 'Work' },
        { id: 'home', label: 'Home' },
      ],
    }),
  )
  const { sent } = base
  const fetchImpl: FetchLike = (input, init) => {
    const request = `${init?.method ?? 'GET'} ${requestedUrl(input)}`
    if (request === 'GET /api/providers/login') {
      sent.push({ request, body: undefined })
      return Promise.resolve(Response.json({ ...running(), status: 'done' }))
    }
    if (request !== 'POST /api/providers/login/answer') return base.fetchImpl(input, init)
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { questionId: string; value: string }
    sent.push({ request, body })
    return Promise.resolve(Response.json(running(questions[body.questionId])))
  }
  const store = createModelsSettingsStore(fetchImpl)
  await store.refresh()
  const container = await mount(<ProvidersSection fetch={fetchImpl} store={store} />)
  await click(container, 'log in to Anthropic with a subscription')
  const answers = (): unknown[] =>
    sent.filter((entry) => entry.request === 'POST /api/providers/login/answer').map((entry) => entry.body)
  const field = (selector: string): Promise<HTMLInputElement & HTMLSelectElement> =>
    eventually(() => {
      const found = container.querySelector<HTMLInputElement & HTMLSelectElement>(selector)
      if (found === null) throw new Error(`expected ${selector}`)
      return found
    })
  const type = (input: HTMLInputElement | HTMLSelectElement, value: string, event: string): Promise<void> =>
    act(async () => {
      Reflect.set(Object.getPrototypeOf(input) as object, 'value', value, input)
      input.dispatchEvent(new Event(event, { bubbles: true }))
    })

  // A choice: the option's id is sent, not its words.
  const choice = await field('select#provider-question-q1')
  expect([...choice.options].map((option) => [option.value, option.textContent])).toEqual([
    ['work', 'Work'],
    ['home', 'Home'],
  ])
  await type(choice, 'home', 'change')
  await click(container, 'Answer')
  expect(answers()).toEqual([{ questionId: 'q1', value: 'home' }])

  // A secret: a password field, emptied as it is sent, and nowhere on the page after.
  const secret = await field('input#provider-question-q2')
  expect(secret.getAttribute('type')).toBe('password')
  expect(secret.getAttribute('placeholder')).toBe('tok-…')
  await type(secret, TOKEN, 'input')
  await click(container, 'Answer')
  expect(answers()).toEqual([
    { questionId: 'q1', value: 'home' },
    { questionId: 'q2', value: TOKEN },
  ])
  expect(secret.value).toBe('')

  // A code, with the page to get it from; a blank answer is not sent.
  const code = await field('input#provider-question-q3')
  expect(code.getAttribute('type')).toBe('text')
  const link = container.querySelector<HTMLAnchorElement>('a[href="https://login.example/device"][target="_blank"]')
  expect(link?.textContent).toBe('Open login page')
  await click(container, 'Answer')
  expect(answers()).toHaveLength(2)
  await type(code, 'code-9', 'input')
  await click(container, 'Answer')
  expect(answers()).toHaveLength(3)
  expect(answers()[2]).toEqual({ questionId: 'q3', value: 'code-9' })
  await eventually(() => expect(container.textContent).toContain('Waiting for pi…'))
  expect(document.body.innerHTML).not.toContain(TOKEN)

  // No question open: the login is asked how it goes, and the page follows it to done.
  const listingReads = (): number => sent.filter((entry) => entry.request === 'GET /api/providers').length
  const readsBefore = listingReads()
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, LOGIN_POLL_MS + 200)
    await promise
  })
  await eventually(() => expect(container.textContent).toContain('Logged in to Anthropic'))
  expect(sent.some((entry) => entry.request === 'GET /api/providers/login')).toBe(true)
  await eventually(() => expect(listingReads()).toBe(readsBefore + 1))
})

test('⚠ switching to a preset replaces every role and the default effort in one save', async () => {
  const models: EnsoModelsConfig = {
    favorites: ['anthropic/claude-opus-4-5'],
    roles: {
      default: { model: 'anthropic/claude-opus-4-5', effort: 'high' },
      review: { model: 'anthropic/claude-opus-4-5', effort: 'xhigh' },
    },
    defaultEffort: 'medium',
    presets: {
      cheap: { roles: { default: { model: 'anthropic/claude-haiku-4-5', effort: 'low' } } },
    },
  }
  const { sent, fetchImpl } = scripted(models, () => {
    throw new Error('the Roles test logs in to nothing')
  })
  const store = createModelsSettingsStore(fetchImpl)
  await store.refresh()
  const container = await mount(<RolesSection fetch={fetchImpl} store={store} />)
  await eventually(() => buttonNamed(container, 'delete role review'))

  await click(container, 'switch to preset cheap')

  const saves = sent.filter((entry) => entry.request === 'PUT /api/models/settings')
  expect(saves).toHaveLength(1)
  // `review` the preset leaves out is cleared, and so is the default effort it has none of; the rest stays.
  expect(saves[0]?.body).toEqual({
    favorites: ['anthropic/claude-opus-4-5'],
    roles: { default: { model: 'anthropic/claude-haiku-4-5', effort: 'low' } },
    presets: models.presets,
  })
  await eventually(() => expect(() => buttonNamed(container, 'delete role review')).toThrow())
})
