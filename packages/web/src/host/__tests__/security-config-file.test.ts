import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoSecurityConfig } from '@enso/core'
import { prunedSecurity, readSecuritySettings, writeJudgeKey, writeSecuritySettings } from '../security-config-file.ts'

/**
 * Settings › Security's files (#933): a save rewrites `config.json` whole, so what it must never do
 * is lose a key the page does not show, write over a file every consumer already refuses, or leave
 * one they would; and the judge's key must land in `secrets.env` beside the other lines, `0600`,
 * without the read ever handing it back.
 */

const home = (): string => mkdtempSync(join(tmpdir(), 'enso-security-'))

test('a save replaces only `security`: every other key stays as it was on disk', () => {
  const dir = home()
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, security: { incidents: { halt: true } } }),
  )
  const read = readSecuritySettings(dir)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  const written = writeSecuritySettings(
    dir,
    {
      incidents: { windowCalls: 12 },
      judge: { backend: 'local', local: { baseUrl: 'http://127.0.0.1:8080', model: 'm' } },
    },
    { kind: 'matches', etag: read.etag },
  )
  expect(written.kind).toBe('written')
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
    security: {
      incidents: { windowCalls: 12 },
      judge: { backend: 'local', local: { baseUrl: 'http://127.0.0.1:8080', model: 'm' } },
    },
  })
  // Cleared, the section leaves no `{}` behind.
  const again = readSecuritySettings(dir)
  if (again.kind !== 'ok' || again.etag === undefined) throw new Error('expected a readable file')
  writeSecuritySettings(dir, { incidents: {} }, { kind: 'matches', etag: again.etag })
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
  })
})

// #969 re-review, issue 1: only empty objects are pruned. A key `EnsoSecurityConfig` gains later
// is kept by a save, a primitive one (`false`, `0`) included, not just an object with keys.
test('pruning drops only empty objects: every other key, primitive or not, is kept', () => {
  const future = { incidents: {}, judge: { backend: 'off' }, enabled: false, retries: 0, label: '' }
  // The cast stands in for keys the type does not have yet; that is the case under test.
  expect(prunedSecurity(future as EnsoSecurityConfig)).toEqual({
    judge: { backend: 'off' },
    enabled: false,
    retries: 0,
    label: '',
  } as EnsoSecurityConfig)
  expect(prunedSecurity({ incidents: {}, judge: {} })).toBeUndefined()
})

// #969 re-review, issue 4: the API refuses what the page refuses: a `local` judge off this machine
// is never asked, so it is not saved through a direct PUT either.
test('a local judge off this machine is refused, and the file is left as it was', () => {
  const dir = home()
  const path = join(dir, 'config.json')
  writeFileSync(path, '{}')
  const written = writeSecuritySettings(
    dir,
    { judge: { backend: 'local', local: { baseUrl: 'http://10.0.0.2:8080', model: 'm' } } },
    { kind: 'present' },
  )
  expect(written).toEqual({
    kind: 'refused',
    reason: 'nothing was saved: the local judge must run on this machine (a loopback address), not 10.0.0.2',
  })
  expect(readFileSync(path, 'utf8')).toBe('{}')
})

test('no file: the save creates it under If-None-Match', () => {
  const dir = home()
  expect(writeSecuritySettings(dir, { incidents: { halt: true } }, { kind: 'absent' }).kind).toBe('written')
  expect(readSecuritySettings(dir)).toMatchObject({ kind: 'ok', security: { incidents: { halt: true } } })
})

test('⚠ an unreadable file is never written over, and a stale version is a conflict', () => {
  const dir = home()
  const path = join(dir, 'config.json')
  writeFileSync(path, '{"securty": {}}')
  expect(readSecuritySettings(dir).kind).toBe('unreadable')
  expect(writeSecuritySettings(dir, { incidents: { halt: true } }, { kind: 'present' }).kind).toBe('refused')
  expect(readFileSync(path, 'utf8')).toBe('{"securty": {}}')

  writeFileSync(path, '{}')
  const stale = '"0000000000000000000000000000000000000000000000000000000000000000"'
  expect(writeSecuritySettings(dir, { incidents: { halt: true } }, { kind: 'matches', etag: stale }).kind).toBe(
    'conflict',
  )
  expect(readFileSync(path, 'utf8')).toBe('{}')
})

test('the judge key is stored beside the other secrets, 0600, replaced and removed; the read says only whether it is set', () => {
  const dir = home()
  const path = join(dir, 'secrets.env')
  writeFileSync(path, '# keys\nTAVILY_API_KEY=tvly-1\nTYPESAFE_API_KEY=old\n')
  expect(writeJudgeKey(dir, 'ts-new-key-123')).toEqual({ kind: 'written', judgeKeySet: true })
  expect(readFileSync(path, 'utf8')).toBe('# keys\nTAVILY_API_KEY=tvly-1\nTYPESAFE_API_KEY=ts-new-key-123\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  const read = readSecuritySettings(dir)
  expect(read.judgeKeySet).toBe(true)
  expect(JSON.stringify(read)).not.toContain('ts-new-key-123')

  expect(writeJudgeKey(dir, null)).toEqual({ kind: 'written', judgeKeySet: false })
  expect(readFileSync(path, 'utf8')).toBe('# keys\nTAVILY_API_KEY=tvly-1\n')
  // A value the dotenv reader would not read back as written is refused, not mangled.
  expect(writeJudgeKey(dir, 'two words').kind).toBe('refused')
})
