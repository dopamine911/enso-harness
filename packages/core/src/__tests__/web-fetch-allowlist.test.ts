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
import { changeUserAllowedHosts } from '../web-fetch-allowlist.ts'
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
