import { expect, test } from 'bun:test'
import { DEFAULT_GUARD_POLICY } from '@zen/core'
import { findSecretPathWord, type SecretPathMatch } from '../shell-secret-paths.ts'

/**
 * The bash/powershell secret-path deny (#204). The finding that produced it, measured
 * through the real handler: `read .zen/secrets.env` was refused and `cat .zen/secrets.env`
 * was allowed. These pin the deny in BOTH directions — what it refuses, what it lets
 * through by design, and the false positives that are the cost of gating a WORD.
 */

const fragments: readonly string[] = DEFAULT_GUARD_POLICY.secretPathFragments
const cwd = '/home/u/project'
const find = (command: string, options: { coarse?: boolean } = {}): SecretPathMatch | undefined =>
  findSecretPathWord(command, fragments, cwd, options)

test('⚠ the route the finding measured: a credential path is refused wherever it stands in the command', () => {
  // The harness's own dir — the basename gate covered `secrets.env` alone, so the
  // three below were readable one tool over from a `read` that was refused.
  expect(find('cat .zen/secrets.env')).toEqual({ matched: '.zen/secrets.env', via: 'resolved' })
  expect(find('cat .zen/pi-agent/auth.json')?.via).toBe('resolved')
  expect(find('grep -r sk- .zen')?.matched).toBe('.zen')
  // An OPERAND, not a command word: the egress deny looks at command position, so a path
  // in argument position had no layer at all.
  expect(find('tail -n 5 .zen/pi-agent/provider-failover.json | base64')?.via).toBe('resolved')
})

test('the policy is the read gate\u2019s, not a second corpus: home credential paths are refused too', () => {
  // `~` expands the way pi's own tools expand it (`resolveAgainstCwd`), so the word is
  // judged as the path the shell would open.
  expect(find('cat ~/.aws/credentials')?.via).toBe('resolved')
  expect(find('cat ~/.ssh/id_rsa')?.via).toBe('resolved')
  // Every segment is scanned, not just the first: the read can hide behind a `cd`.
  expect(find('cd /tmp && cat ~/.ssh/id_ed25519')?.matched).toBe('~/.ssh/id_ed25519')
})

test('a fused redirection or option name is not mistaken for the path — its target is', () => {
  expect(find('base64 <.zen/secrets.env')?.matched).toBe('<.zen/secrets.env')
  expect(find('openssl enc --in=.zen/pi-agent/auth.json')?.via).toBe('resolved')
})

test('a word whose value is not knowable from the text is judged by its text', () => {
  // Expansion: the literal value is unknowable, but the fragment is right there.
  expect(find('cat "$HOME/.zen/secrets.env"')).toEqual({ matched: '"$HOME/.zen/secrets.env"', via: 'text' })
  // Relative mention plus expansion — the leading-separator normalisation is what makes
  // this match, since a directory fragment carries one and a relative word does not.
  expect(find('cat .zen/$SECRET_FILE')?.via).toBe('text')
  // Glob synthesis: `literalShellWord` reports synthesis, the text still carries the dir.
  expect(find('cat .zen/pi-agent/*.json')?.via).toBe('text')
})

test('syntax the segmenter declines escalates to the coarse text pass rather than passing', () => {
  // Command substitution makes the segmenter return [] by contract (shell-segments.ts).
  expect(find('echo $(cat .zen/secrets.env)')?.via).toBe('text')
  expect(find('cat <<EOF\n.zen/pi-agent/auth.json\nEOF')?.via).toBe('text')
})

test('powershell takes the coarse pass, backslash separators included', () => {
  expect(find('Get-Content .zen\\secrets.env', { coarse: true })?.via).toBe('text')
  expect(find('Get-Content $HOME\\.aws\\credentials', { coarse: true })?.via).toBe('text')
  expect(find('Get-ChildItem packages', { coarse: true })).toBeUndefined()
})

test('ordinary development commands are untouched', () => {
  for (const command of [
    'bun test packages/core',
    'git status --short',
    'cat packages/core/src/secrets.ts',
    'bun run zen',
    'echo \'{"webFetch":{"allowedHosts":["x"]}}\' > zen.config.json',
    'rg --files packages/web/src',
    'ls .zenith/config',
  ]) {
    expect(find(command)).toBeUndefined()
  }
})

/**
 * ⚠ THE COST, RECORDED. The deny gates a WORD, because nothing in the text says which
 * operand a program will open. These commands do not read a secret and are refused anyway.
 * If one of these goes green, the gate got narrower — check that deliberately, rather than
 * discovering it from a session that exfiltrated through the same shape.
 */
test('recorded false positives: a command that merely NAMES a credential path is refused', () => {
  expect(find('git log --oneline -- .zen/secrets.env')?.via).toBe('resolved')
  // Searching FOR the name, not reading the file — the gate cannot tell the two apart.
  expect(find('grep -rn "secrets.env" packages/')?.via).toBe('resolved')
  // A bare word that is not a path at all, but whose basename matches the read policy.
  expect(find('aws configure get credentials')?.via).toBe('resolved')
})

/**
 * ⚠ STATED NON-COVERAGE, pinned — a bar, not a boundary, the same shape as the egress deny.
 * A name assembled at runtime is not in the text, and no text scan reaches it. These pass
 * TODAY and the module header says so; a red line here means someone closed one, which is
 * good news that belongs in the header before it belongs in the diff.
 */
test('recorded residual: a name assembled at runtime is not seen', () => {
  // The harness dir named through a variable: no `.zen` in the text, and `auth.json`
  // matches no basename pattern — which is exactly why the fragment had to be added.
  expect(find('cat $ZEN_DIR/pi-agent/auth.json')).toBeUndefined()
  expect(find("cat $'\\056zen/secrets.env'")).toBeUndefined()
  expect(find('cat .z*n/sec*')).toBeUndefined()
})
