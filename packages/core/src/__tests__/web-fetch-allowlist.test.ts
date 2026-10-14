import { expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceFileText } from '../paths.ts'
import { changeUserAllowedHosts, nonPublicAddressReason } from '../web-fetch-allowlist.ts'
import { readWebFetchHostInput } from '../web-fetch.ts'

/**
 * Settings' allowlist editor (#924): what a typed host becomes, and that a change to the user's
 * file changes `webFetch.allowedHosts` and nothing else.
 */

function userFile(text?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'enso-allowlist-')), 'config.json')
  if (text !== undefined) writeFileSync(path, text)
  return path
}

test('a bare host is stored as the fetcher compares it: lower case, an IDN in punycode', () => {
  expect(readWebFetchHostInput('  Docs.Example.COM ')).toEqual({ kind: 'host', host: 'docs.example.com' })
  expect(readWebFetchHostInput('bücher.example')).toEqual({ kind: 'host', host: 'xn--bcher-kva.example' })
  // What web_fetch compares against: the URL's own hostname.
  expect(new URL('https://BÜCHER.example/x').hostname).toBe('xn--bcher-kva.example')
})

test('a pasted http(s) URL is reduced to its host, to confirm', () => {
  expect(readWebFetchHostInput('https://www.enso.engineer/features?x=1')).toEqual({
    kind: 'from-url',
    host: 'www.enso.engineer',
    url: 'https://www.enso.engineer/features?x=1',
  })
})

test.each([
  ['*.example.com', 'Wildcards'],
  ['example.com/docs', 'path'],
  // The URL parser reads `\` as `/` in an http(s) URL: this is a path, not the whole host (#924 review).
  ['example.com\\docs', 'path'],
  ['example.com:8080', 'port'],
  ['user@example.com', 'credential'],
  ['ftp://example.com/', 'scheme ftp'],
  ['https://example.com:8443/', 'port'],
  ['https://user:pw@example.com/', 'credential'],
  ['mailto:someone', 'scheme'],
  ['exa mple.com', 'spaces'],
  ['', 'Type a host'],
  ['example..com', 'isn’t a host name'],
])('%p is refused, saying why', (typed, why) => {
  expect(readWebFetchHostInput(typed)).toEqual({ kind: 'refused', reason: expect.stringContaining(why) })
})

test('add then remove: only webFetch.allowedHosts changes; every other key keeps its text', () => {
  const original =
    '{\n    "projects": { "roots": ["/srv"] },\n    "webSearch": {"backend": "deepseek"},\n    "webFetch": {\n        "allowedHosts": ["a.example"]\n    }\n}\n'
  const path = userFile(original)
  expect(changeUserAllowedHosts(path, { add: 'www.enso.engineer' })).toEqual({
    kind: 'written',
    hosts: ['a.example', 'www.enso.engineer'],
  })
  const added = readFileSync(path, 'utf8')
  expect(added).toContain('    "projects": { "roots": ["/srv"] },\n    "webSearch": {"backend": "deepseek"},\n')
  expect(JSON.parse(added)).toEqual({
    projects: { roots: ['/srv'] },
    webSearch: { backend: 'deepseek' },
    webFetch: { allowedHosts: ['a.example', 'www.enso.engineer'] },
  })
  expect(changeUserAllowedHosts(path, { remove: 'www.enso.engineer' })).toEqual({
    kind: 'written',
    hosts: ['a.example'],
  })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(original))
  expect(readFileSync(path, 'utf8')).toContain('"webSearch": {"backend": "deepseek"}')
  // Written beside the file, then renamed over it: nothing staged is left behind.
  expect(readdirSync(join(path, '..'))).toEqual(['config.json'])
})

test('no file yet: the first host makes one holding only that', () => {
  const path = userFile()
  expect(changeUserAllowedHosts(path, { add: 'docs.example.com' }).kind).toBe('written')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ webFetch: { allowedHosts: ['docs.example.com'] } })
})

test('a host already listed, or one not listed removed, changes nothing', () => {
  const path = userFile('{"webFetch":{"allowedHosts":["a.example"]}}')
  expect(changeUserAllowedHosts(path, { add: 'a.example' })).toEqual({ kind: 'unchanged', hosts: ['a.example'] })
  expect(changeUserAllowedHosts(path, { remove: 'b.example' })).toEqual({ kind: 'unchanged', hosts: ['a.example'] })
  expect(readFileSync(path, 'utf8')).toBe('{"webFetch":{"allowedHosts":["a.example"]}}')
})

