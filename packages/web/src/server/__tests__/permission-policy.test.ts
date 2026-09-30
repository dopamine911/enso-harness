import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EnsoPermissionMap, withRule } from '@enso/core'
import { findRepoRoot, harnessPackageDir, realpathOrSelf } from '@enso/core/paths'
import { ENSO_DEFAULT_PERMISSION_POLICY } from '@enso/core/permission-rules'
import { createAgentHost, type HostedThread } from '../../host/agent-host.ts'
import { readPermissionPolicy, resetPermissionPolicy, writePermissionPolicy } from '../permission-policy.ts'

/**
 * Settings' save (#474) against the REAL engine a session runs: what the page writes is what the
 * next call meets, in the session already running — and what the engine would not run is never
 * written. The project is a bare directory (no `.pi/`), so no trust question stands in the way.
 */

const repoRoot = findRepoRoot(import.meta.url)
const openSessions: HostedThread[] = []
afterAll(() => {
  for (const hosted of openSessions) hosted.runtime.dispose()
})

/** A running session over a fresh policy file (Enso's, seeded by the host), and that file's path. */
async function running(): Promise<{ hosted: HostedThread; policyPath: string; agentDir: string }> {
  const project = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-474-project-')))
  const agentDir = mkdtempSync(join(tmpdir(), 'enso-474-agent-'))
  const policyPath = join(mkdtempSync(join(tmpdir(), 'enso-474-rules-')), 'permissions.json')
  const host = createAgentHost({
    servesDirectory: (directory: string) => realpathOrSelf(directory) === project,
    agentDir,
    permissionRulesPath: policyPath,
    harnessPackageDir: harnessPackageDir(repoRoot),
  })
  const hosted = await host.createSession(crypto.randomUUID(), () => project)
  openSessions.push(hosted)
  return { hosted, policyPath, agentDir }
}

/** The policy as a page reads it — a test that gets `unreadable` has nothing to edit. */
function readOk(policyPath: string, agentDir: string): { file: Record<string, unknown>; etag: string } {
  const read = readPermissionPolicy(policyPath, agentDir)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error(`policy unreadable: ${JSON.stringify(read)}`)
  return { file: read.file, etag: read.etag }
}

const COMMAND = 'npm publish --tag enso-474'

test('⚠ a saved deny is in force at the running session’s next call — no restart — and blocks it (#474)', async () => {
  const { hosted, policyPath, agentDir } = await running()
  expect(hosted.checkPermission({ surface: 'bash', value: COMMAND })?.state).not.toBe('deny')

  const { file, etag } = readOk(policyPath, agentDir)
  const permission = withRule(file.permission as EnsoPermissionMap, 'bash', COMMAND, 'deny')
  const written = writePermissionPolicy(policyPath, agentDir, { ...file, permission }, { kind: 'matches', etag })
  expect(written.kind).toBe('written')

  expect(hosted.checkPermission({ surface: 'bash', value: COMMAND })).toMatchObject({
    mode: 'default',
    state: 'deny',
    matchedPattern: COMMAND,
    origin: 'global',
  })
  expect((await hosted.probeToolCall('bash', { command: COMMAND }))?.block).toBe(true)
})

// ⚠ The engine reads a file its schema rejects as an EMPTY policy — every deny gone. So a save it
// would not run is refused whole, each problem at its place, and the file (and its denies) stay.
test('⚠ a policy the engine would not run is refused with each problem’s place, and nothing is written (#474)', async () => {
  const { hosted, policyPath, agentDir } = await running()
  const { file, etag } = readOk(policyPath, agentDir)
  const denied = withRule(file.permission as EnsoPermissionMap, 'bash', COMMAND, 'deny')
  writePermissionPolicy(policyPath, agentDir, { ...file, permission: denied }, { kind: 'matches', etag })
  const before = readFileSync(policyPath, 'utf8')
  const current = readOk(policyPath, agentDir)

  const typo = { ...current.file, permission: { ...denied, bash: { ...(denied.bash as object), 'git *': 'alow' } } }
  expect(writePermissionPolicy(policyPath, agentDir, typo, { kind: 'matches', etag: current.etag })).toEqual({
    kind: 'refused',
    refusal: {
      reason: expect.stringContaining('nothing was saved'),
      problems: [{ at: '/permission/bash/git *', message: expect.stringContaining('allow, ask, deny') }],
    },
  })
  const unknownKey = { ...current.file, yolomode: true }
  const refused = writePermissionPolicy(policyPath, agentDir, unknownKey, { kind: 'matches', etag: current.etag })
  expect(refused.kind).toBe('refused')

  expect(readFileSync(policyPath, 'utf8')).toBe(before)
  expect(hosted.checkPermission({ surface: 'bash', value: COMMAND })?.state).toBe('deny')
})

test('a save over a file changed since it was read is refused, and the change on disk is kept (#474)', async () => {
  const { policyPath, agentDir } = await running()
  const { file, etag } = readOk(policyPath, agentDir)
  const byHand = `${JSON.stringify({ ...file, permission: { bash: 'ask' } }, null, 2)}\n`
  writeFileSync(policyPath, byHand)
  const outcome = writePermissionPolicy(policyPath, agentDir, file, { kind: 'matches', etag })
  expect(outcome).toEqual({ kind: 'conflict', reason: expect.stringContaining('changed on disk') })
  expect(readFileSync(policyPath, 'utf8')).toBe(byHand)
})

test('a reset puts Enso’s policy in force and keeps every file it replaced, under a name of its own (#474)', async () => {
  const { hosted, policyPath, agentDir } = await running()
  const mine = `${JSON.stringify({ permission: { bash: { '**': 'ask', [COMMAND]: 'deny' } } }, null, 2)}\n`
  writeFileSync(policyPath, mine)
  expect(hosted.checkPermission({ surface: 'bash', value: COMMAND })?.state).toBe('deny')

  const first = resetPermissionPolicy(policyPath, agentDir, { kind: 'present' })
  if (first.kind !== 'reset') throw new Error(first.reason)
  const firstBackup = `${realpathOrSelf(policyPath)}.bak`
  expect(first.backup).toBe(firstBackup)
  expect(readFileSync(firstBackup, 'utf8')).toBe(mine)
  expect(JSON.parse(readFileSync(policyPath, 'utf8'))).toEqual(ENSO_DEFAULT_PERMISSION_POLICY)
  expect(hosted.checkPermission({ surface: 'bash', value: COMMAND })?.state).not.toBe('deny')

  const second = resetPermissionPolicy(policyPath, agentDir, { kind: 'present' })
  if (second.kind !== 'reset') throw new Error(second.reason)
  expect(second.backup).toBe(`${realpathOrSelf(policyPath)}.bak.1`)
  expect(readFileSync(firstBackup, 'utf8')).toBe(mine)

  // With no file at all, a reset is a create: nothing to keep, and `*` — "whatever is there" — refused.
  rmSync(policyPath)
  expect(resetPermissionPolicy(policyPath, agentDir, { kind: 'present' }).kind).toBe('conflict')
  const created = resetPermissionPolicy(policyPath, agentDir, { kind: 'absent' })
  expect(created).toMatchObject({ kind: 'reset', read: { kind: 'ok', file: ENSO_DEFAULT_PERMISSION_POLICY } })
  expect('backup' in created).toBe(false)
})
