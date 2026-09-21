import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'

/**
 * Presentation stays presentation (#121 item 4, #31).
 *
 * ⚠ Enforcement, not a unit test — the shape of `logging-gate.test.ts` and
 * `vendor-gate.test.ts`. Three lines about `packages/web/src/components/`, the directory in
 * this repo whose files came from somewhere else:
 *
 *   1. **Every vendored subdirectory names its origin.** A receipt per subdirectory — the
 *      pinned upstream commit for `ai-elements`, the registry and style for `ui` — and the
 *      receipt set is held against what is on DISK in both directions, so a new vendored
 *      subdirectory fails until it arrives with one instead of quietly inheriting the
 *      exclusions. A vendored file without provenance is just code nobody dares touch.
 *   2. **Every file names its subdirectory's receipt**, so a port that drifts can be diffed
 *      against the pin and a file that moves between subdirectories cannot keep the wrong one.
 *   3. **Nothing under it holds APPLICATION state.** The distinction that makes the rule
 *      usable: a disclosure's open flag, an IME composing flag, the attachment strip before
 *      submit — component-local `useState`/`useRef` — is what a presentation component IS,
 *      and forbidding it would forbid the components. What may not cross is the *state
 *      layer*: our stores, the follow connection, the wire schemas, TanStack's client. A
 *      component that reads a thread's store is no longer portable, no longer replaceable
 *      by an upstream re-port, and the seam README rule 3 names has moved.
 *
 * So the gate matches imports, not hooks. The ported files import React, the `ui` primitives,
 * `lucide-react`, `radix-ui`, `class-variance-authority`, `use-stick-to-bottom` and each
 * other — nothing else — and the point of the test is that the first import of a store fails
 * the build instead of passing review.
 *
 * ⚠ The scan is the EXCLUSION BOUNDARY, recursively (#253). It read `components/ai-elements`
 * only, non-recursively, while three separate exclusions — `biome.jsonc` → `files.includes`,
 * `bunfig.toml` → `coveragePathIgnorePatterns`, `.fallowrc.jsonc` → `ignoreFindings` — are
 * all drawn at `components`. So the eight `ui/*.tsx` shadcn primitives were unlinted,
 * unmeasured, exempt from dead-code findings, carried no provenance, and were held to no
 * state-layer rule: `import { useStore } from "@/store.ts"` in `ui/card.tsx` passed every
 * gate in the repo, and so did any new file one directory below `ai-elements/`. The fence is
 * now the boundary it justifies, over the one walker (`scripts/source-tree.ts`, #174), whose
 * extension set is a superset of the `\.tsx?$` this used to apply.
 */

const repositoryRoot = join(import.meta.dir, '..')
/** The exclusion boundary the three exclusions are drawn at, and therefore the fence. */
const PORTED_DIRECTORY = 'packages/web/src/components'
/**
 * The receipt each vendored subdirectory's files must name; bump one here when its clone or
 * registry moves (the #31 procedure). `ai-elements` is commit-addressable, so the receipt IS
 * the commit. The shadcn registry is not — components are re-fetched by style, not by sha —
 * so its receipt is the registry and style `packages/web/components.json` names, and
 * `ui/README.md` carries the rest (CLI version, the commit that added them, what diverged).
 */
const PROVENANCE_RECEIPTS: Record<string, string> = {
  'ai-elements': '6a9d5b1822ffb10bba4bd97175f01edd7d8651cd',
  ui: 'shadcn/ui radix-nova',
}

/**
 * The state layer, DERIVED (#273). `packages/web/tsconfig.json` maps `@/*` to `./src/*`, so
 * every import a ported file writes is RESOLVED here — the alias, the relative path, the bare
 * specifier alike — and refused when it lands anywhere under `packages/web/src` outside the two
 * presentation neighbourhoods below. No module is spelled by name, because a hand-written list
 * goes stale in silence: the old one still named `session-stats`, renamed to `thread-stats.tsx`
 * long before, and its hard-coded `\.ts` suffix could not have caught a `.tsx` module even if
 * listed — so `import { usePermissionMode } from "@/permission-mode.tsx"`, a hook over the
 * thread's stores, passed this gate (#273). A module added beside `chat-screen.tsx` tomorrow is
 * refused the day it lands.
 *
 * ⚠ Both spellings of the same module (PR #152 review). These files already reach for the `@/`
 * alias for their ui primitives, so `@/store.ts` is the MORE natural way to write the import
 * this gate exists to refuse, and a relative-only pattern would have waved it through.
 *
 * `@zen/core` is the wire: a presentation component taking a `ZenObservation` is reading the
 * protocol, which is the renderer's job (README rule 4 — types are retyped as they cross, not
 * imported); `@tanstack/*` is the vendored state layer itself. Neither is ours to resolve, so
 * both are named — subpaths included, since `@zen/core/log-process` is the same package
 * (PR #153 review).
 */
