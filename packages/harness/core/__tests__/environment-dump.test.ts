import { expect, test } from 'bun:test'
import { findEnvironmentDump } from '../environment-dump.ts'
import { braced } from './shell-fixtures.ts'

/**
 * #89's depth layer: the bash environment-dump deny. The quarantine is the fix; this
 * exists so a regression there is refused with a reason instead of printing a key. Each
 * case names the via so the block reason is explainable.
 */

const denied = (command: string): string | undefined => findEnvironmentDump(command)?.via

// ── listings at command position ─────────────────────────────────────────────

test('a bare env, printenv, set, export -p, declare -p is a listing', () => {
  expect(denied('env')).toBe('command-position')
  expect(denied('printenv')).toBe('command-position')
  expect(denied('set')).toBe('command-position')
  expect(denied('export')).toBe('command-position')
  expect(denied('export -p')).toBe('command-position')
  expect(denied('declare -p')).toBe('command-position')
  expect(denied('typeset -x')).toBe('command-position')
  expect(denied('/usr/bin/env')).toBe('command-position')
  expect(denied('"env"')).toBe('command-position')
  expect(denied('ENV')).toBe('command-position')
  expect(denied('env | sort')).toBe('command-position')
  expect(denied('ls && env')).toBe('command-position')
})

// ⚠ THE FALSE POSITIVES THAT MUST NOT HAPPEN: `env` as a wrapper, `set -e`, `export X=1`
// are everyday shell that RUNS or SETS; denying them would make the tool unusable.
test('env as a wrapper, set with options, export/declare with an assignment all pass', () => {
  expect(denied('env FOO=1 bun test')).toBeUndefined()
  expect(denied("env -i sh -c 'echo hi'")).toBeUndefined()
  expect(denied('set -e')).toBeUndefined()
  expect(denied('set -o pipefail')).toBeUndefined()
  expect(denied('export FOO=1')).toBeUndefined()
  expect(denied('declare -a items')).toBeUndefined()
  expect(denied('printenv PATH')).toBeUndefined()
  expect(denied('printenv HOME PATH')).toBeUndefined()
  expect(denied('echo env is a word')).toBeUndefined()
  expect(denied('grep -r environ src/')).toBeUndefined()
  expect(denied('cat .envrc.example')).toBeUndefined()
})

test('printenv of a secret-shaped name is a listing of exactly the thing the deny is for', () => {
  expect(findEnvironmentDump('printenv TAVILY_API_KEY')).toEqual({
    matched: 'TAVILY_API_KEY',
    via: 'secret-expansion',
  })
  expect(denied('printenv GH_TOKEN PATH')).toBe('secret-expansion')
})

test('a listing past a transparent wrapper is caught', () => {
  expect(denied('timeout 5 env')).toBe('wrapped-command')
  expect(denied('sudo printenv')).toBe('wrapped-command')
  expect(denied('nice -n 5 env | head')).toBe('wrapped-command')
  // The wrapper's OWN listing form: `env` wrapping nothing is the bare env above.
  expect(denied('timeout 5 env FOO=1 make')).toBeUndefined()
})

// ── the raw scans, parseable or not ──────────────────────────────────────────

test("/proc/<pid>/environ is the kernel's copy of the same list", () => {
  expect(denied('cat /proc/self/environ')).toBe('proc-environ')
  expect(denied("tr '\\0' '\\n' < /proc/1234/environ")).toBe('proc-environ')
  expect(denied('strings /proc/$$/environ')).toBe('proc-environ')
  // #160 §5: the same bytes per thread, one level deeper.
  expect(denied('cat /proc/self/task/1/environ')).toBe('proc-environ')
  expect(denied('xargs -0 < /proc/$$/task/$$/environ')).toBe('proc-environ')
})

test('expanding a secret-shaped variable is denied; a non-secret one is not', () => {
  expect(findEnvironmentDump('echo $TAVILY_API_KEY')).toEqual({ matched: '$TAVILY_API_KEY', via: 'secret-expansion' })
  expect(denied(`echo "${braced('GH_TOKEN')}"`)).toBe('secret-expansion')
  expect(denied(`curl -H "Authorization: Bearer ${braced('CLIENT_SECRET')}" x`)).toBe('secret-expansion')
  expect(denied('echo $HOME $PATH')).toBeUndefined()
  expect(denied(`echo ${braced('TOKENIZER_PATH')}`)).toBeUndefined()
})

test('an unparseable command takes the coarse scan; a parseable one does not', () => {
  // Command substitution: the segmenter returns [], so a bare word is enough.
  expect(denied('echo $(env)')).toBe('raw-scan')
  expect(denied('x=`printenv`')).toBe('raw-scan')
  // Parseable and innocent: the same words as arguments pass.
  expect(denied('echo printenv')).toBeUndefined()
})

