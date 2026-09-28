import { expect, test } from 'bun:test'
import { Check } from 'typebox/value'
import { ENSO_RUN_CONTEXT_ENTRY, EnsoForkPoint, type EnsoRunContext, readEnsoRunContext } from '../index.ts'

/**
 * #435: the run-context entry is a wire crossing — pi's log holds whatever was appended — so a
 * reader takes only the declared shape, and only under its own `customType`.
 */

const HASH = 'a'.repeat(64)
const RECORD: EnsoRunContext = {
  git: { revision: 'f00d', dirty: false },
  config: { hash: HASH, sources: ['/home/u/.enso/config.json'] },
  skills: [{ name: 'tdd', path: '/skills/tdd/SKILL.md' }],
  contextFiles: [{ path: '/repo/AGENTS.md', sha256: HASH }],
  mode: { rulesHash: HASH },
}

test('a run context is read under its own type, and outside a repository with no mode recorded', () => {
  expect(readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, RECORD)).toEqual(RECORD)
  const bare = { ...RECORD, git: null, mode: null, skills: [], contextFiles: [] }
  expect(readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, bare)).toEqual(bare)
  expect(readEnsoRunContext('modes', RECORD)).toBeUndefined()
})

test('a malformed run context reads as none: bad hash, missing field, a file body smuggled in', () => {
  expect(
    readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, { ...RECORD, config: { hash: 'nope', sources: [] } }),
  ).toBeUndefined()
  const { skills: _skills, ...withoutSkills } = RECORD
  expect(readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, withoutSkills)).toBeUndefined()
  const withContent = { ...RECORD, contextFiles: [{ path: '/repo/AGENTS.md', sha256: HASH, content: 'secret' }] }
  expect(readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, withContent)).toBeUndefined()
  expect(readEnsoRunContext(ENSO_RUN_CONTEXT_ENTRY, { ...RECORD, git: { revision: '', dirty: false } })).toBeUndefined()
})

test('a fork point takes an empty branch and no run context, and refuses an unknown field', () => {
  const point = {
    identity: { threadId: 't1', leafEntryId: null },
    conditions: { model: null, thinkingLevel: null, mode: 'default', cwd: '/repo', runContext: null },
  }
  expect(Check(EnsoForkPoint, point)).toBe(true)
  expect(Check(EnsoForkPoint, { ...point, conditions: { ...point.conditions, runContext: RECORD } })).toBe(true)
  expect(Check(EnsoForkPoint, { ...point, identity: { ...point.identity, sessionFile: '/x.jsonl' } })).toBe(false)
})
