import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * One place for every shape: no TypeBox schema is declared outside `@enso/core` (#53, #255) —
 * except the one test bench that is not the product. Dogfood Arena's `act` tool schema
 * (`packages/arena/src/act-tool.ts`, #556) lives with the arena, so deleting the package
 * leaves no schema in core that nothing reads. A third root is a design conversation.
 *
 * ⚠ Enforcement, not a unit test — the shape of `vendor-gate.test.ts`. Nothing else stops the
 * next session declaring `Type.Object` beside a consumer, which is exactly the drift that made
 * centralising them necessary, and a convention with no check is a convention that has already
 * been broken somewhere nobody has looked. This is the anti-drift anchor the rest of the repo's
 * "is this shape already declared?" search depends on: a second declaration site does not make
 * the search wrong, it makes it MISS.
 *
 * ⚠ It moved here from `packages/core/src/__tests__/no-duplicate-shapes.test.ts` with #255,
 * because its scope is the repository and not the package: it now walks `packages`, `scripts`
 * and `test` over the one walker (`scripts/source-tree.ts`, #174), and a test inside
 * `packages/core`'s `rootDir` cannot import that walker at all (`tsc -b` refuses the reach:
 * TS6059). The barrel-reachability and export tests that file keeps ARE about the package and
 * stayed there.
 */

/** Where a second declaration site could appear. The declaration roots are skipped. */
const SEARCHED_ROOTS = ['packages', 'scripts', 'test'] as const
const DECLARATION_ROOTS = [join('packages', 'core'), join('packages', 'arena')] as const

/**
 * Is this path inside a declaration root? A SEGMENT test, not a substring one (PR #321 review).
 * `path.includes('packages/core')` also swallows a future `packages/core-extensions/`, which
 * would leave a whole package unscanned by the gate whose job is to say where a schema may be
 * declared — and silently, because an excluded file can never be an offender.
 */
function insideDeclarationRoot(path: string): boolean {
  const relative = path.slice(REPOSITORY_ROOT.length + 1)
  return DECLARATION_ROOTS.some((root) => relative === root || relative.startsWith(`${root}${sep}`))
}

/**
 * A TypeBox schema declaration, independent of the export keyword and of line breaks (#255).
 *
 * ⚠ The needle it replaced required `export const`, the name and `= Type.` on ONE PHYSICAL
 * LINE, and every evasion was idiomatic rather than exotic: `const EnsoFoo = Type.Object({…})`
 * followed by `export { EnsoFoo }` is a normal refactor; `export const EnsoFoo: TObject =` with
 * `Type.Object({` wrapped to the next line is what the FORMATTER produces at 120 columns once
 * the annotation is long; `export default`, `export let` and `export var` were simply not in
 * it. So the export keyword is optional, `default` is its own branch, and `\s` after the `=`
 * spans the wrap. The declaration's NAME is still required, which is what keeps the generators'
 * `export const <name> = Type.Object(` templates and the doc fences' quoted examples out
 * (pinned below, because they are the reason a careless tightening here would go falsely red).
 *
 * ⚠ Whole-file, so it cannot skip comment lines the way the line-scanning gates do: a
 * commented-out declaration at the start of a line is reported. That direction is the safe
 * one — the gate fails on prose rather than admitting a second shape, and the fix is to not
 * leave a dead schema in a comment (`test/gate-support.ts` records the same trade).
 */
const SCHEMA_DECLARATION =
  /(?:^|\n)\s*(?:export\s+default\s+Type\.|(?:export\s+)?(?:const|let|var)\s+[A-Za-z][A-Za-z0-9_]*\s*(?::[^=\n]*)?=\s*Type\.)/

test('⚠ no TypeBox schema is declared outside @enso/core and the arena (#53, #255, #556)', () => {
  const offenders = SEARCHED_ROOTS.flatMap((root) => filesUnder(join(REPOSITORY_ROOT, root)))
    .filter((path) => !insideDeclarationRoot(path))
    .filter((path) => SCHEMA_DECLARATION.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(REPOSITORY_ROOT.length + 1))
  // Named, not counted — a count cannot say which file to look at.
  expect(offenders).toEqual([])
})

// The exclusion decides what the scan never looks at, so its edge is asserted rather than
// assumed: an excluded file cannot be an offender, and a widened exclusion is a gate that
// reports nothing about a whole package while staying green.
test('the declaration roots are path segments, so a sibling package is still scanned (#321 review)', () => {
  const inside = (relative: string): boolean => insideDeclarationRoot(join(REPOSITORY_ROOT, relative))
  expect(inside(join('packages', 'core', 'src', 'follow.ts'))).toBe(true)
  expect(inside(join('packages', 'core'))).toBe(true)
  expect(inside(join('packages', 'arena', 'src', 'act-tool.ts'))).toBe(true)
  // The shape a substring match would swallow: a sibling whose name starts with the same word.
  expect(inside(join('packages', 'core-extensions', 'src', 'shape.ts'))).toBe(false)
  expect(inside(join('packages', 'arena-extensions', 'src', 'shape.ts'))).toBe(false)
  expect(inside(join('packages', 'web', 'src', 'store.ts'))).toBe(false)
})

// The gate can only gate what its needle sees, and the scan above is green only because the
// needle refuses these. Both lists are real shapes from this repository: the matched ones are
// the evasions #255 found, the refused ones are live lines in `scripts/docs/` and `test/` that
// a careless widening would report as second declaration sites.
test('the needle matches every declaration spelling, and no line that merely quotes one (#255)', () => {
  for (const declaration of [
    'export const EnsoFoo = Type.Object({})',
    'const EnsoFoo = Type.Object({})\nexport { EnsoFoo }',
    'export const EnsoFoo: TObject<{ kind: TLiteral<"foo"> }> =\n  Type.Object({ kind: Type.Literal("foo") })',
    'export default Type.Object({})',
    'export let EnsoFoo = Type.Object({})',
    'export var EnsoFoo = Type.Object({})',
  ]) {
    expect(SCHEMA_DECLARATION.test(`const before = 1\n${declaration}\n`)).toBe(true)
  }
  for (const quoted of [
    // scripts/docs/observations.ts and env-and-config.ts build the needle they search FOR.
    `  const declaration = \`export const \${schema} = Type.Object(\``,
    // test/docs-gate.test.ts and test/glossary-gate.test.ts hold fences as string fixtures.
    "    'export const First = Type.Object({',",
    // packages/web/src/host/runtime-event.ts wraps the constructor; it declares no schema.
    'const openObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T): TObject<T> =>',
    "import { Type } from '@sinclair/typebox'",
  ]) {
    expect(SCHEMA_DECLARATION.test(`const before = 1\n${quoted}\n`)).toBe(false)
  }
})
