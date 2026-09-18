import { readFileSync } from 'node:fs'
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

/** Every place one file breaks the rule: its path, then each code line, as `file:line`. */
function fileMatches(scan: CodeLineScan, path: string, repositoryRelative: string): string[] {
  const matches: string[] = []
  if (scan.pathMatches?.(repositoryRelative)) matches.push(repositoryRelative)
  for (const [lineIndex, line] of readFileSync(path, 'utf8').split('\n').entries()) {
    if (COMMENT_LINE.test(line)) continue
    if (scan.lineMatches(line)) matches.push(`${repositoryRelative}:${lineIndex + 1}`)
  }
  return matches
}
