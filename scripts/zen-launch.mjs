import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The terminal launcher's decisions, apart from the launch (`zen.mjs` spawns; this decides):
 * the isolation triple as pi's arguments, the print-run trigger, the vendor paths a manifest
 * declares that are not there, and whether the pi it is about to spawn is one the guard was
 * pinned against. Pure so `scripts/__tests__/zen-launch.test.ts` can pin them — the launcher
 * itself has no test, because it spawns pi (docs/flows/boot-and-launchers.md).
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
 * ⚠ THE PI THE GUARD'S REPLICA IS PINNED AGAINST (#217). `packages/harness/core/paths.ts`
 * REPLICATES pi's path normaliser — it is not on pi's export map, so it is copied, and
 * `packages/harness/core/__tests__/paths.test.ts` keeps the copy honest against the pi in the
 * WORKSPACE tree (`import.meta.resolve`). `zen.mjs` spawns a bare `pi` from `PATH`, which is a
 * different resolution bounded by nothing: measured 2026-09-18, a shim reporting 0.85.0 earlier
 * on `PATH` launched with the whole suite green — so the guard could resolve a path differently
 * from the tool it gates, and a deny would be computed against the wrong target.
 *
 * So the tested range is stated ONCE, here, and both ends read it: `zen.mjs` refuses a `pi`
 * outside it before the spawn, and `scripts/__tests__/pi-version-parity.test.ts` asserts the workspace pi the
 * corpus pins against is inside it. Widening it means running the corpus against the new pi
 * FIRST. It is `^0.84.4` — the harness's peer range and the workspace devDependency.
 */
export const SUPPORTED_PI_VERSIONS = {
  /** The oldest pi the corpus has been run against. */
  minimum: { major: 0, minor: 84, patch: 4 },
  /** The first pi it has NOT been run against. */
  below: { major: 0, minor: 85, patch: 0 },
}

/** @typedef {{ major: number, minor: number, patch: number }} PiVersion */

/**
 * The three numbers, as a version is written.
 * @param {PiVersion} version
 * @returns {string}
 */
export function piVersionText(version) {
  return `${version.major}.${version.minor}.${version.patch}`
}

/**
 * The first `major.minor.patch` in the text, or null when it carries none.
 * @param {string} text
 * @returns {PiVersion | null}
 */
function versionIn(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (match === null) return null
  const [, major, minor, patch] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/**
 * Negative when `left` is the older version, zero when they are the same, positive when newer.
 * @param {PiVersion} left
 * @param {PiVersion} right
 * @returns {number}
 */
function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

/**
 * Whether the version `pi --version` reported is inside {@link SUPPORTED_PI_VERSIONS}.
 *
 * ⚠ Reads the NUMERIC core only: a prerelease of the excluded version (`0.85.0-rc.1`) reads as
 * `0.85.0` and is refused, and output carrying no version at all is refused. Both are the safe
 * direction — an unknown pi is exactly the case the corpus says nothing about.
 * @param {string} reportedVersion whatever `pi --version` printed
 * @returns {boolean}
 */
export function piVersionSupported(reportedVersion) {
  const reported = versionIn(reportedVersion)
  if (reported === null) return false
  return (
    compareVersions(reported, SUPPORTED_PI_VERSIONS.minimum) >= 0 &&
    compareVersions(reported, SUPPORTED_PI_VERSIONS.below) < 0
  )
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
