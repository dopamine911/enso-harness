import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * THE HARNESS BARREL IS ITS CONSUMPTION, AND THAT IS CHECKED (#263).
 *
 * `packages/harness/core/index.ts` used to export the modules' full public surface, and 17 of
 * its 50 names were imported nowhere. They did not fail `fallow dead-code` either: they sat in
 * `fallow-baseline.json`, whose own note deferred the question to "#173's zone rule" — and
 * #173 shipped without taking it, so the suppression outlived the reason for it by an entire
 * workstream. That is the shape `naming-gate.test.ts` closed for the `v` key (#251): an
 * exception nothing reports is an exception nobody removes.
 *
 * ⚠ DEAD-CODE BASELINES DO NOT AGE, WHICH IS WHY THIS IS A GATE AND NOT A BASELINE. A row in
 * `fallow-baseline.json` is silent whether the leak is still there, half fixed, or long gone;
 * the only way to learn is to delete the row and see. Here the barrel's excess is the test's
 * output — the offending NAMES, never a count — so the day an extension drops its last import
 * of something, the line to delete is named rather than baselined.
 *
 * WHAT IT HOLDS, both directions:
 *   • a name on the barrel that no extension imports through it is red — the barrel may not
 *     claim a surface nobody takes;
 *   • a name an extension imports that the barrel does not export does not compile, so `tsc`
 *     owns that half and this file does not restate it.
 *
 * WHAT IT DOES NOT HOLD. Internal reachability: `shell-segments.ts` and
 * `web-search/anthropic-wire.ts` left the barrel with #263 and are imported directly by their
 * siblings and their own tests, which is what internal means. `@enso/core`'s equivalent rule is
 * MODULE reachability (`packages/core/src/__tests__/no-duplicate-shapes.test.ts`) and exists
 * for a different reason — one search for a schema. This package declares no schemas, so the
 * two barrels are held to the claims they each make, not to one shared rule.
 */

const BARREL = 'packages/harness/core/index.ts'
/** Who may import through it. The barrel exists for the extensions; nothing else consumes it. */
const CONSUMER_ROOT = 'packages/harness/extensions'

/**
 * A brace list in an `import`/`export … from '<specifier>'`. ⚠ `[^}]*`, never `[\s\S]*?`: a
 * lazy body still scans PAST an unrelated import to reach a matching specifier further down
 * the file, and measured here that merged four import blocks into one and reported names as
 * consumed that no file imports. A brace list cannot contain a brace.
 */
function namesFrom(source: string, keyword: 'import' | 'export', specifier: RegExp): string[] {
  const pattern = new RegExp(String.raw`${keyword}\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'${specifier.source}'`, 'g')
  return [...source.matchAll(pattern)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^type\s+/, ''))
      .filter((name) => name.length > 0),
  )
}

/** Every name the barrel re-exports, by the module it comes from. */
function barrelExports(): string[] {
  return namesFrom(readFileSync(join(REPOSITORY_ROOT, BARREL), 'utf8'), 'export', /\.\/[^']+/)
}

/** Every name imported THROUGH the barrel, tests included — a test's import is a consumer too. */
function consumedNames(): Set<string> {
  const names = new Set<string>()
  for (const path of filesUnder(join(REPOSITORY_ROOT, CONSUMER_ROOT))) {
    for (const name of namesFrom(readFileSync(path, 'utf8'), 'import', /[^']*core\/index\.ts/)) names.add(name)
  }
  return names
}

test('⚠ every name on the harness barrel is imported through it (#263)', () => {
  const consumed = consumedNames()
  // Named, not counted: the output IS the list of lines to delete.
  expect(barrelExports().filter((name) => !consumed.has(name))).toEqual([])
})

test('the barrel is not empty, and a consumer that imports nothing cannot make it pass', () => {
  // Both halves of the equality above can be satisfied by nothing at all — an empty barrel
  // has no unused name, and so does an unread one. This is the floor under that.
  expect(barrelExports().length).toBeGreaterThan(20)
  expect(consumedNames().size).toBeGreaterThan(20)
})

test('the brace reader stops at its own list, and takes type-only names (#263)', () => {
  const source = [
    "import { alpha } from './other.ts'",
    "import type { Beta, Gamma } from '../../core/index.ts'",
    "import { delta, type Epsilon } from '../../core/index.ts'",
  ].join('\n')
  // ⚠ The first line must NOT be swallowed: a lazy body would run from its `{` to the brace
  // of the next matching specifier and report `alpha` as imported through the barrel.
  expect(namesFrom(source, 'import', /[^']*core\/index\.ts/).sort()).toEqual(
    ['Beta', 'Gamma', 'Epsilon', 'delta'].sort(),
  )
})
