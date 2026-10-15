import { expect, test } from 'bun:test'
import {
  clampEffort,
  ENSO_MODEL_ROLE_ENTRY,
  type EnsoModelsConfig,
  type EnsoTranscriptEntry,
  type HostCommandOption,
  parseEnsoConfig,
  resolveModelRole,
  threadModelRole,
} from '../index.ts'

/**
 * Roles (#904): what a role resolves to against the models on offer — clamped, fallen back with a
 * notice, or refused with a reason, never a silent substitute — and what a branch records it ran.
 */

const OPUS: HostCommandOption = {
  id: 'anthropic/opus',
  label: 'Opus',
  loggedIn: true,
  thinkingLevels: ['off', 'low', 'medium', 'high'],
  defaultThinkingLevel: 'medium',
}
const HAIKU: HostCommandOption = { id: 'anthropic/haiku', label: 'Haiku', loggedIn: true, thinkingLevels: ['off'] }
const CODEX: HostCommandOption = {
  id: 'openai-codex/gpt',
  label: 'GPT',
  providerName: 'ChatGPT',
  loggedIn: false,
  thinkingLevels: ['low', 'high'],
}
const OPTIONS = [OPUS, HAIKU, CODEX]

test("pi's clamp: the level offered, else the next one up, else the next one down", () => {
  expect(clampEffort('high', ['off', 'low', 'medium', 'high'])).toBe('high')
  expect(clampEffort('minimal', ['off', 'low', 'high'])).toBe('low')
  expect(clampEffort('xhigh', ['off', 'low', 'high'])).toBe('high')
  expect(clampEffort('high', [])).toBe('high')
})

test('a role runs its model at its effort, clamped and said so; its effort, else the default effort, else the model’s own', () => {
  const models: EnsoModelsConfig = {
    roles: { quick: { model: 'anthropic/haiku', effort: 'low' }, review: { model: 'anthropic/opus' } },
  }
  expect(resolveModelRole('quick', models, OPTIONS)).toMatchObject({
    kind: 'resolved',
    model: 'anthropic/haiku',
    requestedEffort: 'low',
    effort: 'off',
    clamped: true,
    fallback: false,
  })
  expect(resolveModelRole('review', models, OPTIONS)).toMatchObject({ effort: 'medium', clamped: false })
  expect(resolveModelRole('review', { ...models, defaultEffort: 'high' }, OPTIONS)).toMatchObject({ effort: 'high' })
})

test('a role whose model is unavailable runs its first available fallback and says why; none available, it is refused with each reason', () => {
  const models: EnsoModelsConfig = {
    roles: {
      deep: {
        model: 'openai-codex/gpt',
        effort: 'high',
        fallbacks: [{ model: 'gone/model' }, { model: 'anthropic/opus', effort: 'high' }],
      },
      stuck: { model: 'openai-codex/gpt', fallbacks: [{ model: 'gone/model' }] },
    },
  }
  expect(resolveModelRole('deep', models, OPTIONS)).toMatchObject({
    kind: 'resolved',
    model: 'anthropic/opus',
    effort: 'high',
    fallback: true,
    notice:
      'openai-codex/gpt (ChatGPT is not logged in), gone/model (not in the catalogue) unavailable; using the fallback anthropic/opus',
  })
  expect(resolveModelRole('stuck', models, OPTIONS)).toEqual({
    kind: 'refused',
    role: 'stuck',
    reason:
      'role stuck has no model available: openai-codex/gpt (ChatGPT is not logged in), gone/model (not in the catalogue)',
  })
  expect(resolveModelRole('nobody', models, OPTIONS)).toMatchObject({
    kind: 'refused',
    reason: 'no role is named nobody',
  })
})

test("the user's config takes a models section; a role named as no one could type it is refused", () => {
  expect(parseEnsoConfig(JSON.stringify({ models: { roles: { default: { model: 'a/b' } } } })).kind).toBe('ok')
  expect(parseEnsoConfig(JSON.stringify({ models: { roles: { Default: { model: 'a/b' } } } })).kind).toBe('unreadable')
})

test("a branch's role is its last record: a later `null` ends it, a malformed one reads as none", () => {
  const record = { role: 'review', provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' }
  const entry = (data: unknown, id: string): EnsoTranscriptEntry => ({
    kind: 'custom' as const,
    id,
    customType: ENSO_MODEL_ROLE_ENTRY,
    data,
  })
  expect(threadModelRole([entry(record, 'a')])).toEqual(record)
  expect(threadModelRole([entry(record, 'a'), entry(null, 'b')])).toBeNull()
  expect(threadModelRole([entry({ role: 'Review' }, 'a')])).toBeNull()
  expect(threadModelRole([])).toBeNull()
})