const WEB_SOURCE_ROOT = 'packages/web/src'
/** All a ported file may reach inside our sources: the ui primitives, the class-name helper, each other. */
const PRESENTATION_DIRECTORIES = ['components', 'lib']
const FORBIDDEN_PACKAGE = /^(?:@zen\/core(?:\/.+)?|@tanstack\/.+)$/
/** `from "x"`, a bare `import "x"` and a dynamic `import("x")` — every spelling that pulls a module in. */
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g

/**
 * What `specifier`, written in `fromFile`, actually reaches: the repository-relative path of one
 * of our modules, or the package name of a vendored state layer — undefined when presentation
 * may import it.
 */
function stateLayerTarget(fromFile: string, specifier: string): string | undefined {
  if (FORBIDDEN_PACKAGE.test(specifier)) return specifier
  const webRoot = join(repositoryRoot, WEB_SOURCE_ROOT)
  const aliased = specifier.startsWith('@/')
  // A bare specifier that is not a forbidden package is a dependency, which rule 3 allows.
  if (!(aliased || specifier.startsWith('.'))) return undefined
  const resolved = aliased ? join(webRoot, specifier.slice(2)) : resolve(dirname(fromFile), specifier)
  const inside = relative(webRoot, resolved)
  // ⚠ An escape is not an allowance (PR #293 review). `@/../thread-stores.ts` and
  // `../../../core/src/observation.ts` land ABOVE `src`, where nothing a ported file may
  // import lives — reading that as "allowed" would reopen by spelling exactly what resolving
  // closed by shape. Refused, named by the path it really reaches.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) return relative(repositoryRoot, resolved)
  return PRESENTATION_DIRECTORIES.includes(inside.split(sep)[0] ?? '') ? undefined : `${WEB_SOURCE_ROOT}/${inside}`
}

/** A module beside the app, whatever its extension — the class the old `\.ts` pattern could not see. */
const SOURCE_EXTENSION = /\.(?:ts|tsx|mjs)$/

/** Every vendored file, at any depth under the boundary. */
function portedFiles(): string[] {
  return filesUnder(join(repositoryRoot, PORTED_DIRECTORY))
}

/** The vendored subdirectory a file belongs to, or `undefined` for a file sitting at the root. */
function vendoredSubdirectory(path: string): string | undefined {
  const [head, ...rest] = relative(join(repositoryRoot, PORTED_DIRECTORY), path).split(sep)
  return rest.length > 0 ? head : undefined
}

