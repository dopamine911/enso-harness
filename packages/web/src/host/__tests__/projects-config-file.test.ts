import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDefaultProjectTrust } from '../project-trust.ts'
import { readProjectsSettings, writeProjectsSettings } from '../projects-config-file.ts'

/**
 * Settings › Projects & threads' files (#934): a save rewrites `config.json` whole, so it must never
 * lose a key the page does not show, nor write a root the server would refuse to start with; and the trust default lands in pi's file
 * beside pi's other keys.
 */

function dirs(): { home: string; agentDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'enso-projects-settings-'))
  const agentDir = join(home, 'pi-agent')
  mkdirSync(agentDir)
  return { home, agentDir }
}

test('a save replaces only `projects` and `threads`', () => {
  const { home, agentDir } = dirs()
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { tree: 'copy' } }),
  )
  const read = readProjectsSettings(home, agentDir)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  expect(read.threads).toEqual({ tree: 'copy' })
  const written = writeProjectsSettings(
    home,
    agentDir,
    {
      projects: { roots: ['~/code', '/srv/work'] },
      threads: { tree: 'off', setup: ['bun install'], copy: [], projects: { '/srv/work/big': 'worktree' } },
    },
    { kind: 'matches', etag: read.etag },
  )
  expect(written.kind).toBe('written')
  expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
    projects: { roots: ['~/code', '/srv/work'] },
    threads: { tree: 'off', setup: ['bun install'], projects: { '/srv/work/big': 'worktree' } },
  })
})

test('a root the server would refuse at its next start is never written', () => {
  const { home, agentDir } = dirs()
  const written = writeProjectsSettings(
    home,
    agentDir,
    { projects: { roots: ['code'] }, threads: {} },
    { kind: 'absent' },
  )
  expect(written.kind).toBe('refused')
  expect(existsSync(join(home, 'config.json'))).toBe(false)
})

test('cleared, both sections leave nothing behind', () => {
  const { home, agentDir } = dirs()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: { roots: ['/a'] }, threads: { copy: ['.env'] } }))
  const read = readProjectsSettings(home, agentDir)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  writeProjectsSettings(
    home,
    agentDir,
    { projects: { roots: [] }, threads: { setup: [], copy: [], projects: {} } },
    { kind: 'matches', etag: read.etag },
  )
  expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({})
})

test('the trust default is pi’s key in pi’s file, every other key kept', async () => {
  const { home, agentDir } = dirs()
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 300 } }))
  expect(readProjectsSettings(home, agentDir).defaultProjectTrust).toBe('ask')
  const written = await writeDefaultProjectTrust(agentDir, 'never')
  expect(written).toEqual({ kind: 'written', defaultProjectTrust: 'never' })
  expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))).toEqual({
    compaction: { keepRecentTokens: 300 },
    defaultProjectTrust: 'never',
  })
  expect(readProjectsSettings(home, agentDir).defaultProjectTrust).toBe('never')
})
