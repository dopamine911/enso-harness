import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { ensoAgentDir, ensoSecretsPath } from '@enso/core/paths'
import {
  ARENA_RUN_HOME,
  arenaLoginDir,
  arenaLoginProviders,
  arenaSecretSource,
  arenaSecretValues,
  defaultArenaOut,
  isGuardedForAgent,
  parseEnsoModel,
  prepareRunHome,
  runHomeOf,
  setRunHomeModel,
} from '../run-home.ts'
import { type ArenaSecretScan, scanRunForSecrets, withEarlierHits, zipEntries } from '../secret-scan.ts'

/**
 * A run's own Enso home and the secret scan of what it keeps (#584 A4, A11; #610). The live half —
 * a run over its own home, the operator's untouched — is proven by a run; what each of those rests
 * on is proven here.
 */

const API_KEY = 'sk-ant-api-notarealkey-0123456789'
const ACCESS = 'oauth-access-notarealtoken-abcdef'
const REFRESH = 'oauth-refresh-notarealtoken-ghijkl'

/** An operator's home with a login of their own: `secrets.env`, an OAuth credential, models and settings. */
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

/** The arena's own login directory, logged in: its own OAuth credential and models. */
function arenaLogin(root: string): string {
  const login = arenaLoginDir({ XDG_DATA_HOME: join(root, 'data') })
  mkdirSync(login, { recursive: true })
  writeFileSync(
    join(login, 'auth.json'),
    JSON.stringify({ anthropic: { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 1_760_000_000_000 } }),
  )
  writeFileSync(join(login, 'models.json'), '{"providers":{}}')
  return login
}

/** What pi-multi-account does to write a credential file (`auth-file-transaction.ts`): a temp file, renamed onto the path. */
function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content)
  renameSync(temp, path)
}

test('⚠ the run home reaches the arena’s own login through a directory link, never the operator’s login (#763)', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-'))
  const operator = operatorHome(root)
  const login = arenaLogin(root)
  const runDirectory = join(root, 'run')
  const home = prepareRunHome(runDirectory, operator, login)

  expect(home).toBe(join(runDirectory, ARENA_RUN_HOME))
  expect(lstatSync(ensoAgentDir(home)).isSymbolicLink()).toBe(true)
  expect(readlinkSync(ensoAgentDir(home))).toBe(login)
  // secrets.env is the operator's, linked: only a human writes it.
  expect(readlinkSync(ensoSecretsPath(home))).toBe(ensoSecretsPath(operator))
  // The operator's settings are copied into the login, so a run starts on the operator's default model.
  expect(readFileSync(join(login, 'settings.json'), 'utf8')).toBe('{"defaultModel":"m"}')
})

// ⚠ #639, #758: a rename onto a linked FILE replaced the link, the rotated token stayed in the run,
// and the operator's was revoked. Through a linked DIRECTORY the rename lands in the real file.
test("⚠ a credential written by rename inside the run home lands in the arena login, the link stays, and the operator's login is untouched", () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-rename-'))
  const operator = operatorHome(root)
  const operatorAuth = readFileSync(join(ensoAgentDir(operator), 'auth.json'), 'utf8')
  const login = arenaLogin(root)
  const home = prepareRunHome(join(root, 'run'), operator, login)

  atomicWrite(join(ensoAgentDir(home), 'auth.json'), '{"anthropic":{"refresh":"rotated-in-the-run"}}')

  expect(lstatSync(ensoAgentDir(home)).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(login, 'auth.json'), 'utf8')).toContain('rotated-in-the-run')
  expect(readFileSync(join(ensoAgentDir(operator), 'auth.json'), 'utf8')).toBe(operatorAuth)
  // The next run, over the same login, starts with the rotated token.
  const next = prepareRunHome(join(root, 'next'), operator, login)
  expect(readFileSync(join(ensoAgentDir(next), 'auth.json'), 'utf8')).toContain('rotated-in-the-run')
})

test('a file the operator home lacks is left out of the run home; settings it lacks start the run from none', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-bare-'))
  const operator = join(root, 'bare-operator', '.enso')
  mkdirSync(ensoAgentDir(operator), { recursive: true })
  const login = arenaLogin(root)
  // An earlier run set its own model in the shared login…
  setRunHomeModel(prepareRunHome(join(root, 'earlier'), operatorHome(root), login), parseEnsoModel('anthropic/x'))

  const home = prepareRunHome(join(root, 'run'), operator, login)
  expect(existsSync(ensoSecretsPath(home))).toBe(false)
  // …which this run does not inherit.
  expect(readFileSync(join(ensoAgentDir(home), 'settings.json'), 'utf8')).toBe('{}\n')
})

