import { basename } from 'node:path'
import {
  extractFlatShellCommandSegments,
  type FlatShellCommandSegment,
  literalShellWord,
  shellWordsOf,
  withoutLeadingEnvironmentAssignments,
} from './shell-segments.ts'
import { canonicalToolName } from './tool-identity.ts'

/**
 * The bash network deny (#9) — a BAR, deliberately not a boundary.
 *
 * pi itself ships no web tool, so the raw egress path is `bash` plus an ad-hoc client, and
 * the guard gates exactly that: the named HTTP/TCP client binaries at COMMAND POSITION per
 * shell segment, plus bash's own `/dev/tcp` / `/dev/udp` sockets anywhere in the string.
 * The sanctioned path this deny funnels traffic toward is the harness's own `web_fetch`
 * tool (#54) — allowlist-gated, audited per call (`extensions/web-fetch/`).
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT COVER, so nobody reads it as confinement:
 * - `git` remotes. git push IS this harness's job; git is the largest egress path and
 *   cannot be on the list without breaking every PR the agents make.
 * - Interpreters. `python -c`, `node -e` can open sockets — the unbounded long tail that
 *   #9's option-4 warning is about. A list that chased it would read as coverage and
 *   not be coverage.
 *
 * Three match modes, chosen by what the command word turned out to be:
 * - PARSEABLE commands (the segmenter returned segments): the denied name must be the
 *   segment's command word — leading env assignments stripped, then resolved to the
 *   LITERAL value the shell would execute (quote/escape removal: `"curl"`, `\curl` and
 *   `cu"rl"` all resolve to `curl` — PR #55 review, round 1), path prefix ignored,
 *   case-folded. `echo "curl is a tool"` passes — the word is quoted argument text.
 * - UNPARSEABLE commands (the segmenter returned [] — command substitution, backticks,
 *   heredocs) AND runtime-expanded command words (`$C https://…`) fall back to a
 *   word-boundary scan of the RAW string. Coarser on purpose: substitution and
 *   indirection are exactly where evasion lives, so a false positive there is friction
 *   toward safety ("rewrite without the substitution"), not a broken gate.
 * - SYNTHESIZED command words (PR #55 review, round 2) — unquoted brace/glob characters
 *   (`{c,}url`, `/usr/bin/cur[l]`, both of which execute curl, verified live) — are
 *   DENIED OUTRIGHT: expansion assembles the name from pieces, so no scan of the
 *   unexpanded text can ever see it, and escalating to the raw scan would be theater.
 *   Glob/brace as ARGUMENTS (`ls *.ts`) are untouched — only the command word is gated —
 *   and the bare `[` test builtin is exempt.
 * PowerShell commands always take the raw scan — the segmenter speaks POSIX, not PS.
 *
 * ⚠ Third stated non-coverage, with git and the interpreters: variable indirection ACROSS
 * tool calls (`export C=curl` in one call, `$C …` in the next) — the second call's raw
 * scan sees no denied name, because the value lives in session state no string scan can
 * reach. Same-command indirection (`C=curl; $C …`) IS caught, via the escalation.
 *
 * ⚠ Fourth stated non-coverage: BINARY RELOCATION (`cp /usr/bin/curl /tmp/f && /tmp/f …`)
 * — no name check can see it, and chasing it is full path confinement, #9's explicit
 * option-4 non-goal. Wrapper indirection is covered for every wrapper ON THE LIST
 * (round 3): a segment led by one (`timeout`, `env`, `nohup`, `xargs`, `sudo`, `sh -c`,
 * `find -exec`, …) gets every word checked, since the wrapped command sits verbatim past
 * word 1 at an offset no wrapper-agnostic scan can know. ⚠ FIFTH non-coverage, and the
 * correction #206 bought: that is a LIST, not a class. "A program that execs its operands"
 * is not recognisable from the text, so an unlisted wrapper is an open route — nine were,
 * measured on 2026-09-17, until they were added. Read the list as the current inventory of
 * a bar, never as the closure of a class.
 *
 * NESTED SHELLS (#57, the spike of 2026-09-10): a `-c`/`eval` payload is RE-PARSED by the
 * child shell, so quoting one level down (`bash -c "cu'r'l …"`) is `curl` to the child and
 * an unknown word to any single-pass scan — every classifier in the spike shared the hole.
 * Here the resolved payload IS the child's command line and gets the whole guard, to
 * `MAX_SHELL_NESTING` deep; past that, refusal. And THE FLOOR: where the precise path fails
 * and the raw scan would be the last net, a construct the scan is blind to — a substitution
 * carrying quoting or expansion, a shell whose program is a pipe or a heredoc — is REFUSED
 * BY NAME rather than scanned and hoped over (`via: "unresolvable"`). "Cannot vouch" is a
 * verdict, not a gap: the model is told what to rewrite, and fetching stays `web_fetch`.
 *
 * ⚠ Still a bar. A classifier's content comes from incidents (Claude Code's own is ~5,000
 * lines of named bypass classes); the boundary that makes `curl`, `python -c` and a relocated
 * binary the same non-event is network confinement of the tool, a post-freeze decision
 * (`.local/refactor/goals.md` §5b).
 */

/**
 * How the deny matched — carried into the block reason so a denial is explainable.
 *
 * @group Guard predicates
 */
