import { expect, test } from 'bun:test'
import { DEFAULT_GUARD_POLICY } from '@enso/core'
import { findSecretPathWord, type SecretPathMatch } from '../shell-secret-paths.ts'

/**
 * The bash/powershell secret-path deny (#204). The finding that produced it, measured
 * through the real handler: `read .enso/secrets.env` was refused and `cat .enso/secrets.env`
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
  expect(find('cat .enso/secrets.env')).toEqual({ matched: '.enso/secrets.env', via: 'resolved' })
  expect(find('cat .enso/pi-agent/auth.json')?.via).toBe('resolved')
  expect(find('grep -r sk- .enso')?.matched).toBe('.enso')
  // An OPERAND, not a command word: the egress deny looks at command position, so a path
  // in argument position had no layer at all.
  expect(find('tail -n 5 .enso/pi-agent/provider-failover.json | base64')?.via).toBe('resolved')
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
  expect(find('base64 <.enso/secrets.env')?.matched).toBe('<.enso/secrets.env')
  expect(find('openssl enc --in=.enso/pi-agent/auth.json')?.via).toBe('resolved')
})

// ⚠ The space before a redirect is optional to the shell and was load-bearing to this deny
// (PR #288 review): the word splitter breaks on whitespace, so `cat<PATH` stayed ONE word,
// resolved to `<cwd>/cat<.enso/…`, and the `/.enso/` fragment no longer sat behind a separator.
// Every file the fragment exists for — `auth.json`, `provider-failover*.json`, a transcript —
// was readable through that one keystroke; `secrets.env` survived only on its basename.
test('a redirect fused to the command name with no space is still cut at the operator', () => {
  expect(find('cat<.enso/pi-agent/auth.json')).toEqual({ matched: 'cat<.enso/pi-agent/auth.json', via: 'resolved' })
  expect(find('wc -l<.enso/pi-agent/auth.json')?.via).toBe('resolved')
  expect(find('tee>.enso/pi-agent/auth.json')?.via).toBe('resolved')
  expect(find('cat 2<.enso/pi-agent/auth.json')?.via).toBe('resolved')
  // The operator is a boundary, not a match: an ordinary redirect names nothing credential.
  expect(find('bun test packages/core>out.txt')).toBeUndefined()
})

test('a word whose value is not knowable from the text is judged by its text', () => {
  // Expansion: the literal value is unknowable, but the fragment is right there.
  expect(find('cat "$HOME/.enso/secrets.env"')).toEqual({ matched: '"$HOME/.enso/secrets.env"', via: 'text' })
  // Relative mention plus expansion — the leading-separator normalisation is what makes
  // this match, since a directory fragment carries one and a relative word does not.
  expect(find('cat .enso/$SECRET_FILE')?.via).toBe('text')
  // Glob synthesis: `literalShellWord` reports synthesis, the text still carries the dir.
  expect(find('cat .enso/pi-agent/*.json')?.via).toBe('text')
})

test('syntax the segmenter declines escalates to the coarse text pass rather than passing', () => {
  // Command substitution makes the segmenter return [] by contract (shell-segments.ts).
  expect(find('echo $(cat .enso/secrets.env)')?.via).toBe('text')
  expect(find('cat <<EOF\n.enso/pi-agent/auth.json\nEOF')?.via).toBe('text')
})

test('powershell takes the coarse pass, backslash separators included', () => {
  expect(find('Get-Content .enso\\secrets.env', { coarse: true })?.via).toBe('text')
  expect(find('Get-Content $HOME\\.aws\\credentials', { coarse: true })?.via).toBe('text')
  expect(find('Get-ChildItem packages', { coarse: true })).toBeUndefined()
})

test('ordinary development commands are untouched', () => {
  for (const command of [
    'bun test packages/core',
    'git status --short',
    'cat packages/core/src/secrets.ts',
    'bun run enso',
    'echo \'{"webFetch":{"allowedHosts":["x"]}}\' > enso.config.json',
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
  expect(find('git log --oneline -- .enso/secrets.env')?.via).toBe('resolved')
  // Searching FOR the name, not reading the file — the gate cannot tell the two apart.
  expect(find('grep -rn "secrets.env" packages/')?.via).toBe('resolved')
  // A bare word that is not a path at all, but whose basename matches the read policy.
  expect(find('aws configure get credentials')?.via).toBe('resolved')
  // ⚠ The costliest class: a quoted word is ONE word, so PROSE carrying the fragment is
  // refused — including the commit message that ships a change to this policy. The escape
  // is to spell it so it is not a path, which the refusal text says: `'/\.enso/'` passes.
  expect(find('git commit -m "guards: add /.enso/ to the read policy (#204)"')?.via).toBe('resolved')
  expect(find("rg -n '/\\.enso/' packages/")).toBeUndefined()
  // Harness maintenance through the shell goes with it: the log dir is a credential dir.
  expect(find('wc -l .enso/logs/enso-2026-09-18.jsonl')?.via).toBe('resolved')
  expect(find('du -sh .enso')?.via).toBe('resolved')
})

// ⚠ Quoting must not splice the fragment out of reach. `ln -s "$PWD/.enso" n` creates a name
// whose target does not exist at gate time — so `looksLikeSecret`'s realpath leg has nothing
// to follow — and the next segment reads `n/pi-agent/auth.json`, a path matching nothing.
// The text pass drops quote characters for exactly this: the link word is refused instead.
test('⚠ a same-command symlink into the credential dir is refused at the link, not missed', () => {
  expect(find('ln -s "$PWD/.enso" n && cat n/pi-agent/auth.json')?.via).toBe('text')
  expect(find('ln -s .enso n')?.via).toBe('resolved')
  expect(find('ln -s $(pwd)/.enso n')?.via).toBe('text')
})

/**
 * ⚠ STATED NON-COVERAGE, pinned — a bar, not a boundary, the same shape as the egress deny.
 * A name assembled at runtime is not in the text, and no text scan reaches it. These pass
 * TODAY and the module header says so; a red line here means someone closed one, which is
 * good news that belongs in the header before it belongs in the diff.
 */
test('recorded residual: a name assembled at runtime is not seen', () => {
  // The harness dir named through a variable: no `.enso` in the text, and `auth.json`
  // matches no basename pattern — which is exactly why the fragment had to be added.
  expect(find('cat $ENSO_DIR/pi-agent/auth.json')).toBeUndefined()
  // The symlink route once the NAME is assembled too, not merely quoted.
  expect(find("D=$(printf '.ens%s' 'o'); ln -s $D n; cat n/pi-agent/auth.json")).toBeUndefined()
  // Octal-spelled DIRECTORY, with a basename the policy does not know: nothing to match.
  // (`$'\056enso/secrets.env'` IS refused, but by its basename, not by the fragment.)
  expect(find("cat $'\\056enso'/pi-agent/auth.json")).toBeUndefined()
  expect(find("cat $'\\056enso/secrets.env'")?.via).toBe('text')
  expect(find('cat .en*o/sec*')).toBeUndefined()
  // An ASSIGNMENT keeps its prefix, so the dir inside one is invisible — the price of
  // leaving `ENSO_LOGS_DIR=.enso/logs bun run dev` alone, which reads nothing.
  expect(find('ENSO_LOGS_DIR=.enso/logs bun run dev')).toBeUndefined()
})
