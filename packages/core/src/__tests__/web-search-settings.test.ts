import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnsoConfig } from '../config.ts'
import { parseDotenv, writeSecret } from '../secrets.ts'
import { changeUserWebSearch } from '../web-search-settings.ts'

/**
 * Settings › Web tools › Searching (#932): a change to the user's file changes the touched
 * `webSearch` key and nothing else, and the Tavily key is set, replaced and removed in the secrets
 * file without touching its other lines or ever being repeated in a refusal.
 */

function fileIn(name: string, text?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'enso-web-search-')), name)
  if (text !== undefined) writeFileSync(path, text)
  return path
}

const USER_FILE = `{
  "webFetch": { "allowedHosts": ["docs.example.com"] },
  "projects": { "roots": ["~/code"] }
}
`

test('⚠ each change touches only its key: the allowlist and the roots keep their text', () => {
  const path = fileIn('config.json', USER_FILE)
  expect(changeUserWebSearch(path, { backend: 'deepseek' }).kind).toBe('written')
  expect(changeUserWebSearch(path, { list: 'includeDomains', add: 'docs.bun.sh' }).kind).toBe('written')
  expect(changeUserWebSearch(path, { list: 'excludeDomains', add: 'spam.example' }).kind).toBe('written')
  const text = readFileSync(path, 'utf8')
  expect(text).toContain('"webFetch": { "allowedHosts": ["docs.example.com"] },')
  expect(text).toContain('"projects": { "roots": ["~/code"] }')
  const read = parseEnsoConfig(text)
  expect(read.kind === 'ok' ? read.config.webSearch : undefined).toEqual({
    backend: 'deepseek',
    tavily: { includeDomains: ['docs.bun.sh'], excludeDomains: ['spam.example'] },
  })
  // Back to the current model's search: the key goes, the lists stay.
  changeUserWebSearch(path, { backend: 'model' })
  changeUserWebSearch(path, { list: 'includeDomains', remove: 'docs.bun.sh' })
  const after = parseEnsoConfig(readFileSync(path, 'utf8'))
  expect(after.kind === 'ok' ? after.config.webSearch : undefined).toEqual({
    tavily: { includeDomains: [], excludeDomains: ['spam.example'] },
  })
  expect(readdirSync(join(path, '..'))).toEqual(['config.json'])
})

test('a missing file is written whole; a domain not in its bare form, and an unreadable file, are refused unchanged', () => {
  const missing = fileIn('config.json')
  expect(changeUserWebSearch(missing, { list: 'excludeDomains', add: 'spam.example' }).kind).toBe('written')
  expect(JSON.parse(readFileSync(missing, 'utf8'))).toEqual({
    webSearch: { tavily: { excludeDomains: ['spam.example'] } },
  })
  expect(changeUserWebSearch(missing, { list: 'excludeDomains', add: 'Spam.Example' }).kind).toBe('refused')
  expect(changeUserWebSearch(missing, { list: 'excludeDomains', add: '*.example' }).kind).toBe('refused')
  const broken = fileIn('config.json', '{ "webSerch": {} }')
  expect(changeUserWebSearch(broken, { backend: 'deepseek' }).kind).toBe('refused')
  expect(readFileSync(broken, 'utf8')).toBe('{ "webSerch": {} }')
})

test('⚠ the Tavily key is set, replaced and removed in place, owner-only, every other line kept', () => {
  const key = 'tvly-dev-0123456789abcdef'
  const path = fileIn('secrets.env', '# mine\nDEEPSEEK_API_KEY=sk-deep\n')
  expect(writeSecret(path, 'TAVILY_API_KEY', key)).toEqual({ kind: 'written' })
  expect(readFileSync(path, 'utf8')).toBe(`# mine\nDEEPSEEK_API_KEY=sk-deep\nTAVILY_API_KEY=${key}\n`)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(writeSecret(path, 'TAVILY_API_KEY', 'tvly-dev-rotated99')).toEqual({ kind: 'written' })
  expect(parseDotenv(readFileSync(path, 'utf8')).get('TAVILY_API_KEY')).toBe('tvly-dev-rotated99')
  expect(writeSecret(path, 'TAVILY_API_KEY', undefined)).toEqual({ kind: 'written' })
  expect(readFileSync(path, 'utf8')).toBe('# mine\nDEEPSEEK_API_KEY=sk-deep\n')
  expect(writeSecret(path, 'TAVILY_API_KEY', undefined)).toEqual({ kind: 'unchanged' })
})

test('⚠ a key the file could not hold is refused without repeating it', () => {
  const path = fileIn('secrets.env')
  for (const bad of ['tvly secret part', 'tvly-x\nEVIL=1', '"tvly-quoted"']) {
    const written = writeSecret(path, 'TAVILY_API_KEY', bad)
    expect(written.kind).toBe('refused')
    expect(JSON.stringify(written)).not.toContain('tvly')
  }
  expect(readdirSync(join(path, '..'))).toEqual([])
})
