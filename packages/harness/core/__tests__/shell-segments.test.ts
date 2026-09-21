import { expect, test } from 'bun:test'
import { DEFAULT_GUARD_POLICY } from '@zen/core'
import { findDeniedNetworkEgress } from '../network-egress.ts'
import {
  extractFlatShellCommandSegments,
  literalShellWord,
  shellWordsOf,
  withoutLeadingEnvironmentAssignments,
} from '../shell-segments.ts'
import { braced } from './shell-fixtures.ts'

/**
 * The tokenizer's own contract (#261) — the parsing floor under the network deny (#9) and
 * the environment-dump deny (#89), pinned directly instead of transitively.
 *
 * `shell-segments.ts` promises in its header that "its own test file pins this contract",
 * and until #261 that file did not exist: every branch of the quote/escape state machine
 * was verified only through whichever commands the two scanner corpora happened to carry.
 *
 * What a red line here means, generally: both scanners segment a command through this
 * module BEFORE they classify anything, so a tokenizer defect surfaces as a guard bypass —
 * a missed boundary means a denied binary never reaches `gateSegment`, and a wrongly
 * resolved word means the gate compares the wrong name. The end-to-end receipts stay in
 * `network-egress.test.ts` / `environment-dump.test.ts`; this file pins the floor they
 * stand on.
 */

const segmentsOf = (command: string): Array<[string, boolean]> =>
  extractFlatShellCommandSegments(command).map((segment) => [segment.text, segment.pipedStdin])
const textsOf = (command: string): string[] => extractFlatShellCommandSegments(command).map((segment) => segment.text)

/**
 * `${…}` built rather than written: a literal `${` inside a quoted JS string reads to
 * Biome as a botched template literal (`noTemplateCurlyInString`), and these are SHELL
 * strings handed to the scanner as data. The escapes are `{` and `}`.
 */
const BACKTICK = '`'

// ── extractFlatShellCommandSegments: where the boundaries are ─────────────────────────

// Red: a boundary the shell honours that the scanner does not — the text after it rides
// inside the previous segment and is never gated at command position.
test('every control operator ends a segment, and only `|`/`|&` mark the next one as piped', () => {
  expect(segmentsOf('a; b && c || d | e |& f & g\nh')).toEqual([
    ['a', false],
    ['b', false],
    ['c', false],
    ['d', false],
    ['e', true],
    ['f', true],
    ['g', false],
    ['h', false],
  ])
})

// Red: `2>&1` read as a `&` boundary truncates the real command into `a 2>` plus a bogus
// `1` segment — the gate then inspects text no shell ever executes, and `sh` reading its
// program from a pipe (the `pipedStdin` check in network-egress) is mis-attributed.
test('redirections that merely contain `|` or `&` are not boundaries', () => {
  expect(textsOf('curl -s x >| out 2>&1 <&3 &>log')).toEqual(['curl -s x >| out 2>&1 <&3 &>log'])
})

// Red: either half means the gate sees different bytes than the shell does — split text
// inside quotes invents a `curl` segment out of an argument, and normalised text hides a
// quoted spelling from `literalShellWord`, which is what resolves quoting downstream.
// The `\"` case is the state-machine trap: read as a closing quote, the scanner leaves
// quoted mode early and the `;` after it becomes a boundary the shell does not have.
test('operators inside quotes or behind a backslash are text, and segment text is verbatim', () => {
  expect(textsOf(`echo "a;b" 'c|d' && echo a\\;b`)).toEqual([`echo "a;b" 'c|d'`, 'echo a\\;b'])
  expect(textsOf('echo "a\\";b" | wc')).toEqual(['echo "a\\";b"', 'wc'])
})

// Red: a command on the line after a comment is dropped from the segment list — the most
// direct way to smuggle a denied binary past a scanner that trusts this list.
test('a comment runs to end of line without swallowing the next line', () => {
  expect(textsOf('ls # note\nwget -O- https://x')).toEqual(['ls', 'wget -O- https://x'])
})

