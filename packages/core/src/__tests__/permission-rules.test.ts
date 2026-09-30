import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modeAgentFile } from '../permission-modes.ts'
import {
  ENSO_DEFAULT_PERMISSION_POLICY,
  permissionEngineConfigPath,
  preparePermissionPolicy,
  replacePiccRulesFile,
} from '../permission-rules.ts'

/**
 * #446, #496: the permission engine reads its policy from one path under the agent dir. Enso keeps
 * the user's policy in `ENSO_HOME/permissions.json` and links the engine's path to it; a file
 * holding no policy is seeded, a policy is kept, an old picc rules file is set aside and replaced,
 * and a file that does not parse refuses the launch untouched. That the engine then runs under
 * exactly this file is the host's test (`agent-host.test.ts`), through the real extension.
 */

const scratch = mkdtempSync(join(tmpdir(), 'enso-permission-policy-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let directories = 0

/** A fresh `ENSO_HOME` and agent dir; the policy file holds `content` when given. */
function launch(content?: string): { policyPath: string; agentDir: string } {
  directories += 1
  const root = join(scratch, String(directories))
  mkdirSync(root, { recursive: true })
  const policyPath = join(root, 'home', 'permissions.json')
  if (content !== undefined) {
    mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(policyPath, content)
  }
  return { policyPath, agentDir: join(root, 'pi-agent') }
}

const readBack = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

/** The engine's config path is a link, and reading through it reads the user's file. */
function expectLinked(agentDir: string, policyPath: string): void {
  const linkPath = permissionEngineConfigPath(agentDir)
  expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
  expect(realpathSync(linkPath)).toBe(realpathSync(policyPath))
}

test('a fresh ENSO_HOME gets Enso’s policy, the engine reads it through the link, and every mode agent is written', () => {
  const { policyPath, agentDir } = launch()
  expect(preparePermissionPolicy(policyPath, agentDir)).toEqual({ kind: 'seeded', path: policyPath, was: 'absent' })
  expect(readBack(policyPath)).toEqual(ENSO_DEFAULT_PERMISSION_POLICY)
  expectLinked(agentDir, policyPath)
  expect(readdirSync(join(agentDir, 'agents')).sort()).toEqual([
    'enso-mode-acceptEdits.md',
    'enso-mode-auto.md',
    'enso-mode-bypassPermissions.md',
    'enso-mode-default.md',
    'enso-mode-plan.md',
  ])
  expect(readFileSync(join(agentDir, 'agents', 'enso-mode-plan.md'), 'utf8')).toBe(modeAgentFile('plan'))
})

test('a file that holds a permission block is kept byte for byte, and its surfaces counted', () => {
  const content = `${JSON.stringify({ permission: { bash: 'ask', edit: 'allow' }, note: 'mine' })}\n`
  const { policyPath, agentDir } = launch(content)
  expect(preparePermissionPolicy(policyPath, agentDir)).toEqual({ kind: 'kept', path: policyPath, surfaces: 2 })
  expect(readFileSync(policyPath, 'utf8')).toBe(content)
  expectLinked(agentDir, policyPath)
})

test('a file without a permission block is seeded, and its other keys are kept', () => {
  const { policyPath, agentDir } = launch(JSON.stringify({ note: 'mine', permission: null }))
  expect(preparePermissionPolicy(policyPath, agentDir)).toEqual({
    kind: 'seeded',
    path: policyPath,
    was: 'without a permission block',
  })
  expect(readBack(policyPath)).toEqual({ note: 'mine', ...ENSO_DEFAULT_PERMISSION_POLICY })
})

// picc's rules do not translate to the new engine; carrying them over would be a guess. The old
// file is kept beside the new one, whole, so nothing the user wrote is lost.
test('a picc rules file is kept aside as .picc-backup and replaced whole by Enso’s policy', () => {
  const content = JSON.stringify({ permissions: { deny: ['Bash(npm publish*)'] }, autoMode: { enabled: true } })
  const { policyPath, agentDir } = launch(content)
  expect(preparePermissionPolicy(policyPath, agentDir)).toEqual({
    kind: 'seeded',
    path: policyPath,
    was: 'a picc rules file',
    piccBackup: `${policyPath}.picc-backup`,
  })
  expect(readFileSync(`${policyPath}.picc-backup`, 'utf8')).toBe(content)
  expect(readBack(policyPath)).toEqual(ENSO_DEFAULT_PERMISSION_POLICY)
})

// ⚠ #497 review: the web host and the terminal, started together on a home not yet migrated, both
// read the picc file and both decide to migrate. The second one's step then runs on a decision
// the first has already carried out. These replay that step late, in the two orders it can land.
test('⚠ a launch migrating a picc file the other launch already migrated keeps the user’s rules in .picc-backup', () => {
  const content = JSON.stringify({ permissions: { deny: ['Bash(npm publish*)'] } })
  const { policyPath, agentDir } = launch(content)
  preparePermissionPolicy(policyPath, agentDir)
  // The late launch's step: it read the picc file before the first moved it.
  expect(replacePiccRulesFile(policyPath)).toBe(`${policyPath}.picc-backup.1`)
  expect(readFileSync(`${policyPath}.picc-backup`, 'utf8')).toBe(content)
  expect(readBack(policyPath)).toEqual(ENSO_DEFAULT_PERMISSION_POLICY)
})

test('⚠ a launch whose picc file was moved away under it re-reads rather than failing the launch', () => {
  const { policyPath, agentDir } = launch(JSON.stringify({ permissions: { deny: [] } }))
  // The first launch has moved the file and not written the seed yet.
  renameSync(policyPath, `${policyPath}.picc-backup`)
  expect(replacePiccRulesFile(policyPath)).toBeUndefined()
  expect(preparePermissionPolicy(policyPath, agentDir)).toMatchObject({ kind: 'seeded', was: 'absent' })
})

test('a file that is not a plain JSON object is refused and nothing is written: not the file, not the link', () => {
  for (const [content, reason] of [
    ['{ "permission": { "bash": ', /JSON/],
    ['["bash"]', /not a JSON object/],
    ['null', /not a JSON object/],
    // The engine would strip this comment and read the policy; refusing is the safe direction.
    ['// mine\n{ "permission": { "bash": "ask" } }', /JSON/],
  ] as const) {
    const { policyPath, agentDir } = launch(content)
    const preparation = preparePermissionPolicy(policyPath, agentDir)
    expect(preparation).toMatchObject({ kind: 'unreadable', path: policyPath })
    expect(preparation.kind === 'unreadable' ? preparation.reason : '').toMatch(reason)
    expect(readFileSync(policyPath, 'utf8')).toBe(content)
    expect(existsSync(agentDir)).toBe(false)
  }
})

test('a link to somewhere else is repointed at the user’s file', () => {
  const { policyPath, agentDir } = launch()
  const linkPath = permissionEngineConfigPath(agentDir)
  mkdirSync(join(linkPath, '..'), { recursive: true })
  symlinkSync(join(scratch, 'elsewhere.json'), linkPath)
  preparePermissionPolicy(policyPath, agentDir)
  expectLinked(agentDir, policyPath)
  expect(readlinkSync(linkPath)).not.toContain('elsewhere')
})

// The engine's own settings screen saves by rename, which replaces the link with a file.
test('a regular file at the engine’s path is moved aside, never over an earlier one, and the link put back', () => {
  const { policyPath, agentDir } = launch()
  const linkPath = permissionEngineConfigPath(agentDir)
  mkdirSync(join(linkPath, '..'), { recursive: true })
  writeFileSync(`${linkPath}.bak`, 'an earlier save')
  writeFileSync(linkPath, '{"permission":{"bash":"allow"}}')
  expect(preparePermissionPolicy(policyPath, agentDir)).toMatchObject({ movedAside: `${linkPath}.bak.1` })
  expect(readFileSync(`${linkPath}.bak`, 'utf8')).toBe('an earlier save')
  expect(readFileSync(`${linkPath}.bak.1`, 'utf8')).toBe('{"permission":{"bash":"allow"}}')
  expectLinked(agentDir, policyPath)
})

test('a policy path that is a link to nothing is refused, not written through', () => {
  const { policyPath, agentDir } = launch()
  mkdirSync(join(policyPath, '..'), { recursive: true })
  symlinkSync(join(policyPath, '..', 'gone', 'permissions.json'), policyPath)
  expect(preparePermissionPolicy(policyPath, agentDir)).toEqual({
    kind: 'unreadable',
    path: policyPath,
    reason: 'a link to nothing',
  })
  expect(existsSync(permissionEngineConfigPath(agentDir))).toBe(false)
})
