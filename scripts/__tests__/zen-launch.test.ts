import { expect, test } from 'bun:test'
import { isPrintRun, piArguments, piVersionSupported, piVersionText, SUPPORTED_PI_VERSIONS } from '../zen-launch.ts'

/**
 * The terminal launcher's decisions (docs/flows/boot-and-launchers.md, stated gap: `zen.ts`
 * had no test of its own). The launcher spawns pi and is not driven here; what it decides
 * before spawning is — the isolation triple, the print-run reading, and the version range,
 * against a `pi --version` line of the test's making. The vendor-path precondition moved out
 * with #221 — it is pi's manifest layout, not the launcher's decision, and is pinned at its
 * owner (`packages/core/src/__tests__/pi-manifest.test.ts`). Whether the RANGE still covers
 * the pi the guard corpus pins against is a different question again, and is
 * `pi-version-parity.test.ts`, beside this file.
 */

// ⚠ THE ISOLATION TRIPLE. Two legs are arguments and one is the environment; the arguments
// must be exactly these, in this order, BEFORE whatever the user passed — a flag the user adds
// cannot displace `--no-skills`, which neither of the other two covers (header).
test('pi is launched with --no-extensions, --no-skills and -e <package>, ahead of the user’s arguments', () => {
  expect(piArguments('/pkg', ['-p', 'hello'])).toEqual(['--no-extensions', '--no-skills', '-e', '/pkg', '-p', 'hello'])
  expect(piArguments('/pkg', [])).toEqual(['--no-extensions', '--no-skills', '-e', '/pkg'])
})

test('a print run is -p, --print, or stdin that is not a TTY; an interactive run is none of those', () => {
  expect(isPrintRun(['-p', 'x'], true)).toBe(true)
  expect(isPrintRun(['--print', 'x'], true)).toBe(true)
  expect(isPrintRun([], false)).toBe(true)
  expect(isPrintRun([], true)).toBe(false)
  expect(isPrintRun(['--model', 'x'], true)).toBe(false)
})

// ── #217: the pi on PATH must be one the guard's replica was pinned against ───────────────

// ⚠ The BOUNDARIES, which are the whole content of the predicate: the minimum is supported and
// the patch below it is not; the excluded version is refused and the patch below it is not.
// These four also pin the `^0.84.4` semantics the harness manifest's peer range states.
test('the tested pi range includes its minimum and excludes the version it stops below', () => {
  expect(piVersionSupported(piVersionText(SUPPORTED_PI_VERSIONS.minimum))).toBe(true)
  expect(piVersionSupported('0.84.3')).toBe(false)
  expect(piVersionSupported(piVersionText(SUPPORTED_PI_VERSIONS.below))).toBe(false)
  expect(piVersionSupported('0.84.9')).toBe(true)
})

// ⚠ FAIL CLOSED: a version the launcher cannot read is a pi the corpus says nothing about, so
// it is refused rather than launched. A prerelease of the excluded version is one of those —
// the numeric core reads as the excluded version itself.
test('a pi whose version cannot be read, or is a prerelease of the excluded version, is refused', () => {
  expect(piVersionSupported('')).toBe(false)
  expect(piVersionSupported('unknown')).toBe(false)
  expect(piVersionSupported('0.84')).toBe(false)
  expect(piVersionSupported('0.85.0-rc.1')).toBe(false)
  // …and a version printed with company around it is still read: `pi --version` may grow a banner.
  expect(piVersionSupported('pi 0.84.7 (bun 1.4.0)')).toBe(true)
})

// ⚠ WHOSE number is it (PR #294 review). "The first triple in the output" read bun's version
// when a banner named bun first — a wrong refusal when that number falls outside the range and
// a wrong ACCEPTANCE when it falls inside, on the one gate standing between the guard and a
// deny computed against the wrong target. pi's own name decides; a bare triple is the fallback.
test("the version read is pi's, whatever else the banner names first (#217)", () => {
  // The dangerous shape: another component's number is in range, pi's is not.
  expect(piVersionSupported('bun 0.84.5 / pi 0.85.3')).toBe(false)
  // …and its mirror: the leading number is out of range, pi's is in it.
  expect(piVersionSupported('bun 1.4.0 / pi 0.84.7')).toBe(true)
  expect(piVersionSupported('pi@0.84.7')).toBe(true)
  expect(piVersionSupported('pi v0.84.7')).toBe(true)
  // A banner that names no pi version at all is no version claim: refused.
  expect(piVersionSupported('bun 1.4.0 (linux x64)')).toBe(false)
})
