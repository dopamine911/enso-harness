/**
 * Conservative shell command segmenter — the parsing floor under the bash network deny (#9).
 *
 * Vendored from oh-my-pi `packages/coding-agent/src/tools/shell-tokenize.ts` (
 * `extractFlatShellCommandSegments`) and `tools/bash-interceptor.ts` (the leading
 * env-assignment stripper), MIT:
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 *   Copyright (c) 2026 Stencil Labs, Inc.
 * Vendored as a COPY rather than a dependency: oh-my-pi does not publish these as a
 * library surface, and the guard needs the contract below to be stable under our tests. The
 * scanners here are restructured as per-quote-state steps (#814), every decision unchanged.
 *
 * ⚠ THE `[]` CONTRACT IS THE LOAD-BEARING PART. The extractor deliberately returns NO
 * segments when the command contains syntax whose execution context this small scanner
 * cannot scope — command substitution `$(…)`, backticks, heredocs, `${…}`, brace groups,
 * unterminated quotes. For the network deny, an empty result means "fall back to the
 * coarse whole-string scan", which fails toward safety. A "better" version that returned
 * partial segments for those inputs would silently open the substitution door — do not
 * improve it in that direction. (Its own test file pins this contract.)
 */

/** A flat shell command segment with the context needed to gate it. */
export interface FlatShellCommandSegment {
  /** Original segment text with quoting and escaping preserved. */
  text: string
  /** True when this segment consumes the previous stage's stdout via `|` or `|&`. */
  pipedStdin: boolean
}

/**
 * The quoting a scanner stands in — bash's three lexical contexts for a character. Every scanner
 * here, and `network-egress.ts`'s command-position splitter, is a small state machine over it
 * (#814).
 */
export type Quote = 'none' | 'single' | 'double'

/** The quote state after `character`: an opening quote opens, its own closer closes, anything else leaves it. */
export function quoteAfter(quote: Quote, character: string | undefined): Quote {
  if (quote === 'single') return character === "'" ? 'none' : 'single'
  if (quote === 'double') return character === '"' ? 'none' : 'double'
  if (character === "'") return 'single'
  return character === '"' ? 'double' : 'none'
}

/** A `{`/`}` at word start followed by whitespace/`;`/end is a brace GROUP, not a filename. */
function isBraceGroupBoundary(nextCharacter: string | undefined): boolean {
  return nextCharacter === undefined || /[ \t\n;]/.test(nextCharacter)
}

/** `>|`, `>&`, `<&`, `&>` are redirections, not segment operators — vendored logic, un-nested. */
function isRedirectionOperator(command: string, characterIndex: number, character: string | undefined): boolean {
  if (character === '|') return command[characterIndex - 1] === '>'
  if (character === '&') {
    return (
      command[characterIndex - 1] === '>' || command[characterIndex - 1] === '<' || command[characterIndex + 1] === '>'
    )
  }
  return false
}

/** The segmenter's position, its quote state, and the segment it is building. */
interface SegmentScan {
  readonly command: string
  readonly segments: FlatShellCommandSegment[]
  /** The character being read; a step that consumes more characters leaves it on the last one. */
  index: number
  segmentStart: number
  quote: Quote
  /** The next character starts a word, where `#` opens a comment and `{`/`}` a brace group. */
  atWordStart: boolean
  /** The segment being built reads the previous one's stdout (`|`, `|&`). */
  piped: boolean
}

/** What one step decided: read on, stop with the segments so far (a comment runs to the end), or decline the whole command. */
type SegmentStep = 'next' | 'done' | 'decline'

/** End the segment being built at `end`; false when it holds only blanks, and nothing is pushed. */
function pushSegment(scan: SegmentScan, end: number): boolean {
  const segment = scan.command.slice(scan.segmentStart, end).trim()
  if (segment.length === 0) return false
  scan.segments.push({ text: segment, pipedStdin: scan.piped })
  return true
}

/** A backslash consumes the character after it; one with nothing after it is incomplete syntax. */
function skipEscapedCharacter(scan: SegmentScan): SegmentStep {
  if (scan.index + 1 >= scan.command.length) return 'decline'
  scan.index++
  return 'next'
}

