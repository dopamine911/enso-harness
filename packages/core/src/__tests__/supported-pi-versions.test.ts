import { expect, test } from 'bun:test'
import {
  piVersionSupported,
  piVersionText,
  SUPPORTED_PI_VERSIONS,
  unsupportedPiVersionReason,
} from '../supported-pi-versions.ts'

/**
 * The pi version range both ends refuse outside (#217, #953): the terminal launcher before it spawns
 * the `pi` on `PATH`, and the harness's guard against the pi it runs in. These boundary tests were
 * the launcher's (`scripts/__tests__/enso-launch.test.ts`) until the range moved here with #953; they
 * moved unchanged. Whether the range still covers the pi the guard corpus pins against is
 * `scripts/__tests__/pi-version-parity.test.ts`.
 */

// ⚠ The BOUNDARIES, which are the whole content of the predicate: the minimum is supported and
// the patch below it is not; the excluded version is refused and the patch below it is not.
// These four also pin the `~1.1.0` semantics the harness manifest's pi devDependency states.
// @pins boot-and-launchers/pi-version-gate
test('the tested pi range includes its minimum and excludes the version it stops below', () => {
  expect(piVersionSupported(piVersionText(SUPPORTED_PI_VERSIONS.minimum))).toBe(true)
  expect(piVersionSupported('1.0.4')).toBe(false)
  expect(piVersionSupported(piVersionText(SUPPORTED_PI_VERSIONS.below))).toBe(false)
  expect(piVersionSupported('1.1.9')).toBe(true)
})

// ⚠ FAIL CLOSED: a version the launcher cannot read is a pi the corpus says nothing about, so
// it is refused rather than launched. A prerelease of the excluded version is one of those —
// the numeric core reads as the excluded version itself.
// @pins boot-and-launchers/pi-version-gate
test('a pi whose version cannot be read, or is a prerelease of the excluded version, is refused', () => {
  expect(piVersionSupported('')).toBe(false)
  expect(piVersionSupported('unknown')).toBe(false)
  expect(piVersionSupported('1.1')).toBe(false)
  expect(piVersionSupported('1.2.0-rc.1')).toBe(false)
  // …and a version printed with company around it is still read: `pi --version` may grow a banner.
  expect(piVersionSupported('pi 1.1.7 (bun 1.4.0)')).toBe(true)
})

// ⚠ WHOSE number is it (PR #294 review). "The first triple in the output" read bun's version
// when a banner named bun first — a wrong refusal when that number falls outside the range and
// a wrong ACCEPTANCE when it falls inside, on the one gate standing between the guard and a
// deny computed against the wrong target. pi's own name decides; a bare triple is the fallback.
// @pins boot-and-launchers/pi-version-gate
test("the version read is pi's, whatever else the banner names first (#217)", () => {
  // The dangerous shape: another component's number is in range, pi's is not.
  expect(piVersionSupported('bun 1.1.5 / pi 1.2.3')).toBe(false)
  // …and its mirror: the leading number is out of range, pi's is in it.
  expect(piVersionSupported('bun 1.4.0 / pi 1.1.7')).toBe(true)
  expect(piVersionSupported('pi@1.1.7')).toBe(true)
  expect(piVersionSupported('pi v1.1.7')).toBe(true)
  // A banner that names no pi version at all is no version claim: refused.
  expect(piVersionSupported('bun 1.4.0 (linux x64)')).toBe(false)
})

// One refusal, two places (#953): the launcher writes it to stderr after `enso: `, and the guard puts
// it in every denial. The text names what was reported, both bounds, and where the range is widened —
// the file it moved to, so a reader following the instruction lands on the constant.
test('the refusal names the reported version, both bounds and where the range lives; an empty report reads as no version', () => {
  const reason = unsupportedPiVersionReason('the running pi', '1.2.0')
  expect(reason.startsWith('the running pi reports 1.2.0, outside the range the guards are pinned against')).toBe(true)
  expect(reason).toContain(
    `(>=${piVersionText(SUPPORTED_PI_VERSIONS.minimum)} <${piVersionText(SUPPORTED_PI_VERSIONS.below)})`,
  )
  expect(reason).toContain('packages/core/src/supported-pi-versions.ts#SUPPORTED_PI_VERSIONS')
  expect(reason.endsWith('\n')).toBe(true)
  expect(unsupportedPiVersionReason('the `pi` on PATH', '')).toStartWith('the `pi` on PATH reports no version,')
})
