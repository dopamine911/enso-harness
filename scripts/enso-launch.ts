/**
 * The terminal launcher's decisions, apart from the launch (`enso.ts` spawns; this decides):
 * the isolation triple as pi's arguments, the print-run trigger, and whether the pi it is
 * about to spawn is one the guard was pinned against. Pure so
 * `scripts/__tests__/enso-launch.test.ts` can pin them — the launcher itself has no test,
 * because it spawns pi (docs/flows/boot-and-launchers.md).
 *
 * ⚠ The vendor-path precondition is NOT here. It was, in a copy of its own, until #221 gave
 * pi's manifest-resource layout one owner: `@enso/core/pi-manifest`. `enso.ts` calls that
 * directly, as the server and the linker do.
 */

/**
 * ⚠ THE PI THE GUARD'S REPLICA IS PINNED AGAINST (#217). `packages/harness/core/paths.ts`
 * REPLICATES pi's path normaliser — it is not on pi's export map, so it is copied, and
 * `packages/harness/core/__tests__/paths.test.ts` keeps the copy honest against the pi in the
 * WORKSPACE tree (`import.meta.resolve`). `enso.ts` spawns a bare `pi` from `PATH`, which is a
 * different resolution bounded by nothing: measured 2026-09-18, a shim reporting 0.85.0 earlier
 * on `PATH` launched with the whole suite green — so the guard could resolve a path differently
 * from the tool it gates, and a deny would be computed against the wrong target.
 *
 * So the tested range is stated ONCE, here, and both ends read it: `enso.ts` refuses a `pi`
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

/**
 * A semantic version, as `pi --version` reports one.
 *
 * ⚠ NOT `PiVersion` (#165, surfaced by #308): a `Pi`-prefixed name on a first-party shape is
 * retired vocabulary — it reads as the vendor's type when it is ours. The JSDoc `@typedef` it
 * was before the move said `PiVersion` and `glossary-gate.test.ts` could not see it; a real
 * declaration is code, and the gate found it the moment the file became TypeScript.
 */
export interface ReportedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** The three numbers, as a version is written. */
export function piVersionText(version: ReportedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/**
 * `pi 0.84.7`, `pi@0.84.7`, `pi/0.84.7`, `pi v0.84.7` — the version with pi's own name on it.
 *
 * ⚠ The name PRECEDES the version here (PR #294 review). A banner that inverted them
 * (`0.84.7 (pi)`) is read by `LEADING_VERSION` below while the version leads the line, and
 * by nothing if something else leads it — a refusal, which is the safe direction and the
 * only one this gate may take when it cannot tell whose number it is holding.
 */
const PI_NAMED_VERSION = /\bpi[@ /]?\s*v?(\d+)\.(\d+)\.(\d+)/i
/** `0.84.4`, `v0.84.4` — a banner that is only the version, which is what today's pi prints. */
const LEADING_VERSION = /^\s*v?(\d+)\.(\d+)\.(\d+)/

/**
 * The version `pi --version` reported, or null when its output carries none.
 *
 * ⚠ Not "the first triple anywhere" (PR #294 review). This gate stands between the guard and
 * computing a deny against the wrong target, and a banner naming another component first —
 * `bun 1.4.0 / pi 0.84.7` — would have matched bun's number: a wrong refusal at best, and a
 * wrong ACCEPTANCE whenever the other component's number happens to fall inside the range.
 * So pi's own name is looked for first, and a bare leading triple (today's output) second. A
 * banner that names neither reads as no version, which is refused.
 */
function versionIn(text: string): ReportedVersion | null {
  const match = PI_NAMED_VERSION.exec(text) ?? LEADING_VERSION.exec(text)
  if (match === null) return null
  const [, major, minor, patch] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/**
 * Negative when `left` is the older version, zero when they are the same, positive when newer.
 */
function compareVersions(left: ReportedVersion, right: ReportedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

/**
 * Whether the version `pi --version` reported is inside {@link SUPPORTED_PI_VERSIONS}.
 *
 * ⚠ Reads the NUMERIC core only: a prerelease of the excluded version (`0.85.0-rc.1`) reads as
 * `0.85.0` and is refused, and output carrying no version at all is refused. Both are the safe
 * direction — an unknown pi is exactly the case the corpus says nothing about.
 * @param reportedVersion whatever `pi --version` printed
 */
export function piVersionSupported(reportedVersion: string): boolean {
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
 */
export function isPrintRun(passthroughArgs: readonly string[], stdinIsTty: boolean): boolean {
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
 */
export function piArguments(packageToLoad: string, passthroughArgs: readonly string[]): string[] {
  return ['--no-extensions', '--no-skills', '-e', packageToLoad, ...passthroughArgs]
}
