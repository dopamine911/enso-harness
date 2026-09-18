import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Presentation stays presentation (#121 item 4, #31).
 *
 * ⚠ Enforcement, not a unit test — the shape of `logging-gate.test.ts` and
 * `vendor-gate.test.ts`. Two lines about `components/ai-elements/`, which is the one
 * directory in this repo whose files came from somewhere else:
 *
 *   1. **Every file names its origin.** The pinned upstream commit in a provenance header,
 *      so a reader knows the file is ported, and a port that drifts can be diffed against
 *      the pin. A vendored file without provenance is just code nobody dares touch.
 *   2. **Nothing under it holds APPLICATION state.** The distinction that makes the rule
 *      usable: a disclosure's open flag, an IME composing flag, the attachment strip before
 *      submit — component-local `useState`/`useRef` — is what a presentation component IS,
 *      and forbidding it would forbid the components. What may not cross is the *state
 *      layer*: our stores, the follow connection, the wire schemas, TanStack's client. A
 *      component that reads a thread's store is no longer portable, no longer replaceable
 *      by an upstream re-port, and the seam README rule 3 names has moved.
 *
 * So the gate matches imports, not hooks. Today the six ported files import React, two ui
 * primitives, `lucide-react`, `use-stick-to-bottom` and each other — nothing else — and the
 * point of the test is that the first import of a store fails the build instead of passing
 * review.
 */

const repositoryRoot = join(import.meta.dir, '..')
const PORTED_DIRECTORY = 'packages/web/src/components/ai-elements'
/** The pin every ported file carries; bump it here when the clone moves (the #31 procedure). */
const UPSTREAM_PIN = '6a9d5b1822ffb10bba4bd97175f01edd7d8651cd'
const SOURCE_EXTENSION = /\.tsx?$/

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
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) return undefined
  return PRESENTATION_DIRECTORIES.includes(inside.split(sep)[0] ?? '') ? undefined : `${WEB_SOURCE_ROOT}/${inside}`
}

function portedFiles(): string[] {
  const directory = join(repositoryRoot, PORTED_DIRECTORY)
  return readdirSync(directory)
    .filter((name) => SOURCE_EXTENSION.test(name))
    .map((name) => join(directory, name))
}

test('⚠ every ported presentation file names its upstream pin (#31, #121)', () => {
  const withoutProvenance = portedFiles()
    .filter((path) => !readFileSync(path, 'utf8').includes(UPSTREAM_PIN))
    .map((path) => path.slice(repositoryRoot.length + 1))
  expect(withoutProvenance).toEqual([])
})

test('⚠ nothing under ai-elements reaches the state layer — component-local state only (#121 item 4)', () => {
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
