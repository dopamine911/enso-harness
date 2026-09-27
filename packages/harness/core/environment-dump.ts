import { basename } from 'node:path'
import { PROC_ENVIRON_IN_COMMAND } from '@enso/core'
import { isSecretShapedName } from '@enso/core/secrets'
import { EXEC_TERMINATORS, FIND_COMMAND, findExecPayloads, TRANSPARENT_COMMAND_WRAPPERS } from './network-egress.ts'
import {
  extractFlatShellCommandSegments,
  literalShellWord,
  shellWordsOf,
  withoutLeadingEnvironmentAssignments,
} from './shell-segments.ts'

/**
 * The bash environment-dump deny (#89) — DEPTH, not the fix.
 *
 * The fix is `quarantineSecrets` in `@enso/core`: secrets are deleted from the process
 * environment before any session or child exists, so an environment listing shows none.
 * This deny exists so that a REGRESSION there is loud rather than silent — a `bash env`
 * that would have printed a key is refused with a reason naming #89, instead of quietly
 * succeeding and putting the value in a transcript again.
 *
 * What it gates, per parseable segment, at command position (leading assignments
 * stripped, the word resolved to its literal, path prefix ignored):
 * - `env` / `printenv` with nothing to run or print — `env FOO=1 cmd` runs cmd and passes;
 *   `printenv PATH` passes; `printenv <secret-shaped name>` does not.
 * - `export` / `declare` / `typeset` in their listing forms (bare, `-p`, `-x`), and bare
 *   `set`. `export FOO=1`, `set -e`, `set -o pipefail` pass — they set, they do not list.
 * - the same command past a transparent wrapper (`timeout 5 env`, `sudo printenv`), and the
 *   payload of a `find -exec` (#206) — a payload is a command line, so it is gated as one.
 * And anywhere in the raw string, regardless of parse:
 * - `/proc/<pid>/environ` — the kernel's copy of the same list.
 * - a `$NAME` / `${NAME…}` expansion of a secret-shaped name (`echo $TAVILY_API_KEY`).
 * - PowerShell's `$env:<secret-shaped>` and `Get-ChildItem env:` family.
 * An UNPARSEABLE command (substitution, heredoc — where evasion lives) takes a coarse
 * word-boundary scan for `env` / `printenv`, the egress module's stance: friction toward
 * "rewrite without the substitution", not a broken gate.
 *
 * ⚠ Stated non-coverage, same as the egress deny's interpreters: `node -e
 * "console.log(process.env)"`, `python -c "import os; print(os.environ)"`. Chasing the
 * interpreters would read as coverage and not be coverage; the quarantine is what makes
 * them harmless.
 *
 * @group Guard predicates
 */
export interface EnvironmentDumpMatch {
  /** The command word, variable name, or path that matched. */
  matched: string
  via: 'command-position' | 'wrapped-command' | 'proc-environ' | 'secret-expansion' | 'powershell' | 'raw-scan'
}

const LISTING_COMMANDS = new Set(['env', 'printenv', 'export', 'declare', 'typeset', 'set'])
/** `export -p`, `declare -p`, `declare -x`, `typeset -p`: the listing options; anything else is an assignment or a flag that does not list. */
const LISTING_OPTIONS = new Set(['-p', '-x', '-px', '-xp'])

const SHELL_EXPANSION_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g
const POWERSHELL_ENV_VARIABLE_PATTERN = /\$env:([A-Za-z_][A-Za-z0-9_]*)/gi
const POWERSHELL_ENV_LISTING_PATTERN = /\b(?:get-childitem|gci|ls|dir|get-item|gi)\s+env:/i
/** Not `$env` and not `env:` — PowerShell's variable and drive syntax, gated by the two patterns above instead. */
const COARSE_LISTING_PATTERN = /(?<!\$)\b(env|printenv)\b(?!:)/i

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

/** Does this listing command, with these argument words, LIST rather than set/run? */
function listsEnvironment(command: string, argumentWords: readonly string[]): EnvironmentDumpMatch | undefined {
  const literal = (word: string): string | undefined => {
    const resolved = literalShellWord(word)
    return resolved.kind === 'literal' ? resolved.value : undefined
  }
  switch (command) {
    case 'env': {
      // Options and assignments do not run anything; a remaining word is a command to run.
      // ⚠ `find -exec env ;` — the terminator is find's operand, not a command for env to
      // run, and counting it as one made the dump tripwire report "nothing" for the whole
      // `-exec` route (#206). Matched by LITERAL value, so `\;`, `';'` and `";"` all count.
      const operands = argumentWords.filter(
        (word) => !(word.startsWith('-') || isAssignment(word) || EXEC_TERMINATORS.has(literal(word) ?? word)),
      )
      return operands.length === 0 ? { matched: 'env', via: 'command-position' } : undefined
    }
    case 'printenv': {
      const names = argumentWords.filter((word) => !word.startsWith('-'))
      if (names.length === 0) return { matched: 'printenv', via: 'command-position' }
      const secret = names
        .map(literal)
        .find((variableName) => variableName !== undefined && isSecretShapedName(variableName))
      return secret === undefined ? undefined : { matched: secret, via: 'secret-expansion' }
    }
    case 'set':
      return argumentWords.length === 0 ? { matched: 'set', via: 'command-position' } : undefined
    default: {
      // export / declare / typeset: bare or with only listing options.
      const lists = argumentWords.every((word) => LISTING_OPTIONS.has(word))
      return lists ? { matched: command, via: 'command-position' } : undefined
    }
  }
}

