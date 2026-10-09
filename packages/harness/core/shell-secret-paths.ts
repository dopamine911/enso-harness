import { isAbsolute } from 'node:path'
import { looksLikeSecret, realpathOfNearestExisting, resolveAgainstCwd, wordTextLooksLikeSecret } from './paths.ts'
import { extractFlatShellCommandSegments, literalShellWord, shellWordsOf } from './shell-segments.ts'

/**
 * The bash/powershell secret-path deny (#204) — the read gate's own policy, on the shell route.
 *
 * The reader gate in the guards extension refuses a credential path for every tool that
 * carries one (`read`, `grep`, `find`, `ls`). `bash` carries a COMMAND, so it never reached
 * that gate: the guard's three shell denies are about destruction (cc-safety-net), egress
 * (#9) and environment listing (#89), and none of them resolves a path. Measured before
 * this module existed, with the real handler and the real analyzer: `read .enso/secrets.env`
 * was refused while `cat .enso/secrets.env`, `cat .enso/pi-agent/auth.json` and
 * `cat ~/.aws/credentials` were all ALLOWED — the same bytes, one tool over.
 *
 * So this deny is not a second corpus. It resolves each word of the command the way the
 * reader gate resolves a path argument and asks `looksLikeSecret` the same question with
 * the same `policy.secretPathFragments`. ONE policy, both routes.
 *
 * ⚠ It gates WORDS, not reads: a word that merely NAMES a credential path is refused even
 * where the command would not open it (`grep -rn '\.enso/secrets\.env' packages/` is denied;
 * so is `git log -- .enso/secrets.env`). That is the deliberate direction. The gate cannot
 * know which operand a program will open, and over-refusing a mention fails safe and says
 * so, while under-refusing hands over a key. `shell-secret-paths.test.ts` pins both
 * directions, the false positives included, so the cost stays visible rather than becoming
 * a surprise.
 *
 * STATED NON-COVERAGE — a bar, not a boundary, exactly like the egress deny:
 *   - A name assembled at runtime that the word's own text does not contain:
 *     `D=$(printf '.z%sn' e); ln -s $D n; cat n/pi-agent/auth.json`, `cat .z*n/sec*`,
 *     `cat $ENSO_DIR/pi-agent/auth.json`. A word whose value is not knowable from the text
 *     (expansion, brace/glob synthesis, malformed quoting) falls back to a scan of that
 *     word's raw TEXT with quoting removed, which catches `"$HOME/.enso/secrets.env"`,
 *     `ln -s "$PWD/.enso" n` and `.enso/$KEY` — and nothing spelled indirectly.
 *   - A `NAME=value` word keeps its prefix, so a path inside an ASSIGNMENT resolves to
 *     `<cwd>/NAME=.enso/…` and matches no directory fragment. Deliberate: stripping it
 *     would refuse `ENSO_HOME=.enso bun run dev`, which reads nothing. (The
 *     basename pass still catches an assignment ending in a credential basename.)
 *   - A `-c` payload is not re-parsed one level down the way `network-egress.ts` re-parses
 *     a wrapper's argument vector: `bash -c 'cat .enso/secrets.env'` is caught because that
 *     one quoted word's literal value contains the fragment, not because the payload was
 *     analysed as a command. A payload that assembles the name is outside this deny.
 *   - Interpreters: `bun -e 'await Bun.file(".enso/secrets.env").text()'` — the path is a
 *     word of the `-e` payload, so the scan does see this one, but a program that builds
 *     the name from pieces at runtime is outside any text scan. `network-egress.ts` states
 *     the same interpreter non-coverage for the same reason.
 *   - Anything already read: this deny is about disclosure at the shell, not about what a
 *     session that has the bytes then does with them.
 */

/**
 * How the deny matched — carried into the block reason so a denial is explainable.
 *
 * @group Guard predicates
 */
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
 * splitter breaks on whitespace only, so a fused operator left `cat<.enso/pi-agent/auth.json`
 * as ONE word that resolved to `<cwd>/cat<.enso/…` and carried the `/.enso/` fragment past the
 * match. The operator is a word boundary here for the same reason it is one
 * to the shell: what follows it is a path.
 */
const REDIRECT_OPERATOR = /\d*(?:<<<|<<-?|<>|>>|>|<)|&>>?/g
/** `--file=PATH`, `-o=PATH`: the option name is not the path, the value after `=` is. */
const FLAG_VALUE_PREFIX = /^--?[A-Za-z0-9][-A-Za-z0-9_]*=/
/** Coarse split: whitespace and the shell/PowerShell operators that can abut a path. */
const COARSE_WORD_BOUNDARY = /[\s;|&()]+/
/** PowerShell (and Git-Bash-typed) separators, so a text scan sees `.enso\secrets.env` as a path. */
const BACKSLASH_SEPARATOR = /\\/g
/**
 * Quote characters, removed for the TEXT pass. Without this, quoting splices the fragment
 * out of reach at the END of a word: `ln -s "$PWD/.enso" n` leaves `"` between `.enso` and
 * the separator the fragment pass appends, so `/.enso/` did not match and the link — whose
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
 * (`/.enso/`), and a relative mention (`.enso/$KEY`) has nothing before its first segment, so
 * without this the fragment pass would see `.enso/...` and match nothing while
 * `<cwd>/.enso/...` matches.
 */