test('the PowerShell path: $env:<secret> and the Env: drive listing, coarse', () => {
  const coarse = (command: string): string | undefined => findEnvironmentDump(command, { coarse: true })?.via
  expect(coarse('Write-Output $env:TAVILY_API_KEY')).toBe('powershell')
  expect(coarse('Get-ChildItem Env:')).toBe('powershell')
  expect(coarse('gci env: | Sort-Object Name')).toBe('powershell')
  expect(coarse('Write-Output $env:PATH')).toBeUndefined()
})

// ── #206: the tripwire has to know `find -exec`, and one wrapper shape it still misses ─────
// This deny is the sensor for a secrets-quarantine regression, so an unlisted bypass makes
// it report "no regression" either way. Measured 2026-09-17: `find . -exec env ;` passed.
test('⚠ a listing command reached through find -exec is denied, naming the wrapped command (#206)', () => {
  expect(denied('find . -maxdepth 0 -exec env ;')).toBe('wrapped-command')
  expect(denied('find . -exec printenv \\;')).toBe('wrapped-command')
  expect(denied('find . -exec env +')).toBe('wrapped-command')
  // The exec-only wrappers added with it reach the listing too.
  expect(denied('unshare -r env')).toBe('wrapped-command')
  expect(denied('runuser -u nobody -- printenv')).toBe('wrapped-command')
  // find's predicates are arguments, not commands: a file NAMED env is not a listing.
  expect(denied('find . -name env -type f')).toBeUndefined()
  expect(denied('find . -exec wc -l {} ;')).toBeUndefined()
})

// ⚠ A payload is a command line, not a command NAME (PR #290 review). Checking `payload[0]`
// alone made the sensor miss inside `find -exec` exactly what it catches outside it — the
// asymmetry a sensor cannot afford, since a silent miss reads as "no regression".
test('a wrapper or nested shell INSIDE a find -exec payload is denied too (#206)', () => {
  expect(denied("find . -exec sh -c 'env' ;")).toBe('wrapped-command')
  expect(denied('find . -exec sudo env ;')).toBe('wrapped-command')
  // The same two lines without the `find` were already denied: that is the asymmetry.
  expect(denied("sh -c 'env'")).toBe('wrapped-command')
  expect(denied('sudo env')).toBe('wrapped-command')
  // Still a payload, still not a listing: the recursion refuses no more than the gate does.
  expect(denied("find . -exec sh -c 'wc -l' ;")).toBeUndefined()
})

// ⚠ STATED RESIDUAL, pinned: a wrapper whose OWN operand follows the wrapped command reads
// as "env runs that operand" and passes. Closing it means counting a wrapper's trailing
// operands as the listing's arguments, which denies `sudo env FOO=1 make build` — a command
// that lists nothing. The sensor takes the miss rather than that false positive, and says so
// here. A red line means someone closed it: keep the false-positive cost in view.
test('recorded residual: a wrapper operand after the listing hides it (#206)', () => {
  expect(denied('script -qc env /dev/null')).toBeUndefined()
  expect(denied('sudo env FOO=1 make build')).toBeUndefined()
})

// #778: a heredoc makes the segmenter decline (#545), and the coarse listing scan read the body:
// `#!/usr/bin/env node` in a script written with `cat` was refused as an environment dump, and the
// agent's next tries to write it otherwise escalated to a security incident.
test("⚠ a quoted heredoc's body is data to the listing scan; a shell reading it, or a listing next to it, is still denied (#778)", () => {
  const script = "<< 'EOF'\n#!/usr/bin/env node\nconsole.log('printenv is a word here')\nEOF"
  expect(denied(`cat > run.js ${script}`)).toBeUndefined()
  // A shell reading the stream runs the body as its program.
  expect(denied("bash << 'EOF'\nenv\nEOF")).toBe('raw-scan')
  // …and with it beside a `cat` heredoc, the whole command is scanned: a shell-fed stream anywhere
  // keeps every body in, the data one included (PR #783 review).
  expect(denied(`cat > run.js ${script}\nbash << 'RUN'\nnode run.js\nRUN`)).toBe('raw-scan')
  // A listing on a command line beside the heredoc.
  expect(denied(`env > dump.txt; cat > run.js ${script}`)).toBe('raw-scan')
  // An unquoted body is expanded by bash, so it stays in the scan.
  expect(denied('cat > run.js << EOF\n#!/usr/bin/env node\nEOF')).toBe('raw-scan')
  // A secret expansion or /proc/…/environ in the body still counts: the script runs later.
  expect(denied("cat > leak.sh << 'EOF'\necho $OPENAI_API_KEY\nEOF")).toBe('secret-expansion')
  expect(denied("cat > leak.sh << 'EOF'\ncat /proc/self/environ\nEOF")).toBe('proc-environ')
})
