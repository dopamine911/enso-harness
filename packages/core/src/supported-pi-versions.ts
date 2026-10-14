/**
 * The pi versions the guard was pinned against, and the check both ends of Enso make against them.
 *
 * Two places run pi, and both must refuse one the guard was not pinned against (#217, #953):
 *
 *   terminal launcher  `scripts/enso.ts` reads `pi --version` BEFORE it spawns the first `pi` on
 *                      `PATH`, and refuses outside the range.
 *   the harness        `packages/harness/extensions/guards/index.ts` reads the RUNNING pi's own
 *                      `VERSION` when it loads, so a `pi install npm:…` (which never runs the
 *                      launcher) still refuses an unsupported pi — fail closed, every tool call.
 *
 * It lives in `@enso/core` since #953 so both read ONE range and say ONE refusal: it was the
 * launcher's alone (`scripts/enso-launch.ts`) while only the launcher enforced it. Pure, so the
 * barrel stays browser-safe.
 *
 * @module
 */

/**
 * The tested range is stated ONCE, here, and every end reads it: `enso.ts` refuses a `pi` outside it
 * before the spawn, the guards extension refuses every tool call under a running pi outside it, and
 * `scripts/__tests__/pi-version-parity.test.ts` asserts the workspace pi the corpus pins against is
 * inside it. It is `~1.1.0` (at least 1.1.0, below 1.2.0): the harness's workspace devDependency on
 * pi. Not its peer range, which is pi's `"*"` because pi's installer never reads one (#952).
 *
 * @invariant boot-and-launchers/pi-version-gate The terminal launcher refuses a `pi` it was not pinned against (#217), and the harness refuses one too, wherever it is loaded (#953).
 * The two surfaces resolve pi differently and only one was bounded: in-process imports the WORKSPACE
 * copy, while the terminal launcher spawns the first `pi` on `PATH`. The guard REPLICATES pi's path
 * resolver (`packages/harness/core/paths.ts`; `resolveToCwd` is not on pi's export map) and the corpus
 * that keeps the copy honest (`packages/harness/core/__tests__/paths.test.ts`) reads the workspace
 * copy, so on the terminal surface the guard could resolve a path differently from the tool it gates,
 * and compute a deny against the wrong target, with the whole suite green (measured 2026-09-18 with a
 * shim printing `0.85.0` earlier on `PATH`). So `enso.ts` reads `pi --version` before the spawn and
 * refuses outside this range, naming both bounds, with no override flag: the range means "the corpus
 * has been run against this", and `packages/harness/package.json` → `devDependencies` states the same
 * bound. Widening it means running the corpus against the new pi FIRST.
 *
 * ⚠ The launcher is not the only way in (#953): `pi install npm:<package>` loads the harness into
 * whatever pi the user has, and never runs `enso.ts`. So the guards extension checks the running pi's
 * `VERSION` too, and refuses every tool call outside this range — the same fail-closed floor a policy
 * naming a missing tool takes.
 *
 * The launcher's probe fails closed three ways beside the range: it is bounded at 5s (a wedged
 * `pi --version` used to park the launcher silently, worse than the refusal it exists to print, and
 * arming a kill is not enough, since a shell shim's own child holds the pipe open, so the deadline
 * races the READ), a non-zero exit is refused rather than parsed, and a banner carrying no pi version
 * is no version claim. What it does NOT cover: the versions of the libraries inside the pi binary's
 * own tree.
 *
 * @group Guards
 */
export const SUPPORTED_PI_VERSIONS = {
  /** The oldest pi the corpus has been run against. */
  minimum: { major: 1, minor: 1, patch: 0 },
  /** The first pi it has NOT been run against. */
  below: { major: 1, minor: 2, patch: 0 },
}

/**
 * A semantic version, as pi reports one.
 *
 * ⚠ NOT `PiVersion` (#165, surfaced by #308): a `Pi`-prefixed name on a first-party shape is
 * retired vocabulary — it reads as the vendor's type when it is ours.
 *
 * @group Guards
 */
export interface ReportedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/**
 * The three numbers, as a version is written.
 *
 * @group Guards
 */
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
 * The version a pi reported, or null when the text carries none.
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
 * Whether the version a pi reported is inside {@link SUPPORTED_PI_VERSIONS}.
 *
 * ⚠ Reads the NUMERIC core only: a prerelease of the excluded version (`0.88.0-rc.1`) reads as
 * `0.88.0` and is refused, and text carrying no version at all is refused. Both are the safe
 * direction — an unknown pi is exactly the case the corpus says nothing about.
 *
 * @param reportedVersion whatever `pi --version` printed, or the running pi's own `VERSION`
 * @group Guards
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
 * Why a pi is refused: what it reported, the range, why the range exists, and how it is widened —
 * the same words wherever the refusal is made, so the launcher's stderr and the guard's denial read
 * alike. `subject` names which pi: "the \`pi\` on PATH" for the launcher, "the running pi" for the
 * harness. Ends in a newline, as the launcher writes it.
 *
 * @param subject which pi reported the version, as the sentence opens
 * @param reportedVersion what it reported; empty when it reported nothing
 * @group Guards
 */
export function unsupportedPiVersionReason(subject: string, reportedVersion: string): string {
  return (
    `${subject} reports ${reportedVersion === '' ? 'no version' : reportedVersion}, ` +
    `outside the range the guards are pinned against ` +
    `(>=${piVersionText(SUPPORTED_PI_VERSIONS.minimum)} <${piVersionText(SUPPORTED_PI_VERSIONS.below)}).\n` +
    "The guard replicates pi's path resolver; against an unpinned pi a deny can be computed against the wrong\n" +
    'target (#217). Either use the pinned pi, or run the corpus against this one and widen the range:\n' +
    '  bun test packages/harness/core/__tests__/paths.test.ts   then packages/core/src/supported-pi-versions.ts#SUPPORTED_PI_VERSIONS\n'
  )
}