function textCandidateOf(candidate: string): string {
  const folded = candidate.replace(BACKSLASH_SEPARATOR, '/').replace(QUOTE_CHARACTERS, '')
  return folded.startsWith('/') ? folded : `/${folded}`
}

/**
 * What a walk asks of each path candidate: of a resolved literal path, and of a word's raw text
 * when its value is not knowable. The credential question is the reader gate's (`looksLikeSecret`);
 * the records question (#466) asks only whether the path is inside a directory — never a basename,
 * so `cat .env` is not a record.
 */
interface PathQuestion {
  readonly resolved: (absolutePath: string) => boolean
  readonly text: (text: string) => boolean
}

/**
 * Judge ONE word. A word whose literal value is knowable gets the reader gate's exact
 * question; a word whose value is not gets a scan of its own text, which is where
 * `"$HOME/.enso/secrets.env"` and `.enso/$KEY` are caught.
 */
function wordFinding(word: string, question: PathQuestion, cwd: string): SecretPathMatch | undefined {
  for (const candidate of pathCandidatesOf(word)) {
    const literal = literalShellWord(candidate)
    if (literal.kind !== 'literal') {
      if (question.text(textCandidateOf(candidate))) return { matched: word, via: 'text' }
      continue
    }
    if (literal.value.length === 0) continue
    if (question.resolved(resolveAgainstCwd(literal.value, cwd))) return { matched: word, via: 'resolved' }
  }
  return undefined
}

/**
 * The coarse pass: every whitespace/operator-delimited token, judged by TEXT only.
 * PowerShell always takes this (the segmenter speaks POSIX, not PS), and so does a POSIX
 * command the segmenter declined — the same escalation the other two shell denies make.
 */
function coarseFinding(command: string, question: PathQuestion): SecretPathMatch | undefined {
  for (const token of command.split(COARSE_WORD_BOUNDARY)) {
    for (const candidate of pathCandidatesOf(token)) {
      if (question.text(textCandidateOf(candidate))) return { matched: token, via: 'text' }
    }
  }
  return undefined
}

/** The first word of a shell command the question matches, walking segments then words. */
function findPathWord(
  command: string,
  question: PathQuestion,
  cwd: string,
  options: { coarse?: boolean },
): SecretPathMatch | undefined {
  if (options.coarse === true) return coarseFinding(command, question)
  const segments = extractFlatShellCommandSegments(command)
  if (segments.length === 0) return coarseFinding(command, question)
  for (const segment of segments) {
    const words = shellWordsOf(segment.text)
    if (words === null) {
      const finding = coarseFinding(segment.text, question)
      if (finding !== undefined) return finding
      continue
    }
    for (const word of words) {
      const finding = wordFinding(word, question, cwd)
      if (finding !== undefined) return finding
    }
  }
  return undefined
}

/**
 * Find the first word of a shell command that names credential material, or undefined when
 * none does. `coarse` forces the text pass (the PowerShell path). `ownTree` is the session's own
 * thread tree (#615): a word that resolves inside it is judged relative to it, as the reader gate
 * judges it — without it every word of a command run in a tree under `ENSO_HOME` (`bun`, `test`,
 * `src/a.ts`) resolved under `/.enso/` and refused the command.
 *
 * @group Guard predicates
 */
export function findSecretPathWord(
  command: string,
  fragments: readonly string[],
  cwd: string,
  options: { coarse?: boolean; ownTree?: string | undefined } = {},
): SecretPathMatch | undefined {
  const question: PathQuestion = {
    resolved: (absolutePath) => looksLikeSecret(absolutePath, fragments, options.ownTree),
    text: (text) => wordTextLooksLikeSecret(text, fragments, options.ownTree),
  }
  return findPathWord(command, question, cwd, options)
}

/**
 * Find the first word of a shell command naming a path inside one of `directories` (absolute), or
 * undefined — the records deny's question (#466): the session and log directories an incident
 * rests on. A literal word is judged as resolved against the cwd AND through the realpath of its
 * nearest existing ancestor, so a symlink into the directory is caught (either is enough: this is
 * a deny, not a confinement). A word whose value is not knowable is judged by its text, which
 * sees an absolute spelling and nothing assembled at runtime (`$ENSO_HOME/logs` passes — the
 * module header's non-coverage). ⚠ A directory that is not absolute is skipped (#530): pi's
 * in-memory session answers its directory as `""`, which would become the prefix `/` and match
 * every path.
 *
 * @group Guard predicates
 */
export function findDirectoryWord(
  command: string,
  directories: readonly string[],
  cwd: string,
  options: { coarse?: boolean } = {},
): SecretPathMatch | undefined {
  const prefixes = directories
    .filter((directory) => isAbsolute(directory))
    .map((directory) => `${directory.replace(/\/+$/, '').toLowerCase()}/`)
  const inside = (path: string): boolean => {
    const lowered = `${path.toLowerCase()}/`
    return prefixes.some((prefix) => lowered.startsWith(prefix))
  }
  const question: PathQuestion = {
    resolved: (absolutePath) => inside(absolutePath) || inside(realpathOfNearestExisting(absolutePath)),
    text: inside,
  }
  return findPathWord(command, question, cwd, options)
}