test('⚠ every vendored subdirectory has a receipt, and every receipt a subdirectory (#31, #253)', () => {
  const onDisk = readdirSync(join(repositoryRoot, PORTED_DIRECTORY), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  // Both directions, because each is a different rot: a subdirectory with no receipt is
  // upstream code that inherited three exclusions without saying where it came from, and a
  // receipt with no subdirectory is a pin nobody can check (the `v` shape of #251).
  expect(onDisk).toEqual(Object.keys(PROVENANCE_RECEIPTS).sort())
})

test('⚠ every ported presentation file names its subdirectory’s receipt (#31, #121, #253)', () => {
  const withoutProvenance: string[] = []
  for (const path of portedFiles()) {
    const subdirectory = vendoredSubdirectory(path)
    const receipt = subdirectory === undefined ? undefined : PROVENANCE_RECEIPTS[subdirectory]
    // A file at the root belongs to no receipted port: it is first-party code in an excluded
    // tree, which is the one thing this directory may not hold.
    if (receipt === undefined || !readFileSync(path, 'utf8').includes(receipt))
      withoutProvenance.push(path.slice(repositoryRoot.length + 1))
  }
  expect(withoutProvenance).toEqual([])
})

/**
 * ⚠ THE `ui` RECEIPT IS A REPRODUCTION RECIPE, AND A RECIPE CAN GO STALE (PR #321 review).
 * The test above proves a file's header NAMES the receipt; it cannot prove the file still
 * equals what the registry serves, because the shadcn registry is not commit-addressable —
 * `ui/README.md` says so, and that limitation stands. What it CAN prove is that the recipe
 * still describes this repository: the style the receipt names is the style
 * `components.json` fetches with, and the CLI version `README.md` tells the next person to
 * run is the one the package manifest pins. Both drift by ordinary edits — a `style` bump in
 * `components.json`, a `shadcn` version bump in `package.json` — and either leaves every
 * header in the directory naming a fetch nobody can reproduce, with the presence check still
 * green. Presence is not equality; this is what keeps presence worth anything.
 */
test('⚠ the ui receipt still names the style and CLI version this repository fetches with (#31, #253)', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'packages/web/components.json'), 'utf8')) as {
    style?: string
  }
  const style = manifest.style ?? ''
  expect(style.length).toBeGreaterThan(0)
  expect(PROVENANCE_RECEIPTS.ui).toBe(`shadcn/ui ${style}`)

  const web = JSON.parse(readFileSync(join(repositoryRoot, 'packages/web/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const pinned = (web.dependencies?.shadcn ?? web.devDependencies?.shadcn ?? '').replace(/^[^\d]*/, '')
  expect(pinned.length).toBeGreaterThan(0)
  // The README's procedure names the version to re-fetch with; a bump that leaves it behind
  // sends the next reader to a CLI this repository does not install.
  const readme = readFileSync(join(repositoryRoot, PORTED_DIRECTORY, 'ui', 'README.md'), 'utf8')
  expect(readme).toContain(`shadcn@${pinned}`)
  expect(readme).toContain(`\`${PROVENANCE_RECEIPTS.ui}\``)
})

test('⚠ nothing under components/ reaches the state layer — component-local state only (#121 item 4, #253)', () => {
  const offenders: string[] = []
  for (const path of portedFiles()) {
    for (const [lineIndex, line] of readFileSync(path, 'utf8').split('\n').entries()) {
      for (const [, specifier] of line.matchAll(IMPORT_SPECIFIER)) {
        const target = stateLayerTarget(path, specifier ?? '')
        const site = `${path.slice(repositoryRoot.length + 1)}:${lineIndex + 1}`
        if (target !== undefined) offenders.push(`${site} → ${target}`)
      }
    }
  }
  expect(offenders).toEqual([])
})

// The gate can only gate what its resolver sees. Every spelling of a forbidden module belongs
// here: the `@/` alias row is the one PR #152's review found missing, and the four `.tsx`
// modules are the ones #273's probe found the hand-written list waving through.
test('the state-layer resolver catches every spelling — the alias, the relative path, a `.tsx` module, a package subpath (#273, PR #152 review)', () => {
  const ported = join(repositoryRoot, PORTED_DIRECTORY, 'message.tsx')
  const wavedThrough: string[] = []
  for (const specifier of [
    '@/store.ts',
    '../../thread-stores.ts',
    '@/follow-connection.ts',
    // ⚠ A `.tsx` module carries thread state too: these four read `useThreadStores()` and
    // export the hooks and components that carry it. A red line here is the #273 regression —
    // the extension, not the module list, is what the old pattern could not see.
    '@/permission-mode.tsx',
    '@/thread-stats.tsx',
    '../../notifications.tsx',
    '@/thread-status.tsx',
    '@/to-agui.ts',
    '../../host/extension-ui-context.ts',
    // An escape is a spelling too (PR #293 review): a path that climbs OUT of `src` reaches
    // nothing presentation may import, so "outside the tree" may not read as "allowed".
    '@/../../core/src/observation.ts',
    '../../../../core/src/guard.ts',
    '@zen/core',
    '@zen/core/log-process',
    '@tanstack/react-ai',
  ]) {
    if (stateLayerTarget(ported, specifier) === undefined) wavedThrough.push(specifier)
  }
  expect(wavedThrough).toEqual([])
  // What presentation legitimately imports, and must keep importing.
  for (const specifier of [
    '@/lib/utils.ts',
    '@/components/ui/button.tsx',
    './prompt-input.tsx',
    'react',
    'lucide-react',
    'use-stick-to-bottom',
  ]) {
    expect({ specifier, target: stateLayerTarget(ported, specifier) }).toEqual({ specifier, target: undefined })
  }
})

// ⚠ THE LIST IS DERIVED, AND THIS IS THE PROOF (#273). Every module that sits beside
// `chat-screen.tsx` — the thread's stores and everything carrying them — is refused under both
// spellings, whatever its extension, without being named above. A red line here means the
// resolver has a hole a new state module can walk through; the old gate spelled six names, one
// of which had not existed for months.
test('⚠ every module beside the app is refused, in both spellings, whatever its extension (#273)', () => {
  const stateModules = readdirSync(join(repositoryRoot, WEB_SOURCE_ROOT), { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSION.test(entry.name))
    .map((entry) => entry.name)
  // Not vacuous, and not vacuous in the direction that matters: the directory really does hold
  // `.tsx` state modules, the class the old pattern's `\.ts` suffix could not match.
  expect(stateModules.some((name) => name.endsWith('.tsx'))).toBe(true)
  const ported = join(repositoryRoot, PORTED_DIRECTORY, 'message.tsx')
  const wavedThrough = stateModules.filter(
    (name) =>
      stateLayerTarget(ported, `@/${name}`) === undefined || stateLayerTarget(ported, `../../${name}`) === undefined,
  )
  expect(wavedThrough).toEqual([])
})
