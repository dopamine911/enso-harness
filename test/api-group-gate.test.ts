import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * THE API PAGE IS ORGANISED BY SEAM, AND THAT ORGANISATION IS HELD (#188).
 *
 * TypeDoc's default grouping is by KIND, and measured on this repo that is what the reader got:
 * one page of `Type Aliases (61)`, `Variables (90)`, `Functions (21)` — 179 symbols sorted by a
 * property of the TypeScript language rather than by anything the harness is about. `@group`
 * replaces that with the repo's own vocabulary (`Observations`, `Follow wire`, `Guards`), so the
 * generated API page and `docs/seams/` name the same seams.
 *
 * ⚠ AN UNTAGGED EXPORT DOES NOT FAIL TYPEDOC — IT SILENTLY FALLS BACK TO ITS KIND GROUP. Add one
 * export without `@group` and the page grows a stray `Functions (1)` beside the seams, with no
 * warning even under `treatWarningsAsErrors`: a group is not a resolvable reference, so there is
 * nothing for TypeDoc to fail on. That is the whole reason this file exists — the organisation
 * decays one export at a time, invisibly, and only a gate notices.
 *
 * WHAT IT HOLDS:
 *   • every exported declaration in a DOCUMENTED file carries `@group` — offenders named;
 *   • every group used is declared in `typedoc.json`'s `groupOrder`, so a typo (`Observation`)
 *     cannot quietly open a second, nearly-identical section;
 *   • every name in `groupOrder` is used, so the order does not accumulate ghosts.
 *
 * WHAT IT DOES NOT HOLD: which group a symbol belongs in. That is a judgement — `web-fetch.ts`
 * under `Web tools` rather than its own section is a choice about how the page reads, and a test
 * that pinned it would only restate the map.
 */

const TYPEDOC_CONFIG = 'typedoc.json'

/** A file is documented when TypeDoc reaches it: an entry point, or a module one re-exports. */
function documentedFiles(): string[] {
  const config = JSON.parse(readFileSync(join(REPOSITORY_ROOT, TYPEDOC_CONFIG), 'utf8')) as {
    entryPoints: string[]
  }
  const files = new Set(config.entryPoints)
  for (const entryPoint of config.entryPoints) {
    const source = readFileSync(join(REPOSITORY_ROOT, entryPoint), 'utf8')
    for (const match of source.matchAll(/(?:export|import)\s[^']*from\s*'(\.[^']+)'/g)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      files.add(relative(REPOSITORY_ROOT, join(REPOSITORY_ROOT, dirname(entryPoint), specifier)))
    }
  }
  return [...files].toSorted()
}

/** An ORDER list from the config, minus the `*` catch-all: it orders the unnamed, names nothing. */
function declaredOrder(key: 'groupOrder' | 'categoryOrder'): string[] {
  const config = JSON.parse(readFileSync(join(REPOSITORY_ROOT, TYPEDOC_CONFIG), 'utf8')) as Record<string, string[]>
  return (config[key] ?? []).filter((entry) => entry !== '*')
}

/** A declaration this gate organises — the `export` forms the documented surface actually uses. */
const DECLARATION =
  /^export (?:declare )?(?:abstract )?(?:async )?(?:const|let|function|class|interface|type|enum)\s+(\w+)/

/**
 * The organising tag on the doc comment IMMEDIATELY above `index`, or `undefined`.
 *
 * ⚠ Immediately: a file-wide scan for `@group` would pass every export in `observation.ts` on
 * the strength of the first tagged schema in it, which is the failure this gate exists to
 * catch. The walk stops at the first line that is neither comment nor decorator — a blank line
 * between a comment and a declaration means the comment belongs to nothing.
 */
function tagAbove(lines: readonly string[], index: number, tag: '@group' | '@category'): string | undefined {
  const pattern = new RegExp(String.raw`^(?:/\*\*)?\s*\*?\s*${tag}\s+(.+?)(?:\s*\*/)?$`)
  for (let above = index - 1; above >= 0; above -= 1) {
    const text = (lines[above] ?? '').trim()
    if (text.startsWith('@')) continue
    const found = pattern.exec(text)
    if (found?.[1] !== undefined) return found[1].trim()
    if (text.endsWith('*/') || text.startsWith('*') || text.startsWith('/**')) continue
    return undefined
  }
  return undefined
}

/** Every top-level exported declaration in a file, paired with its organising tag. */
function exportedTags(source: string, tag: '@group' | '@category'): { name: string; value: string | undefined }[] {
  const lines = source.split('\n')
  return lines.flatMap((line, index) => {
    const name = DECLARATION.exec(line)?.[1]
    return name === undefined ? [] : [{ name, value: tagAbove(lines, index, tag) }]
  })
}

test('⚠ every exported declaration on the documented surface carries @group (#188)', () => {
  const untagged: string[] = []
  for (const file of documentedFiles()) {
    for (const { name, value } of exportedTags(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'), '@group')) {
      if (value === undefined) untagged.push(`${file}#${name}`)
    }
  }
  // Named, not counted: the output IS the list of declarations to tag.
  expect(untagged).toEqual([])
})

/**
 * `Observations` is the one group big enough to need subdividing — 39 of the module's 179
 * symbols, pi's whole event vocabulary in one list. `@category` splits it into pi's own
 * families UNDER the group (`categorizeByGroup`), so the rest of the page stays flat.
 *
 * ⚠ Measured with `categorizeByGroup` off, `@category` REPLACES the groups on the page rather
 * than nesting inside them: the index became seven observation families plus `Other (159)`,
 * every other seam erased. Both settings render, so only reading the built page tells them
 * apart — the reason the option is pinned in `typedoc.json` and asserted here.
 */
const CATEGORISED = 'packages/core/src/observation.ts'

test('⚠ the group large enough to subdivide is fully subdivided, and nests (#188)', () => {
  const config = JSON.parse(readFileSync(join(REPOSITORY_ROOT, TYPEDOC_CONFIG), 'utf8')) as {
    categorizeByGroup?: boolean
  }
  // Without this, the categories below do not organise the group — they replace every group.
  expect(config.categorizeByGroup).toBe(true)
  const uncategorised = exportedTags(readFileSync(join(REPOSITORY_ROOT, CATEGORISED), 'utf8'), '@category')
    .filter((entry) => entry.value === undefined)
    .map((entry) => entry.name)
  // An untagged one lands in a trailing `Observations - Other`, which is the unsorted list back.
  expect(uncategorised).toEqual([])
})

test('every group and category used is declared in its order, and every declared one is used (#188)', () => {
  const usedGroups = new Set<string>()
  for (const file of documentedFiles()) {
    for (const { value } of exportedTags(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'), '@group')) {
      if (value !== undefined) usedGroups.add(value)
    }
  }
  const usedCategories = new Set(
    exportedTags(readFileSync(join(REPOSITORY_ROOT, CATEGORISED), 'utf8'), '@category')
      .map((entry) => entry.value)
      .filter((value) => value !== undefined),
  )
  // A typo opens a second section that reads almost like the first; an unused entry is an
  // ordering instruction for a section that no longer exists.
  for (const [key, used] of [
    ['groupOrder', usedGroups],
    ['categoryOrder', usedCategories],
  ] as const) {
    const declared = declaredOrder(key)
    expect([...used].filter((entry) => !declared.includes(entry)).toSorted()).toEqual([])
    expect(declared.filter((entry) => !used.has(entry)).toSorted()).toEqual([])
  }
})

test('the reader takes the comment above the declaration, and no other (#188)', () => {
  const source = [
    '/**',
    ' * Something.',
    ' *',
    ' * @group Observations',
    ' */',
    'export const Tagged = 1',
    '',
    'export const Bare = 2',
    '/** @group Guards */',
    'export type OneLiner = string',
    'const notExported = 3',
  ].join('\n')
  // ⚠ `Bare` sits BELOW a tagged declaration: a file-wide or nearest-tag-above scan would
  // report it as grouped, and the gate would pass a page that has grown a stray kind section.
  expect(exportedTags(source, '@group')).toEqual([
    { name: 'Tagged', value: 'Observations' },
    { name: 'Bare', value: undefined },
    { name: 'OneLiner', value: 'Guards' },
  ])
})
