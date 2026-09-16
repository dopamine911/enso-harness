import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The terminal launcher's decisions, apart from the launch (`zen.mjs` spawns; this decides):
 * the isolation triple as pi's arguments, the print-run trigger, and the vendor paths a
 * manifest declares that are not there. Pure so `scripts/__tests__/zen-launch.test.ts` can
 * pin them — the launcher itself has no test, because it spawns pi (docs/flows/boot-and-launchers.md).
 */

const VENDOR_PATH_PREFIX = 'node_modules/'

/**
 * Every resource path the manifest declares under `pi.*`, flattened.
 * @param {{ pi?: Record<string, unknown> }} manifest
 * @returns {string[]}
 */
export function declaredResources(manifest) {
  return Object.values(manifest.pi ?? {})
    .flatMap((paths) => (Array.isArray(paths) ? paths : [paths]))
    .filter((resourcePath) => typeof resourcePath === 'string')
}

/**
 * ⚠ pi does NOT error on a manifest resource path that does not exist — it skips it
 * silently (verified 2026-09-03: the vendor extension did not load and nothing was
 * reported). npm workspaces hoist our vendor packages to the repo root, so those paths
 * are missing until `bun run link:vendor` materializes them. The launcher checks and
 * refuses, because the alternative is a session that looks correct and is missing
 * whatever the vendor package was supposed to provide.
 * @param {{ pi?: Record<string, unknown> }} manifest
 * @param {string} packageRoot
 * @returns {string[]} the declared `node_modules/…` paths that do not exist under `packageRoot`
 */
export function missingVendorPaths(manifest, packageRoot) {
  return declaredResources(manifest)
    .filter((resourcePath) => resourcePath.startsWith(VENDOR_PATH_PREFIX))
    .filter((resourcePath) => !existsSync(resolve(packageRoot, resourcePath)))
}

/**
 * ⚠ PRINT RUNS LOAD A VARIANT PACKAGE WITHOUT picc-permission-modes (#20). The trigger is
 * "this run cannot prompt": an explicit `-p`/`--print`, or stdin that is not a TTY (piped
 * input cannot answer a permission dialog even without -p). Interactive runs keep the full
 * package and the full permission model.
 * @param {readonly string[]} passthroughArgs
 * @param {boolean} stdinIsTty
 */
export function isPrintRun(passthroughArgs, stdinIsTty) {
  return passthroughArgs.includes('-p') || passthroughArgs.includes('--print') || !stdinIsTty
}

/**
 * pi's arguments: the isolation triple, then whatever the user passed.
 *   --no-extensions  disables discovery, which also suppresses the PROJECT-local
 *                    `.pi/settings.json` that would otherwise load this package twice;
 *   --no-skills      ⚠ REQUIRED, and neither the agent dir nor --no-extensions covers it:
 *                    pi discovers skills from `~/.agents/skills/` too;
 *   -e <package>     the ONE package to load — the harness, or its print variant.
 * (`PI_CODING_AGENT_DIR` is the third leg, on the spawn's environment, not an argument.)
 * @param {string} packageToLoad
 * @param {readonly string[]} passthroughArgs
 * @returns {string[]}
 */
export function piArguments(packageToLoad, passthroughArgs) {
  return ['--no-extensions', '--no-skills', '-e', packageToLoad, ...passthroughArgs]
}