export interface NetworkEgressMatch {
  /** The denied name (or device path) that matched. */
  matched: string
  /**
   * Which mode found it — segment-precise, the coarse raw scan, the bash socket device,
   * or a brace/glob-synthesized command word (denied without knowing the final name,
   * because expansion assembles it from pieces no scan can see contiguously).
   */
  via: 'command-position' | 'raw-scan' | 'dev-socket' | 'command-word-synthesis' | 'wrapped-command' | 'unresolvable'
}

/**
 * How deep a `-c`/`eval` payload may nest another before the guard stops resolving and
 * refuses instead (#57). Two levels is `bash -c "sh -c '…'"`; a legitimate command does
 * not go past that, and past the cap "cannot vouch" is the honest verdict.
 */
const MAX_SHELL_NESTING = 3

/** Shells whose program is whatever they are fed when no `-c` names it — a pipe or a heredoc IS their code. */
const STDIN_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** `-c` in any of its spellings; a shell carrying one reads its program from the argument, not from stdin. */
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
/** Characters that make an unparseable region unscannable: quoting and escapes splice a name, expansion assembles one. */
const UNSCANNABLE_CHARACTERS = /['"\\{[*?]/

/**
 * `${…}` standing where the command word goes: the start of a line or just after a
 * separator (`;`, `&&`, `||`, `|`), past any leading `NAME=value` assignments —
 * `P=cur; ${P}l https://x`. An expansion anywhere else is an argument.
 *
 * ⚠ Applied per LINE, with comment lines dropped first (review): a newline is a command
 * separator, so `# note: ${CMD} is a placeholder` otherwise reads as an expansion at
 * command position and denies a command bash never runs. Refusing what is safe is the
 * cheap direction to be wrong in, but a gate that fires on a comment teaches people to
 * route around the gate.
 */
/**
 * Where a command word can begin on a line the segmenter declined (#160): the list
 * separators, AND the compound-command delimiters the segmenter refuses — `(`/`)` (a
 * substitution's `$(` is masked first) and a `{`/`}` standing alone as a word (a group;
 * inside a word it is brace expansion and stays for the classifier). Quote-aware, like the
 * segmenter it stands in for: a separator inside `'…'` or `"…"` is text (review of #203 —
 * `echo "note: { {w,}get removed }"` is a string, not a group with synthesis in it).
 */
// `time` is NOT here: it is a TRANSPARENT_COMMAND_WRAPPER, and wrapper mode — every word of
// the segment, `time bash -c "…"` included — is the more thorough owner (review of #203).
const COMPOUND_KEYWORD = /^(?:if|then|else|elif|while|until|do|done|fi|esac|!)$/
/** A masked `$( … )` / backtick substitution: one token, no separators, so a joined tail stays joined. */
const SUBSTITUTION_MASK = '\u0001'
const SHELL_COMMENT_LINE = /^[ \t]*#/

/** bash's built-in TCP/UDP redirection devices — no legitimate use in this harness. */
const BASH_SOCKET_DEVICE_PATTERN = /\/dev\/(?:tcp|udp)\//i

/**
 * The segment's command word, resolved to the LITERAL value the shell would execute —
 * or the reason it cannot be, which decides the caller's move.
 *
 * ⚠ Literal resolution is load-bearing (PR #55 review, round 1): `"curl"`, `\curl` and
 * `cu"rl"` are all `curl` to bash but were unequal to it as raw text — and because a
 * balanced-quoted command is fully PARSEABLE, the coarse fallback never ran. Round 2 of
 * the same review found the second class: brace/glob SYNTHESIS (`{c,}url`), where the
 * raw scan is no net at all — see LiteralShellWordResult's doc for the split.
 */
type CommandWordResult =
  | { kind: 'word'; canonical: string }
  | { kind: 'escalate-to-raw-scan' }
  | { kind: 'deny-synthesis'; rawWord: string }

/**
 * Commands that transparently exec their argument vector as the next command — no code
 * interpretation, the wrapped command sits VERBATIM in later words (PR #55 review,
 * round 3: `timeout 30 curl …`, `env curl …`).
 *
 * A segment led by one of these gets WRAPPER MODE: every subsequent word receives the
 * command-word treatment, which also makes wrapper STACKING free (`nohup timeout 30 curl …` —
 * the scan reaches curl without modelling any wrapper's own options). `sh -c "curl …"` rides
 * the same list: unlike python/node, its payload is THIS grammar, and the quoted payload's
 * first token is checkable — assembled eval payloads remain interpreter non-coverage.
 *
 * ⚠ IT IS A LIST, and a list is escapable by the name that is not on it. The second block
 * below is the set #206 measured open on 2026-09-17: `script -qc 'curl …' /dev/null`,
 * `unshare -r curl …`, `setarch x86_64 curl …`, `runuser -u x -- curl …`,
 * `systemd-run --user curl …`, `parallel curl ::: …`, `busybox wget …`, `su`, `setpriv`
 * and `chroot` all reached the network with word 1 resolving to a benign name; `find`'s
 * `-exec` payload did too, and gets its own precise handling below. They are covered now;
 * the CLASS — "a program that execs its operands" — cannot be recognised from the text, so
 * the next unlisted one is open too. That residual is the honest statement, and
 * `network-egress.test.ts` pins it as a row rather than leaving it to a reader's optimism.
 */
/**
 * Shared with `environment-dump.ts`: the same wrappers move a dumping command past word 1.
 *
 * @group Guard predicates
 */
export const TRANSPARENT_COMMAND_WRAPPERS = new Set([
  'env',
  'timeout',
  'nohup',
  'nice',
  'ionice',
  'setsid',
  'stdbuf',
  'taskset',
  'chrt',
  'numactl',
  'flock',
  'watch',
  'xargs',
  'command',
  'exec',
  'eval',
  'time',
  'sudo',
  'doas',
  'strace',
  'ltrace',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  // #206, measured open on 2026-09-17: these exec their operands too, and each one
  // carried `curl`/`wget` to the network with word 1 resolving to a benign name.
  // (`find` is NOT here — see FIND_EXEC_PREDICATES below for why it needs the precise
  // shape instead of every-word scanning.)
  'script',
  'unshare',
  'setarch',
  'runuser',
  'su',
  'setpriv',
  'chroot',
  'systemd-run',
  'parallel',
  'busybox',
])

/**
 * Wrapper-word exemptions: `[` is the test builtin; `{}` is xargs's -I placeholder and
 * expands to NOTHING in bash (brace expansion needs a comma or range), so neither can
 * synthesize a name.
 */
const WRAPPER_WORD_EXEMPTIONS = new Set(['[', '{}'])

/**
 * `find`'s exec predicates and their terminators.
 *
 * `find` is NOT a transparent wrapper: its predicate list carries GLOBS as ordinary arguments
 * (`find . -name "*.ts"`), and giving every word the command-word treatment denied that as
 * synthesis — a false positive on one of the most common commands in this repo. The precise
 * shape instead: the words after an exec predicate, up to `;`/`+`, ARE a command line, and
 * nothing else on the line is. ⚠ Terminators are matched by LITERAL value, so `\;`, `';'` and
 * `";"` all count.
 *
 * @group Guard predicates
 */
export const FIND_COMMAND = 'find'
const FIND_EXEC_PREDICATES = new Set(['-exec', '-execdir', '-ok', '-okdir'])
/** @group Guard predicates */
export const EXEC_TERMINATORS = new Set([';', '+'])

/**
 * Every `find … -exec`/`-execdir`/`-ok` payload of a word list, as raw-word groups in order.
 *
 * Shared with `environment-dump.ts`, which asks the same question of the same words: pi's
 * `find` tool and a shell `find` both reach a program through this one construct, and a deny
 * that knew it for egress but not for the environment dump reported "no regression" for the
 * entire route (#206).
 *
 * @group Guard predicates
 */
export function findExecPayloads(words: readonly string[]): string[][] {
  const payloads: string[][] = []
  let current: string[] | undefined
  for (const word of words) {
    const resolved = literalShellWord(word)
    const value = resolved.kind === 'literal' ? resolved.value : word
    if (FIND_EXEC_PREDICATES.has(value)) {
      if (current !== undefined && current.length > 0) payloads.push(current)
      current = []
      continue
    }
    if (current === undefined) continue
    if (EXEC_TERMINATORS.has(value)) {
      if (current.length > 0) payloads.push(current)
      current = undefined
      continue
    }
    current.push(word)
  }
  if (current !== undefined && current.length > 0) payloads.push(current)
  return payloads
}

/**
 * A segment's leading compound keywords are not its command: `then cur[l] …` runs `cur[l]`.
 * The segmenter leaves keywords in place (it splits on separators, not on grammar), so the
 * classifier steps over them here — for the segmented path and the floor alike (#160 §1,
 * review of #203: the keyword form with bare glob synthesis segmented cleanly and only
 * `then` was ever inspected).
 */
function withoutLeadingCompoundKeywords(text: string): string {
  let rest = text.trim()
  for (;;) {
    const [head = ''] = rest.split(/[ \t]/, 1)
    if (!COMPOUND_KEYWORD.test(head)) return rest
    rest = rest.slice(head.length).trim()
  }
}

function commandWordOf(segmentText: string): CommandWordResult {
  const afterKeywords = withoutLeadingCompoundKeywords(segmentText)
  const withoutAssignments = (withoutLeadingEnvironmentAssignments(afterKeywords) ?? afterKeywords).trim()
  const resolved = literalShellWord(withoutAssignments)
  if (resolved.kind === 'word-synthesis') {
    // ⚠ The one legitimate synthesis character at command position: a word that IS
    // exactly `[` is the test builtin (`[ -f x ] && …`), everywhere in shell scripts.
    // Only the BARE bracket is exempt — `cur[l]` and `[foo` stay synthesis.
    const rawWord = withoutAssignments.split(/[ \t]/, 1)[0] ?? ''
    if (rawWord === '[') return { kind: 'word', canonical: '[' }
    return { kind: 'deny-synthesis', rawWord }
  }
  if (resolved.kind !== 'literal') return { kind: 'escalate-to-raw-scan' }
  if (resolved.value.length === 0) return { kind: 'word', canonical: '' }
  // `/usr/bin/curl` and `curl` are the same binary.
  return { kind: 'word', canonical: canonicalToolName(basename(resolved.value)) }
}

type WrappedWordFinding =
  | { kind: 'denied'; word: string; via: NetworkEgressMatch['via'] }
  | { kind: 'synthesis'; word: string }
  | { kind: 'unresolvable' }

/**
 * A word as the program it is handed to will read it: this shell's double quotes and their
 * escapes (`\"`, `\\`, `\$`, `` \` ``) gone, single-quoted text left quoted — its content is
 * literal to the child too — and every substitution left in place, unexpanded.
 */
function withoutOuterDoubleQuotes(word: string): string {
  let text = ''
  let inSingle = false
  let inDouble = false
  for (let characterIndex = 0; characterIndex < word.length; characterIndex += 1) {
    const character = word[characterIndex] ?? ''
    const next = word[characterIndex + 1] ?? ''
    if (inSingle) {
      inSingle = character !== "'"
      text += character
    } else if (character === "'" && !inDouble) {
      inSingle = true
      text += character
    } else if (character === '"') {
      inDouble = !inDouble
    } else if (inDouble && character === '\\' && '"\\$`'.includes(next)) {
      text += next
      characterIndex += 1
    } else {
      text += character
    }
  }
  return text
}

/**
 * ⚠ A wrapper operand that becomes the wrapped program at runtime (#524): `sh -c "$(printf cu)rl …"`,
 * `sudo $(printf cu)rl …`. The wrapped program — or the `-c` payload — is whatever the
 * substitution yields, so the floor that refuses `$(printf cu)rl …` at the top level reads the
 * operand as the child will: a substitution joined to text, or a `${…}`, at its command
 * position is refused by the construct's name. Like every word in wrapper mode, an operand
 * is treated as a possible command, since the wrapper's own options are not modelled.
 *
 * Two routes reach it. A segmented command hands the operand over as written (`text` is the
 * child's command line with its substitutions in place); the floor's own path hands it over
 * MASKED (`commandPositionFinding`), where a substitution is one mask character that would
 * otherwise read as a plain letter.
 */
function runtimeOperandFinding(
  text: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): NetworkEgressMatch | undefined {
  if (depth + 1 > MAX_SHELL_NESTING) {
    return { matched: `a shell nested more than ${MAX_SHELL_NESTING} deep`, via: 'unresolvable' }
  }
  return text.includes(SUBSTITUTION_MASK)
    ? commandPositionFinding(text, denied, deniedBinaries, depth + 1)
    : unscannableFloor(text, denied, deniedBinaries, depth + 1)
}

const asDenied = (match: NetworkEgressMatch): WrappedWordFinding => ({
  kind: 'denied',
  word: match.matched,
  via: match.via,
})

/**
 * One operand of a wrapper-led segment: denied, synthesised, only knowable at runtime, or
 * clean (undefined).
 *
 * ⚠ The resolved literal IS the command line the child shell will parse (#57): a `-c`
 * payload's outer quoting is gone, and whatever quoting it still carries is the child's to
 * resolve — `cu'r'l` inside `"…"` is `curl` to that child. So the whole guard runs on it, one
 * level down, rather than a whitespace split that sees the inner quotes as part of the name
 * (the hole every classifier in the #57 spike shared). A plain wrapper operand (`timeout 30
 * curl …` → `30`, `curl`) is a one-word command line to the same call, so this is the
 * round-3 word treatment too.
 */
function wrappedOperandFinding(
  rawWord: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): WrappedWordFinding | undefined {
  const resolved = literalShellWord(rawWord)
  if (resolved.kind === 'word-synthesis') return { kind: 'synthesis', word: rawWord }
  if (resolved.kind !== 'literal') {
    const floor = runtimeOperandFinding(withoutOuterDoubleQuotes(rawWord), denied, deniedBinaries, depth)
    return floor === undefined ? { kind: 'unresolvable' } : asDenied(floor)
  }
  if (EXEC_TERMINATORS.has(resolved.value)) return undefined
  if (resolved.value.includes(SUBSTITUTION_MASK)) {
    const floor = runtimeOperandFinding(resolved.value, denied, deniedBinaries, depth)
    if (floor !== undefined) return asDenied(floor)
  }
  const verdict = gateCommandLine(resolved.value, denied, deniedBinaries, depth + 1)
  if (verdict === 'escalate' || verdict === 'escalate-unparseable') return { kind: 'unresolvable' }
  return verdict === undefined ? undefined : asDenied(verdict)
}

/**
 * Scan every word of a wrapper-led segment with the command-word treatment. A word's
 * LITERAL value is checked by EVERY internal whitespace token — a quoted `-c`/`eval`
 * payload is a full shell script (`bash -c "echo hi && curl …"`), and checking only its
 * first token was PR #55 review round 4: the word resolved cleanly to the wrong token
 * and, having resolved, never escalated — the round-1 shape again, a clean-but-wrong
 * value silencing the fallback that would have caught it. All-token scanning is the
 * wrapper-mode philosophy applied inside the payload; each token is basename'd and
 * case-folded. `NAME=value` words (env's assignments) and the exempted `[`/`{}` are
 * skipped. A synthesis word reports as itself, for the caller to deny as it would at command
 * position; a word built at runtime is run through the same floor the top level uses
 * (`wrappedOperandFinding` → `runtimeOperandFinding`, #524), so the caller gets a denial or
 * `unresolvable` — never a word to re-check.
 */
function deniedWordInWrappedSegment(
  segmentText: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): WrappedWordFinding | undefined {
  const rawWords = shellWordsOf(segmentText)
  if (rawWords === null) return { kind: 'unresolvable' }
  let sawUnresolvable = false
  for (const rawWord of rawWords.slice(1)) {
    if (WRAPPER_WORD_EXEMPTIONS.has(rawWord)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rawWord)) continue
    const finding = wrappedOperandFinding(rawWord, denied, deniedBinaries, depth)
    if (finding?.kind === 'unresolvable') sawUnresolvable = true
    else if (finding !== undefined) return finding
  }
  return sawUnresolvable ? { kind: 'unresolvable' } : undefined
}