test('only a normalised host is written: a URL, a wildcard or upper case is refused, the file untouched', () => {
  const path = userFile('{}')
  for (const add of ['https://a.example/', '*.a.example', 'A.example']) {
    expect(changeUserAllowedHosts(path, { add }).kind).toBe('refused')
  }
  expect(readFileSync(path, 'utf8')).toBe('{}')
})

test('an unreadable file is never overwritten: the reason comes back', () => {
  const path = userFile('{"webFetch":{"allowedHost":[]}}')
  const written = changeUserAllowedHosts(path, { add: 'a.example' })
  expect(written.kind).toBe('refused')
  expect(readFileSync(path, 'utf8')).toBe('{"webFetch":{"allowedHost":[]}}')
  expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
})

test('a file with no webFetch yet: the section is added, the keys around it keep their text', () => {
  const path = userFile('{\n  "projects": { "roots": ["/srv"] }\n}\n')
  expect(changeUserAllowedHosts(path, { add: 'a.example' }).kind).toBe('written')
  const written = readFileSync(path, 'utf8')
  expect(written).toBe('{\n  "projects": { "roots": ["/srv"] },\n  "webFetch": {"allowedHosts":["a.example"]}\n}\n')
})

test('an empty file, or a webFetch with no allowedHosts, is not a config Enso reads: refused, left as it is (#924 review)', () => {
  for (const text of ['', '{"webFetch":{}}']) {
    const path = userFile(text)
    expect(changeUserAllowedHosts(path, { add: 'a.example' })).toEqual({
      kind: 'refused',
      reason: expect.stringContaining('it is never overwritten'),
    })
    expect(readFileSync(path, 'utf8')).toBe(text)
  }
})

test('⚠ a symlinked config stays a link: the file behind it changes, and keeps its mode (#924 review)', () => {
  const dotfiles = mkdtempSync(join(tmpdir(), 'enso-dotfiles-'))
  const real = join(dotfiles, 'enso.json')
  writeFileSync(real, '{}')
  chmodSync(real, 0o640)
  const path = join(mkdtempSync(join(tmpdir(), 'enso-allowlist-')), 'config.json')
  symlinkSync(real, path)
  expect(changeUserAllowedHosts(path, { add: 'a.example' }).kind).toBe('written')
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
  expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ webFetch: { allowedHosts: ['a.example'] } })
  expect(statSync(real).mode & 0o777).toBe(0o640)
  expect(readdirSync(dotfiles)).toEqual(['enso.json'])
})

test('a write that fails leaves nothing staged behind, and the error is thrown (#924 review)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-replace-'))
  // A directory where the file should be: the rename over it fails.
  const path = join(directory, 'config.json')
  mkdirSync(join(path, 'inside'), { recursive: true })
  expect(() => replaceFileText(path, '{}\n')).toThrow()
  expect(readdirSync(directory)).toEqual(['config.json'])
})

test('⚠ a dangling symlinked config stays a link: the file it points at is made (#972 re-review)', () => {
  const dotfiles = mkdtempSync(join(tmpdir(), 'enso-dotfiles-'))
  const real = join(dotfiles, 'enso.json')
  const path = join(mkdtempSync(join(tmpdir(), 'enso-allowlist-')), 'config.json')
  symlinkSync(real, path)
  expect(changeUserAllowedHosts(path, { add: 'a.example' }).kind).toBe('written')
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
  expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ webFetch: { allowedHosts: ['a.example'] } })
  expect(readdirSync(dotfiles)).toEqual(['enso.json'])
})

test('a symlink into a directory not there is an error, and the link is left as it was (#972 re-review)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-replace-'))
  const path = join(directory, 'config.json')
  symlinkSync(join(directory, 'missing', 'enso.json'), path)
  expect(() => replaceFileText(path, '{}\n')).toThrow()
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
  expect(readdirSync(directory)).toEqual(['config.json'])
})

