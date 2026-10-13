import { expect, test } from 'bun:test'
import type { EnsoStoredThread, HostCommandOption } from '@enso/core'
import { effortRange, modelGroups, RECENT_MODELS, rankOption, recentModelIds } from '../model-picker.tsx'

/**
 * The model picker's rules (#880), over plain options: the Recent group, the provider groups and
 * their order, the order within a provider, and the search (#338 slice 3). Mounted behaviour —
 * collapsed providers, the highlight, Escape — is pinned in `launch-panel.test.tsx`.
 */

function model(provider: string, label: string, extra: Partial<HostCommandOption> = {}): HostCommandOption {
  return {
    id: `${provider}/${label.toLowerCase().replaceAll(' ', '-')}`,
    label,
    detail: provider,
    loggedIn: true,
    ...extra,
  }
}

/** A group as its heading and its rows' labels. */
const shape = (
  options: readonly HostCommandOption[],
  recent: readonly string[],
  search: string,
): [string, string[]][] =>
  modelGroups(options, recent, search).map((group) => [group.heading, group.rows.map((row) => row.option.label)])

test('within a provider the order is pinned — family A–Z, then newest version first — not the catalogue’s', () => {
  // pi's registration order, as the host lists it.
  const catalogue = [
    model('anthropic', 'Claude Sonnet 4.5'),
    model('anthropic', 'Claude Opus 4.1'),
    model('anthropic', 'Claude 3.5 Sonnet'),
    model('anthropic', 'Claude Opus 4.5'),
    model('anthropic', 'Claude Haiku 4.5'),
    model('anthropic', 'Claude Opus 5'),
    model('openai', 'GPT-5'),
    model('openai', 'GPT-4.1'),
    model('openai', 'GPT-5.1'),
    model('openai', 'Codex Mini'),
  ]
  expect(shape(catalogue, [], '')).toEqual([
    [
      'anthropic',
      [
        'Claude Haiku 4.5',
        'Claude Opus 5',
        'Claude Opus 4.5',
        'Claude Opus 4.1',
        'Claude Sonnet 4.5',
        'Claude 3.5 Sonnet',
      ],
    ],
    ['openai', ['Codex Mini', 'GPT-5.1', 'GPT-5', 'GPT-4.1']],
  ])
})

test('groups are headed by the provider’s readable name: logged in first, A–Z, then the ones not logged in', () => {
  const options = [
    model('openai-codex-2', 'GPT-5', { providerName: 'ChatGPT Plus/Pro (Codex openai-codex-2)', loggedIn: false }),
    model('zai', 'GLM 4.6', { providerName: 'Z.AI' }),
    model('anthropic', 'Claude Opus 4.5', { providerName: 'Anthropic' }),
  ]
  expect(modelGroups(options, [], '').map((group) => [group.heading, group.loggedIn])).toEqual([
    ['Anthropic', true],
    ['Z.AI', true],
    ['ChatGPT Plus/Pro (Codex openai-codex-2)', false],
  ])
})

test('Recent: the latest threads’ models, last used first, each once, only those still on offer, at most three', () => {
  const options = [
    model('a', 'One'),
    model('a', 'Two'),
    model('b', 'Three'),
    model('b', 'Four'),
    model('c', 'Spare', { loggedIn: false }),
  ]
  const recent = ['b/three', 'gone/model', 'c/spare', 'a/two', 'b/four', 'a/one']
  expect(RECENT_MODELS).toBe(3)
  // Unfiltered, a recent model is not repeated in its group; a group left empty is not shown.
  expect(shape(options, recent, '')).toEqual([
    ['Recent', ['Three', 'Two', 'Four']],
    ['a', ['One']],
    ['c', ['Spare']],
  ])
  // While filtering, Recent repeats its matches, best match first, and every group shows its own.
  expect(shape(options, recent, 'o')).toEqual([
    ['Recent', ['Four', 'Two']],
    ['a', ['One', 'Two']],
    ['b', ['Four']],
  ])
  // A recent row's value is its own: a model in two groups is two rows cmdk can tell apart.
  const values = modelGroups(options, recent, 'o').flatMap((group) => group.rows.map((row) => row.value))
  expect(new Set(values).size).toBe(values.length)
})

test('recentModelIds reads each stored thread’s recorded model, newest first, each once, skipping threads with none', () => {
  const thread = (threadId: string, at: string, model?: EnsoStoredThread['model']): EnsoStoredThread => ({
    threadId,
    projectId: 'p',
    lastActivityAt: at,
    messageCount: 1,
    busy: false,
    waiting: false,
    ...(model === undefined ? {} : { model }),
  })
  expect(
    recentModelIds([
      thread('old', '2026-10-01T10:00:00.000Z', { provider: 'a', modelId: 'one' }),
      thread('new', '2026-10-03T10:00:00.000Z', { provider: 'b', modelId: 'two' }),
      thread('none', '2026-10-04T10:00:00.000Z'),
      thread('mid', '2026-10-02T10:00:00.000Z', { provider: 'b', modelId: 'two' }),
    ]),
  ).toEqual(['b/two', 'a/one'])
})

// #880 keeps #338's search: substring-first on the id, the name and the provider — "openai" finds
// that provider's models, not opencode's (cmdk's fuzzy score matched o-p-e-n-a-i in any order).
test('search: "openai" finds only that provider’s models, the readable name counts, and a better match ranks first', () => {
  const options = [
    model('openai', 'GPT-5', { providerName: 'OpenAI' }),
    model('opencode', 'Big Pickle', { providerName: 'OpenCode Zen' }),
    model('anthropic', 'Claude Opus 4.5', { providerName: 'Anthropic' }),
    model('openai', 'o3', { providerName: 'OpenAI' }),
  ]
  expect(shape(options, [], 'openai')).toEqual([['OpenAI', ['GPT-5', 'o3']]])
  expect(shape(options, [], 'zen')).toEqual([['OpenCode Zen', ['Big Pickle']]])
  expect(shape(options, [], 'nothing like it')).toEqual([])
})

test('rankOption hides a row the typed text does not appear in, and ranks an earlier appearance higher', () => {
  expect(rankOption('openai/api_key', 'openai', ['OpenAI · API key', 'not configured'])).toBeGreaterThan(0)
  expect(rankOption('opencode/api_key', 'openai', ['opencode · API key', 'not configured'])).toBe(0)
  expect(rankOption('azure-openai-responses/api_key', 'openai', ['Azure OpenAI · API key'])).toBeGreaterThan(0)
  expect(rankOption('openai/api_key', 'openai', ['OpenAI · API key'])).toBeGreaterThan(
    rankOption('azure-openai-responses/api_key', 'openai', ['Azure OpenAI · API key']),
  )
  expect(rankOption('anything', '', [])).toBe(1)
})

test('each row’s effort range is its first and last level, its one level, or nothing when none is named', () => {
  expect(effortRange(model('a', 'One', { thinkingLevels: ['off', 'low', 'medium', 'high'] }))).toBe('off–high')
  expect(effortRange(model('a', 'One', { thinkingLevels: ['minimal', 'xhigh'] }))).toBe('minimal–xhigh')
  expect(effortRange(model('a', 'One', { thinkingLevels: ['off'] }))).toBe('off')
  expect(effortRange(model('a', 'One'))).toBeUndefined()
})