function rawScanFor(command: string, deniedBinaries: readonly string[]): string | undefined {
  for (const deniedBinary of deniedBinaries) {
    // All list entries are [word-ish] names, so \b is well-defined at both ends;
    // escape anything regex-special defensively rather than trusting the policy data.
    const escaped = deniedBinary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(command)) return deniedBinary
  }
  return undefined
}

/**
 * `find`'s exec payloads, each gated as the command line it is. Not wrapper mode: the
 * predicate list is full of globs that are ordinary arguments (`-name "*.ts"`), and the
 * payload's own first word is the program — so this is command-position gating at a known
 * offset instead of every-word gating at an unknown one. The payload is handed over as a
 * command LINE so a shell inside it (`-exec sh -c 'curl …' ;`) takes the same recursion a
 * shell anywhere else takes.
 */
function findExecFinding(
  segmentText: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): NetworkEgressMatch | 'escalate' | undefined {
  const words = shellWordsOf(segmentText)
  if (words === null) return 'escalate'
  let sawUnresolvable = false
  for (const payload of findExecPayloads(words.slice(1))) {
    const line = payload.join(' ')
    // The floor's path hands this segment over masked (#524): `-exec $(printf cu)rl {} ;`.
    const floor = line.includes(SUBSTITUTION_MASK)
      ? runtimeOperandFinding(line, denied, deniedBinaries, depth)
      : undefined
    if (floor !== undefined) return floor
    const verdict = gateCommandLine(line, denied, deniedBinaries, depth + 1)
    if (verdict === 'escalate' || verdict === 'escalate-unparseable') {
      sawUnresolvable = true
      continue
    }
    if (verdict !== undefined) {
      return { matched: verdict.matched, via: verdict.via === 'command-position' ? 'wrapped-command' : verdict.via }
    }
  }
  return sawUnresolvable ? 'escalate' : undefined
}