/**
 * ⚠ The syntax whose execution context this scanner cannot scope, met outside quotes: a
 * substitution, a subshell, `${…}`, a heredoc, a brace group. Each declines the whole command
 * (the module header's `[]` contract, #814).
 */
function opensUnscopedSyntax(command: string, index: number, atWordStart: boolean): boolean {
  const next = command[index + 1]
  switch (command[index]) {
    case '`':
    case '(':
    case ')':
      return true
    case '$':
      return next === '(' || next === '{'
    case '<':
      return next === '<'
    case '{':
    case '}':
      return atWordStart && isBraceGroupBoundary(next)
    default:
      return false
  }
}

/** `#` at a word start comments out the rest of its line: the segment ends before it and the scan resumes on the next line. */
function skipComment(scan: SegmentScan): SegmentStep {
  const pushed = pushSegment(scan, scan.index)
  const newline = scan.command.indexOf('\n', scan.index + 1)
  if (newline === -1) return 'done'
  scan.index = newline
  scan.segmentStart = newline + 1
  scan.atWordStart = true
  // Preserve a pending pipe through a comment-only continuation.
  if (pushed) scan.piped = false
  return 'next'
}

function isSegmentOperator(command: string, index: number): boolean {
  const character = command[index]
  return (
    (character === '\n' || character === ';' || character === '|' || character === '&') &&
    !isRedirectionOperator(command, index, character)
  )
}

/** End the segment at the operator under the scan, consuming a doubled `||`/`&&` or a `|&` whole. */
function splitSegment(scan: SegmentScan): void {
  const character = scan.command[scan.index]
  const next = scan.command[scan.index + 1]
  const pushed = pushSegment(scan, scan.index)
  const doubled = (character === '|' || character === '&') && next === character
  const pipeStderr = character === '|' && next === '&'
  if (doubled || pipeStderr) scan.index++
  // `|` and `|&` pipe into the next segment; other operators reset the state.
  if (pushed || character !== '\n') scan.piped = character === '|' && !doubled
  scan.segmentStart = scan.index + 1
  scan.atWordStart = true
}

function singleQuotedSegmentStep(scan: SegmentScan): SegmentStep {
  scan.quote = quoteAfter('single', scan.command[scan.index])
  return 'next'
}

/** Inside double quotes a substitution still runs, so a backtick or `$(` declines here too. */
function doubleQuotedSegmentStep(scan: SegmentScan): SegmentStep {
  const { command, index } = scan
  const character = command[index]
  if (character === '\\') return skipEscapedCharacter(scan)
  if (character === '"') scan.quote = 'none'
  else if (character === '`' || (character === '$' && command[index + 1] === '(')) return 'decline'
  return 'next'
}

function unquotedSegmentStep(scan: SegmentScan): SegmentStep {
  const { command, index } = scan
  const character = command[index]
  if (character === '\\') {
    scan.atWordStart = false
    return skipEscapedCharacter(scan)
  }
  if (character === "'" || character === '"') {
    scan.atWordStart = false
    scan.quote = quoteAfter('none', character)
    return 'next'
  }
  if (opensUnscopedSyntax(command, index, scan.atWordStart)) return 'decline'
  if (character === '#' && scan.atWordStart) return skipComment(scan)
  if (isSegmentOperator(command, index)) splitSegment(scan)
  else scan.atWordStart = character === ' ' || character === '\t'
  return 'next'
}

const SEGMENT_STEP: Readonly<Record<Quote, (scan: SegmentScan) => SegmentStep>> = {
  none: unquotedSegmentStep,
  single: singleQuotedSegmentStep,
  double: doubleQuotedSegmentStep,
}

/**
 * Split a bash command into flat command segments on `;`, `&&`, `||`, `|`, `&` and
 * newlines, preserving each segment's original text.
 *
 * Returns `[]` for syntax it cannot scope — see the module header for why that emptiness is a
 * feature.
 */
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
  const scan: SegmentScan = {
    command,
    segments: [],
    index: 0,
    segmentStart: 0,
    quote: 'none',
    atWordStart: true,
    piped: false,
  }
  for (; scan.index < command.length; scan.index++) {
    const step = SEGMENT_STEP[scan.quote](scan)
    if (step === 'decline') return []
    if (step === 'done') return scan.segments
  }
  // An unterminated quote is incomplete syntax.
  if (scan.quote !== 'none') return []
  pushSegment(scan, command.length)
  return scan.segments
}

