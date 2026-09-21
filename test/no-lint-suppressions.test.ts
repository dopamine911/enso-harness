import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The gate may not be talked out of, one line at a time.
 *
 * ⚠ This is not a unit test — it is the enforcement of "fix the code, don't suppress the
 * rule" (#82). A suppression comment is a rule we chose to lose, sitting in a comment
 * nobody reviews again, and 11 of them had accumulated before anyone counted. Biome cannot
 * police this itself: `noTsIgnore` covers one of TypeScript's four directives, `noCommentText`
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

const SCANNED_ROOTS = ['packages', 'scripts', 'test'] as const
/** Vendored upstream code — biome.jsonc excludes it from linting, so it has no rules to suppress. */
const VENDORED_DIRECTORIES = ['packages/web/src/components'] as const

/**
 * Matched by CLASS, never by a list of spellings (#249). One entry per checker `bun run check`
 * runs, and each entry is the PREFIX every member of that checker's suppression family shares,
 * so a member nobody has written yet is caught without this list being edited:
 *   • the linter's pragma, whose family adds the `-all`, `-start` and `-end` suffixes;
 *   • the dead-code analyser's pragma, whose family adds `-file` and `-next-line` — zero in the
 *     tree today, and `bunx fallow suppressions` is the inventory that says so;
 *   • the type checker's `@ts` directives, which suppress what the linter never sees: its
 *     ignore, expect-error and nocheck members each REMOVE a diagnostic, and its check member
 *     is the only one that ADDS one, so that member is the single exclusion. Anything else
 *     under the prefix reads as a suppression, which is the safe direction for this gate.
 *
 * Matched ANYWHERE in a line, NOT after a line-comment opener. The `//` anchor this replaces
 * saw line comments only: measured 2026-09-17 through this repo's Biome config, the block and
 * JSDoc forms of the same pragma both suppress the rule and exit 0, so the one gate whose
 * point is "may not be talked out of" was evaded by changing two characters. A list of
 * spellings is escapable the same way — by writing the next one. A class is not.
 *
 * Assembled rather than written literally, so this file can scan ITSELF without matching its
 * own explanation. A needle spelled out here would make the check permanently red, and the
 * usual fix for that — excluding this path — would leave the one file whose whole job is
 * banning suppressions as the one file allowed to contain them.
 */
const SUPPRESSION = new RegExp(
  [['biome', 'ignore'].join('-'), ['fallow', 'ignore'].join('-'), `${['@ts', ''].join('-')}(?!check\\b)`].join('|'),
)

test('⚠ no lint rule is suppressed by a comment — fix the code or record it in biome.jsonc (#82)', () => {
  const offenders: string[] = []
  for (const root of SCANNED_ROOTS) {
    for (const path of filesUnder(join(REPOSITORY_ROOT, root))) {
      const repositoryRelative = path.slice(REPOSITORY_ROOT.length + 1)
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

/** The three families, assembled the same way the matcher is, so the probes below scan clean. */
const LINT_PRAGMA = ['biome', 'ignore'].join('-')
const DEAD_CODE_PRAGMA = ['fallow', 'ignore'].join('-')
const TYPE_DIRECTIVE = ['@ts', ''].join('-')

/**
 * The matcher's own boundary. The scan above is only as good as what it RECOGNISES, and the
 * hole #249 found was in the recognition, not the walk — the tree was clean under a needle
 * that could not see half the syntax. Every probe here is a suppression that works today in
 * one of the three tools; the last two of them are spellings nobody has written, and they must
 * already be red, because that is the difference between matching a class and matching a list.
 *
 * ⚠ A red line here means the matcher stopped covering one of these classes. The probe is not
 * the thing to fix.
 */
test('⚠ every suppression CLASS is matched in every comment form, unwritten spellings included (#249)', () => {
  const suppressing = [
    `// ${LINT_PRAGMA} lint/suspicious/noExplicitAny: probe`,
    `/* ${LINT_PRAGMA} lint/suspicious/noExplicitAny: probe */`,
    `/** ${LINT_PRAGMA} lint/suspicious/noExplicitAny: probe */`,
    `const value = raw as Any /* ${LINT_PRAGMA} lint/suspicious/noExplicitAny: probe */`,
    `//${LINT_PRAGMA}-all lint/suspicious/noExplicitAny: probe`,
    `// ${DEAD_CODE_PRAGMA}-file security-sink`,
    `// ${DEAD_CODE_PRAGMA}-next-line complexity`,
    `// ${TYPE_DIRECTIVE}ignore`,
    `// ${TYPE_DIRECTIVE}expect-error — the lib types lag`,
    `// ${TYPE_DIRECTIVE}nocheck`,
    // Spellings that do not exist in any of the three tools yet.
    `// ${LINT_PRAGMA}-region lint/suspicious/noExplicitAny: probe`,
    `// ${TYPE_DIRECTIVE}expect-warning`,
  ]
  expect(suppressing.filter((line) => !SUPPRESSION.test(line))).toEqual([])

  const innocent = [
    // The one directive under the type-checker prefix that ADDS a check; flagging it would
    // make the gate punish the right move.
    `// ${TYPE_DIRECTIVE}check`,
    // A needle widened to the bare verb matches identifiers, and a gate that names half the
    // repository names nothing.
    'const IGNORED_DIRECTORIES: readonly string[] = []',
  ]
  expect(innocent.filter((line) => SUPPRESSION.test(line))).toEqual([])
})