/**
 * Gate ONE parseable segment: a match to deny on, "escalate" when a word's value is only
 * knowable at runtime (the caller falls back to the whole-command raw scan), or undefined
 * to pass. WRAPPER MODE (round 3) lives here: when the command word is a transparent
 * process wrapper, the effective command sits past word 1 at an offset no wrapper-agnostic
 * scan can know (each wrapper has its own options/operands) — so EVERY subsequent word
 * gets the command-word treatment. ⚠ The accepted false positive, pinned in a test: a
 * denied NAME as a plain argument inside a wrapped segment denies (`timeout 30 grep curl
 * f`), where the unwrapped form passes — the friction self-remediates (drop the wrapper)
 * and errs toward safety.
 */
function gateSegment(
  segment: FlatShellCommandSegment,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): NetworkEgressMatch | 'escalate' | undefined {
  const commandWord = commandWordOf(segment.text)
  if (commandWord.kind === 'deny-synthesis') {
    return { matched: commandWord.rawWord, via: 'command-word-synthesis' }
  }
  if (commandWord.kind === 'escalate-to-raw-scan') return 'escalate'
  if (denied.has(commandWord.canonical)) {
    return { matched: commandWord.canonical, via: 'command-position' }
  }
  // A shell fed by a pipe runs the pipe (#57's heredoc twin, `curl … | bash` with the
  // fetch a step earlier): its program is data no scan of this command can see. The
  // same shell with `-c` names its program in the argument and takes wrapper mode; with a
  // script operand (`cat in | bash script.sh`) the pipe is the SCRIPT's stdin, not the program.
  if (
    STDIN_SHELLS.has(commandWord.canonical) &&
    segment.pipedStdin &&
    shellProgramIsStdin((shellWordsOf(segment.text) ?? []).slice(1))
  ) {
    return { matched: `${commandWord.canonical} reading its program from a pipe`, via: 'unresolvable' }
  }
  if (commandWord.canonical === FIND_COMMAND) {
    return findExecFinding(segment.text, denied, deniedBinaries, depth)
  }
  if (!TRANSPARENT_COMMAND_WRAPPERS.has(commandWord.canonical)) return undefined
  const wrapped = deniedWordInWrappedSegment(segment.text, denied, deniedBinaries, depth)
  if (wrapped === undefined) return undefined
  if (wrapped.kind === 'unresolvable') return 'escalate'
  if (wrapped.kind === 'synthesis') return { matched: wrapped.word, via: 'command-word-synthesis' }
  // A match inside a payload reports how the CHILD saw it (its own command position is
  // this level's wrapped command); the floor's own vocabulary passes through unchanged.
  return { matched: wrapped.word, via: wrapped.via === 'command-position' ? 'wrapped-command' : wrapped.via }
}

