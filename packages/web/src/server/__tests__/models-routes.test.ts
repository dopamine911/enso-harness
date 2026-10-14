import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnsoModelsSettings, EnsoProviderLogin, EnsoProvidersListing } from '@enso/core'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/test-support/log-recorder'
import type { LogRecorder } from '@logtape/testing/recorder'
import { Check } from 'typebox/value'
import { HostCommandRefused } from '../../host/host-commands.ts'
import { startEnsoServer } from '../index.ts'
import {
  createFakeAgentHost,
  createFakeHostedThread,
  createFakeProviders,
  type FakeHostedThreadOptions,
  type FakeProviders,
  type FakeThreadRecord,
} from './fake-hosted-thread.ts'

/**
 * The models routes (#904) over the fake host: the `models` section of the user's config, Settings'
 * providers and their logins, and a `…/configure` that names a role. The key that crosses a login
 * is asserted to come back NOWHERE — no answer, no log record, no file Enso writes (decision 3).
 */

const openServers: { close: () => Promise<void> }[] = []
let logs: LogRecorder
beforeEach(async () => {
  logs = await recordEnsoLogs()
})
afterEach(async () => {
  for (const started of openServers.splice(0)) await started.close()
  await releaseEnsoLogs()
})

/** Every file under `directory`, read as text. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, 'utf8'))
}

async function start(
  config?: object,
  threadOptions?: FakeHostedThreadOptions,
): Promise<{
  url: string
  home: string
  configPath: string
  providers: FakeProviders
  built: FakeThreadRecord[]
}> {
  const home = mkdtempSync(join(tmpdir(), 'enso-models-home-'))
  const configPath = join(home, 'config.json')
  if (config !== undefined) writeFileSync(configPath, JSON.stringify(config))
  const harness = join(home, 'harness')
  mkdirSync(harness)
  writeFileSync(join(harness, 'package.json'), JSON.stringify({ name: 'fake-harness', pi: {} }))
  const providers = createFakeProviders()
  const built: FakeThreadRecord[] = []
  const started = startEnsoServer({
    cwd: tmpdir(),
    modelsConfigPath: configPath,
    harnessPackageDir: harness,
    agentDir: join(home, 'pi-agent'),
    permissionRulesPath: join(home, 'permissions.json'),
    logsDir: join(home, 'logs'),
    port: 0,
    host: () => ({
      ...createFakeAgentHost(() => {
        const fake = createFakeHostedThread(threadOptions)
        built.push(fake.record)
        return Promise.resolve(fake.hosted)
      }),
      providers,
    }),
  })
  openServers.push(started)
  return { url: await started.listening, home, configPath, providers, built }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const KEY = 'sk-904-known-key-c0ffee'

test('⚠ an API key typed into Settings goes to the credential store once, and no answer, log record or file repeats it', async () => {
  const { url, home, providers } = await start()
  const answers: string[] = []
  const login = await post(`${url}/api/providers/login`, { provider: 'fake', authType: 'api_key', apiKey: KEY })
  answers.push(await login.clone().text())
  expect(login.status).toBe(200)
  const state: unknown = await login.json()
  expect(Check(EnsoProviderLogin, state) && state.status).toBe('done')
  // Straight to the store: the fake's stands in for pi's `AuthStorage`.
  expect(providers.stored.get('fake')).toBe(KEY)

  const listing = await fetch(`${url}/api/providers`)
  answers.push(await listing.clone().text())
  const listed: unknown = await listing.json()
  if (!Check(EnsoProvidersListing, listed)) throw new Error('listing off its schema')
  // On screen: only that a key is set.
  expect(listed.providers.find((provider) => provider.id === 'fake')).toMatchObject({ loggedIn: true, via: 'api-key' })
  answers.push(await (await fetch(`${url}/api/providers/login`)).text())

  // A key the provider refuses, quoting it: refused with the reason, the key cut out, nothing stored.
  const badKey = 'bad-904-refused-key'
  const refused = await post(`${url}/api/providers/login`, { provider: 'fake', authType: 'api_key', apiKey: badKey })
  const refusedText = await refused.text()
  expect(refusedText).toContain('"status":"failed"')
  expect(refusedText).toContain('rejected the key [the key]')
  expect(refusedText).not.toContain(badKey)
  // A key no key looks like is refused before pi, and not repeated either.
  const pasted = await post(`${url}/api/providers/login`, { provider: 'fake', authType: 'api_key', apiKey: `${KEY}\n` })
  expect(pasted.status).toBe(422)
  answers.push(await pasted.text())
  // Malformed JSON around a key: refused in our words, never the parser's.
  const malformed = await fetch(`${url}/api/providers/login`, {
    method: 'POST',
    body: `{"provider":"fake","authType":"api_key","apiKey":${KEY}}`,
  })
  expect(malformed.status).toBe(400)
  answers.push(await malformed.text())
  expect(providers.stored.get('fake')).toBe(KEY)

  for (const secret of [KEY, badKey]) {
    for (const answer of answers) expect(answer).not.toContain(secret)
    expect(JSON.stringify(logs.records.map((record) => [record.message, record.properties]))).not.toContain(secret)
    for (const text of filesUnder(home)) expect(text).not.toContain(secret)
  }
})

test('a page on another origin is refused a login (403), and nothing is stored', async () => {
  const { url, providers } = await start()
  const foreign = await post(
    `${url}/api/providers/login`,
    { provider: 'fake', authType: 'api_key', apiKey: KEY },
    { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site' },
  )
  expect(foreign.status).toBe(403)
  expect(providers.stored.size).toBe(0)
})

test('a subscription login says its page, asks for the code, and is done once answered; logout removes it', async () => {
  const { url, providers } = await start()
  const started = (await (
    await post(`${url}/api/providers/login`, { provider: 'faux-sub', authType: 'oauth' })
  ).json()) as EnsoProviderLogin
  expect(started.notices).toEqual(['To log in to Faux Subscription, open https://login.example/authorize'])
  expect(started.question).toMatchObject({ kind: 'code', link: { url: 'https://login.example/authorize' } })
  const busy = await post(`${url}/api/providers/login`, { provider: 'fake', authType: 'api_key', apiKey: KEY })
  expect(busy.status).toBe(409)
  const done = (await (
    await post(`${url}/api/providers/login/answer`, { questionId: started.question?.id, value: 'code-1' })
  ).json()) as EnsoProviderLogin
  expect(done.status).toBe('done')
  expect(providers.stored.get('faux-sub')).toBe('code-1')
  const after = (await (
    await post(`${url}/api/providers/logout`, { provider: 'faux-sub' })
  ).json()) as EnsoProvidersListing
  expect(after.providers.find((provider) => provider.id === 'faux-sub')).toMatchObject({
    loggedIn: false,
    accountSlot: true,
  })
  // Nobody set `fake` or `other` up: each is to be added, not listed.
  expect(after.addable.map((provider) => provider.id)).toEqual(['fake', 'other'])
})

test("a login that asks a choice and then a name: the page gets the choice's options by id, then the name's text field; the answers are what is stored", async () => {
  const { url, providers } = await start()
  const answer = async (questionId: string | undefined, value: string): Promise<EnsoProviderLogin> =>
    (await (await post(`${url}/api/providers/login/answer`, { questionId, value })).json()) as EnsoProviderLogin
  const started = (await (
    await post(`${url}/api/providers/login`, { provider: 'other', authType: 'oauth' })
  ).json()) as EnsoProviderLogin
  expect(started.question).toEqual({
    id: expect.any(String),
    kind: 'select',
    message: 'Choose a region',
    options: [
      { id: 'eu', label: 'Europe' },
      { id: 'us', label: 'United States' },
    ],
  })
  const named = await answer(started.question?.id, 'us')
  expect(named.status).toBe('running')
  expect(named.question).toEqual({
    id: expect.any(String),
    kind: 'text',
    message: 'Name this account',
    placeholder: 'work',
  })
  expect(named.question?.id).not.toBe(started.question?.id)
  const done = await answer(named.question?.id, 'personal')
  expect(done.status).toBe('done')
  expect(providers.stored.get('other')).toBe('us:personal')
})

test("the models section is written whole into the user's config, every other section kept; an unreadable file is never overwritten", async () => {
  const { url, configPath } = await start({ webFetch: { allowedHosts: ['docs.example.com'] } })
  const models = {
    favorites: ['fake/fake-2', 'gone/model'],
    hiddenProviders: ['faux-sub'],
    roles: { review: { model: 'fake/fake-2', effort: 'high', fallbacks: [{ model: 'fake/fake-1' }] } },
    presets: { night: { roles: { quick: { model: 'fake/fake-1' } }, defaultEffort: 'low' } },
  }
  const saved = await fetch(`${url}/api/models/settings`, { method: 'PUT', body: JSON.stringify(models) })
  expect(Check(EnsoModelsSettings, await saved.json())).toBe(true)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
    models,
  })
  expect(await (await fetch(`${url}/api/models/settings`)).json()).toEqual({ path: configPath, models })
  // A hidden provider is still listed in Settings, marked.
  const listed = (await (await fetch(`${url}/api/providers`)).json()) as EnsoProvidersListing
  expect(listed.providers.find((provider) => provider.id === 'faux-sub')?.hidden).toBe(true)
  // A role name the picker could not say is refused.
  const badName = await fetch(`${url}/api/models/settings`, {
    method: 'PUT',
    body: JSON.stringify({ roles: { 'Big Model': { model: 'x/y' } } }),
  })
  expect(badName.status).toBe(400)

  writeFileSync(configPath, '{ not json')
  const refused = await fetch(`${url}/api/models/settings`, { method: 'PUT', body: JSON.stringify({}) })
  expect(refused.status).toBe(422)
  expect(readFileSync(configPath, 'utf8')).toBe('{ not json')
})

// A rename installs the temporary file's inode: written with the umask's default, the second save
// would leave the user's config readable to every account on the machine.
test("the user's config keeps its mode across saves: 0600 when the server made it, whatever the umask", async () => {
  const umask = process.umask(0o022)
  try {
    const { url, configPath } = await start()
    for (const favorites of [['fake/fake-1'], ['fake/fake-2']]) {
      const saved = await fetch(`${url}/api/models/settings`, { method: 'PUT', body: JSON.stringify({ favorites }) })
      expect(saved.status).toBe(200)
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
    }
  } finally {
    process.umask(umask)
  }
})

test("the user's config keeps a mode the user gave it: a 0640 file is 0640 after a save", async () => {
  const { url, configPath } = await start({ webFetch: { allowedHosts: ['docs.example.com'] } })
  chmodSync(configPath, 0o640)
  const saved = await fetch(`${url}/api/models/settings`, {
    method: 'PUT',
    body: JSON.stringify({ favorites: ['fake/fake-1'] }),
  })
  expect(saved.status).toBe(200)
  expect(statSync(configPath).mode & 0o777).toBe(0o640)
})

test('two logins started together: one runs and keeps its question answerable, the other is refused (409)', async () => {
  const { url, providers } = await start()
  // Both requests read the providers before either goes on: the window a running-login check
  // made before that read would leave open.
  const list = providers.list.bind(providers)
  const bothListing = Promise.withResolvers<void>()
  let listings = 0
  providers.list = async () => {
    listings += 1
    if (listings === 2) bothListing.resolve()
    await bothListing.promise
    return list()
  }
  const subscription = { provider: 'faux-sub', authType: 'oauth' }
  const responses = await Promise.all([
    post(`${url}/api/providers/login`, subscription),
    post(`${url}/api/providers/login`, subscription),
  ])
  expect(responses.map((response) => response.status).toSorted((first, second) => first - second)).toEqual([200, 409])
  const started = (await responses.find((response) => response.status === 200)?.json()) as EnsoProviderLogin
  const done = (await (
    await post(`${url}/api/providers/login/answer`, { questionId: started.question?.id, value: 'code-1' })
  ).json()) as EnsoProviderLogin
  expect(done.status).toBe('done')
  expect(providers.stored.get('faux-sub')).toBe('code-1')
})

test('⚠ a configure that names a role runs its model at its effort, clamped, and records the role with what it resolved to (#904)', async () => {
  const { url, configPath, built } = await start({
    models: {
      roles: {
        // fake-2 offers `off` alone: `high` is clamped to it.
        review: { model: 'fake/fake-2', effort: 'high' },
        // A model gone from the catalogue falls back to the first available.
        quick: { model: 'gone/model', effort: 'low', fallbacks: [{ model: 'fake/fake-1', effort: 'low' }] },
        stuck: { model: 'gone/model' },
      },
    },
  })
  const configure = (threadId: string, body: object): Promise<Response> =>
    post(`${url}/api/threads/${threadId}/configure`, body)
  expect((await configure('t1', { role: 'review' })).status).toBe(204)
  expect(built[0]?.modelRoles).toEqual([{ role: 'review', provider: 'fake', modelId: 'fake-2', thinkingLevel: 'off' }])
  expect((await configure('t2', { role: 'quick' })).status).toBe(204)
  expect(built[1]?.modelRoles).toEqual([
    { role: 'quick', provider: 'fake', modelId: 'fake-1', thinkingLevel: 'low', fallback: true },
  ])
  const stuck = await configure('t3', { role: 'stuck' })
  expect(stuck.status).toBe(422)
  expect(await stuck.json()).toEqual({
    step: 'model',
    reason: 'role stuck has no model available: gone/model (not in the catalogue)',
  })
  expect((await configure('t4', { role: 'review', model: 'fake/fake-1' })).status).toBe(400)

  // Editing the role later rewrites nothing a thread recorded: the record is the thread's.
  writeFileSync(configPath, JSON.stringify({ models: { roles: { review: { model: 'fake/fake-1' } } } }))
  expect(built[0]?.modelRoles).toEqual([{ role: 'review', provider: 'fake', modelId: 'fake-2', thinkingLevel: 'off' }])
})

// PR #973 review: a role chosen again says nothing new, and a switch from one role to another
// records the new role alone — never the first one ended and the second begun. A hand change ends it.
test('re-choosing the current role appends nothing; switching roles appends only the new one; a hand change ends it (#904)', async () => {
  const { url, built } = await start({
    models: {
      roles: {
        review: { model: 'fake/fake-2', effort: 'high' },
        quick: { model: 'fake/fake-1', effort: 'low' },
      },
    },
  })
  const configure = (body: object): Promise<Response> => post(`${url}/api/threads/t1/configure`, body)
  const review = { role: 'review', provider: 'fake', modelId: 'fake-2', thinkingLevel: 'off' }
  const quick = { role: 'quick', provider: 'fake', modelId: 'fake-1', thinkingLevel: 'low' }
  expect((await configure({ role: 'review' })).status).toBe(204)
  expect((await configure({ role: 'review' })).status).toBe(204)
  expect(built[0]?.modelRoles).toEqual([review])
  expect((await configure({ role: 'quick' })).status).toBe(204)
  expect(built[0]?.modelRoles).toEqual([review, quick])
  expect((await post(`${url}/api/threads/t1/command`, { name: 'thinking', value: 'high' })).status).toBe(204)
  expect(built[0]?.modelRoles).toEqual([review, quick, null])
})

// A role step refused part way (#904, `applyRole`): with the model already switched, the record no
// longer says what runs and is ended; with nothing applied, the role the thread ran under still is.
test("a role's effort step refused: the record is ended when its model was applied, kept when nothing was (#904)", async () => {
  let effortLocked = false
  const { url, built } = await start(
    {
      models: {
        roles: {
          quick: { model: 'fake/fake-1', effort: 'low' },
          deep: { model: 'fake/fake-1', effort: 'high' },
          // fake-2 offers `off` alone: `high` is clamped to it.
          review: { model: 'fake/fake-2', effort: 'high' },
        },
      },
    },
    {
      // Each step sets only what it names, so a model switch leaves the effort for the effort step.
      runtime: ({ record, emit }) => ({
        runHostCommand: (run) => {
          record.hostCommands.push(run)
          if (run.name === 'thinking' && effortLocked) {
            return Promise.reject(new HostCommandRefused('the effort is locked here'))
          }
          const [provider = '', id = ''] = (run.value ?? '').split('/')
          record.modelState =
            run.name === 'model'
              ? { ...record.modelState, model: { provider, id, name: id } }
              : { ...record.modelState, thinkingLevel: run.value ?? '' }
          emit({ kind: 'model', ...record.modelState })
          return Promise.resolve()
        },
      }),
    },
  )
  const configure = (body: object): Promise<Response> => post(`${url}/api/threads/t1/configure`, body)
  const quick = { role: 'quick', provider: 'fake', modelId: 'fake-1', thinkingLevel: 'low' }
  expect((await configure({ role: 'quick' })).status).toBe(204)
  expect(built[0]?.modelRoles).toEqual([quick])
  effortLocked = true

  // `deep` runs on the model already running: only its effort step runs, and it is refused.
  const deep = await configure({ role: 'deep' })
  expect(deep.status).toBe(422)
  expect(await deep.json()).toEqual({ step: 'thinking', reason: 'the effort is locked here' })
  expect(built[0]?.modelRoles).toEqual([quick])

  // `review` switches the model, then its effort (`off`, fake-2's only level) is refused.
  const review = await configure({ role: 'review' })
  expect(review.status).toBe(422)
  expect(await review.json()).toEqual({ step: 'thinking', reason: 'the effort is locked here' })
  expect(built[0]?.modelRoles).toEqual([quick, null])
})
