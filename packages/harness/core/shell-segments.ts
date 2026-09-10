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
 * library surface, and the guard needs the contract below to be stable under our tests.
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

/**
 * Split a bash command into flat command segments on `;`, `&&`, `||`, `|`, `&` and
 * newlines, preserving each segment's original text. Returns `[]` for syntax it cannot
 * scope — see the module header for why that emptiness is a feature.
 */
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
  const segments: FlatShellCommandSegment[] = []
  let segmentStart = 0
  let inSingle = false
  let inDouble = false
  let atWordStart = true
  let currentPiped = false

  const pushSegment = (end: number): boolean => {
    const segment = command.slice(segmentStart, end).trim()
    if (segment.length === 0) return false
    segments.push({ text: segment, pipedStdin: currentPiped })
    return true
  }

  for (let characterIndex = 0; characterIndex < command.length; characterIndex++) {
    const character = command[characterIndex]
    if (inSingle) {
      if (character === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (character === '\\') {
        if (characterIndex + 1 >= command.length) return []
        characterIndex++
        continue
      }
      if (character === '"') {
        inDouble = false
        continue
      }
      if (character === '`' || (character === '$' && command[characterIndex + 1] === '(')) return []
      continue
    }

    if (character === "'") {
      inSingle = true
      atWordStart = false
      continue
    }
    if (character === '"') {
      inDouble = true
      atWordStart = false
      continue
    }
    if (character === '\\') {
      if (characterIndex + 1 >= command.length) return []
      characterIndex++
      atWordStart = false
      continue
    }
    if (
      character === '`' ||
      character === '(' ||
      character === ')' ||
      (character === '$' && command[characterIndex + 1] === '(') ||
      (character === '$' && command[characterIndex + 1] === '{') ||
      (character === '<' && command[characterIndex + 1] === '<') ||
      ((character === '{' || character === '}') && atWordStart && isBraceGroupBoundary(command[characterIndex + 1]))
    ) {
      return []
    }
    if (character === '#' && atWordStart) {
      const pushed = pushSegment(characterIndex)
      const newline = command.indexOf('\n', characterIndex + 1)
      if (newline === -1) return segments
      characterIndex = newline
      segmentStart = newline + 1
      atWordStart = true
      // Preserve a pending pipe through a comment-only continuation.
      if (pushed) currentPiped = false
      continue
    }
    const isRedirectionOperatorCharacter = isRedirectionOperator(command, characterIndex, character)
    if (
      (character === '\n' || character === ';' || character === '|' || character === '&') &&
      !isRedirectionOperatorCharacter
    ) {
      const pushed = pushSegment(characterIndex)
      const doubled = (character === '|' || character === '&') && command[characterIndex + 1] === character
      const pipeStderr = character === '|' && command[characterIndex + 1] === '&'
      if (doubled || pipeStderr) characterIndex++
      // `|` and `|&` pipe into the next segment; other operators reset the state.
      if (pushed || character !== '\n') currentPiped = character === '|' && !doubled
      segmentStart = characterIndex + 1
      atWordStart = true
      continue
    }
    atWordStart = character === ' ' || character === '\t'
  }

  if (inSingle || inDouble) return []
  pushSegment(command.length)
  return segments
}

/** Finds the end of a shell word, respecting quotes and escapes; null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
  let inSingle = false
  let inDouble = false
  for (let characterIndex = start; characterIndex < command.length; characterIndex++) {
    const character = command[characterIndex]
    if (inSingle) {
      if (character === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (character === '\\') {
        if (characterIndex + 1 >= command.length) return null
        characterIndex++
        continue
      }
      if (character === '"') inDouble = false
      continue
    }
    if (character === "'") {
      inSingle = true
      continue
    }
    if (character === '"') {
      inDouble = true
      continue
    }
    if (character === '\\') {
      if (characterIndex + 1 >= command.length) return null
      characterIndex++
      continue
    }
    if (character === ' ' || character === '\t') return characterIndex
  }
  return inSingle || inDouble ? null : command.length
}

/**
 * Resolve the FIRST shell word of `text` to the literal value the shell would execute —
 * quote removal and backslash-escape resolution, exactly the transformations bash applies
 * before command lookup. `"curl"`, `\curl`, `cu"rl"` and `'cu'r'l'` all resolve to `curl`.
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

export function literalShellWord(text: string): LiteralShellWordResult {
  let literal = ''
  let inSingle = false
  let inDouble = false
  for (let characterIndex = 0; characterIndex < text.length; characterIndex++) {
    const character = text[characterIndex]
    if (inSingle) {
      if (character === "'") {
        inSingle = false
        continue
      }
      literal += character
      continue
    }
    if (inDouble) {
      if (character === '\\') {
        const next = text[characterIndex + 1]
        if (next === undefined) return { kind: 'malformed' }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          literal += next
          characterIndex++
          continue
        }
        literal += character
        continue
      }
      if (character === '"') {
        inDouble = false
        continue
      }
      if (character === '$' || character === '`') return { kind: 'runtime-expansion' }
      literal += character
      continue
    }
    if (character === "'") {
      inSingle = true
      continue
    }
    if (character === '"') {
      inDouble = true
      continue
    }
    if (character === '\\') {
      const next = text[characterIndex + 1]
      if (next === undefined) return { kind: 'malformed' }
      literal += next
      characterIndex++
      continue
    }
    if (character === '$' || character === '`') return { kind: 'runtime-expansion' }
    if (WORD_SYNTHESIS_CHARACTERS.has(character ?? '')) return { kind: 'word-synthesis' }
    if (character === ' ' || character === '\t') break
    literal += character
  }
  if (inSingle || inDouble) return { kind: 'malformed' }
  return { kind: 'literal', value: literal }
}

/**
 * Split `text` into its RAW shell words — quote-aware slices with quoting preserved —
 * or null when the syntax is incomplete. The wrapper-mode scan (network-egress.ts) maps
 * `literalShellWord` over these: a transparent process wrapper (`timeout 30 curl …`)
 * moves the effective command PAST word 1, so every word needs the command-word
 * treatment there (PR #55 review, round 3).
 */
export function shellWordsOf(text: string): string[] | null {
  const words: string[] = []
  let index = 0
  while (index < text.length) {
    while (text[index] === ' ' || text[index] === '\t') index++
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
 * `FOO=1 curl …` exposes `curl` at command position. Returns null when the input has no
 * leading assignment (caller keeps the original) or when the syntax is incomplete.
 */
export function withoutLeadingEnvironmentAssignments(command: string): string | null {
  let index = 0
  let foundAssignment = false
  while (index < command.length) {
    while (command[index] === ' ' || command[index] === '\t') index++
    const assignmentStart = index
    if (!/[A-Za-z_]/.test(command[index] ?? '')) break
    let nameEnd = index + 1
    while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? '')) nameEnd++
    if (command[nameEnd] !== '=') {
      return foundAssignment ? command.slice(assignmentStart).trimStart() : null
    }
    const wordEnd = skipShellWord(command, nameEnd + 1)
    if (wordEnd === null) return null
    foundAssignment = true
    index = wordEnd
    if (index === command.length) return null
  }
  if (!foundAssignment) return null
  const commandWithoutAssignments = command.slice(index).trimStart()
  return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null
}