/** Redirect operators, with or without a descriptor, whose next word is a target and not an operand. */
const REDIRECT_OPERATOR = /^(?:\d*(?:<<<|<<-?|<>|>>|>|<)|&>>?|\d*>&\d*)$/
/** A redirect with its target attached (`>file`, `2>&1`, `<<EOF`, `<<<word`): one word, no operand. */
const ATTACHED_REDIRECT = /^(?:\d*(?:<<<|<<-?|<>|>>|>|<)|&>>?)\S+$/

/**
 * A shell whose words after its own name leave NO program: no `-c` (any spelling) naming
 * one, and no operand — a script path — once options and redirects are set aside. Such a
 * shell reads its program from stdin, and stdin is whatever the pipe or the heredoc feeds it.
 */
function shellProgramIsStdin(wordsAfterShell: readonly string[]): boolean {
  let skipNext = false
  for (const word of wordsAfterShell) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (SHELL_COMMAND_FLAG.test(word)) return false
    // The bare operator BEFORE the attached form: `<<<` alone would otherwise read as `<<`
    // with `<` attached, and the herestring's word as an operand.
    if (REDIRECT_OPERATOR.test(word)) {
      skipNext = true
      continue
    }
    if (word.startsWith('-') || ATTACHED_REDIRECT.test(word)) continue
    return false // an operand: the shell's program is this file
  }
  return true
}

