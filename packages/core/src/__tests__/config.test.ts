import { expect, test } from 'bun:test'
import { ENSO_CONFIG_EXAMPLE, mergeEnsoConfig, parseEnsoConfig } from '../config.ts'
import { ensoConfigPath } from '../paths.ts'

/**
 * The config loading contract (#59, #421): a file that is there parses or fails CLOSED — every
 * non-conforming input comes back `unreadable`, never as a silently-empty config — and no file is
 * the defaults.
 */

test('a conforming config parses, and the section reaches its owner', () => {
  const result = parseEnsoConfig(JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] } }))
  expect(result.kind).toBe('ok')
  const allowedHosts = result.kind === 'ok' ? result.config.webFetch?.allowedHosts : []
  expect(allowedHosts).toEqual(['docs.example.com'])
})

test('an empty allowlist is valid', () => {
  expect(parseEnsoConfig(`{ "webFetch": { "allowedHosts": [] } }`).kind).toBe('ok')
})

// #421: the install ships no config; an absent file is the defaults (every section's reader says
// what absent means), and an empty one is too. Neither is `unreadable` — that is a file that is
// there and wrong, which still fails closed.
test('⚠ no config file is the defaults, not a failure; nor is a file with no sections (#421)', () => {
  expect(parseEnsoConfig(undefined)).toEqual({ kind: 'ok', config: {} })
  expect(parseEnsoConfig('{}')).toEqual({ kind: 'ok', config: {} })
  expect(parseEnsoConfig('').kind).toBe('unreadable')
})

// #551, #754: the `threads` section holds a tree mode, the commands and the paths a new tree is set
// up with; a mode the schema does not know, or an empty command, is a config that fails closed.
test('⚠ the threads section: a mode, setup commands and paths to copy; an unknown mode or an empty command is unreadable (#551, #754)', () => {
  const parsed = parseEnsoConfig(
    JSON.stringify({
      threads: { tree: 'copy', projects: { '~/legacy': 'off' }, setup: ['bun install'], copy: ['.env'] },
    }),
  )
  expect(parsed.kind).toBe('ok')
  expect(parseEnsoConfig(JSON.stringify({ threads: { tree: 'none' } })).kind).toBe('unreadable')
  expect(parseEnsoConfig(JSON.stringify({ threads: { setup: [''] } })).kind).toBe('unreadable')
})

test('invalid JSON is unreadable, naming the file and the failure', () => {
  const result = parseEnsoConfig('{ webFetch: [')
  const reason = result.kind === 'unreadable' ? result.reason : '(readable)'
  expect(reason).toContain('config.json')
  expect(reason).toContain('not valid JSON')
})

test('a wrong shape is unreadable and shows the expected example', () => {
  const result = parseEnsoConfig(JSON.stringify({ hosts: [] }))
  const reason = result.kind === 'unreadable' ? result.reason : '(readable)'
  expect(reason).toContain(ENSO_CONFIG_EXAMPLE)
})

// ⚠ STRICT on unknown keys, deliberately (see config.ts's header): this is a policy file,
// and a typo must refuse loudly rather than silently configure nothing. The forward-incompat
// cost (an older harness refuses a newer config) is the wanted failure direction.
test('a TYPO in a section key is unreadable — strict schema', () => {
  const result = parseEnsoConfig(JSON.stringify({ webFetch: { allowedHost: ['docs.example.com'] } }))
  expect(result.kind).toBe('unreadable')
})

test('an unknown top-level key is unreadable — strict schema', () => {
  const result = parseEnsoConfig(JSON.stringify({ webFetch: { allowedHosts: [] }, extra: true }))
  expect(result.kind).toBe('unreadable')
})

// ⚠ The webSearch section is OPTIONAL and must stay optional (#63): a required section
// would render every existing config unreadable, and unreadable fails CLOSED
// for every consumer at once — web_fetch would refuse everything until a human edit.
test('the webSearch section is optional — the pre-#63 committed shape still parses', () => {
  expect(parseEnsoConfig(`{ "webFetch": { "allowedHosts": [] } }`).kind).toBe('ok')
})

test('a full webSearch section parses: the deepseek pin and the tavily domain filters', () => {
  const result = parseEnsoConfig(
    JSON.stringify({
      webFetch: { allowedHosts: [] },
      webSearch: { backend: 'deepseek', tavily: { includeDomains: ['example.com'], excludeDomains: [] } },
    }),
  )
  expect(result.kind).toBe('ok')
  const backend = result.kind === 'ok' ? result.config.webSearch?.backend : undefined
  expect(backend).toBe('deepseek')
})

test('webSearch is strict like every section: an unknown backend or a typo key is unreadable', () => {
  const unknownBackend = parseEnsoConfig(
    JSON.stringify({ webFetch: { allowedHosts: [] }, webSearch: { backend: 'google' } }),
  )
  expect(unknownBackend.kind).toBe('unreadable')
  const typoKey = parseEnsoConfig(
    JSON.stringify({ webFetch: { allowedHosts: [] }, webSearch: { tavily: { includeDomain: [] } } }),
  )
  expect(typoKey.kind).toBe('unreadable')
})

// #421: a trusted project's config over the user's. The nesting is real — `webSearch.tavily` holds
// lists two levels down, `webSearch.backend` is a scalar — so a merge that stops one level down, or
// that replaces a list, drops a user's setting the project never mentioned.
test("⚠ mergeEnsoConfig: lists combine at every depth, a project's value wins, and the user's unmentioned settings survive", () => {
  const merged = mergeEnsoConfig(
    {
      webFetch: { allowedHosts: ['docs.user.example', 'shared.example'] },
      webSearch: {
        backend: 'deepseek',
        tavily: { includeDomains: ['user.example'], excludeDomains: ['spam.example'] },
      },
      projects: { roots: ['~/code'] },
    },
    {
      webFetch: { allowedHosts: ['shared.example', 'docs.project.example'] },
      webSearch: { tavily: { includeDomains: ['project.example', 'user.example'] } },
    },
  )
  expect(merged).toEqual({
    webFetch: { allowedHosts: ['docs.user.example', 'shared.example', 'docs.project.example'] },
    webSearch: {
      backend: 'deepseek',
      tavily: { includeDomains: ['user.example', 'project.example'], excludeDomains: ['spam.example'] },
    },
    projects: { roots: ['~/code'] },
  })
})

test("ensoConfigPath is the user's config in ENSO_HOME", () => {
  expect(ensoConfigPath('/home/u/.enso')).toBe('/home/u/.enso/config.json')
})
