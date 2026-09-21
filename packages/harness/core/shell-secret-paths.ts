import { looksLikeSecret, resolveAgainstCwd, textLooksLikeSecretPath } from './paths.ts'
import { extractFlatShellCommandSegments, literalShellWord, shellWordsOf } from './shell-segments.ts'

/**
 * The bash/powershell secret-path deny (#204) — the read gate's own policy, on the shell route.
 *
 * The reader gate in the guards extension refuses a credential path for every tool that
 * carries one (`read`, `grep`, `find`, `ls`). `bash` carries a COMMAND, so it never reached
 * that gate: the guard's three shell denies are about destruction (cc-safety-net), egress
 * (#9) and environment listing (#89), and none of them resolves a path. Measured before
 * this module existed, with the real handler and the real analyzer: `read .zen/secrets.env`
 * was refused while `cat .zen/secrets.env`, `cat .zen/pi-agent/auth.json` and
 * `cat ~/.aws/credentials` were all ALLOWED — the same bytes, one tool over.
 *
 * So this deny is not a second corpus. It resolves each word of the command the way the
 * reader gate resolves a path argument and asks `looksLikeSecret` the same question with
 * the same `policy.secretPathFragments`. ONE policy, both routes.
 *
 * ⚠ It gates WORDS, not reads: a word that merely NAMES a credential path is refused even
 * where the command would not open it (`grep -rn '\.zen/secrets\.env' packages/` is denied;
 * so is `git log -- .zen/secrets.env`). That is the deliberate direction. The gate cannot
 * know which operand a program will open, and over-refusing a mention fails safe and says
 * so, while under-refusing hands over a key. `shell-secret-paths.test.ts` pins both
 * directions, the false positives included, so the cost stays visible rather than becoming
 * a surprise.
 *
 * STATED NON-COVERAGE — a bar, not a boundary, exactly like the egress deny:
 *   - A name assembled at runtime that the word's own text does not contain:
 *     `D=$(printf '.z%sn' e); ln -s $D n; cat n/pi-agent/auth.json`, `cat .z*n/sec*`,
 *     `cat $ZEN_DIR/pi-agent/auth.json`. A word whose value is not knowable from the text
 *     (expansion, brace/glob synthesis, malformed quoting) falls back to a scan of that
 *     word's raw TEXT with quoting removed, which catches `"$HOME/.zen/secrets.env"`,
 *     `ln -s "$PWD/.zen" n` and `.zen/$KEY` — and nothing spelled indirectly.
 *   - A `NAME=value` word keeps its prefix, so a path inside an ASSIGNMENT resolves to
 *     `<cwd>/NAME=.zen/…` and matches no directory fragment. Deliberate: stripping it
 *     would refuse `ZEN_LOGS_DIR=.zen/logs bun run dev`, which reads nothing. (The
 *     basename pass still catches an assignment ending in a credential basename.)
 *   - A `-c` payload is not re-parsed one level down the way `network-egress.ts` re-parses
 *     a wrapper's argument vector: `bash -c 'cat .zen/secrets.env'` is caught because that
 *     one quoted word's literal value contains the fragment, not because the payload was
 *     analysed as a command. A payload that assembles the name is outside this deny.
 *   - Interpreters: `bun -e 'await Bun.file(".zen/secrets.env").text()'` — the path is a
 *     word of the `-e` payload, so the scan does see this one, but a program that builds
 *     the name from pieces at runtime is outside any text scan. `network-egress.ts` states
 *     the same interpreter non-coverage for the same reason.
 *   - Anything already read: this deny is about disclosure at the shell, not about what a
 *     session that has the bytes then does with them.
 */

/** How the deny matched — carried into the block reason so a denial is explainable. */
export interface SecretPathMatch {
  /** The offending word, as written in the command. */
  matched: string
  /**
   * `resolved` — the word's literal value, resolved against the session cwd, matched the
   * read policy (the reader gate's own question). `text` — the value was not knowable from
   * the text (expansion, synthesis, malformed quoting), and the raw word carried a
   * credential fragment or basename anyway.
   */
  via: 'resolved' | 'text'
}

/**
 * A redirection operator, wherever it sits in a word: `<file`, `2>file`, `&>file` — and
 * `cat<file`, which is the same syntax with the space the shell never required. The word
 * splitter breaks on whitespace only, so a fused operator left `cat<.zen/pi-agent/auth.json`
 * as ONE word that resolved to `<cwd>/cat<.zen/…` and carried the `/.zen/` fragment past the
 * match (PR #288 review). The operator is a word boundary here for the same reason it is one
 * to the shell: what follows it is a path.
 */