/** Finds the end of a shell word, respecting quotes and escapes; null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
  let quote: Quote = 'none'
  for (let characterIndex = start; characterIndex < command.length; characterIndex++) {
    const character = command[characterIndex]
    if (character === '\\' && quote !== 'single') {
      if (characterIndex + 1 >= command.length) return null
      characterIndex++
    } else if (quote === 'none' && (character === ' ' || character === '\t')) {
      return characterIndex
    } else {
      quote = quoteAfter(quote, character)
    }
  }
  return quote === 'none' ? command.length : null
}

/**
 * Resolve the FIRST shell word of `text` to the literal value the shell would execute —
 * quote removal and backslash-escape resolution, exactly the transformations bash applies
 * before command lookup.
 *
 * `"curl"`, `\curl`, `cu"rl"` and `'cu'r'l'` all resolve to `curl`.
 *
 * Three ways the value can be unknowable, and they are NOT interchangeable for a caller
 * gating on the result (both found on PR #55 review, one round each):
 *
 *   `runtime-expansion`  an unquoted (or double-quoted) `$` or backtick — expansion
 *                        decides the value at runtime. A coarse scan of the raw string
 *                        MAY still catch a sibling assignment (`C=curl; $C …`), so the
 *                        right escalation is the whole-command raw scan.
 *   `word-synthesis`     an UNQUOTED brace or glob character (`{ } * ? [`) — bash's
 *                        brace/pathname expansion can assemble a denied name from pieces
 *                        (`{c,}url` executes curl; `/usr/bin/cur[l]` too — both verified
 *                        live), and the raw scan is STRUCTURALLY BLIND to them: the name
 *                        never appears contiguously in the unexpanded text. Escalating to
 *                        the raw scan is therefore not a safety net; a gate must refuse
 *                        outright. Quoted braces/globs are literal characters and flow
 *                        into `literal` (a quoted "cur[l]" expands to nothing — verified:
 *                        command not found).
 *   `malformed`          incomplete syntax (trailing backslash, unterminated quote) —
 *                        the shell would not accept the input as written.
 *
 * ⚠ The one legitimate `[` at command position is the test builtin — the word that IS
 * exactly `[`. The CALLER owns that exception; this function reports what it saw.
 */
export type LiteralShellWordResult =
  | { kind: 'literal'; value: string }
  | { kind: 'runtime-expansion' }
  | { kind: 'word-synthesis' }
  | { kind: 'malformed' }

const WORD_SYNTHESIS_CHARACTERS = new Set(['{', '}', '*', '?', '['])
/** The characters a backslash escapes inside double quotes; before any other it stays a backslash. */
const DOUBLE_QUOTED_ESCAPES = new Set(['"', '\\', '$', '`'])

/** `literalShellWord`'s position, quote state and the value resolved so far. */
interface LiteralRead {
  readonly text: string
  /** The character being read; a step that consumes more characters leaves it on the last one. */
  index: number
  quote: Quote
  literal: string
}

/** What one step decided: read on, the word ended at a blank, or the word's result. */
type LiteralStep = 'next' | 'end' | LiteralShellWordResult

/** A backslash outside single quotes: `\x` is `x`, except inside double quotes before a character it does not escape. */
function literalEscape(read: LiteralRead): LiteralStep {
  const next = read.text[read.index + 1]
  if (next === undefined) return { kind: 'malformed' }
  if (read.quote === 'double' && !DOUBLE_QUOTED_ESCAPES.has(next)) {
    read.literal += '\\'
    return 'next'
  }
  read.literal += next
  read.index++
  return 'next'
}

function literalSingleQuotedStep(read: LiteralRead): LiteralStep {
  const character = read.text[read.index]
  if (character === "'") read.quote = 'none'
  else read.literal += character
  return 'next'
}

function literalDoubleQuotedStep(read: LiteralRead): LiteralStep {
  const character = read.text[read.index]
  if (character === '\\') return literalEscape(read)
  if (character === '"') read.quote = 'none'
  else if (character === '$' || character === '`') return { kind: 'runtime-expansion' }
  else read.literal += character
  return 'next'
}

