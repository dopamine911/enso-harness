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
 * The tested range is stated ONCE, here, and both ends read it: `enso.ts` refuses a `pi` outside it
 * before the spawn, and `scripts/__tests__/pi-version-parity.test.ts` asserts the workspace pi the
 * corpus pins against is inside it. It is `^0.87.1`: the harness's peer range and the workspace
 * devDependency.
 *
 * @invariant boot-and-launchers/pi-version-gate The terminal launcher refuses a `pi` it was not pinned against (#217).
 * The two surfaces resolve pi differently and only one was bounded: in-process imports the WORKSPACE
 * copy, while the terminal launcher spawns the first `pi` on `PATH`. The guard REPLICATES pi's path
 * resolver (`packages/harness/core/paths.ts`; `resolveToCwd` is not on pi's export map) and the corpus
 * that keeps the copy honest (`packages/harness/core/__tests__/paths.test.ts`) reads the workspace
 * copy, so on the terminal surface the guard could resolve a path differently from the tool it gates,
 * and compute a deny against the wrong target, with the whole suite green (measured 2026-09-18 with a
 * shim printing `0.85.0` earlier on `PATH`). So `enso.ts` reads `pi --version` before the spawn and
 * refuses outside this range, naming both bounds, with no override flag: the range means "the corpus
 * has been run against this", and `packages/harness/package.json` → `peerDependencies` states the same
 * bound. Widening it means running the corpus against the new pi FIRST.
 *
 * The probe fails closed three ways beside the range: it is bounded at 5s (a wedged `pi --version`
 * used to park the launcher silently, worse than the refusal it exists to print, and arming a kill is
 * not enough, since a shell shim's own child holds the pipe open, so the deadline races the READ), a
 * non-zero exit is refused rather than parsed, and a banner carrying no pi version is no version
 * claim. What it does NOT cover: the versions of the libraries inside the pi binary's own tree.
 */
export const SUPPORTED_PI_VERSIONS = {
  /** The oldest pi the corpus has been run against. */
  minimum: { major: 0, minor: 87, patch: 1 },
  /** The first pi it has NOT been run against. */
  below: { major: 0, minor: 88, patch: 0 },
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
 * ⚠ Reads the NUMERIC core only: a prerelease of the excluded version (`0.88.0-rc.1`) reads as
 * `0.88.0` and is refused, and output carrying no version at all is refused. Both are the safe
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
 * pi's arguments: the isolation triple's two argument legs, then whatever the user passed. The
 * third leg, `PI_CODING_AGENT_DIR`, is on the spawn's environment, not an argument.
 *
 * @invariant boot-and-launchers/isolation-triple Isolation is three mechanisms, each closing a different hole, and the same three at both launch points.
 * `PI_CODING_AGENT_DIR` points the runtime at `ENSO_HOME/pi-agent` (`~/.enso`, #421): none of the
 * user's packages, settings or credentials are visible. `--no-extensions` turns discovery off,
 * including this repo's own `.pi/settings.json`, which installs the package and would load it twice.
 * `--no-skills` is required and covered by neither: `~/.agents/skills/` is outside the agent dir.
 * They go BEFORE the user's arguments, so a flag the user adds cannot displace them. The host applies
 * the same triple as loader options and sets the env at creation, before the first services (it is
 * read at module import).
 *
 * The permission rules are pinned the same way at both points (#446): `PICC_PERMISSION_MODES_CONFIG_PATH`
 * names `ENSO_HOME/permissions.json`, prepared first by `preparePermissionRules`: seeded with Enso's
 * deny rules when missing or empty (an empty file would make the extension import
 * `~/.claude/settings.json`), refused when unreadable, and the launcher says which on stderr, the host
 * in its log.
 *
 * @invariant boot-and-launchers/package-dir `-e` receives the package directory, never extension files.
 * Loaded by package rules, the manifest drives every resource kind: extensions, skills, prompts and
 * themes. Files passed individually loaded the extensions and silently dropped everything else. The
 * ONE package is the harness, or its print variant.
 */
export function piArguments(packageToLoad: string, passthroughArgs: readonly string[]): string[] {
  return ['--no-extensions', '--no-skills', '-e', packageToLoad, ...passthroughArgs]
}
