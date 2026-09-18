import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootDotenvPath, zenSecretsPath } from '../paths.ts'
import {
  isSecretShapedName,
  knownSecretValues,
  knownSecretValuesTracking,
  parseDotenv,
  quarantineSecrets,
  readSecret,
} from '../secrets.ts'

/**
 * #89: secrets stay out of the environment the model's tools inherit. The reader takes
 * the gated `.zen/secrets.env`; the quarantine empties an environment of anything
 * secret-shaped or file-defined and reports a root `.env` that still holds a secret. Both
 * run on their own inputs — no test touches `process.env`.
 */

/** A scratch repo root with `.zen/` present, the way `zen.mjs` and the host find it. */
function scratchRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zen-secrets-'))
  mkdirSync(join(root, '.zen'))
  return root
}

test('secret-shaped names are whole underscore-delimited words, so a look-alike is untouched', () => {
  for (const name of [
    'TAVILY_API_KEY',
    'GH_TOKEN',
    'TOKEN',
    'CLIENT_SECRET',
    'DB_PASSWORD',
    'X_SECRET_Y',
    'STRIPE_API_KEYS',
    'AUTH_TOKENS',
  ]) {
    expect(isSecretShapedName(name)).toBe(true)
  }
  for (const name of ['TOKENIZER_PATH', 'PATH', 'PI_CODING_AGENT_DIR', 'SECRETARY', 'api_key']) {
    expect(isSecretShapedName(name)).toBe(false)
  }
})

test('the dotenv subset: comments, export, quotes, trailing comments, CRLF', () => {
  const parsed = parseDotenv(
    [
      '# a comment',
      '',
      'PLAIN=value with spaces # trailing comment',
      'export EXPORTED=yes',
      'DOUBLE="quoted # not a comment\\nline two"',
      "SINGLE='keeps \\n literally'",
      'NOT A LINE',
      'TAVILY_API_KEY=tvly-dev-abc\r',
    ].join('\n'),
  )
  expect(parsed.get('PLAIN')).toBe('value with spaces')
  expect(parsed.get('EXPORTED')).toBe('yes')
  expect(parsed.get('DOUBLE')).toBe('quoted # not a comment\nline two')
  expect(parsed.get('SINGLE')).toBe('keeps \\n literally')
  expect(parsed.get('TAVILY_API_KEY')).toBe('tvly-dev-abc')
  expect(parsed.has('NOT')).toBe(false)
})

// ⚠ THE ONE SOURCE. A secret is read from `.zen/secrets.env` per call, and NEVER from the
// root `.env` — a fallback there would keep a misplaced file silently working, which is
// the opposite of loud.
test('a secret is read from .zen/secrets.env per call; the root .env is never a source', () => {
  const root = scratchRepoRoot()
  expect(readSecret(root, 'TAVILY_API_KEY')).toBeUndefined()
  writeFileSync(rootDotenvPath(root), 'TAVILY_API_KEY=misplaced\n')
  expect(readSecret(root, 'TAVILY_API_KEY')).toBeUndefined()
  writeFileSync(zenSecretsPath(root), 'TAVILY_API_KEY=first\n')
  expect(readSecret(root, 'TAVILY_API_KEY')).toBe('first')
  // Rotated on disk → the next read sees it, no restart.
  writeFileSync(zenSecretsPath(root), 'TAVILY_API_KEY=rotated\n')
  expect(readSecret(root, 'TAVILY_API_KEY')).toBe('rotated')
})

// ⚠ THE FIX. Everything secret-shaped, and everything either file defines (whatever its
// name), leaves the environment; everything else stays, because pi and its children
// legitimately need PATH, HOME, TERM and the harness's own PI_* variables.
test('⚠ the quarantine removes secret-shaped and file-defined names, and nothing else', () => {
  const root = scratchRepoRoot()
  writeFileSync(zenSecretsPath(root), 'TAVILY_API_KEY=tvly\nHARMLESS_LOOKING=but-in-the-file\n')
  const environment: Record<string, string | undefined> = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    PI_CODING_AGENT_DIR: '/agent',
    TAVILY_API_KEY: 'tvly',
    GH_TOKEN: 'ghp',
    CLIENT_SECRET: 's',
    HARMLESS_LOOKING: 'but-in-the-file',
    TOKENIZER_PATH: '/tok',
  }
  const report = quarantineSecrets(environment, root)
  expect(report.removed).toEqual(['CLIENT_SECRET', 'GH_TOKEN', 'HARMLESS_LOOKING', 'TAVILY_API_KEY'])
  expect(report.misplaced).toEqual([])
  expect(Object.keys(environment).sort()).toEqual(['HOME', 'PATH', 'PI_CODING_AGENT_DIR', 'TOKENIZER_PATH'])
  // Idempotent: nothing left to remove, nothing else touched.
  expect(quarantineSecrets(environment, root).removed).toEqual([])
  expect(environment.PATH).toBe('/usr/bin')
})

