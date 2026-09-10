import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The gate may not be talked out of, one line at a time.
 *
 * ⚠ This is not a unit test — it is the enforcement of "fix the code, don't suppress the
 * rule" (#82). A suppression comment is a rule we chose to lose, sitting in a comment
 * nobody reviews again, and 11 of them had accumulated before anyone counted. Biome cannot
 * police this itself: `noTsIgnore` covers TypeScript's own ignore directive, `noCommentText`
 * is JSX text, and a GritQL plugin cannot match comments because they are trivia, not AST
 * nodes. So the check lives here, where `scripts/gate.ts` already runs it via `bun test`.
 *
 * The legitimate exceptions have somewhere better to live, and both are reviewable diffs:
 *   • a name fixed by an external contract → `is_external_contract_key` in
 *     `.biome/naming.grit`, which carries the receipt and stays key-only;
 *   • a function whose complexity is an external grammar's → a bounded per-file
 *     `maxAllowedComplexity` in `biome.jsonc`, pinned to today's exact score so the rule
 *     still fails when the function grows.
 *
 * There is deliberately NO allowlist here. Adding one would recreate the thing this test
 * exists to prevent, just with extra steps — if a case truly cannot be expressed in either
 * config above, that is a design conversation, not a comment.
 */

const repositoryRoot = join(import.meta.dir, '..')
const SCANNED_ROOTS = ['packages', 'scripts', 'test'] as const
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-types', 'coverage'])
/** Vendored upstream code — biome.jsonc excludes it from linting, so it has no rules to suppress. */
const VENDORED_DIRECTORIES = ['packages/web/src/components'] as const
const SOURCE_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs)$/

/**
 * Assembled rather than written literally, so this file can scan ITSELF without matching
 * its own explanation. A needle spelled out here would make the check permanently red, and
 * the usual fix for that — excluding this path — would leave the one file whose whole job
 * is banning suppressions as the one file allowed to contain them.
 */
const SUPPRESSION = new RegExp(`//\\s*${['biome', 'ignore'].join('-')}`)

function sourceFiles(directory: string): string[] {
  const found: string[] = []
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(dirent.name)) continue
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) found.push(...sourceFiles(path))
    else if (SOURCE_EXTENSION.test(dirent.name)) found.push(path)
  }
  return found
}

test('⚠ no lint rule is suppressed by a comment — fix the code or record it in biome.jsonc (#82)', () => {
  const offenders: string[] = []
  for (const root of SCANNED_ROOTS) {
    for (const path of sourceFiles(join(repositoryRoot, root))) {
      const repositoryRelative = path.slice(repositoryRoot.length + 1)
      if (VENDORED_DIRECTORIES.some((vendored) => repositoryRelative.startsWith(vendored))) continue
      const lines = readFileSync(path, 'utf8').split('\n')
      for (const [lineIndex, line] of lines.entries()) {
        // Named with a line number, not counted — a count cannot say where to look.
        if (SUPPRESSION.test(line)) offenders.push(`${repositoryRelative}:${lineIndex + 1}`)
      }
    }
  }
  expect(offenders).toEqual([])
})