const REDIRECT_OPERATOR = /\d*(?:<<<|<<-?|<>|>>|>|<)|&>>?/g
/** `--file=PATH`, `-o=PATH`: the option name is not the path, the value after `=` is. */
const FLAG_VALUE_PREFIX = /^--?[A-Za-z0-9][-A-Za-z0-9_]*=/
/** Coarse split: whitespace and the shell/PowerShell operators that can abut a path. */
const COARSE_WORD_BOUNDARY = /[\s;|&()]+/
/** PowerShell (and Git-Bash-typed) separators, so a text scan sees `.zen\secrets.env` as a path. */
const BACKSLASH_SEPARATOR = /\\/g
/**
 * Quote characters, removed for the TEXT pass. Without this, quoting splices the fragment
 * out of reach at the END of a word: `ln -s "$PWD/.zen" n` leaves `"` between `.zen` and
 * the separator the fragment pass appends, so `/.zen/` did not match and the link — whose
 * target does not exist yet, so there is no realpath to follow — carried the whole dir into
 * a name the next segment could read. Quotes are not part of any path the shell opens.
 */
const QUOTE_CHARACTERS = /['"]/g

/**
 * The path candidates one word carries: the word cut at every redirection operator, each
 * piece with a fused option name (`--file=PATH`, `-o=PATH`) removed — the option name is not
 * the path, the value after `=` is.
 */
function pathCandidatesOf(word: string): string[] {
  const candidates: string[] = []
  for (const piece of word.split(REDIRECT_OPERATOR)) {
    const candidate = piece.replace(FLAG_VALUE_PREFIX, '')
    if (candidate.length > 0) candidates.push(candidate)
  }
  return candidates
}

/**
 * A candidate as TEXT, made comparable to a resolved path: quoting removed, PowerShell
 * separators folded, and a LEADING separator added — a directory fragment carries one
 * (`/.zen/`), and a relative mention (`.zen/$KEY`) has nothing before its first segment, so
 * without this the fragment pass would see `.zen/...` and match nothing while
 * `<cwd>/.zen/...` matches.
 */
function textCandidateOf(candidate: string): string {
  const folded = candidate.replace(BACKSLASH_SEPARATOR, '/').replace(QUOTE_CHARACTERS, '')
  return folded.startsWith('/') ? folded : `/${folded}`
}

/**
 * Judge ONE word. A word whose literal value is knowable gets the reader gate's exact
 * question; a word whose value is not gets a scan of its own text, which is where
 * `"$HOME/.zen/secrets.env"` and `.zen/$KEY` are caught.
 */
function wordFinding(word: string, fragments: readonly string[], cwd: string): SecretPathMatch | undefined {
  for (const candidate of pathCandidatesOf(word)) {
    const literal = literalShellWord(candidate)
    if (literal.kind !== 'literal') {
      if (textLooksLikeSecretPath(textCandidateOf(candidate), fragments)) return { matched: word, via: 'text' }
      continue
    }
    if (literal.value.length === 0) continue
    if (looksLikeSecret(resolveAgainstCwd(literal.value, cwd), fragments)) return { matched: word, via: 'resolved' }
  }
  return undefined
}

/**
 * The coarse pass: every whitespace/operator-delimited token, judged by TEXT only.
 * PowerShell always takes this (the segmenter speaks POSIX, not PS), and so does a POSIX
 * command the segmenter declined — the same escalation the other two shell denies make.
 */
function coarseFinding(command: string, fragments: readonly string[]): SecretPathMatch | undefined {
  for (const token of command.split(COARSE_WORD_BOUNDARY)) {
    for (const candidate of pathCandidatesOf(token)) {
      if (textLooksLikeSecretPath(textCandidateOf(candidate), fragments)) return { matched: token, via: 'text' }
    }
  }
  return undefined
}

/**
 * Find the first word of a shell command that names credential material, or undefined when
 * none does. `coarse` forces the text pass (the PowerShell path).
 */
export function findSecretPathWord(
  command: string,
  fragments: readonly string[],
  cwd: string,
  options: { coarse?: boolean } = {},
): SecretPathMatch | undefined {
  if (options.coarse === true) return coarseFinding(command, fragments)
  const segments = extractFlatShellCommandSegments(command)
  if (segments.length === 0) return coarseFinding(command, fragments)
  for (const segment of segments) {
    const words = shellWordsOf(segment.text)
    if (words === null) {
      const finding = coarseFinding(segment.text, fragments)
      if (finding !== undefined) return finding
      continue
    }
    for (const word of words) {
      const finding = wordFinding(word, fragments, cwd)
      if (finding !== undefined) return finding
    }
  }
  return undefined
}
