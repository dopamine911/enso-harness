import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'

/**
 * What the source-tree gates share (#165, #162 workstream 6): the word-splitter, the sequence
 * matcher, the comment skip, over the one walker (`scripts/source-tree.ts`, #174). A gate is
 * these plus a rule and an allowlist; the third copy of the walker is where this file was
 * extracted from (`vendor-gate` had the word-splitter, `logging-gate` and `naming-gate` the
 * walker), and the fourth and fifth — the generators' — are where the walker left for.
 *
 * ⚠ Words, not substrings (PR #150 review): `readPiccPersistedMode` is `read | picc | persisted
 * | mode`, `PICC_PERMISSION_MODES` is `picc | permission | modes`, `.cc-safety-net` is `cc |
 * safety | net`. A `\b` boundary misses the `_` form, a both-sides lookaround misses the
 * camelCase one, and each let a live site through. `piccolo` and `pick` are not `picc`: a word
 * is the unit.
 *
 * `COMMENT_LINE` reads one line at a time, so a block comment whose continuation lines do not
 * lead with `*` is scanned as code. That direction is the safe one: a gate FAILS on prose
 * rather than passing a dependency, and the fix is the house comment style.
 */

export const REPOSITORY_ROOT: string = join(import.meta.dir, '..')
/** A line that is only a comment: `//`, a block opener, or a block's `*`-led body. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/** Whether a line is only a comment — prose, where a gate may name what it refuses. */
export function isCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line)
}

/**
 * Every source file under `directory`, absolute paths; `__tests__` only when asked for.
 * The shared walker matches every JS/TS flavour where this file's own regex matched `tsx?|mjs`
 * (#174): 0 of 196 files differed at the fold, and a `.js` added later is scanned by the
 * gates rather than invisible to them — the widening is the safe direction.
 */
export function sourceFiles(directory: string, includeTests = false): string[] {
  return filesUnder(directory, { skipDirectories: includeTests ? [] : ['__tests__'] })
}

/**
 * Every markdown page under `directory`, absolute paths — the docs' counterpart to
 * `sourceFiles`. Here rather than in one gate because two read it: `docs-gate.test.ts` for
 * fences and generated blocks, `prose-citation-gate.test.ts` for line citations, and a second
 * copy is how a page ends up scanned by one of them and not the other.
 */
export function markdownFiles(directory: string): string[] {
  const found: string[] = []
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) found.push(...markdownFiles(path))
    else if (dirent.name.endsWith('.md')) found.push(path)
  }
  return found
}

/**
 * Comments and string lexemes in one alternation, so a `//` inside a quoted string is not a
 * comment — the shape `gate-support.ts` uses for the same reason.
 *
 * ⚠ TEMPLATE LITERALS ARE LEXEMES TOO (PR #317 review). Leaving backticks out looks like a
 * false-negative — a name spelled `` `stop the run` `` simply not found — but the cost is on
 * the scanner, not the search: an unconsumed template literal hands its contents to the
 * alternation, so an apostrophe in one (`` `pi's answer` ``) opens a quote that closes on the
 * next unrelated one, and a `//` in one eats the rest of its line. Both invent literals, or
 * lose real ones, some distance away. Multi-line by design: a template literal is the one
 * string lexeme that spans lines.
 */
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g

/**
 * Every string literal a file DECLARES with a STATIC value, comments removed. Shared by
 * `e2e-selectors.test.ts` (#277) and `features-gate.test.ts` (#437): both ask whether the UI
 * still renders a name that something outside it depends on.
 *
 * ⚠ Comments first (PR #317 review). This side answers "does the composer render this name",
 * and a comment string is not markup: with prose in scope, renaming a rendered `aria-label`
 * while a comment still mentioned the old one kept the gate green — the exact drift the file
 * claims to catch, one side of it unheld.
 *
 * A template literal counts only when it interpolates nothing. One that does is not a name
 * this gate can compare: its rendered value is not in the source. That is a true negative —
 * the constant it would have to match is a plain literal in the spec, by the test below.
 */
export function quotedLiterals(source: string): string[] {
  const code = source.replace(COMMENT_OR_STRING, (lexeme) => (lexeme.startsWith('/') ? '' : lexeme))
  return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((literal) => !literal.includes('${'))
}

