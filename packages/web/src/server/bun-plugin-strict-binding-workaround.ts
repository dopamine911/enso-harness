import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Workaround for a live bun bug (dev-server HMR, present in 1.4.0 and the 2026-09-03
 * canary): a bare `export * from "./arguments/index.mjs"` makes the HMR wrapper
 * materialize an import binding named `arguments` — illegal in strict mode — so the whole
 * dev bundle becomes one SyntaxError ("Invalid destructuring assignment target" in the
 * browser) and the app never mounts. typebox's `system/system.mjs` hits it.
 *
 * ⚠ The binding name comes from the IMPORT SPECIFIER TEXT, not the resolved file: bun
 * takes the specifier's basename up to the first dot and, for `index`, falls back to the
 * parent directory segment — `arguments`. Two onResolve redirections (suffixed path, then
 * a renamed basename) were tried first and the binding did not move, which is the receipt
 * for "specifier-derived"; only rewriting the importing SOURCE changes it.
 *
 * So this plugin rewrites that one line of system.mjs at load time, inlining what
 * `arguments/index.mjs` itself does, in the ALIASED form bun names by alias instead of
 * by path (verified in the bundle: `var [Arguments7] = hmr.imports`):
 *
 *     export * from './arguments/index.mjs';          // bare star — binding `arguments`
 *  →  export * as Arguments from './arguments/arguments.mjs';   // alias — binding legal
 *
 * The rewrite VERIFIES both file shapes first and throws a named error on any mismatch,
 * so a typebox restructure surfaces as a loud build failure naming this plugin — never a
 * silently wrong module graph. Named imports of the same file (`import { Arguments }
 * from '…/arguments/index.mjs'`, used by compile/convert/pipeline) bind by their own
 * names and are untouched. Delete this plugin (and its bunfig entry) once bun sanitizes
 * reserved identifiers in HMR bindings.
 *
 * Minimal repro of the bug (fails on 1.4.0 and canary): a module `arguments/index.mjs`,
 * a barrel doing `export * from "./arguments/index.mjs"`, `development: { hmr: true }`.
 */

const BARE_STAR_LINE = "export * from './arguments/index.mjs';"
const ALIASED_REPLACEMENT = "export * as Arguments from './arguments/arguments.mjs';"
/** What arguments/index.mjs must contain for the inlined replacement to be faithful. */
const EXPECTED_INDEX_CONTENT = "export * as Arguments from './arguments.mjs';"

class StrictBindingWorkaroundStaleError extends Error {
  constructor(detail: string) {
    super(
      `zen-strict-binding-workaround: typebox no longer matches the shape this plugin ` +
        `rewrites (${detail}). Re-derive the workaround or delete it if bun fixed the ` +
        `reserved-identifier HMR binding bug.`,
    )
    this.name = 'StrictBindingWorkaroundStaleError'
  }
}

const strictBindingWorkaround: import('bun').BunPlugin = {
  name: 'zen-strict-binding-workaround',
  setup(build) {
    build.onLoad({ filter: /typebox[/\\]build[/\\]system[/\\]system\.mjs$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      if (!source.includes(BARE_STAR_LINE)) {
        throw new StrictBindingWorkaroundStaleError('system.mjs lost the bare-star line')
      }
      const indexPath = join(dirname(args.path), 'arguments', 'index.mjs')
      const indexContent = readFileSync(indexPath, 'utf8').trim()
      if (indexContent !== EXPECTED_INDEX_CONTENT) {
        throw new StrictBindingWorkaroundStaleError(
          `arguments/index.mjs is no longer exactly the aliased one-liner (${indexContent})`,
        )
      }
      return {
        contents: source.replace(BARE_STAR_LINE, ALIASED_REPLACEMENT),
        loader: 'js',
      }
    })
  },
}

export default strictBindingWorkaround
