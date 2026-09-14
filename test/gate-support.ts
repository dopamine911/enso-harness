import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the source-tree gates share (#165, #162 workstream 6): the walker, the word-splitter,
 * the sequence matcher, the comment skip. A gate is one of these plus a rule and an allowlist;
 * the third copy of the walker is where this file was extracted from (`vendor-gate` had the
 * word-splitter, `logging-gate` and `naming-gate` the walker).
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
const SKIPPED_DIRECTORIES = ['node_modules', 'dist', 'dist-types', 'coverage'] as const
const SOURCE_EXTENSION = /\.(?:tsx?|mjs)$/
/** A line that is only a comment: `//`, a block opener, or a block's `*`-led body. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/** Every source file under `directory`, absolute paths; `__tests__` only when asked for. */
function sourceFiles(directory: string, includeTests = false): string[] {
  const found: string[] = []
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    if ((SKIPPED_DIRECTORIES as readonly string[]).includes(dirent.name)) continue
    if (!includeTests && dirent.name === '__tests__') continue
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) found.push(...sourceFiles(path, includeTests))
    else if (SOURCE_EXTENSION.test(dirent.name)) found.push(path)
  }
  return found
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

/** `file:line` (or `file` for a path match) for every code line the rule refuses. */
export function codeOffenders(scan: CodeLineScan): string[] {
  const offenders: string[] = []
  for (const root of scan.roots) {
    for (const path of sourceFiles(join(REPOSITORY_ROOT, root), scan.includeTests ?? false)) {
      const repositoryRelative = path.slice(REPOSITORY_ROOT.length + 1)
      if (scan.exemptRoots?.some((exempt) => repositoryRelative.startsWith(`${exempt}/`))) continue
      if (scan.allowed?.includes(repositoryRelative)) continue
      if (scan.pathMatches?.(repositoryRelative)) offenders.push(repositoryRelative)
      for (const [lineIndex, line] of readFileSync(path, 'utf8').split('\n').entries()) {
        if (COMMENT_LINE.test(line)) continue
        if (scan.lineMatches(line)) offenders.push(`${repositoryRelative}:${lineIndex + 1}`)
      }
    }
  }
  return offenders
}