/**
 * The precise path over one command line at one nesting depth: segments, each gated.
 * Returns the match; "escalate" when some word is only knowable at runtime (the caller runs
 * the floor, then the raw scan); "escalate-unparseable" when the segmenter refused the text
 * (the floor has ALREADY run on it here — the caller goes straight to the raw scan, PR #149
 * review); or undefined to pass.
 */
function gateCommandLine(
  command: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): NetworkEgressMatch | 'escalate' | 'escalate-unparseable' | undefined {
  if (depth > MAX_SHELL_NESTING) {
    return { matched: `a shell nested more than ${MAX_SHELL_NESTING} deep`, via: 'unresolvable' }
  }
  const segments = extractFlatShellCommandSegments(command)
  if (segments.length === 0) return unscannableFloor(command, denied, deniedBinaries, depth) ?? 'escalate-unparseable'
  // Two distinct unknowable-word escalations (PR #55 review, one round each), and they
  // must NOT share a path:
  // - runtime-expansion (`$C https://…`): the coarse scan of the WHOLE command may catch
  //   a sibling assignment (`C=curl; $C …`), so escalate to it. What it cannot see is a
  //   value set in an EARLIER tool call — stated non-coverage, with the interpreters.
  // - word-synthesis (`{c,}url`, `/usr/bin/cur[l]` — both execute curl, verified live):
  //   brace/pathname expansion assembles the name from pieces, so it never appears
  //   contiguously and the raw scan is STRUCTURALLY BLIND. Escalation is not a net here —
  //   deny outright. The false-positive cost is glob/brace AT COMMAND POSITION, which
  //   legitimate commands essentially never need (the bare `[` test builtin is exempted
  //   in commandWordOf).
  let hasUnresolvableCommandWord = false
  for (const segment of segments) {
    const verdict = gateSegment(segment, denied, deniedBinaries, depth)
    if (verdict === 'escalate') {
      hasUnresolvableCommandWord = true
      continue
    }
    if (verdict !== undefined) return verdict
  }
  return hasUnresolvableCommandWord ? 'escalate' : undefined
}

/**
 * THE FLOOR under the raw scan (#57 spike). The raw scan is a word-boundary regex over
 * text the shell has not resolved — exact for `$(curl …)`, blind to `$(cu'r'l …)`: the
 * same splice that hides a name from any single-pass scanner hides it here, and the
 * scan was the last net. So a substitution whose body carries quoting, escapes or
 * expansion characters is refused BY NAME OF THE CONSTRUCT rather than scanned and hoped
 * over — "rewrite without the substitution" is the friction the header promises. Same for
 * a shell taking a heredoc/herestring as its program: the body is data to this scan.
 *
 * ⚠ Heredoc bodies are DATA to the command that reads them (PR #149 review, two false
 * positives): `sh migrate.sh` as a line INSIDE a body written to `run.sh` is two words of
 * text, and `$(cu'r'l …)` inside a body under a QUOTED delimiter (`<<'EOF'`) is written
 * literally — bash expands nothing there. So the bodies are modelled: quoted ones leave
 * the substitution scan entirely, unquoted ones stay (bash DOES expand them), and only the
 * command lines decide whether a shell is what reads a body. `$(date)`, `"$(cat msg.txt)"`,
 * `cat <<EOF > file` with any body, `sh migrate.sh <<EOF` (the heredoc is the SCRIPT's
 * stdin): none of these trip it.
 */
function unscannableFloor(
  command: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): NetworkEgressMatch | undefined {
  const heredocs = heredocBodies(command)
  const expanded = withoutRanges(
    command,
    heredocs.filter((body) => body.quoted).map((body) => [body.start, body.end]),
  )
  for (const body of substitutionBodies(expanded)) {
    if (UNSCANNABLE_CHARACTERS.test(body)) {
      return { matched: 'a command substitution with quoting or expansion inside it', via: 'unresolvable' }
    }
  }
  const commandLines = withoutRanges(
    command,
    heredocs.map((body) => [body.start, body.end]),
  )
  // ⚠ Every command position on these lines meets the SAME classifier a segment's word
  // does (#160: the floor used to enumerate constructs — `${` after `;`/`&`/`|` — and a
  // synthesised word inside `( )`, `{ }` or after `then` walked past every rule built to
  // catch it). Refused by class, never by spelling: brace/glob/ANSI-C synthesis at command
  // position, a `${…}` at command position (`P=cur; ${P}l`), and a substitution JOINED to
  // text at command position (`$(echo cur)l` — bash word-splits it to `curl`). Arguments
  // are untouched: `echo "${HOME}/x"`, `echo $(date)` and `"$(cat msg.txt)"` stay allowed,
  // and a bare `$C` still escalates to the raw scan, which can see a sibling `C=curl`.
  const runnableLines = commandLines
    .split('\n')
    .filter((line) => !SHELL_COMMENT_LINE.test(line))
    .join('\n')
  // The stream check FIRST: a shell fed a heredoc/herestring is refused by that class — its
  // program is data — before any command position is classified, or the wrapper scan would
  // read the stream's text and report a name where the point is that no name can be trusted.
  if (/<</.test(commandLines) && shellFedByStream(commandLines)) {
    return { matched: 'a shell reading its program from a heredoc', via: 'unresolvable' }
  }
  return commandPositionFinding(runnableLines, denied, deniedBinaries, depth)
}

