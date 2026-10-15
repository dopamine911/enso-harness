import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoRuleRecord } from '@enso/core'
import { writePermissionPolicy } from '../permission-policy-file.ts'

/**
 * Enso's record and the policy written together (#945, PR #970 review): the record first, then the
 * policy, and the record put back when the policy's write fails. The policy's write is made to fail
 * by putting the file it names in a directory nothing may write to: the temporary file beside it
 * cannot be made, while the record, beside the name, can.
 */

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    chmodSync(join(home, 'locked'), 0o755)
    rmSync(home, { recursive: true, force: true })
  }
})

const POLICY = `${JSON.stringify({ permission: { bash: { '**': 'ask', 'npm publish*': 'deny' } } }, null, 2)}\n`

const SWITCHED_OFF: EnsoRuleRecord = {
  disabled: [{ surface: 'bash', pattern: 'npm publish*', decision: 'deny', after: '**' }],
  groups: {},
}

/** `permissions.json` a link to a policy in a directory nothing may write to; the record beside the link. */
function lockedPolicy(record: string | undefined): { policyPath: string; recordPath: string; agentDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'enso-policy-rollback-'))
  homes.push(home)
  const locked = join(home, 'locked')
  mkdirSync(locked)
  writeFileSync(join(locked, 'permissions.json'), POLICY)
  const policyPath = join(home, 'permissions.json')
  symlinkSync(join(locked, 'permissions.json'), policyPath)
  const recordPath = join(home, 'permissions.disabled.json')
  if (record !== undefined) writeFileSync(recordPath, record)
  chmodSync(locked, 0o555)
  return { policyPath, recordPath, agentDir: join(home, 'pi-agent') }
}

const switchedOff = { file: { permission: { bash: { '**': 'ask' } } }, record: SWITCHED_OFF }

// Root writes through a read-only directory, so the policy's write would not fail.
test.skipIf(process.getuid?.() === 0)(
  'a policy write that fails after the record was written puts the record on disk back, byte for byte',
  () => {
    const before = `${JSON.stringify({ disabled: [], groups: { publishing: { added: [] } } }, null, 2)}\n`
    const { policyPath, recordPath, agentDir } = lockedPolicy(before)

    expect(() => writePermissionPolicy(policyPath, agentDir, switchedOff, { kind: 'present' })).toThrow()

    expect(readFileSync(recordPath, 'utf8')).toBe(before)
    expect(readFileSync(policyPath, 'utf8')).toBe(POLICY)
  },
)

test.skipIf(process.getuid?.() === 0)(
  'a policy write that fails after the record was created removes the record: none was there before',
  () => {
    const { policyPath, recordPath, agentDir } = lockedPolicy(undefined)

    expect(() => writePermissionPolicy(policyPath, agentDir, switchedOff, { kind: 'present' })).toThrow()

    expect(existsSync(recordPath)).toBe(false)
    expect(readFileSync(policyPath, 'utf8')).toBe(POLICY)
  },
)
