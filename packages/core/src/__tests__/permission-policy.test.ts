import { expect, test } from 'bun:test'
import {
  effectivePermission,
  effectiveRows,
  hasRule,
  type EnsoPermissionMap,
  policyKnobs,
  policyRows,
  runsAnyCode,
  withoutRule,
  withRule,
  withRuleMoved,
} from '../permission-policy.ts'

/**
 * #474: the policy as Settings shows and edits it. What a mode does to the file is pinned against
 * the real engine in `agent-host.test.ts`; these hold the model's own boundaries.
 */

const POLICY: EnsoPermissionMap = {
  '*': 'ask',
  read: 'allow',
  edit: { '**': 'ask', 'docs/*': 'allow' },
  bash: { '**': 'ask', 'git status': 'allow', 'rm -rf *': 'deny' },
}

const summary = (rows: ReturnType<typeof policyRows>): string[] =>
  rows.map((row) => `${row.surface} ${row.pattern} ${JSON.stringify(row.decision)} ${row.owner}`)

test('the rules in the engine’s order, Enso’s catch-all marked apart from yours', () => {
  expect(summary(policyRows(POLICY))).toEqual([
    '* * "ask" yours',
    'read * "allow" yours',
    'edit ** "ask" catch-all',
    'edit docs/* "allow" yours',
    'bash ** "ask" catch-all',
    'bash git status "allow" yours',
    'bash rm -rf * "deny" yours',
  ])
})

// ⚠ The engine's merge: a map over a map changes only the keys the preset names (so your rules after
// `**` hold); a single decision REPLACES the surface, so `plan` drops every edit rule you wrote.
test('each mode changes only what its preset names, and a single decision replaces the surface', () => {
  expect(summary(effectiveRows(POLICY, 'default'))).toEqual(summary(policyRows(POLICY)))
  const bypass = summary(effectiveRows(POLICY, 'bypassPermissions'))
  expect(bypass).toContain('* * "allow" mode')
  expect(bypass).toContain('bash ** "allow" mode')
  expect(bypass).toContain('bash rm -rf * "deny" yours')
  const plan = effectivePermission(POLICY, 'plan')
  expect(plan.edit).toBe('deny')
  expect(summary(effectiveRows(POLICY, 'plan')).filter((row) => row.startsWith('edit '))).toEqual([
    'edit * "deny" mode',
  ])
  expect(summary(effectiveRows(POLICY, 'acceptEdits'))).toContain('edit docs/* "allow" yours')
})

// The `path` shorthand stands for both directions, its entries first, the direction's own after.
test('the path shorthand expands into both directions, a direction’s own rules winning after it', () => {
  const permission: EnsoPermissionMap = { path: { '*.pem': 'deny', '*.md': 'ask' }, path_read: { '*.md': 'allow' } }
  const effective = effectivePermission(permission, 'default')
  expect(effective.path_read).toEqual({ '*.pem': 'deny', '*.md': 'allow' })
  expect(effective.path_write).toEqual({ '*.pem': 'deny', '*.md': 'ask' })
  expect('path' in effective).toBe(false)
})

test('an allowed pattern that runs code the agent chose is flagged; an ask, a deny or another surface is not', () => {
  expect(runsAnyCode('bash', 'python3 -c *', 'allow')).toContain('code passed')
  expect(runsAnyCode('bash', 'sh -c *', 'allow')).toContain('shell command')
  expect(runsAnyCode('bash', 'npm run *', 'allow')).toContain('script')
  expect(runsAnyCode('bash', '*', 'allow')).toBe('allows every command')
  expect(runsAnyCode('bash', 'python3 -c *', 'ask')).toBeUndefined()
  expect(runsAnyCode('bash', 'git status', 'allow')).toBeUndefined()
  expect(runsAnyCode('bash', 'python3 script.py', 'allow')).toBeUndefined()
  expect(runsAnyCode('path_read', '*', 'allow')).toBeUndefined()
})

test('a new rule lands last — after `**`, winning over what came before — and a single decision becomes its `*`', () => {
  expect(Object.keys(withRule(POLICY, 'bash', 'git push *', 'ask').bash as object)).toEqual([
    '**',
    'git status',
    'rm -rf *',
    'git push *',
  ])
  expect(withRule(POLICY, 'read', '*.pem', 'deny').read).toEqual({ '*': 'allow', '*.pem': 'deny' })
  expect(withRule(POLICY, 'web_fetch', 'https://docs.example/*', 'allow').web_fetch).toEqual({
    'https://docs.example/*': 'allow',
  })
})

// ⚠ Found in review of #474: the engine puts a shorthand's entries BEFORE a direction's own, so a
// deny written on `path` over the seed's `path_read: { '**': 'allow' }` came first and never won.
test('a path rule lands on the directions the file spells out, after their `**`, and wins', () => {
  const seedShape: EnsoPermissionMap = { path_read: { '**': 'allow' }, path_write: { '**': 'allow' } }
  const added = withRule(seedShape, 'path', '~/.ssh/*', 'deny')
  expect('path' in added).toBe(false)
  for (const direction of ['path_read', 'path_write'] as const) {
    const effective = effectivePermission(added, 'default')[direction] as Record<string, unknown>
    expect(Object.entries(effective).at(-1)).toEqual(['~/.ssh/*', 'deny'])
  }
  expect(hasRule(added, 'path', '~/.ssh/*', 'deny')).toBe(true)
  expect(hasRule(seedShape, 'path', '~/.ssh/*', 'deny')).toBe(false)
  // With no direction spelled out, the shorthand is where it goes.
  expect(withRule({}, 'path', '*.pem', 'deny')).toEqual({ path: { '*.pem': 'deny' } })
})

test('nothing moves above `**`, `**` does not move, and it cannot be removed', () => {
  const up = withRuleMoved(POLICY, 'bash', 'git status', -1)
  expect(up).toBe(POLICY)
  expect(withRuleMoved(POLICY, 'bash', '**', 1)).toBe(POLICY)
  expect(Object.keys(withRuleMoved(POLICY, 'bash', 'rm -rf *', -1).bash as object)).toEqual([
    '**',
    'rm -rf *',
    'git status',
  ])
  expect(withoutRule(POLICY, 'bash', '**')).toBe(POLICY)
  expect(Object.keys(withoutRule(POLICY, 'bash', 'git status').bash as object)).toEqual(['**', 'rm -rf *'])
  expect('read' in withoutRule(POLICY, 'read', '*')).toBe(false)
})

test('the knobs: yoloMode only when true, the review log unless turned off, the classifier when chained', () => {
  expect(policyKnobs({})).toEqual({ yoloMode: false, reviewLog: true, autoClassifier: false })
  expect(policyKnobs({ yoloMode: true, permissionReviewLog: false, authorizerChain: ['enso-auto'] })).toEqual({
    yoloMode: true,
    reviewLog: false,
    autoClassifier: true,
  })
})