/**
 * Replace every `$( … )` and backtick pair with one mask character, so a substitution is a
 * single token to the splitter and anything bash would join to it stays joined to the mask.
 */
function maskSubstitutions(text: string): string {
  let masked = ''
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    if (text[characterIndex] === '$' && text[characterIndex + 1] === '(') {
      const close = closingParenAfter(text, characterIndex + 2)
      masked += SUBSTITUTION_MASK
      characterIndex = close
    } else if (text[characterIndex] === '`') {
      const close = text.indexOf('`', characterIndex + 1)
      masked += SUBSTITUTION_MASK
      characterIndex = close === -1 ? text.length : close
    } else {
      masked += text[characterIndex]
    }
  }
  return masked
}

/**
 * The first refusal at any command position of the (unsegmentable) command lines, or
 * undefined. Each piece between separators is a command position; leading compound
 * keywords and `NAME=value` assignments are stepped over; the word is then what
 * `commandWordOf` sees for a segment.
 */
/** Split at every unquoted command-position boundary; a backslash escapes the next character outside single quotes. */
function commandPositionPieces(text: string): string[] {
  const pieces: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  const isWordBoundary = (position: number): boolean =>
    position < 0 || position >= text.length || /\s/.test(text[position] ?? '')
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    const character = text[characterIndex] ?? ''
    if (!inSingle && character === '\\') {
      current += character + (text[characterIndex + 1] ?? '')
      characterIndex += 1
      continue
    }
    if (character === "'" && !inDouble) inSingle = !inSingle
    else if (character === '"' && !inSingle) inDouble = !inDouble
    if (inSingle || inDouble) {
      current += character
      continue
    }
    const standaloneBrace =
      (character === '{' || character === '}') &&
      isWordBoundary(characterIndex - 1) &&
      isWordBoundary(characterIndex + 1)
    const listSeparator = character === ';' || character === '&' || character === '|' || character === '\n'
    if (listSeparator || character === '(' || character === ')' || standaloneBrace) {
      pieces.push(current)
      current = ''
      continue
    }
    current += character
  }
  pieces.push(current)
  return pieces
}

/**
 * The first refusal at any command position of the (unsegmentable) command lines, or
 * undefined. Each piece between separators is a command position and is handed to
 * `gateSegment` — THE segment classifier, keywords and wrappers included — not to a copy of
 * its first step (review of #203, round 3: the floor checked one word, so `$(true); sudo
 * cur[l] …` shielded the synthesis behind the wrapper). Two floor-only checks come first,
 * because the segmenter never sees a masked substitution: a substitution alone as the
 * command word passes to the raw scan; one joined to text is refused. A piece the
 * classifier would escalate is left to the raw scan, as on the segmented path.
 */
function commandPositionFinding(
  commandLines: string,
  denied: Set<string>,
  deniedBinaries: readonly string[],
  depth: number,
): NetworkEgressMatch | undefined {
  for (const piece of commandPositionPieces(maskSubstitutions(commandLines))) {
    const rest = withoutLeadingCompoundKeywords(piece)
    if (rest.length === 0) continue
    const word = (withoutLeadingEnvironmentAssignments(rest) ?? rest).trim().split(/[ \t]/, 1)[0] ?? ''
    if (word.length === 0) continue
    if (word.includes(SUBSTITUTION_MASK)) {
      if (word !== SUBSTITUTION_MASK) {
        return { matched: 'a command substitution joined to text at command position', via: 'unresolvable' }
      }
      continue // a substitution alone as the command: its body meets the raw scan
    }
    if (word.startsWith('${')) return { matched: 'a parameter expansion at command position', via: 'unresolvable' }
    const verdict = gateSegment({ text: rest, pipedStdin: false }, denied, deniedBinaries, depth)
    if (verdict !== undefined && verdict !== 'escalate') return verdict
  }
  return undefined
}

interface HeredocBody {
  /** Offset of the body's first character — the line after the operator's line. */
  readonly start: number
  /** Offset just past the terminator line, or the end of the text when it never closes. */
  readonly end: number
  /** The delimiter was quoted or escaped: the body is literal, bash expands nothing in it. */
  readonly quoted: boolean
}

/** `<<` and `<<-` (not `<<<`), the optional quoting or escape, and the delimiter word. */
const HEREDOC_OPERATOR =
  /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z0-9_.-]+)|([A-Za-z_][A-Za-z0-9_.-]*))/g

/**
 * Every heredoc's body, in order. bash reads the bodies of a line's operators one after
 * another starting on the next line, each ending at the first line that is exactly its
 * delimiter (leading tabs allowed for `<<-`). Over-approximate on purpose: a body that never
 * closes runs to the end of the text.
 */
function heredocBodies(command: string): HeredocBody[] {
  const bodies: HeredocBody[] = []
  let cursor = 0
  for (const match of command.matchAll(HEREDOC_OPERATOR)) {
    const stripTabs = match[1] === '-'
    const delimiter = match[2] ?? match[3] ?? match[4] ?? match[5] ?? ''
    const quoted = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
    const operatorLineEnd = command.indexOf('\n', match.index ?? 0)
    if (operatorLineEnd === -1) break // no line after the operator: no body to read
    const start = Math.max(operatorLineEnd + 1, cursor)
    const end = heredocTerminatorEnd(command, start, delimiter, stripTabs)
    bodies.push({ start, end, quoted })
    cursor = end
  }
  return bodies
}

