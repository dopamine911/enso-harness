import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codeLinesUnder, REPOSITORY_ROOT } from './gate-support.ts'

/**
 * What the dependency manifests claim, held against what the code actually imports
 * (#218, #223).
 *
 * ⚠ Enforcement, not a unit test — the shape of `vendor-gate.test.ts`. Two facts about the
 * vendor boundary lived nowhere checkable, so both were wrong:
 *
 *   1. The root `overrides` block pinned `@tanstack/ai-utils`, which no file imports (it
 *      arrives as a dependency of `@tanstack/ai` and `@tanstack/ai-client`), and omitted
 *      `@tanstack/ai-react`, which two production files import. The rule the block follows —
 *      unwritten until now — is: every `@tanstack/*` or `@ag-ui/*` package a source file
 *      imports DIRECTLY is pinned to one version here, and nothing else is. The reason is in
 *      `bunfig.toml`'s header: two copies of one package give the same enum two module
 *      identities and tsc fails on `EventType.RUN_FINISHED is not assignable to
 *      EventType.RUN_FINISHED`. A pin on a package nobody imports buys nothing; a missing
 *      pin on one two files import is how a second copy arrives.
 *   2. `@shadcn/helpers` was a devDependency statically imported by a module the production
 *      bundle includes, so `bun install --production` yielded a browser build that could not
 *      resolve it. Its compatibility with this repo's TanStack versions — which its own peer
 *      range excludes — was a probe in a PR body. The probe is now
 *      `packages/web/src/__tests__/fixture-conversation.test.ts`; this file pins the version
 *      pair that probe was taken against, so the next bump goes red with somewhere to look.
 *
 * ⚠ TYPE-ONLY IMPORTS COUNT, and that is why this is a text scan and not
 * `Bun.Transpiler#scanImports`: the transpiler drops `import type`, and measured here every
 * one of `@tanstack/ai`'s eight import sites is type-only (`StreamChunk`, `ContentPart`,
 * `ToolResultPart`). The failure the pins prevent IS a type error, so erasing type imports
 * would have concluded that `@tanstack/ai` needs no pin at all.
 *
 * What it does not cover: `overrides` is Bun's field, and nothing here proves Bun honoured a
 * pin — only that the set of pins matches the set of direct importers. The installed tree is
 * `bun.lock`'s business, and `bunfig.toml`'s `linker = "hoisted"` is what keeps one copy.
 */

/** The state layer, by scope: the packages whose duplication broke tsc once. */
const STATE_LAYER_SCOPE = /^@(?:tanstack|ag-ui)\//
/** Every root a source file lives under, tests included — a file's imports count wherever it is. */
const SOURCE_ROOTS = ['packages', 'scripts', 'test'] as const
/**
 * A module specifier in an import position: `from '…'`, `import('…')`, `require('…')`.
 * Comment-only lines never reach here (`gate-support.ts`), so prose naming a package is free.
 */
const IMPORT_SPECIFIER = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

interface Manifest {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
  readonly overrides?: Record<string, string>
}

function manifest(repositoryRelative: string): Manifest {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, repositoryRelative), 'utf8')) as Manifest
}

const root = manifest('package.json')
const web = manifest('packages/web/package.json')
/** The helper as installed — the peer ranges that actually govern this tree. */
const helper = manifest('node_modules/@shadcn/helpers/package.json')

/**
 * Every package a source file imports directly, to the repository-relative files that import
 * it. One walk: both questions below are views of this graph. A specifier's subpath is
 * dropped (`@shadcn/helpers/tanstack-ai` is the helper), which is also how a manifest names it.
 *
 * ⚠ A specifier naming nothing in `node_modules` is skipped, and that is the line between an
 * import and an import-SHAPED STRING: `test/presentation-gate.test.ts:81` carries
 * `'import { useChat } from "@tanstack/react-ai";'` as a fixture for its own matcher, and
 * `@tanstack/react-ai` is not a package that exists (the real one is `@tanstack/ai-react`).
 * Nothing is lost by skipping: a real import of a package that does not resolve fails tsc,
 * gate two, before it reaches here. Hoisted install (`bunfig.toml`), so one directory to look in.
 */
function directImportGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const line of codeLinesUnder(SOURCE_ROOTS, true)) {
    for (const [, specifier] of line.text.matchAll(IMPORT_SPECIFIER)) {
      if (specifier === undefined || specifier.startsWith('.')) continue
      const parts = specifier.split('/')
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
      if (!existsSync(join(REPOSITORY_ROOT, 'node_modules', name))) continue
      const importers = graph.get(name)
      if (importers === undefined) graph.set(name, [line.file])
      else if (!importers.includes(line.file)) importers.push(line.file)
    }
  }
  return graph
}

const imports = directImportGraph()

test('⚠ the root `overrides` block is exactly the state-layer packages the code imports (#223)', () => {
  expect(Object.keys(root.overrides ?? {}).sort()).toEqual(
    [...imports.keys()].filter((name) => STATE_LAYER_SCOPE.test(name)).sort(),
  )
})

/**
 * A `__tests__` import may be a devDependency; an import the browser bundle can reach may
 * not. If `fixture-conversation.ts` ever reaches the helper through a dynamic `import()`
 * gated on fixture mode instead, this goes red — and the honest answer then is to move the
 * helper BACK to `devDependencies`, not to widen this test.
 */
test('⚠ @shadcn/helpers is imported by the production bundle, so it is a dependency, pinned exactly (#218)', () => {
  expect({
    productionImporters: (imports.get('@shadcn/helpers') ?? []).filter(
      (file) => file.startsWith('packages/web/src/') && !file.includes('/__tests__/'),
    ),
    declaredRange: web.dependencies?.['@shadcn/helpers'],
    declaredAsDevDependency: web.devDependencies?.['@shadcn/helpers'],
  }).toEqual({
    productionImporters: ['packages/web/src/fixture-conversation.ts'],
    declaredRange: '0.2.0',
    declaredAsDevDependency: undefined,
  })
})

/**
 * ⚠ A DELIBERATE VIOLATION, pinned so it stays deliberate. The helper declares support for
 * `@tanstack/ai` 0.40 and `@tanstack/ai-client` 0.20 and we run 0.53 and 0.31 — thirteen and
 * eleven minors past. It installs silently because all three peers are optional, so the
 * installer will never be the detector. A red line here means one side moved: re-run
 * `fixture-conversation.test.ts` (the probe), and if the four part kinds still materialize,
 * update this row with the new pair. `ai` is absent on purpose — nothing in this repo imports
 * the Vercel SDK, and the helper's `tanstack-ai` entry point does not need it.
 */
test('⚠ @shadcn/helpers’ peer ranges are knowingly violated — re-probe when either side moves (#218)', () => {
  expect({
    declaredPeers: helper.peerDependencies,
    optionalPeers: Object.entries(helper.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)
      .sort(),
    weRun: {
      '@tanstack/ai': web.dependencies?.['@tanstack/ai'],
      '@tanstack/ai-client': web.dependencies?.['@tanstack/ai-client'],
      ai: web.dependencies?.ai ?? root.dependencies?.ai,
    },
  }).toEqual({
    declaredPeers: {
      '@tanstack/ai': '>=0.40.0 <0.41.0',
      '@tanstack/ai-client': '>=0.20.0 <0.21.0',
      ai: '>=7.0.0 <8',
    },
    optionalPeers: ['@tanstack/ai', '@tanstack/ai-client', 'ai'],
    weRun: { '@tanstack/ai': '0.53.0', '@tanstack/ai-client': '0.31.0', ai: undefined },
  })
})