test('a dangling `..` link under a symlinked directory writes where the kernel resolves it (#972 review)', () => {
  const home = mkdtempSync(join(tmpdir(), 'enso-home-'))
  mkdirSync(join(home, 'dotfiles', 'enso'), { recursive: true })
  mkdirSync(join(home, 'dotfiles', 'shared'))
  mkdirSync(join(home, 'shared')) // the textual reading of `..` — must stay empty
  symlinkSync(join(home, 'dotfiles', 'enso'), join(home, '.enso'))
  symlinkSync('../shared/enso.json', join(home, 'dotfiles', 'enso', 'config.json'))
  const path = join(home, '.enso', 'config.json')
  replaceFileText(path, '{}\n')
  expect(readFileSync(join(home, 'dotfiles', 'shared', 'enso.json'), 'utf8')).toBe('{}\n')
  expect(readdirSync(join(home, 'shared'))).toEqual([])
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
})

test('⚠ a link loop throws ELOOP and the link is never replaced by a file (#972 review)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-replace-'))
  const self = join(directory, 'config.json')
  symlinkSync('config.json', self)
  expect(() => replaceFileText(self, '{}\n')).toThrow('ELOOP')
  expect(lstatSync(self).isSymbolicLink()).toBe(true)
  symlinkSync('b.json', join(directory, 'a.json'))
  symlinkSync('a.json', join(directory, 'b.json'))
  expect(() => replaceFileText(join(directory, 'a.json'), '{}\n')).toThrow('ELOOP')
  expect(lstatSync(join(directory, 'a.json')).isSymbolicLink()).toBe(true)
  expect(readdirSync(directory).toSorted()).toEqual(['a.json', 'b.json', 'config.json'])
})

test('⚠ replaceLink: a link at the path is replaced by the file, the file it named untouched (#984 review)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-replace-'))
  const elsewhere = join(directory, 'user.json')
  writeFileSync(elsewhere, '{"mine":true}\n')
  const path = join(directory, 'nested', 'config.json')
  mkdirSync(join(directory, 'nested'))
  symlinkSync(elsewhere, path)
  replaceFileText(path, '{}\n', { replaceLink: true })
  expect(lstatSync(path).isFile()).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('{}\n')
  expect(readFileSync(elsewhere, 'utf8')).toBe('{"mine":true}\n')
})

test('a chain of two links, the last dangling, makes the file at its end (#978 review)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-replace-'))
  symlinkSync('real.json', join(directory, 'middle.json'))
  symlinkSync('middle.json', join(directory, 'config.json'))
  replaceFileText(join(directory, 'config.json'), '{}\n')
  expect(readFileSync(join(directory, 'real.json'), 'utf8')).toBe('{}\n')
  expect(lstatSync(join(directory, 'config.json')).isSymbolicLink()).toBe(true)
  expect(lstatSync(join(directory, 'middle.json')).isSymbolicLink()).toBe(true)
})

// --- nonPublicAddressReason: web_fetch's address gate, the one copy (#972 re-review) ---------------

const answering = (addresses: readonly string[]) => async (): Promise<readonly string[]> => addresses

test('any one non-public address refuses, wherever it stands in the answer', async () => {
  expect(await nonPublicAddressReason('mixed.example', answering(['93.184.216.34', '10.0.0.1']))).toEqual({
    kind: 'non-public',
    reason: '"mixed.example" resolves to a non-public address (10.0.0.1)',
  })
})

test('an empty answer refuses: no address is provably public', async () => {
  expect(await nonPublicAddressReason('empty.example', answering([]))).toEqual({
    kind: 'non-public',
    reason: '"empty.example" resolves to a non-public address',
  })
})

test('a lookup that throws refuses as unresolved — missing, not private — naming the error', async () => {
  const failing = async (): Promise<readonly string[]> => {
    throw new Error('queryA ENOTFOUND nowhere.example')
  }
  expect(await nonPublicAddressReason('nowhere.example', failing)).toEqual({
    kind: 'unresolved',
    reason: '"nowhere.example" did not resolve (Error: queryA ENOTFOUND nowhere.example)',
  })
})

test('every address public passes; an IP literal (bracketed or not) is classified without a lookup', async () => {
  expect(await nonPublicAddressReason('public.example', answering(['93.184.216.34', '2606:2800:220:1::']))).toBe(
    undefined,
  )
  const neverAsked = async (): Promise<readonly string[]> => {
    throw new Error('a literal is never looked up')
  }
  expect(await nonPublicAddressReason('93.184.216.34', neverAsked)).toBe(undefined)
  expect(await nonPublicAddressReason('[::1]', neverAsked)).toEqual({
    kind: 'non-public',
    reason: '"::1" resolves to a non-public address (::1)',
  })
})
