import { expect, test } from 'bun:test'
import {
  authEventText,
  compactDoneText,
  decideHostFlow,
  hostFlowRows,
  loginDoneText,
  loginOptions,
  logoutDoneText,
  logoutOptions,
} from '../host-flows.ts'

/**
 * The flow decisions (#338 slice 3), as the fake and the real host share them: what `/login`
 * and `/logout` offer, what a run must name, and the words the flow says. The interaction itself
 * — pi asking, the browser answering through the dialog seam — is the host's, and is proven by
 * the route test over the fake and by the smoke; nothing here mocks pi.
 */

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', offersOAuth: true, offersApiKeyLogin: true, configuredVia: 'environment' },
  { id: 'anthropic', name: 'Anthropic', offersOAuth: true, offersApiKeyLogin: true, configuredVia: undefined },
  // Ambient-only: a key from the environment, no login pi can run — no `/login` row for it.
  { id: 'bedrock', name: 'Amazon Bedrock', offersOAuth: false, offersApiKeyLogin: false, configuredVia: 'aws profile' },
]

test('login options: one per provider per way in, by name; an ambient-only provider offers none; status is the detail', () => {
  expect(loginOptions(PROVIDERS)).toEqual([
    { id: 'anthropic/oauth', label: 'Anthropic · subscription', detail: 'not configured' },
    { id: 'anthropic/api_key', label: 'Anthropic · API key', detail: 'not configured' },
    { id: 'openai/oauth', label: 'OpenAI · subscription', detail: 'via environment' },
    { id: 'openai/api_key', label: 'OpenAI · API key', detail: 'via environment' },
  ])
})

test('logout options are the stored credentials only, and the /logout row is absent while there are none', () => {
  const stored = logoutOptions([{ providerId: 'openai', providerName: 'OpenAI', type: 'oauth' }])
  expect(stored).toEqual([{ id: 'openai', label: 'OpenAI', detail: 'stored subscription' }])
  expect(hostFlowRows(loginOptions(PROVIDERS), []).map((row) => row.name)).toEqual(['login', 'compact'])
  expect(hostFlowRows(loginOptions(PROVIDERS), stored).map((row) => [row.name, row.kind])).toEqual([
    ['login', 'flow'],
    ['logout', 'flow'],
    ['compact', 'action'],
  ])
  const compact = hostFlowRows([], []).find((row) => row.name === 'compact')
  expect(compact?.options).toBeUndefined()
  expect(compact?.value).toBeUndefined()
})

test('a run names an offered option or is refused with the reason the route says; the option id splits at its LAST slash', () => {
  const login = loginOptions([
    ...PROVIDERS,
    { id: 'my/proxy', name: 'Proxy', offersOAuth: false, offersApiKeyLogin: true, configuredVia: undefined },
  ])
  const logout = logoutOptions([{ providerId: 'openai', providerName: 'OpenAI', type: 'api_key' }])
  expect(decideHostFlow({ name: 'login', value: 'anthropic/oauth' }, login, logout)).toEqual({
    kind: 'login',
    providerId: 'anthropic',
    authType: 'oauth',
  })
  expect(decideHostFlow({ name: 'login', value: 'my/proxy/api_key' }, login, logout)).toEqual({
    kind: 'login',
    providerId: 'my/proxy',
    authType: 'api_key',
  })
  expect(decideHostFlow({ name: 'logout', value: 'openai' }, login, logout)).toEqual({
    kind: 'logout',
    providerId: 'openai',
  })
  expect(() => decideHostFlow({ name: 'login' }, login, logout)).toThrow('login needs a value')
  expect(() => decideHostFlow({ name: 'login', value: 'bedrock/api_key' }, login, logout)).toThrow(
    'is not offered here',
  )
  expect(() => decideHostFlow({ name: 'logout', value: 'anthropic' }, login, logout)).toThrow(
    'no stored credential for anthropic',
  )
  expect(decideHostFlow({ name: 'compact' }, login, logout)).toEqual({ kind: 'compact' })
  expect(() => decideHostFlow({ name: 'compact', value: 'now' }, login, logout)).toThrow('compact takes no value')
  expect(() => decideHostFlow({ name: 'reload' }, login, logout)).toThrow('no host flow named reload')
})

test('every auth event is one line with the thing the user needs in it — the URL, the code', () => {
  expect(authEventText({ type: 'auth_url', url: 'https://x/auth' })).toBe(
    'Open this URL to authenticate: https://x/auth',
  )
  expect(authEventText({ type: 'auth_url', url: 'https://x/auth', instructions: 'Sign in here:' })).toBe(
    'Sign in here: https://x/auth',
  )
  expect(
    authEventText({
      type: 'device_code',
      userCode: 'B599-2E10',
      verificationUri: 'https://x/device',
      expiresInSeconds: 900,
    }),
  ).toBe('Enter code B599-2E10 at https://x/device (expires in 15 min)')
  expect(authEventText({ type: 'info', message: 'Read this', links: [{ url: 'https://x/doc', label: 'docs' }] })).toBe(
    'Read this docs: https://x/doc',
  )
  expect(authEventText({ type: 'progress', message: 'Waiting…' })).toBe('Waiting…')
  expect(loginDoneText('OpenAI', 'oauth', 'gpt-5')).toBe('Logged in to OpenAI. Selected gpt-5.')
  expect(loginDoneText('OpenAI', 'api_key', undefined)).toBe('Saved API key for OpenAI.')
  expect(logoutDoneText('OpenAI', 'oauth')).toBe('Logged out of OpenAI.')
  expect(compactDoneText(84_120, 11_900)).toBe(
    'Compacted the context: 84,120 → 11,900 tokens. Reload the page to see the compacted transcript.',
  )
  expect(compactDoneText(84_120, undefined)).toBe(
    'Compacted the context from 84,120 tokens. Reload the page to see the compacted transcript.',
  )
  expect(logoutDoneText('OpenAI', undefined)).toBe('Removed the stored credential for OpenAI.')
})