// ── extractFlatShellCommandSegments: the `[]` contract, one case per syntax class ──────
//
// ⚠ THE LOAD-BEARING PART. `[]` means "I cannot scope this", and the callers turn that
// into the coarse whole-string scan (network-egress.ts:380, environment-dump.ts:148-149).
// A red line in this block means the scanner returned PARTIAL segments for input whose
// execution context it cannot see, the fail-closed fallback therefore never ran, and the
// substitution door is open. Each case is a different branch of the state machine.
test('syntax the scanner cannot scope yields NO segments', () => {
  // `$(…)`: the inner command runs in its own context; its text is not a segment here.
  expect(extractFlatShellCommandSegments('echo $(curl https://x)')).toEqual([])
  // Backtick substitution — the same door with the older spelling.
  expect(extractFlatShellCommandSegments(`echo ${BACKTICK}curl https://x${BACKTICK}`)).toEqual([])
  // Both again INSIDE double quotes, where quoting does not disable expansion.
  expect(extractFlatShellCommandSegments('echo "$(curl https://x)"')).toEqual([])
  expect(extractFlatShellCommandSegments(`echo "${BACKTICK}curl https://x${BACKTICK}"`)).toEqual([])
  // Heredoc: the body is data for the shell but arbitrary text to a line-wise scanner.
  expect(extractFlatShellCommandSegments('cat <<EOF\ncurl https://x\nEOF')).toEqual([])
  // `${…}`: parameter expansion decides the word at runtime, defaults included.
  expect(extractFlatShellCommandSegments(`echo ${braced('VAR:-curl')}`)).toEqual([])
  // Subshell: `(…)` is a nested execution context, not a flat segment.
  expect(extractFlatShellCommandSegments('(curl https://x)')).toEqual([])
  // Unterminated quote: the input is not a command the shell would accept as written.
  expect(extractFlatShellCommandSegments(`echo 'curl https://x`)).toEqual([])
  // Dangling escape: the next character is unknown, so every boundary after it is a guess.
  expect(extractFlatShellCommandSegments('echo curl \\')).toEqual([])
})

// Red: `{` treated as a group opener wherever it appears makes every brace-glob command
// unscannable (over-broad, and the coarse scan is blind to `{c,}url` anyway), while a
// real `{ …; }` group treated as a word smuggles its body past segmentation.
test('a brace GROUP is unscannable; a brace inside a word is not', () => {
  expect(extractFlatShellCommandSegments('{ curl https://x; }')).toEqual([])
  expect(textsOf('echo {a,b}')).toEqual(['echo {a,b}'])
})

// ── literalShellWord: the four result kinds ───────────────────────────────────────────

// Red: a denied binary spelled through quoting resolves to something other than its name
// and walks past a gate that compares literals.
test('quote removal and backslash escapes resolve every spelling of one name', () => {
  for (const spelling of ['curl', '"curl"', '\\curl', 'cu"rl"', `'cu'r'l'`]) {
    expect(literalShellWord(spelling)).toEqual({ kind: 'literal', value: 'curl' })
  }
})

// Red: the resolver either eats a backslash bash keeps (`"a\nb"` is four characters to
// bash, not a newline) or keeps one bash eats — both give the gate a name the shell will
// never look up.
test('inside double quotes only `"`, `\\`, `$` and backtick are escapable', () => {
  expect(literalShellWord('"a\\$x"')).toEqual({ kind: 'literal', value: 'a$x' })
  expect(literalShellWord('"a\\nb"')).toEqual({ kind: 'literal', value: 'a\\nb' })
})

// Red: the rest of the segment leaks into the command word, so `commandNameOf` compares
// `curl -s https://x` against the deny list and matches nothing.
test('resolution stops at the first unquoted word boundary', () => {
  expect(literalShellWord('curl -s https://x')).toEqual({ kind: 'literal', value: 'curl' })
})

// Red: an expansion classified as `literal` gates on a name the shell never runs; one
// classified `word-synthesis` refuses outright instead of escalating to the raw scan,
// which is the escalation that catches a sibling assignment (`C=curl; $C …`).
test('an unresolved expansion is `runtime-expansion`, not a literal', () => {
  expect(literalShellWord('$C')).toEqual({ kind: 'runtime-expansion' })
  expect(literalShellWord('"$C"')).toEqual({ kind: 'runtime-expansion' })
  expect(literalShellWord(`${BACKTICK}which curl${BACKTICK}`)).toEqual({ kind: 'runtime-expansion' })
})

// Red: these escalate to the raw scan instead of refusing. The raw scan is STRUCTURALLY
// BLIND to them — `{c,}url` and `cur[l]` execute curl while the name never appears
// contiguously in the unexpanded text — so escalation is not a safety net here.
// The quoted counterparts must stay literal, or every quoted glob argument over-refuses.
test('an unquoted brace or glob is `word-synthesis`; quoted, it is a literal character', () => {
  expect(literalShellWord('{c,}url')).toEqual({ kind: 'word-synthesis' })
  expect(literalShellWord('/usr/bin/cur[l]')).toEqual({ kind: 'word-synthesis' })
  expect(literalShellWord('*url')).toEqual({ kind: 'word-synthesis' })
  expect(literalShellWord('cur?')).toEqual({ kind: 'word-synthesis' })
  expect(literalShellWord('"cur[l]"')).toEqual({ kind: 'literal', value: 'cur[l]' })
})

