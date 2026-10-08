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
 *
 * ⚠ The keyword is anchored, and `\b` is NOT the anchor that works (PR #302 review). The
 * risk is real — unanchored, `Array.from('@tanstack/ai-react')` reads as an import of that
 * package and would satisfy the `overrides` equality below by accident — but a word boundary
 * sits between `.` and `from`, so `\b` still matches `Array.from(`. It only stops
 * `myimport('x')`. The lookbehind refuses a preceding word character, `.` or `$`, which
 * covers both: a member call and a longer identifier are neither of them an import.
 */
const IMPORT_SPECIFIER = /(?<![\w.$])(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

interface Manifest {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
  readonly overrides?: Record<string, string>
  /** Only read off an INSTALLED manifest, never a workspace one. */
  readonly version?: string
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
  expect(Object.keys(root.overrides ?? {}).toSorted()).toEqual(
    [...imports.keys()].filter((name) => STATE_LAYER_SCOPE.test(name)).toSorted(),
  )
})

// The skip above is load-bearing in BOTH directions, so it is asserted here rather than
// borrowed from another gate's fixture (PR #302 review). It is what keeps an import-shaped
// string out of the graph — and, if it ever widened, what would quietly drop a real package
// and make the `overrides` equality above pass by omission.
test('an import-shaped string that names no installed package is not an import (#223)', () => {
  // The fixture that taught the gate this: a matcher's own example, naming a package that has
  // never existed (the real one is `@tanstack/ai-react`).
  expect(imports.has('@tanstack/react-ai')).toBe(false)
  expect(existsSync(join(REPOSITORY_ROOT, 'node_modules', '@tanstack/react-ai'))).toBe(false)
  // …and the near neighbour it is one transposition from IS in the graph, so the skip is a
  // resolution test and not a spelling rule.
  expect(imports.get('@tanstack/ai-react')).toEqual(expect.arrayContaining(['packages/web/src/chat-screen.tsx']))
})

// The keyword anchor, asserted against the shape that was live when it was added (PR #302
// review). Unanchored — or anchored with `\b`, which does not help, because a word boundary
// sits between `.` and `from` — `Buffer.from('🚀', 'utf8')` in `scripts/__tests__/enso-logs.test.ts`
// entered the graph as an import of a package named `🚀`. Harmless there; the same shape
// spelled `Array.from('@tanstack/ai-react')` would satisfy the `overrides` equality above
// without anyone importing the package.
test('a member call is not an import position, however it is spelled (#223)', () => {
  const memberCalls = [...imports.keys()].filter((name) => name === '🚀' || name.includes(' '))
  expect(memberCalls).toEqual([])
  expect([...`const rocket = Buffer.from('🚀', 'utf8')`.matchAll(IMPORT_SPECIFIER)].map((match) => match[1])).toEqual(
    [],
  )
  // …and the import positions it must still see, on one line each.
  expect(
    [`} from '@tanstack/ai-react/ui'`, `await import('@enso/core')`, `require('node:fs')`].map((line) =>
      [...line.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]),
    ),
  ).toEqual([['@tanstack/ai-react/ui'], ['@enso/core'], ['node:fs']])
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
 * `@tanstack/ai` 0.40 and `@tanstack/ai-client` 0.20 and we run 0.66 and 0.39 — twenty-six and
 * nineteen minors past (re-probed on the #770 bump). It installs silently because all three peers
 * are optional, so the installer will never be the detector. A red line here means one side moved: re-run
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
      .toSorted(),
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
    weRun: { '@tanstack/ai': '0.66.0', '@tanstack/ai-client': '0.39.0', ai: undefined },
  })
})

/**
 * ⚠ ONE AG-UI BETWEEN THE ADAPTER AND TANSTACK. The follow adapter speaks AG-UI events to
 * TanStack's chat client, so both must read ONE `@ag-ui/core`: two installed copies give `EventType`
 * two module identities, and tsc fails (`bunfig.toml`'s header; the first test in this file pins the
 * `overrides` rule that prevents it). Through `@tanstack/ai` 0.58 the override was also a DEVIATION:
 * TanStack pinned `0.1.1-canary.beta.0`, and 1.0.0 was forced under it. Since 0.59 (TanStack/ai
 * #1460/#1465) TanStack declares 1.0.0 itself, so the override agrees with it rather than overruling
 * it (re-checked on the 0.66 bump, #770). A red line means the declarations parted or a second copy
 * got installed: re-read that release's migration notes, then align the versions, not the test.
 */