// ⚠ THE RESIDUAL bun AUTOLOAD. A root `.env` reaches every bun child from the cwd no matter
// what the parent scrubbed (verified with `env -i`). Its secret-shaped names are scrubbed
// from THIS process and named as misplaced so the operator moves them — and its NON-secret
// names are left alone: the root `.env` is the project's, not ours, and `PORT` or
// `PUBLIC_URL` there is config bun loaded on purpose (PR #98 review).
test('a root .env: its secret-shaped names are scrubbed and reported as misplaced; its other names stay', () => {
  const root = scratchRepoRoot()
  writeFileSync(rootDotenvPath(root), 'TAVILY_API_KEY=in-the-wrong-place\nPUBLIC_URL=https://x\n')
  const environment: Record<string, string | undefined> = {
    TAVILY_API_KEY: 'in-the-wrong-place',
    PUBLIC_URL: 'https://x',
  }
  const report = quarantineSecrets(environment, root)
  expect(report.removed).toEqual(['TAVILY_API_KEY'])
  expect(report.misplaced).toEqual(['TAVILY_API_KEY'])
  expect(environment).toEqual({ PUBLIC_URL: 'https://x' })
})

test('with no secrets file the quarantine still removes secret-shaped names from the environment', () => {
  const environment: Record<string, string | undefined> = { GH_TOKEN: 'ghp', LANG: 'C' }
  const report = quarantineSecrets(environment, scratchRepoRoot())
  expect(report).toEqual({ removed: ['GH_TOKEN'], misplaced: [] })
  expect(environment).toEqual({ LANG: 'C' })
})

// #139: the values the logger scans for. A fixture root, never the operator's own file —
// the whole reason `knownSecretValues` takes a root and an environment as arguments.
test("⚠ the logger's value set is the secrets file plus secret-shaped env names, deduped, short values left out", () => {
  const root = scratchRepoRoot()
  writeFileSync(
    zenSecretsPath(root),
    ['TAVILY_API_KEY=tvly-long-enough-to-scan', 'HARMLESS_LOOKING=but-in-the-file-so-secret', 'SHORT=abc'].join('\n'),
  )
  const values = knownSecretValues(root, {
    // Secret-shaped, long enough: in — a process configured before quarantine ran. The value
    // says `notarealsecret` because a PAT-shaped fixture (`ghp_…`) trips the repo's secret
    // scanner, and a fixture that reads as a real credential to a scanner is a bad fixture.
    GH_TOKEN: 'ghp-notarealsecret-fixture',
    // Secret-shaped but too short to scan for: a 4-char value would redact prose.
    DB_PASSWORD: 'hunt',
    // The same value the file holds: one entry, not two.
    ANTHROPIC_API_KEY: 'tvly-long-enough-to-scan',
    // Not secret-shaped: never scanned for, however long.
    PUBLIC_URL: 'https://example.com/a-very-long-public-url',
  })
  expect([...values].sort()).toEqual([
    'but-in-the-file-so-secret', // in the file, so a secret by definition whatever its name
    'ghp-notarealsecret-fixture',
    'tvly-long-enough-to-scan',
  ])
})

test('no secrets file and no secret-shaped names: an empty set, so the value pass never runs', () => {
  expect(knownSecretValues(scratchRepoRoot(), { PUBLIC_URL: 'https://example.com' })).toEqual([])
})

// #207: the reader was per call and the redactor was a boot snapshot, so a key rotated while
// a launcher ran was live for `readSecret` and absent from every sink's alternation for the
// rest of that process's life.
test('⚠ the tracking set follows a rotation, and hands back the SAME array while the file is unchanged', () => {
  const root = scratchRepoRoot()
  writeFileSync(zenSecretsPath(root), 'TAVILY_API_KEY=tvly-notarealsecret-first\n')
  const tracking = knownSecretValuesTracking(root, {})
  expect(tracking()).toEqual(['tvly-notarealsecret-first'])
  // ⚠ IDENTITY, not contents: `redactingKnownValues` asks per record and rebuilds its
  // alternation only when the array changes, so a tracker that allocated a fresh array per
  // call would recompile the regex on every record written. A red line here is that cost
  // coming back, not a wrong redaction.
  expect(tracking()).toBe(tracking())
  const before = tracking()
  writeFileSync(zenSecretsPath(root), 'TAVILY_API_KEY=tvly-notarealsecret-rotated\n')
  expect(tracking()).toEqual(['tvly-notarealsecret-rotated'])
  expect(tracking()).not.toBe(before)
})

test('the tracking set starts empty when there is no file and picks the file up when one appears', () => {
  const root = scratchRepoRoot()
  const tracking = knownSecretValuesTracking(root, {})
  expect(tracking()).toEqual([])
  writeFileSync(zenSecretsPath(root), 'TAVILY_API_KEY=tvly-notarealsecret-appeared\n')
  expect(tracking()).toEqual(['tvly-notarealsecret-appeared'])
})
