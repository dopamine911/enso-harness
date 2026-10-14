import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDefaultProjectTrust } from '../project-trust.ts'
import { type SettingsPlaces, readProjectsSettings, writeProjectsSettings } from '../projects-config-file.ts'

/**
 * Settings › Projects & threads' files (#934): a save rewrites `config.json` whole, so it must never
 * lose a key the page does not show, nor write a root the server would refuse to start with; a
 * project's own mode is keyed as the resolver matches it; and the trust default lands in pi's file
 * beside pi's other keys.
 */

/** The resolver's rule as a test can pin it: `~/` is `/home/me/`, and a trailing slash goes. */
const canonical = (key: string): string => key.replace(/^~\//, '/home/me/').replace(/\/+$/, '')

function dirs(): SettingsPlaces {
  const home = mkdtempSync(join(tmpdir(), 'enso-projects-settings-'))
  const agentDir = join(home, 'pi-agent')
  mkdirSync(agentDir)
  return { home, agentDir, canonical }
}

test('a save replaces only `projects` and `threads`', () => {
  const places = dirs()
  writeFileSync(
    join(places.home, 'config.json'),
    JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { tree: 'copy' } }),
  )
  const read = readProjectsSettings(places)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  expect(read.threads).toEqual({ tree: 'copy' })
  const written = writeProjectsSettings(
    places,
    {
      projects: { roots: ['~/code', '/srv/work'] },
      threads: { tree: 'off', setup: ['bun install'], copy: [], projects: { '/srv/work/big': 'worktree' } },
    },
    { kind: 'matches', etag: read.etag },
  )
  expect(written.kind).toBe('written')
  expect(JSON.parse(readFileSync(join(places.home, 'config.json'), 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
    projects: { roots: ['~/code', '/srv/work'] },
    threads: { tree: 'off', setup: ['bun install'], projects: { '/srv/work/big': 'worktree' } },
  })
})

test('a root the server would refuse at its next start is never written', () => {
  const places = dirs()
  const written = writeProjectsSettings(places, { projects: { roots: ['code'] }, threads: {} }, { kind: 'absent' })
  expect(written.kind).toBe('refused')
  expect(existsSync(join(places.home, 'config.json'))).toBe(false)
})

test('a project mode keyed by a relative path is never written', () => {
  const places = dirs()
  const written = writeProjectsSettings(places, { threads: { projects: { 'code/app': 'off' } } }, { kind: 'absent' })
  expect(written).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not code/app') })
  expect(existsSync(join(places.home, 'config.json'))).toBe(false)
})

// #979 review, issue 1: the resolver applies the first key whose canonical path is the project's,
// so the page must show and write a `~/` or trailing-slash key as that path — else the project's row
// shows no mode, a second row holds the real one, and a new choice is written beside it and ignored.
test('a project mode is read and written under its canonical path, the one the resolver matches', () => {
  const places = dirs()
  writeFileSync(
    join(places.home, 'config.json'),
    JSON.stringify({ threads: { projects: { '~/code/app': 'off', '/home/me/code/app/': 'copy', '/srv/b': 'copy' } } }),
  )
  const read = readProjectsSettings(places)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  // Of two keys for one project, the first: the one the resolver applies.
  expect(read.threads.projects).toEqual({ '/home/me/code/app': 'off', '/srv/b': 'copy' })

  const written = writeProjectsSettings(
    places,
    { threads: { projects: { '~/code/app': 'copy', '/srv/b': 'copy' } } },
    { kind: 'matches', etag: read.etag },
  )
  expect(written.kind).toBe('written')
  expect(JSON.parse(readFileSync(join(places.home, 'config.json'), 'utf8'))).toEqual({
    threads: { projects: { '/home/me/code/app': 'copy', '/srv/b': 'copy' } },
  })
})

// #979 re-review, issue 6: the refusal names the two keys that collide, not every key written.
test('two modes naming one project are refused, naming those two: only one of them would apply', () => {
  const places = dirs()
  const written = writeProjectsSettings(
    places,
    { threads: { projects: { '/srv/a': 'off', '~/code/app': 'off', '/srv/b': 'copy', '/home/me/code/app': 'copy' } } },
    { kind: 'absent' },
  )
  expect(written).toEqual({
    kind: 'refused',
    reason: 'nothing was saved: ~/code/app and /home/me/code/app name the same project, and only one would apply',
  })
  expect(existsSync(join(places.home, 'config.json'))).toBe(false)
})

test('cleared, both sections leave nothing behind', () => {
  const places = dirs()
  writeFileSync(
    join(places.home, 'config.json'),
    JSON.stringify({ projects: { roots: ['/a'] }, threads: { copy: ['.env'] } }),
  )
  const read = readProjectsSettings(places)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  writeProjectsSettings(
    places,
    { projects: { roots: [] }, threads: { setup: [], copy: [], projects: {} } },
    { kind: 'matches', etag: read.etag },
  )
  expect(JSON.parse(readFileSync(join(places.home, 'config.json'), 'utf8'))).toEqual({})
})

test('the trust default is pi’s key in pi’s file, every other key kept', async () => {
  const places = dirs()
  writeFileSync(join(places.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 300 } }))
  expect(readProjectsSettings(places).defaultProjectTrust).toBe('ask')
  const written = await writeDefaultProjectTrust(places.agentDir, 'never')
  expect(written).toEqual({ kind: 'written', defaultProjectTrust: 'never' })
  expect(JSON.parse(readFileSync(join(places.agentDir, 'settings.json'), 'utf8'))).toEqual({
    compaction: { keepRecentTokens: 300 },
    defaultProjectTrust: 'never',
  })
  expect(readProjectsSettings(places).defaultProjectTrust).toBe('never')
})

// #979 review, issue 3: pi reads a settings file it cannot parse as no settings (`ask`), and the
// next Set is refused — so the read says why, rather than showing `ask` as if it were set so.
test('a pi settings file that cannot be read is said on read, and never written over', async () => {
  const places = dirs()
  writeFileSync(join(places.agentDir, 'settings.json'), '{ not json')
  const read = readProjectsSettings(places)
  expect(read.defaultProjectTrust).toBe('ask')
  expect(read.trustUnreadable).toEqual(expect.any(String))
  const written = await writeDefaultProjectTrust(places.agentDir, 'always')
  expect(written).toMatchObject({ kind: 'refused', reason: expect.stringContaining('could not be read') })
  expect(readFileSync(join(places.agentDir, 'settings.json'), 'utf8')).toBe('{ not json')
})