// The container links its own `~/.enso/pi-agent` to the arena login (`Dockerfile`, #763).
test('⚠ when the operator’s agent dir is the login itself, the settings are kept, not copied onto themselves', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-same-'))
  const login = arenaLogin(root)
  writeFileSync(join(login, 'settings.json'), '{"defaultModel":"kept"}')
  const operator = join(root, 'container-home', '.enso')
  mkdirSync(operator, { recursive: true })
  symlinkSync(login, ensoAgentDir(operator))

  const home = prepareRunHome(join(root, 'run'), operator, login)
  expect(readFileSync(join(ensoAgentDir(home), 'settings.json'), 'utf8')).toBe('{"defaultModel":"kept"}')
})

// #674: Enso's model for a run is the settings the run home reaches — never the operator's, whatever
// the operator's file holds besides.
test('a run sets the model Enso starts on in the settings it reaches, keeping the rest; the operator’s are untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-home-model-'))
  const operator = operatorHome(root)
  writeFileSync(join(ensoAgentDir(operator), 'settings.json'), '{"defaultModel":"m","theme":"dark"}')
  const home = prepareRunHome(join(root, 'run'), operator, arenaLogin(root))
  // An id may hold a slash of its own (`openrouter/anthropic/claude-…`).
  setRunHomeModel(home, parseEnsoModel('openrouter/anthropic/claude-sonnet-5-5'))
  expect(JSON.parse(readFileSync(join(ensoAgentDir(home), 'settings.json'), 'utf8'))).toEqual({
    defaultModel: 'anthropic/claude-sonnet-5-5',
    defaultProvider: 'openrouter',
    theme: 'dark',
  })
  expect(readFileSync(join(ensoAgentDir(operator), 'settings.json'), 'utf8')).toBe(
    '{"defaultModel":"m","theme":"dark"}',
  )
  // A home with no settings gets a file of the two.
  const bare = join(root, 'bare', '.enso')
  mkdirSync(ensoAgentDir(bare), { recursive: true })
  setRunHomeModel(bare, parseEnsoModel('anthropic/claude-fable-5'))
  expect(JSON.parse(readFileSync(join(ensoAgentDir(bare), 'settings.json'), 'utf8'))).toEqual({
    defaultProvider: 'anthropic',
    defaultModel: 'claude-fable-5',
  })
  for (const wrong of ['claude-fable-5', '/claude', 'anthropic/']) {
    expect(() => parseEnsoModel(wrong)).toThrow('provider/id')
  }
})

test('⚠ a run under ~/.enso is a project the guard keeps Enso’s agent out of; the default is not, and the run home and the arena login are (#610, #763)', () => {
  expect(isGuardedForAgent(join(homedir(), '.enso', 'arena'))).toBe(true)
  expect(isGuardedForAgent(defaultArenaOut({}))).toBe(false)
  expect(defaultArenaOut({ XDG_DATA_HOME: '/data' })).toBe('/data/enso/arena')
  // The links live where the guard denies Enso's agent both reading and writing…
  expect(isGuardedForAgent(join('/data/enso/arena/snake-1', ARENA_RUN_HOME))).toBe(true)
  expect(isGuardedForAgent('/data/enso/arena/snake-1/project')).toBe(false)
  // …and so does the login they lead to: an agent in a run cannot read it by its real path either.
  expect(arenaLoginDir({ XDG_DATA_HOME: '/data' })).toBe('/data/enso/arena-login/.enso/pi-agent')
  expect(isGuardedForAgent(arenaLoginDir({ XDG_DATA_HOME: '/data' }))).toBe(true)
})

