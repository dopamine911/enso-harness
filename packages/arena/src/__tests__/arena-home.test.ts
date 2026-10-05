import { expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { ensoAgentDir, ensoSecretsPath } from '@enso/core/paths'
import { ARENA_RUN_HOME, arenaSecretValues, defaultArenaOut, isGuardedForAgent, prepareRunHome } from '../run-home.ts'
import { scanRunForSecrets, zipEntries } from '../secret-scan.ts'

/**
 * A run's own Enso home and the secret scan of what it keeps (#584 A4, A11; #610). The live half —
 * a run over its own home, the operator's untouched — is proven by a run; what each of those rests
 * on is proven here.
 */

const API_KEY = 'sk-ant-api-notarealkey-0123456789'
const ACCESS = 'oauth-access-notarealtoken-abcdef'
const REFRESH = 'oauth-refresh-notarealtoken-ghijkl'

/** An operator's home with a login: `secrets.env`, an OAuth credential, models and settings. */
function operatorHome(root: string): string {
  const home = join(root, 'operator', '.enso')
  mkdirSync(ensoAgentDir(home), { recursive: true })
  writeFileSync(ensoSecretsPath(home), `ANTHROPIC_API_KEY=${API_KEY}\n`)
  writeFileSync(
    join(ensoAgentDir(home), 'auth.json'),
    JSON.stringify({ anthropic: { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 1_760_000_000_000 } }),
  )
  writeFileSync(join(ensoAgentDir(home), 'models.json'), '{"providers":{}}')
  writeFileSync(join(ensoAgentDir(home), 'settings.json'), '{"defaultModel":"m"}')
  return home
}

test('⚠ the run home links the login and copies the settings: a token refresh writes through to the operator (#610)', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-'))
  const operator = operatorHome(root)
  const runDirectory = join(root, 'run')
  const home = prepareRunHome(runDirectory, operator)

  expect(home).toBe(join(runDirectory, ARENA_RUN_HOME))
  for (const [linked, source] of [
    [ensoSecretsPath(home), ensoSecretsPath(operator)],
    [join(ensoAgentDir(home), 'auth.json'), join(ensoAgentDir(operator), 'auth.json')],
    [join(ensoAgentDir(home), 'models.json'), join(ensoAgentDir(operator), 'models.json')],
  ] as const) {
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(readlinkSync(linked)).toBe(source)
  }
  const settings = join(ensoAgentDir(home), 'settings.json')
  expect(lstatSync(settings).isSymbolicLink()).toBe(false)

  // pi rewrites auth.json in place after a refresh (`FileAuthStorageBackend.withLock`): through the
  // link, the rotated token is the operator's too, so the run cannot log the operator out.
  writeFileSync(join(ensoAgentDir(home), 'auth.json'), '{"anthropic":{"refresh":"rotated"}}')
  expect(readFileSync(join(ensoAgentDir(operator), 'auth.json'), 'utf8')).toContain('rotated')
  // …while a setting the run changes stays the run's.
  writeFileSync(settings, '{"defaultModel":"other"}')
  expect(readFileSync(join(ensoAgentDir(operator), 'settings.json'), 'utf8')).toContain('"m"')
})

test('a file the operator home lacks is left out of the run home, never created', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-bare-'))
  const operator = join(root, 'operator', '.enso')
  mkdirSync(ensoAgentDir(operator), { recursive: true })
  const home = prepareRunHome(join(root, 'run'), operator)
  expect(existsSync(ensoSecretsPath(home))).toBe(false)
  expect(existsSync(join(ensoAgentDir(home), 'auth.json'))).toBe(false)
  expect(existsSync(join(ensoAgentDir(home), 'settings.json'))).toBe(false)
})

test('⚠ a run under ~/.enso is a project the guard keeps Enso’s agent out of; the default is not, and the run home is (#610)', () => {
  expect(isGuardedForAgent(join(homedir(), '.enso', 'arena'))).toBe(true)
  expect(isGuardedForAgent(defaultArenaOut({}))).toBe(false)
  expect(defaultArenaOut({ XDG_DATA_HOME: '/data' })).toBe('/data/enso/arena')
  // The links live where the guard denies Enso's agent both reading and writing.
  expect(isGuardedForAgent(join('/data/enso/arena/snake-1', ARENA_RUN_HOME))).toBe(true)
  expect(isGuardedForAgent('/data/enso/arena/snake-1/project')).toBe(false)
})