/** Just past the first line from `start` that is exactly `delimiter` — or the end of the text. */
function heredocTerminatorEnd(command: string, start: number, delimiter: string, stripTabs: boolean): number {
  let lineStart = start
  while (lineStart < command.length) {
    const lineEnd = command.indexOf('\n', lineStart)
    const line = command.slice(lineStart, lineEnd === -1 ? command.length : lineEnd)
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
      return lineEnd === -1 ? command.length : lineEnd + 1
    }
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }
  return command.length
}

/** The text with the `[start, end)` ranges cut out. */
function withoutRanges(text: string, ranges: readonly (readonly [number, number])[]): string {
  if (ranges.length === 0) return text
  const sorted = [...ranges].toSorted((left, right) => left[0] - right[0])
  let kept = ''
  let cursor = 0
  for (const [start, end] of sorted) {
    if (start > cursor) kept += text.slice(cursor, start)
    cursor = Math.max(cursor, end)
  }
  return kept + text.slice(cursor)
}

/** Where a `$(` opened at `start` closes, paren-balanced — or the end of the text when it never does. */
function closingParenAfter(command: string, start: number): number {
  let depth = 1
  let end = start
  while (end < command.length && depth > 0) {
    if (command[end] === '(') depth += 1
    else if (command[end] === ')') depth -= 1
    end += 1
  }
  return depth === 0 ? end - 1 : end
}

/** The inside of every `$( … )` and every backtick pair — over-approximate on purpose: an unclosed one runs to the end. */
function substitutionBodies(command: string): string[] {
  const bodies: string[] = []
  for (let characterIndex = 0; characterIndex < command.length; characterIndex += 1) {
    if (command[characterIndex] === '$' && command[characterIndex + 1] === '(') {
      const close = closingParenAfter(command, characterIndex + 2)
      bodies.push(command.slice(characterIndex + 2, close))
      characterIndex = close
    } else if (command[characterIndex] === '`') {
      const close = command.indexOf('`', characterIndex + 1)
      bodies.push(command.slice(characterIndex + 1, close === -1 ? command.length : close))
      characterIndex = close === -1 ? command.length : close
    }
  }
  return bodies
}

/**
 * Over the command LINES (heredoc bodies already cut out): a shell with no program of its
 * own, fed a stream — piped into, or carrying a `<<`/`<<<` redirect. Coarse split on
 * purpose: this runs only where the segmenter has already declined.
 */
function shellFedByStream(commandLines: string): boolean {
  for (const list of commandLines.split(/\|\||&&|;|\n/)) {
    const pipeline = list.split('|')
    for (const [position, piece] of pipeline.entries()) {
      // Quote-aware words where the text allows it (`bash <<< "two words"` is one operand),
      // whitespace otherwise — coarse is the mode here, and coarse errs toward the floor.
      const words =
        shellWordsOf(piece.trim()) ??
        piece
          .trim()
          .split(/\s+/)
          .filter((word) => word.length > 0)
      let head = 0
      while (head < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head] ?? '')) head += 1
      if (!STDIN_SHELLS.has(canonicalToolName(basename(words[head] ?? '')))) continue
      const rest = words.slice(head + 1)
      const fedByRedirect = rest.some((word) => /^\d*<<</.test(word) || /^\d*<<-?/.test(word))
      if ((position > 0 || fedByRedirect) && shellProgramIsStdin(rest)) return true
    }
  }
  return false
}

/**
 * The command with every QUOTED heredoc body cut out: the text bash runs as commands, for a scan
 * that reads words where the segmenter declined (#778). A body under a quoted delimiter is literal
 * data for the command that reads it (`cat > run.js << 'EOF'`), the model `unscannableFloor` already
 * holds (PR #149). ⚠ Unchanged when a shell reads a stream as its program (`bash << 'EOF'`): that
 * body IS commands. Unquoted bodies stay too: bash expands them.
 *
 * @group Guard predicates
 */
export function withoutLiteralHeredocBodies(command: string): string {
  const heredocs = heredocBodies(command)
  const literal = heredocs.filter((body) => body.quoted)
  if (literal.length === 0) return command
  const commandLines = withoutRanges(
    command,
    heredocs.map((body) => [body.start, body.end]),
  )
  if (/<</.test(commandLines) && shellFedByStream(commandLines)) return command
  return withoutRanges(
    command,
    literal.map((body) => [body.start, body.end]),
  )
}

/**
 * Find the first denied network egress in a shell command, or undefined when none match.
 * `coarse` forces the raw word-boundary scan (the PowerShell path).
 *
 * @group Guard predicates
 */
export function findDeniedNetworkEgress(
  command: string,
  deniedBinaries: readonly string[],
  options: { coarse?: boolean } = {},
): NetworkEgressMatch | undefined {
  if (BASH_SOCKET_DEVICE_PATTERN.test(command)) {
    return { matched: '/dev/tcp|/dev/udp', via: 'dev-socket' }
  }
  if (options.coarse !== true) {
    const denied = new Set(deniedBinaries.map((binary) => canonicalToolName(binary)))
    const verdict = gateCommandLine(command, denied, deniedBinaries, 0)
    if (verdict === 'escalate') {
      // A parseable command with an unresolvable word: the floor has not seen this text
      // yet (the unparseable path runs it itself); then coarse over the whole command.
      const floor = unscannableFloor(command, denied, deniedBinaries, 0)
      if (floor !== undefined) return floor
    } else if (verdict !== 'escalate-unparseable') {
      return verdict
    }
  }
  const rawMatch = rawScanFor(command, deniedBinaries)
  return rawMatch === undefined ? undefined : { matched: rawMatch, via: 'raw-scan' }
}