test('the arena login names the providers it holds a credential for, and none before `arena login`', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-login-providers-'))
  expect(arenaLoginProviders(join(root, 'never-made'))).toEqual([])
  expect(arenaLoginProviders(arenaLogin(root))).toEqual(['anthropic'])
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

test('⚠ a secret in a response body inside the trace is found, named by file and entry; the run home, links and screenshots are not read (#584 A11)', () => {
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
  // Not read: the run home holds the credential links by design; a link is someone else's file; a screenshot is pixels.
  mkdirSync(join(runDirectory, ARENA_RUN_HOME))
  writeFileSync(join(runDirectory, ARENA_RUN_HOME, 'secrets.env'), `KEY=${API_KEY}\n`)
  const outside = join(mkdtempSync(join(tmpdir(), 'arena-outside-')), 'auth.json')
  writeFileSync(outside, API_KEY)
  symlinkSync(outside, join(runDirectory, 'linked.json'))
  writeFileSync(join(runDirectory, 'shot.jpg'), API_KEY)
  writeFileSync(join(runDirectory, 'older-run-shot.png'), API_KEY)
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

test('⚠ a token the login rotates mid-run joins the secret set, and the one it replaced stays in it (PR #613 review)', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-rotate-'))
  const runDirectory = join(root, 'run')
  const home = prepareRunHome(runDirectory, operatorHome(root), arenaLogin(root))
  const secrets = arenaSecretSource(home)
  expect(secrets()).toEqual(expect.arrayContaining([ACCESS, REFRESH]))

  // pi's refresh rewrites auth.json in place — through the run home's link to the arena login.
  const rotated = 'oauth-access-rotated-mid-run-0123456789'
  writeFileSync(
    join(ensoAgentDir(home), 'auth.json'),
    JSON.stringify({ anthropic: { type: 'oauth', access: rotated, refresh: 'oauth-refresh-rotated-0123456789' } }),
  )
  expect(secrets()).toEqual(expect.arrayContaining([rotated, ACCESS, REFRESH]))
  writeFileSync(join(runDirectory, 'response.json'), `{"token":"${rotated}","old":"${ACCESS}"}`)
  expect(scanRunForSecrets(runDirectory, secrets()).hits).toEqual([{ path: 'response.json' }])
})

/** A scan result with these hits and nothing else. */
const scanWith = (hits: ArenaSecretScan['hits']): ArenaSecretScan => ({ files: 1, entries: 0, hits, unreadable: [] })

test('⚠ a refold never clears a recorded hit it cannot re-check, and drops one whose file is gone (PR #613 review)', () => {
  const runDirectory = mkdtempSync(join(tmpdir(), 'arena-refold-'))
  writeFileSync(join(runDirectory, 'response.json'), 'a value this refold does not know')
  const earlier = { secretScan: scanWith([{ path: 'response.json' }, { path: 'deleted.json' }]) }
  // A rescan with another home's values, or after the token rotated, finds nothing.
  expect(withEarlierHits(scanWith([]), earlier, runDirectory).hits).toEqual([{ path: 'response.json' }])
  // A hit the rescan finds again is one hit, not two.
  expect(withEarlierHits(scanWith([{ path: 'response.json' }]), earlier, runDirectory).hits).toEqual([
    { path: 'response.json' },
  ])
  // A manifest from before the scan, or one that is not one, carries nothing.
  expect(withEarlierHits(scanWith([]), { evidence: [] }, runDirectory).hits).toEqual([])
  expect(withEarlierHits(scanWith([]), 'not a manifest', runDirectory).hits).toEqual([])
})

test('the home a run recorded is the one a refold scans with — not the invoking shell’s, not a guess', () => {
  const runDirectory = mkdtempSync(join(tmpdir(), 'arena-recorded-'))
  mkdirSync(join(runDirectory, ARENA_RUN_HOME))
  expect(runHomeOf(runDirectory, '/shell/home', '/the/run/home')).toBe('/the/run/home')
  expect(runHomeOf(runDirectory, '/shell/home')).toBe(join(runDirectory, ARENA_RUN_HOME))
  rmSync(join(runDirectory, ARENA_RUN_HOME), { recursive: true })
  expect(runHomeOf(runDirectory, '/shell/home')).toBe('/shell/home')
})

const locked: string[] = []
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o755)
})

// Root reads a mode-000 file regardless, so there is nothing unreadable to make.
test.skipIf(process.getuid?.() === 0)(
  '⚠ a file or directory the scan cannot read is an unreadable row, and the rest is still scanned (PR #613 review)',
  () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'arena-locked-'))
    mkdirSync(join(runDirectory, 'project', 'closed'), { recursive: true })
    writeFileSync(join(runDirectory, 'project', 'locked.txt'), API_KEY)
    writeFileSync(join(runDirectory, 'project', 'open.txt'), API_KEY)
    for (const path of [join(runDirectory, 'project', 'locked.txt'), join(runDirectory, 'project', 'closed')]) {
      chmodSync(path, 0o000)
      locked.push(path)
    }
    const scan = scanRunForSecrets(runDirectory, [API_KEY])
    expect(scan.hits).toEqual([{ path: 'project/open.txt' }])
    expect(scan.unreadable.map((row) => row.path).toSorted()).toEqual(['project/closed', 'project/locked.txt'])
    expect(scan.unreadable.every((row) => row.error.includes('EACCES'))).toBe(true)
  },
)