/** The literal, path-stripped, case-folded command word — or undefined when it is not knowable from the text. */
function commandNameOf(word: string): string | undefined {
  const resolved = literalShellWord(word)
  if (resolved.kind !== 'literal') return undefined
  return basename(resolved.value).toLowerCase()
}

function gateSegment(segmentText: string): EnvironmentDumpMatch | undefined {
  const stripped = (withoutLeadingEnvironmentAssignments(segmentText) ?? segmentText).trim()
  const words = shellWordsOf(stripped)
  if (words === null || words.length === 0) return undefined
  return gateWords(words)
}

/**
 * One command line, as words: a listing command, a `find` whose exec payload IS one, or a
 * wrapper with one behind it.
 *
 * ⚠ A payload is a command line, so it goes back through THIS function rather than having
 * its first word looked up (PR #290 review). Checking `payload[0]` alone let the sensor miss
 * what it catches everywhere else — `find . -exec sh -c 'env' ;` and `find . -exec sudo env ;`
 * read as "sh" and "sudo", neither a listing command, while the same two lines without the
 * `find` are caught by the wrapper scan below. The egress deny already recursed its payload
 * through `gateCommandLine`; this is the same shape, so both denies know the construct
 * equally instead of only claiming to. Recursion terminates: a payload is strictly shorter
 * than the words it came from.
 */
function gateWords(words: readonly string[]): EnvironmentDumpMatch | undefined {
  const command = commandNameOf(words[0] ?? '')
  if (command === undefined) return undefined
  if (LISTING_COMMANDS.has(command)) return listsEnvironment(command, words.slice(1))
  // `find … -exec env ;` reaches a listing command at a KNOWN offset, and the tripwire has
  // to know the one construct pi's own `find` tool and a shell `find` share (#206). Not
  // wrapper mode: find's predicates carry globs that are ordinary arguments.
  if (command === FIND_COMMAND) {
    for (const payload of findExecPayloads(words.slice(1))) {
      const verdict = gateWords(payload)
      if (verdict !== undefined) return { matched: verdict.matched, via: 'wrapped-command' }
    }
    return undefined
  }
  if (!TRANSPARENT_COMMAND_WRAPPERS.has(command)) return undefined
  // Past a wrapper the effective command sits at an unknown offset (each wrapper has its
  // own options), so any later word that IS a listing command is treated as one — the
  // accepted false positive the egress deny also takes.
  // ⚠ STATED RESIDUAL (#206): the reverse shape, a wrapper whose OWN operand follows the
  // wrapped command (`script -qc env /dev/null`), reads as "env runs /dev/null" and passes.
  // Counting those words as find's would deny `sudo env FOO=1 make build`, which lists
  // nothing — so the tripwire takes the miss rather than the false positive, and says so.
  for (const [position, word] of words.slice(1).entries()) {
    const wrapped = commandNameOf(word)
    if (wrapped === undefined || !LISTING_COMMANDS.has(wrapped)) continue
    const verdict = listsEnvironment(wrapped, words.slice(position + 2))
    if (verdict !== undefined) return { matched: verdict.matched, via: 'wrapped-command' }
  }
  return undefined
}

function rawScan(command: string, coarse: boolean): EnvironmentDumpMatch | undefined {
  const procMatch = PROC_ENVIRON_IN_COMMAND.exec(command)
  if (procMatch !== null) return { matched: procMatch[0], via: 'proc-environ' }
  for (const expansion of command.matchAll(SHELL_EXPANSION_PATTERN)) {
    const name = expansion[1] ?? ''
    if (isSecretShapedName(name)) return { matched: `$${name}`, via: 'secret-expansion' }
  }
  for (const expansion of command.matchAll(POWERSHELL_ENV_VARIABLE_PATTERN)) {
    const name = expansion[1] ?? ''
    if (isSecretShapedName(name)) return { matched: `$env:${name}`, via: 'powershell' }
  }
  const listing = POWERSHELL_ENV_LISTING_PATTERN.exec(command)
  if (listing !== null) return { matched: listing[0], via: 'powershell' }
  if (!coarse) return undefined
  const coarseMatch = COARSE_LISTING_PATTERN.exec(command)
  return coarseMatch === null ? undefined : { matched: coarseMatch[1] ?? coarseMatch[0], via: 'raw-scan' }
}

/**
 * Find the first environment dump in a shell command, or undefined when none.
 *
 * `coarse` forces the raw scan (the PowerShell path); a POSIX command the segmenter cannot
 * parse takes it too.
 *
 * @group Guard predicates
 */
export function findEnvironmentDump(
  command: string,
  options: { coarse?: boolean } = {},
): EnvironmentDumpMatch | undefined {
  let coarse = options.coarse === true
  if (!coarse) {
    const segments = extractFlatShellCommandSegments(command)
    if (segments.length === 0) coarse = true
    for (const segment of segments) {
      const verdict = gateSegment(segment.text)
      if (verdict !== undefined) return verdict
    }
  }
  return rawScan(command, coarse)
}
