import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findRepoRoot } from '../paths.ts'

/**
 * The anti-duplication anchor for path resolution (#59) — Daniel: "this should live in
 * core and prevent duplicate code again."
 *
 * Before paths.ts, seven call sites each walked up from their own `import.meta.url`
 * (one counted `4×".."` and broke on any file move). This anchor refuses an eighth copy
 * the way `no-duplicate-shapes.test.ts` refuses a stray schema: a convention with no
 * check is a convention that has already been broken somewhere nobody has looked.
 *
 * ⚠ It refuses the SHAPE, not a list of spellings (#256). A rule expressed as two literals is one
 * rename away from blind: `new URL('../..', import.meta.url)` reproduces the eighth copy exactly
 * and matched neither of the original needles — measured 2026-09-18, a planted resolver spelled
 * that way ran GREEN through all four tests here. The pattern below matches the construction.
 *
 * What it cannot catch: a root derived from `process.cwd()` rather than from a module's location.
 * That is a different failure — it breaks when you run from a subdirectory, not when a file moves
 * — the one non-test use in source is a CLI `--cwd` default (`packages/web/src/server/dev.ts`),
 * and no text pattern separates "cwd as the directory the user is in" from "cwd walked up from".
 * `paths.ts` states that rule in prose ("do not 'fix' this to consult `process.cwd()`"); review
 * enforces it.
 *
 * Tests are excluded — a test legitimately builds fixture paths and reads its own
 * location. The rules gate SOURCE, where a duplicate resolver silently drifts.
 */

const repositoryRoot = findRepoRoot(import.meta.url)
const PATHS_MODULE = join('packages', 'core', 'src', 'paths.ts')

/** The scanned surface: every non-test source file the migration covered. */
const SCANNED_ROOTS = [
  'packages/core/src',
  'packages/harness/core',
  'packages/harness/extensions',
  'packages/web/src',
  'scripts',
] as const

/** Vendored code — the linter's exclusion boundary (oxlint.config.ts), same as the coverage manifest. */
const VENDORED_DIRECTORIES = ['packages/web/src/components'] as const

function isScannableSource(fileName: string): boolean {
  if (fileName.endsWith('.test.ts') || fileName.endsWith('.test.tsx')) return false
  return fileName.endsWith('.ts') || fileName.endsWith('.tsx') || fileName.endsWith('.mjs')
}

/** Path fragments outside the scan: tests, installs, emitted types. */
const EXCLUDED_PATH_FRAGMENTS = ['__tests__', 'node_modules', 'dist-types'] as const

function isExcludedPath(repositoryRelative: string): boolean {
  return (
    EXCLUDED_PATH_FRAGMENTS.some((fragment) => repositoryRelative.includes(fragment)) ||
    VENDORED_DIRECTORIES.some((vendored) => repositoryRelative.startsWith(vendored))
  )
}

function collectScannableSources(): string[] {
  return SCANNED_ROOTS.flatMap((scannedRoot) =>
    readdirSync(join(repositoryRoot, scannedRoot), { withFileTypes: true, recursive: true })
      .filter((dirEntry) => dirEntry.isFile() && isScannableSource(dirEntry.name))
      .map((dirEntry) => relative(repositoryRoot, join(dirEntry.parentPath, dirEntry.name)))
      .filter((repositoryRelative) => !isExcludedPath(repositoryRelative)),
  )
}

function offendersContaining(needle: string, allowedFiles: readonly string[]): string[] {
  return offendersMatching(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), allowedFiles, needle)
}

/**
 * ⚠ Scan by PATTERN, not by a quoted literal. `offendersContaining('".enso"')` went blind the day
 * the formatter switched to single quotes: the needle matched nothing, the offender list was empty,
 * and the gate passed while enforcing nothing. A gate that cannot fail is worse than no gate — it
 * reads as protection. Quote characters belong in the pattern as a class, never baked into a needle.
 */
function offendersMatching(pattern: RegExp, allowedFiles: readonly string[], described: string): string[] {
  return collectScannableSources()
    .filter((repositoryRelative) => !allowedFiles.includes(repositoryRelative))
    .filter((repositoryRelative) => pattern.test(readFileSync(join(repositoryRoot, repositoryRelative), 'utf8')))
    .map((repositoryRelative) => `${repositoryRelative} contains ${JSON.stringify(described)}`)
}

test("⚠ fileURLToPath lives ONLY in core's paths module — pass import.meta.url to findRepoRoot instead", () => {
  // Named, not counted — a count cannot say which file to look at.
  expect(offendersContaining('fileURLToPath(', [PATHS_MODULE])).toEqual([])
})

/**
 * Resolution from a module's OWN location, in every spelling it has. `new URL` alone is not the
 * offence — the web server and the fetch guard parse request URLs with it — so the match requires
 * `import.meta.url` inside the same call. The `import.meta` accessors are bounded by the exact
 * property name, so `import.meta.main` (check-coverage's entry idiom) does not match, and neither
 * does `import.meta.url` handed straight to `findRepoRoot`, which is the sanctioned call.
 *
 * ⚠ The gap between the call and the argument is bounded by the LINE, not by the first `)`
 * (PR #319 review). `[^)]*` stopped at the first closing bracket, so `new URL(join('..', '..'),
 * import.meta.url)` — a helper call before the base — matched nothing: the spelling-not-shape
 * blind spot this gate was rewritten to close, reproduced one nesting level down.
 */
const RESOLVES_FROM_OWN_LOCATION = /new URL\s*\([^;\n]*import\.meta\.url|import\.meta\.(?:dirname|filename|dir)\b/

test('⚠ no source resolves a path from its own location — that is the seven-copies shape returning', () => {
  // The allowlist is EMPTY and paths.ts needs no entry: the one sanctioned walk takes its start
  // location as an ARGUMENT (`findRepoRoot(startPathOrFileUrl)`), so not even the module that owns
  // the walk resolves from wherever it happens to sit. An entry here would be the first regression.
  expect(offendersMatching(RESOLVES_FROM_OWN_LOCATION, [], 'a path resolved from its own location')).toEqual([])
})

test('⚠ the ".enso" literal is assembled only in paths.ts (plus guard.ts, where it is corpus data)', () => {
  // guard.ts's exception is ENSO_PERSISTENCE_WRITE_DIRECTORIES: there ".enso" is a DENIED
  // DIRECTORY NAME in the write-guard's corpus, not a path being assembled — rewiring the
  // corpus to import from paths.ts would couple the guard's deny-list to the helper for
  // no safety gain (the corpus lists names to REFUSE; paths.ts assembles paths to USE).
  const GUARD_CORPUS_MODULE = join('packages', 'core', 'src', 'guard.ts')
  // Either quote style: the literal is what matters, not how the formatter spells it today.
  expect(offendersMatching(/['"]\.enso['"]/, [PATHS_MODULE, GUARD_CORPUS_MODULE], '".enso"')).toEqual([])
})

// The storage seam (#102, `docs/architecture.md` → Persistence; #801): pi's `SessionManager` and the
// session-file layout are touched in ONE file, so a later store is a one-file change. Everything
// above it reads a thread's log through `ThreadLog`; core and the browser see a path only as debug
// text (`sessionDir`/`sessionFile` in the inspection).
test("⚠ SessionManager is imported ONLY by the web host's thread-log.ts — the storage seam", () => {
  const STORAGE_SEAM = join('packages', 'web', 'src', 'host', 'thread-log.ts')
  expect(offendersContaining('SessionManager', [STORAGE_SEAM])).toEqual([])
})