test('⚠ @tanstack/ai, the web package and the override name the same @ag-ui/core, and one copy is installed', () => {
  expect({
    tanstackDeclares: manifest('node_modules/@tanstack/ai/package.json').dependencies?.['@ag-ui/core'],
    overriddenTo: root.overrides?.['@ag-ui/core'],
    webDeclares: web.dependencies?.['@ag-ui/core'],
    installed: manifest('node_modules/@ag-ui/core/package.json').version,
  }).toEqual({
    tanstackDeclares: '1.0.0',
    overriddenTo: '1.0.0',
    webDeclares: '1.0.0',
    installed: '1.0.0',
  })
})

/**
 * ⚠ THE TYPESCRIPT MAJOR IS PINNED BY TYPEDOC, NOT BY TASTE (#188). 7.0.2 was installed here
 * and the build is SIX TIMES faster on it — measured cold, `tsc -b` over this tree: 1.0 s
 * against 6.4 s. It was given up on purpose: 7.x is the native port and ships no compiler
 * API — `node_modules/typescript/lib/` holds `tsc.js` and `getExePath.js` and no
 * `typescript.js` — so every tool that READS types rather than checking them stops working.
 * TypeDoc is the one this repo needs (#188's reference surface), and its own peer range is
 * the authority, read here rather than restated.
 *
 * A bump back to 7 is not wrong, it is a TRADE: it buys the compile time back and costs the
 * generated API reference. This line is what makes that trade a decision instead of a
 * surprise on the next docs build — and the failure names TypeDoc, which a version pin in a
 * manifest cannot.
 */
test('⚠ the installed TypeScript is one TypeDoc supports — the reason the major is pinned (#188)', () => {
  const installedMajorMinor = /^(\d+\.\d+)\./.exec(manifest('node_modules/typescript/package.json').version ?? '')?.[1]
  const supported = manifest('node_modules/typedoc/package.json').peerDependencies?.typescript ?? ''
  expect(supported).not.toBe('')
  expect(supported.split('||').map((range) => range.trim())).toContain(`${installedMajorMinor}.x`)
  // …and the compiler API TypeDoc reads is actually on disk, which is the thing 7.x drops.
  expect(existsSync(join(REPOSITORY_ROOT, 'node_modules/typescript/lib/typescript.js'))).toBe(true)
})

/**
 * ⚠ THE DOWNGRADE INSTALLED A SECOND TYPESCRIPT, and #228 spent a PR removing one (PR #327
 * review).
 *
 * `fallow-type-aware` declares its own `typescript` and shared the root's copy while that was
 * 7.0.2; the root moving to 6.0.3 split them, so `bun.lock` now carries a nested
 * `fallow-type-aware/typescript@7.0.2`. That is the installer doing its job, not lock drift —
 * but it is exactly the shape #228 refused, and the difference has to be checkable rather than
 * explained in a pull-request body nobody reads twice.
 *
 * The difference: #228's rule is that no WORKSPACE package pins a TypeScript of its own, so
 * `tsc -b` compiles this tree with one compiler. A vendor's private copy is that vendor's
 * business — it never reaches `tsc -b`, the barrels, or the build. This holds the rule where
 * #228 drew it and states the exception where the installer put it.
 */
test('⚠ only the root declares TypeScript — a second copy is a vendor’s, never a workspace’s (#228, #188)', () => {
  const workspaces = ['packages/arena', 'packages/core', 'packages/harness', 'packages/web'].map((workspace) => ({
    workspace,
    declares: manifest(`${workspace}/package.json`).devDependencies?.typescript,
  }))
  expect(workspaces.filter((entry) => entry.declares !== undefined)).toEqual([])
  expect(manifest('package.json').devDependencies?.typescript).toBe('~6.0.3')
  // The vendor's private copy, named so the next reader does not take it for drift.
  expect(existsSync(join(REPOSITORY_ROOT, 'node_modules/fallow-type-aware/node_modules/typescript'))).toBe(true)
})