test('the secret set holds the login’s OAuth tokens and keys as well as secrets.env', () => {
  const values = arenaSecretValues(operatorHome(mkdtempSync(join(tmpdir(), 'arena-secrets-'))))
  expect(values).toEqual(expect.arrayContaining([API_KEY, ACCESS, REFRESH]))
  expect(values).not.toContain('oauth')
})

/** A zip as a writer makes one: each entry stored or deflated, with its CRC, and the central directory. */
function zipOf(
  entries: ReadonlyArray<{ readonly name: string; readonly text: string; readonly deflate: boolean }>,
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const zipEntry of entries) {
    const name = Buffer.from(zipEntry.name)
    const raw = Buffer.from(zipEntry.text)
    const data = zipEntry.deflate ? deflateRawSync(raw) : raw
    const crc = Bun.hash.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04_03_4b_50, 0)
    local.writeUInt16LE(zipEntry.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02_01_4b_50, 0)
    central.writeUInt16LE(zipEntry.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06_05_4b_50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

test('a trace zip is read entry by entry, stored and deflated', () => {
  const entries = zipEntries(
    zipOf([
      { name: 'trace.trace', text: 'one', deflate: false },
      { name: 'resources/a.json', text: 'two'.repeat(50), deflate: true },
    ]),
  )
  expect(entries.map((zipEntry) => [zipEntry.name, Buffer.from(zipEntry.data).toString()])).toEqual([
    ['trace.trace', 'one'],
    ['resources/a.json', 'two'.repeat(50)],
  ])
})

test('⚠ a secret in a response body inside the trace is found, named by file and entry; the run home, links and PNGs are not read (#584 A11)', () => {
  const runDirectory = mkdtempSync(join(tmpdir(), 'arena-scan-'))
  mkdirSync(join(runDirectory, 'trace'))
  writeFileSync(
    join(runDirectory, 'trace', 'trace-000.zip'),
    zipOf([
      { name: 'trace.trace', text: '{"type":"action"}', deflate: true },
      { name: 'resources/9f2.json', text: `{"provider":{"key":"${API_KEY}"}}`, deflate: true },
    ]),
  )
  mkdirSync(join(runDirectory, 'project'))
  writeFileSync(join(runDirectory, 'project', 'config.js'), `export const key = '${API_KEY}'\n`)
  writeFileSync(join(runDirectory, 'timeline.jsonl'), '{"kind":"run-start"}\n')
  // Not read: the run home holds the credential links by design; a link is someone else's file; a PNG is pixels.
  mkdirSync(join(runDirectory, ARENA_RUN_HOME))
  writeFileSync(join(runDirectory, ARENA_RUN_HOME, 'secrets.env'), `KEY=${API_KEY}\n`)
  const outside = join(mkdtempSync(join(tmpdir(), 'arena-outside-')), 'auth.json')
  writeFileSync(outside, API_KEY)
  symlinkSync(outside, join(runDirectory, 'linked.json'))
  writeFileSync(join(runDirectory, 'shot.png'), API_KEY)
  writeFileSync(join(runDirectory, 'trace', 'trace-001.zip'), 'not a zip')

  const scan = scanRunForSecrets(runDirectory, [API_KEY])
  expect(scan.hits).toEqual(
    expect.arrayContaining([
      { path: 'trace/trace-000.zip', entry: 'resources/9f2.json' },
      { path: 'project/config.js' },
    ]),
  )
  expect(scan.hits).toHaveLength(2)
  expect(scan.unreadable).toEqual([{ path: 'trace/trace-001.zip', error: 'not a zip: no end of central directory' }])
  expect(scan.entries).toBe(2)
  // The report names where, never what.
  expect(JSON.stringify(scan)).not.toContain(API_KEY)
})
