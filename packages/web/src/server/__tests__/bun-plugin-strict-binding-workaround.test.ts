import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BunPlugin, Loader, OnLoadArgs, OnLoadCallback, PluginBuilder } from 'bun'
import strictBindingWorkaround from '../bun-plugin-strict-binding-workaround.ts'

/**
 * The dev bundle's one source rewrite, executed (#237).
 *
 * ⚠ Nothing imported this plugin before: in the full-suite report it held 13 of 36 lines, all
 * of them top-level constants, and both functions unhit — so its header's claim ("the rewrite
 * VERIFIES both file shapes first and throws a named error on any mismatch") was a claim about
 * code that had never run. It is on the only path to a running web UI (`bun run dev` →
 * `scripts/dev.ts` → `dev-web.ts`, registered in `packages/web/bunfig.toml`), and `bun run
 * check` never builds that bundle, so a typebox reshape would be green here and an unmountable
 * page there. The Playwright suite that would notice does not run in CI.
 *
 * The plugin is driven the way bun drives it — `setup` with a builder that captures the
 * `onLoad` registration — over fixtures written OUTSIDE the repository tree. A fixture under
 * `packages/` would be visible to the source-walking gates while bun runs test files
 * concurrently; `test/naming-gate.test.ts`'s header records that flake.
 *
 * ⚠ The one failure this plugin cannot report itself is typebox MOVING the file: the filter
 * would stop matching, `onLoad` would never fire, and there would be no error to print — just
 * the SyntaxError in the browser again. So the last test drives the plugin over the typebox
 * actually installed rather than a fixture.
 */

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')
const INSTALLED_TYPEBOX_SYSTEM = join(REPOSITORY_ROOT, 'node_modules', 'typebox', 'build', 'system', 'system.mjs')

/** typebox's barrel as it is on disk: the bare star first, five more re-exports after it. */
const SYSTEM_MJS = [
  "export * from './arguments/index.mjs';",
  "export * from './environment/index.mjs';",
  "export * from './hashing/index.mjs';",
  '',
].join('\n')

/** What `arguments/index.mjs` must be for the inlined replacement to be faithful. */
const ARGUMENTS_INDEX_MJS = "export * as Arguments from './arguments.mjs';\n"

const fixtureDirectories: string[] = []
afterAll(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true })
})

/** A `system/` pair in a temp tree; returns the path bun would hand `onLoad`. */
function systemFixture(parts: { system: string; argumentsIndex: string }): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-strict-binding-'))
  fixtureDirectories.push(directory)
  mkdirSync(join(directory, 'arguments'))
  writeFileSync(join(directory, 'system.mjs'), parts.system)
  writeFileSync(join(directory, 'arguments', 'index.mjs'), parts.argumentsIndex)
  return join(directory, 'system.mjs')
}

/** The plugin's single registration, captured as bun's bundler would receive it. */
function captureOnLoad(plugin: BunPlugin): { filter: RegExp; load: OnLoadCallback } {
  const registrations: { filter: RegExp; load: OnLoadCallback }[] = []
  const builder = {
    onLoad: (constraints: { filter: RegExp }, load: OnLoadCallback): void => {
      registrations.push({ filter: constraints.filter, load })
    },
  } as unknown as PluginBuilder
  // Registrations are read straight after `setup` returns, so an async setup would be read too early.
  const setupDone = plugin.setup(builder)
  if (setupDone instanceof Promise) throw new Error('expected a synchronous setup, got a promise')
  const only = registrations[0]
  if (registrations.length !== 1 || only === undefined) {
    throw new Error(`expected one onLoad registration, got ${registrations.length}`)
  }
  return only
}

const loadArgs = (path: string): OnLoadArgs => ({
  path,
  namespace: 'file',
  loader: 'js',
  defer: (): Promise<void> => Promise.resolve(),
})

/** The rewritten module, narrowed from the result union bun accepts. */
function rewrittenSource(path: string): { contents: string; loader: Loader | undefined } {
  const result = captureOnLoad(strictBindingWorkaround).load(loadArgs(path))
  if (result === undefined || result instanceof Promise || !('contents' in result)) {
    throw new Error('the plugin returned no source code')
  }
  if (typeof result.contents !== 'string') throw new Error('the plugin returned non-text contents')
  return { contents: result.contents, loader: result.loader }
}

test('⚠ the bare star becomes the aliased export — the binding bun names `arguments` is gone, the rest of the module is not', () => {
  const rewritten = rewrittenSource(systemFixture({ system: SYSTEM_MJS, argumentsIndex: ARGUMENTS_INDEX_MJS }))
  expect(rewritten.contents).toContain("export * as Arguments from './arguments/arguments.mjs';")
  // The whole point: the specifier bun derives the illegal binding from must not survive.
  expect(rewritten.contents).not.toContain("export * from './arguments/index.mjs';")
  // …and it is a rewrite of one line, not a replacement of the module.
  expect(rewritten.contents).toContain("export * from './environment/index.mjs';")
  expect(rewritten.contents).toContain("export * from './hashing/index.mjs';")
  // A source rewrite with the wrong loader is a module bun parses as something else.
  expect(rewritten.loader).toBe('js')
})

test('⚠ a system.mjs that lost the bare-star line is a named build failure, never a pass-through', () => {
  // The realistic reshape: typebox emitting the same re-export with double quotes.
  const path = systemFixture({
    system: 'export * from "./arguments/index.mjs";\n',
    argumentsIndex: ARGUMENTS_INDEX_MJS,
  })
  expect(() => rewrittenSource(path)).toThrow(/enso-strict-binding-workaround: /)
  expect(() => rewrittenSource(path)).toThrow(/system\.mjs lost the bare-star line/)
})

test('⚠ an arguments/index.mjs that is no longer the aliased one-liner throws with its content quoted', () => {
  const path = systemFixture({
    system: SYSTEM_MJS,
    argumentsIndex: "export * from './arguments.mjs';\nexport const Arguments = [];\n",
  })
  expect(() => rewrittenSource(path)).toThrow(/no longer exactly the aliased one-liner/)
  // Quoted, because the next reader has to decide whether the inlined alias is still faithful.
  expect(() => rewrittenSource(path)).toThrow(/export \* from '\.\/arguments\.mjs';/)
})

test('⚠ the plugin still matches and rewrites the typebox that is installed, not only a fixture', () => {
  expect(existsSync(INSTALLED_TYPEBOX_SYSTEM)).toBe(true)
  // A filter that stopped matching would fire nothing and say nothing — the one stale shape
  // the plugin's own verification cannot reach.
  expect(captureOnLoad(strictBindingWorkaround).filter.test(INSTALLED_TYPEBOX_SYSTEM)).toBe(true)
  expect(rewrittenSource(INSTALLED_TYPEBOX_SYSTEM).contents).toContain(
    "export * as Arguments from './arguments/arguments.mjs';",
  )
})