function literalUnquotedStep(read: LiteralRead): LiteralStep {
  const character = read.text[read.index]
  switch (character) {
    case "'":
    case '"':
      read.quote = quoteAfter('none', character)
      return 'next'
    case '\\':
      return literalEscape(read)
    case ' ':
    case '\t':
      return 'end'
    case '$':
      // ⚠ `$'…'` is ANSI-C quoting, not an expansion: bash decodes the escapes and the word
      // becomes a name that never appears in the text — `$'\143url'` IS `curl`, verified
      // live. That is the SYNTHESIS class, not the expansion class: escalating to a scan of
      // the unexpanded text is no net at all, because the scan cannot see a name spelled in
      // octal. Same verdict as `{c,}url` and for the same reason (the two were missed when
      // that round landed). `$"…"` keeps escalating: its content stays contiguous.
      return read.text[read.index + 1] === "'" ? { kind: 'word-synthesis' } : { kind: 'runtime-expansion' }
    case '`':
      return { kind: 'runtime-expansion' }
    default:
      if (WORD_SYNTHESIS_CHARACTERS.has(character ?? '')) return { kind: 'word-synthesis' }
      read.literal += character
      return 'next'
  }
}

const LITERAL_STEP: Readonly<Record<Quote, (read: LiteralRead) => LiteralStep>> = {
  none: literalUnquotedStep,
  single: literalSingleQuotedStep,
  double: literalDoubleQuotedStep,
}

/** The first shell word of `text` as the shell would execute it — `LiteralShellWordResult` above states the outcomes. */
export function literalShellWord(text: string): LiteralShellWordResult {
  const read: LiteralRead = { text, index: 0, quote: 'none', literal: '' }
  for (; read.index < text.length; read.index++) {
    const step = LITERAL_STEP[read.quote](read)
    if (step === 'end') break
    if (step !== 'next') return step
  }
  if (read.quote !== 'none') return { kind: 'malformed' }
  return { kind: 'literal', value: read.literal }
}

/** Just past the blanks (spaces and tabs) from `start`. */
function afterBlanks(text: string, start: number): number {
  let index = start
  while (text[index] === ' ' || text[index] === '\t') index++
  return index
}

/**
 * Split `text` into its RAW shell words — quote-aware slices with quoting preserved —
 * or null when the syntax is incomplete.
 *
 * The wrapper-mode scan (network-egress.ts) maps `literalShellWord` over these: a transparent
 * process wrapper (`timeout 30 curl …`) moves the effective command PAST word 1, so every word
 * needs the command-word treatment there (PR #55 review, round 3).
 */
export function shellWordsOf(text: string): string[] | null {
  const words: string[] = []
  let index = 0
  while (index < text.length) {
    index = afterBlanks(text, index)
    if (index >= text.length) break
    const wordEnd = skipShellWord(text, index)
    if (wordEnd === null) return null
    words.push(text.slice(index, wordEnd))
    index = wordEnd
  }
  return words
}

/**
 * Remove leading `NAME=value` assignments without interpreting shell syntax, so
 * `FOO=1 curl …` exposes `curl` at command position.
 *
 * Returns null when the input has no leading assignment (caller keeps the original) or when the
 * syntax is incomplete.
 */
export function withoutLeadingEnvironmentAssignments(command: string): string | null {
  let index = 0
  let foundAssignment = false
  while (index < command.length) {
    index = afterBlanks(command, index)
    const nameEnd = shellNameEnd(command, index)
    if (nameEnd === undefined) break
    if (command[nameEnd] !== '=') return foundAssignment ? command.slice(index).trimStart() : null
    const wordEnd = skipShellWord(command, nameEnd + 1)
    // An incomplete value, or assignments with no command after them, expose nothing.
    if (wordEnd === null || wordEnd === command.length) return null
    foundAssignment = true
    index = wordEnd
  }
  if (!foundAssignment) return null
  const commandWithoutAssignments = command.slice(index).trimStart()
  return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null
}

/** Just past the shell NAME (`[A-Za-z_][A-Za-z0-9_]*`) starting at `start`, or undefined when none starts there. */
function shellNameEnd(command: string, start: number): number | undefined {
  if (!/[A-Za-z_]/.test(command[start] ?? '')) return undefined
  let nameEnd = start + 1
  while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? '')) nameEnd++
  return nameEnd
}
