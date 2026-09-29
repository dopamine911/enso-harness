import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_DEFAULT_DENY_RULES, preparePermissionRules } from '../permission-rules.ts'

/**
 * #446: the permission-modes extension reads a file with no rules as "import Claude Code's
 * settings into it". So Enso must never hand it one: every file it could read as empty is
 * seeded, every file with a rule is left alone, and a file it cannot read the same way is
 * refused rather than rewritten. That the extension then runs under exactly this file is the
 * host's test (`agent-host.test.ts`), through the real extension.
 */

function rulesFile(content?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'enso-permission-rules-')), 'permissions.json')
  if (content !== undefined) writeFileSync(path, content)
  return path
}

const readBack = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

test('a fresh ENSO_HOME gets Enso’s deny rules and nothing else — no allow rule, from anywhere', () => {
  const path = rulesFile()
  expect(preparePermissionRules(path)).toEqual({ kind: 'seeded', path, was: 'absent' })
  expect(readBack(path)).toEqual({ permissions: { allow: [], deny: [...ENSO_DEFAULT_DENY_RULES], ask: [] } })
})

test('a file that holds one rule of any kind is kept byte for byte, and counted as the extension counts', () => {
  for (const [block, counts] of [
    [{ allow: ['Bash(bun test:*)'] }, { allow: 1, deny: 0, ask: 0 }],
    [
      { ask: ['Bash(git push:*)'], deny: [] },
      { allow: 0, deny: 0, ask: 1 },
    ],
    // Blank entries are not rules to the extension (`readStringArray` drops them), so not here either.
    [{ deny: ['Bash(npm publish*)', '  ', 7] }, { allow: 0, deny: 1, ask: 0 }],
  ] as const) {
    const content = `${JSON.stringify({ permissions: block, note: 'mine' })}\n`
    const path = rulesFile(content)
    expect(preparePermissionRules(path)).toEqual({ kind: 'kept', path, counts })
    expect(readFileSync(path, 'utf8')).toBe(content)
  }
})

// Each of these is a file the extension reads as having no rules — and would fill with Claude
// Code's. Seeded instead, with whatever else the file held kept.
test('a file with no rules — no block, empty lists, blank entries only — is seeded, and its other keys are kept', () => {
  for (const file of [
    { autoMode: { enabled: true } },
    { autoMode: { enabled: true }, permissions: { allow: [], deny: [], ask: [] } },
    { autoMode: { enabled: true }, permissions: { allow: ['', '   '] } },
    { autoMode: { enabled: true }, permissions: 'allow everything' },
  ]) {
    const path = rulesFile(JSON.stringify(file))
    expect(preparePermissionRules(path)).toEqual({ kind: 'seeded', path, was: 'without rules' })
    expect(readBack(path)).toEqual({
      autoMode: { enabled: true },
      permissions: { allow: [], deny: [...ENSO_DEFAULT_DENY_RULES], ask: [] },
    })
  }
})

test('a file that is not a plain JSON object is refused and left exactly as it was', () => {
  for (const [content, reason] of [
    ['{ "permissions": { "deny": [', /JSON/],
    ['["Bash(ls:*)"]', /not a JSON object/],
    ['null', /not a JSON object/],
    // The extension would strip this comment and read the rule; refusing is the safe direction.
    ['// mine\n{ "permissions": { "deny": ["Bash(npm publish*)"] } }', /JSON/],
  ] as const) {
    const path = rulesFile(content)
    const preparation = preparePermissionRules(path)
    expect(preparation).toMatchObject({ kind: 'unreadable', path })
    expect(preparation.kind === 'unreadable' ? preparation.reason : '').toMatch(reason)
    expect(readFileSync(path, 'utf8')).toBe(content)
  }
})

test('seeding creates the directory ENSO_HOME names when it is not there yet', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'enso-permission-rules-')), 'not-yet', 'permissions.json')
  expect(preparePermissionRules(path)).toMatchObject({ kind: 'seeded', was: 'absent' })
  expect(existsSync(path)).toBe(true)
})