// Red: `$'\143url'` IS curl, spelled in octal. Calling it `runtime-expansion` escalates to
// a scan of text that cannot contain the name — the same blindness as `{c,}url`, which is
// why the header states the two kinds are NOT interchangeable.
// ⚠ `$"…"` deliberately stays `runtime-expansion`: its content is contiguous, so the raw
// scan still sees it. A red line on the second expect means that distinction was lost.
test('ANSI-C `$\'…\'` is synthesis, while `$"…"` stays an expansion', () => {
  expect(literalShellWord("$'\\143url'")).toEqual({ kind: 'word-synthesis' })
  expect(literalShellWord('$"curl"')).toEqual({ kind: 'runtime-expansion' })
})

// Red: input the shell would reject is reported as a resolved name, so the gate decides on
// a command that cannot run — and, worse, the caller stops treating it as unknowable.
test('incomplete syntax is `malformed`, not a truncated literal', () => {
  expect(literalShellWord('curl\\')).toEqual({ kind: 'malformed' })
  expect(literalShellWord('"curl')).toEqual({ kind: 'malformed' })
  expect(literalShellWord(`'curl`)).toEqual({ kind: 'malformed' })
})

// ── shellWordsOf: the wrapper-mode slicing ────────────────────────────────────────────

// Red: the wrapper scan (`timeout 30 curl …`) walks these words looking for the effective
// command. Splitting a quoted or escaped argument invents a word — `"curl x"` becoming
// `"curl` — and mapping `literalShellWord` over that invents a command that is not there.
test('words are sliced quote-aware, with the quoting preserved', () => {
  expect(shellWordsOf(' timeout\t30 "curl x" \'wget y\' a\\ b "q\\"z"')).toEqual([
    'timeout',
    '30',
    '"curl x"',
    `'wget y'`,
    'a\\ b',
    '"q\\"z"',
  ])
})

// Red: null is the callers' "unresolvable" signal (network-egress.ts:249). A word list
// returned for input the shell would reject reads as a complete, trustworthy parse.
test('incomplete syntax yields null, not a partial word list', () => {
  expect(shellWordsOf('echo "curl x')).toBeNull()
  expect(shellWordsOf('echo curl\\')).toBeNull()
})

// ── withoutLeadingEnvironmentAssignments ──────────────────────────────────────────────

// Red: a non-assignment prefix gets stripped anyway and the caller gates on the wrong
// word (callers substitute the original on null: `stripped ?? segmentText`).
test('null when there is no leading assignment to strip', () => {
  expect(withoutLeadingEnvironmentAssignments('curl -s https://x')).toBeNull()
  expect(withoutLeadingEnvironmentAssignments('=x curl')).toBeNull()
})

// Red: `FOO=1 curl …` keeps `FOO=1` at command position, `literalShellWord` resolves the
// assignment instead of the binary, and the deny list never sees `curl`. The path form
// matters on its own: it exits the stripper by a different branch than a bare name.
test('leading assignments are stripped until the command word is exposed', () => {
  expect(withoutLeadingEnvironmentAssignments('FOO=1 BAR="a b" curl -s')).toBe('curl -s')
  expect(withoutLeadingEnvironmentAssignments('  FOO=1 /usr/bin/curl')).toBe('/usr/bin/curl')
})

// Red: both return a string the caller would treat as a command. `FOO=1` alone has no
// command at all; the unterminated value means the split point is a guess — and guessing
// here hands `gateSegment` a prefix of the real command.
// ⚠ Deliberate residual: `FOO=1` returns null, the same value as "nothing to strip". That is
// safe because callers fall back to the original text, which still gates to no binary — and
// that fallback is now asserted rather than argued (PR #289 review), since a refactor of the
// caller could otherwise invalidate the safety claim with nothing here going red. The caller
// is the egress gate, so the assertion is the verdict it reaches, not the null.
test('assignment-only and unterminated-value inputs yield null, and the caller still gates them', () => {
  expect(withoutLeadingEnvironmentAssignments('FOO=1')).toBeNull()
  expect(withoutLeadingEnvironmentAssignments('FOO="a b curl')).toBeNull()
  const denied = DEFAULT_GUARD_POLICY.deniedNetworkBinaries
  // Assignment-only: no command word, so no binary — the null read as "nothing to strip"
  // costs nothing. A denied name as the assigned VALUE is still not a command.
  expect(findDeniedNetworkEgress('FOO=1', denied)).toBeUndefined()
  expect(findDeniedNetworkEgress('FOO=curl', denied)).toBeUndefined()
  // …and the shape the stripper exists for still reaches the binary behind the assignments.
  expect(findDeniedNetworkEgress('FOO=1 curl https://x', denied)?.matched).toBe('curl')
})