/** The words a line is made of, lower-cased, with `camelCase` and every separator split. */
export function wordsOf(line: string): string[] {
  const words: string[] = []
  for (const token of line.match(/[A-Za-z0-9]+/g) ?? []) {
    words.push(...(token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[0-9]+/g) ?? []).map((word) => word.toLowerCase()))
  }
  return words
}

/** Whether `words` contains `sequence` contiguously — `cc-safety-net` and `ccSafetyNet` alike. */
export function hasWordSequence(words: readonly string[], sequence: readonly string[]): boolean {
  return words.some((_word, start) => sequence.every((part, offset) => words[start + offset] === part))
}

export interface CodeLineScan {
  /** Repository roots to walk, relative. */
  readonly roots: readonly string[]
  /** Walk `__tests__` too. A dependency gate reads production code; a vocabulary gate reads all of it. */
  readonly includeTests?: boolean
  /** Repository-relative directory prefixes the rule does not apply under. */
  readonly exemptRoots?: readonly string[]
  /** Repository-relative files the rule does not apply to — the ratchet. */
  readonly allowed?: readonly string[]
  /** Whether a file's own repository-relative PATH breaks the rule (a retired word in a name). */
  readonly pathMatches?: (repositoryRelative: string) => boolean
  /** Whether one code line breaks the rule. Comment lines are never offered. */
  readonly lineMatches: (line: string) => boolean
}

/**
 * `file:line` (or `file` for a path match) for every code line the rule refuses — and
 * `file (allowlisted, matches nothing)` for every allowlisted file the rule no longer catches,
 * including one the walk never visits (renamed, deleted, or moved under an exempt root). The
 * allowlist is the leak inventory; a row for a leak that has left is inventory drift, and this
 * is how it leaves the list the same day the leak leaves the code (#162 workstream 4).
 */
export function codeOffenders(scan: CodeLineScan): string[] {
  const offenders: string[] = []
  const unvisited = new Set(scan.allowed ?? [])
  for (const root of scan.roots) {
    for (const path of sourceFiles(join(REPOSITORY_ROOT, root), scan.includeTests ?? false)) {
      const repositoryRelative = path.slice(REPOSITORY_ROOT.length + 1)
      if (scan.exemptRoots?.some((exempt) => repositoryRelative.startsWith(`${exempt}/`))) continue
      const matches = fileMatches(scan, path, repositoryRelative)
      if (unvisited.delete(repositoryRelative)) {
        if (matches.length === 0) offenders.push(`${repositoryRelative} (allowlisted, matches nothing)`)
      } else {
        offenders.push(...matches)
      }
    }
  }
  for (const missing of unvisited) offenders.push(`${missing} (allowlisted, matches nothing)`)
  return offenders
}

/** One code line: 1-based number and text, as the gates address it. */
export interface CodeLine {
  /** Repository-relative path of the file it came from. */
  readonly file: string
  /** 1-based, so `file:number` is what an editor jumps to. */
  readonly number: number
  readonly text: string
}

/** A file's code lines, comment-only lines dropped. The one read-and-split. */
function codeLinesOf(path: string, repositoryRelative: string): CodeLine[] {
  const lines: CodeLine[] = []
  for (const [lineIndex, text] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (COMMENT_LINE.test(text)) continue
    lines.push({ file: repositoryRelative, number: lineIndex + 1, text })
  }
  return lines
}

/**
 * Every code line under `roots`, for a gate that needs the LINES rather than a verdict —
 * `dependency-gate.test.ts` reads import specifiers out of them (#223). Same walk, same
 * comment skip as `codeOffenders`: a gate that scanned its own way would disagree with the
 * others about what a comment is, which is the duplication this file exists to prevent.
 */
export function codeLinesUnder(roots: readonly string[], includeTests = false): CodeLine[] {
  return roots.flatMap((root) =>
    sourceFiles(join(REPOSITORY_ROOT, root), includeTests).flatMap((path) =>
      codeLinesOf(path, path.slice(REPOSITORY_ROOT.length + 1)),
    ),
  )
}

/** Every place one file breaks the rule: its path, then each code line, as `file:line`. */
function fileMatches(scan: CodeLineScan, path: string, repositoryRelative: string): string[] {
  const matches: string[] = []
  if (scan.pathMatches?.(repositoryRelative)) matches.push(repositoryRelative)
  for (const line of codeLinesOf(path, repositoryRelative)) {
    if (scan.lineMatches(line.text)) matches.push(`${repositoryRelative}:${line.number}`)
  }
  return matches
}
