import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findRepoRoot, harnessPackageDir } from '@enso/core/paths'

/**
 * THE #4 TRIPWIRE — the arbiter trigger, made structural.
 *
 * pi's `tool_call` protocol has a veto and no approve: handlers stack, only `block`
 * short-circuits, and what a stack produces is a union of vetoes emergent from load order.
 * #4 designed the arbiter that fixes this (one handler owning the verdict, participants as
 * libraries with priority + claim-or-skip + a discriminated decisionReason — the merged
 * design lives in #4's comments) and then DEFERRED the build when a permission-modes extension
 * was adopted (picc then; `@gotgenes/pi-permission-system` since #496): two participants with
 * aligned fail direction are tolerable.
 *
 * The recorded trigger: **a third `tool_call` participant is where evaluation order stops
 * being reasonable by luck** — and two fail-closed handlers already compose to "nothing
 * runs" in non-interactive mode (verified live; that hazard is why the print harness
 * strips the permission engine, #20). The discipline has been to design AROUND the trigger: cc-safety-net
 * went in as a LIBRARY inside the guards handler precisely to keep the count at two, and
 * web_fetch registers a TOOL, not a handler.
 *
 * A trigger that lives in an issue nobody re-reads is a convention with no check. This
 * test is the check.
 *
 * ⚠ IF THIS TEST JUST WENT RED because you added a `tool_call` handler: you are the third
 * participant. Do NOT add yourself to the allowed list — that is exactly the drift this
 * anchor exists to refuse. Either contribute your logic as a library inside the guards
 * handler (the cc-safety-net pattern), or the deferred arbiter (#4) is now due: read that
 * issue's comments first — the design is already worked out there, including the shipped
 * shapes it merges and the fail-mode lessons it must carry.
 *
 * ⚠ Accepted tradeoff (PR #62 review): detection is a literal-string scan, the same
 * tradeoff every anchor here makes — a registration through a constant
 * (`pi.on(TOOL_CALL_EVENT, …)`) would evade it. The anchor guards against DRIFT by
 * honest collaborators, not evasion; an in-repo evader is a review problem, not a scan
 * problem.
 */

const repositoryRoot = findRepoRoot(import.meta.url)
const harnessRoot = harnessPackageDir(repositoryRoot)

/**
 * The two known participants, in load order (load order is a security property — the
 * manifest enumerates extensions explicitly, guards first). Paths relative to the
 * harness package root. Asserted by NAME and by set equality: a drifted set gets a
 * named offender, never a count that quietly moves.
 */
const ALLOWED_TOOL_CALL_PARTICIPANTS = [
  'extensions/guards/index.ts',
  'node_modules/@gotgenes/pi-permission-system/src/index.ts',
] as const

/**
 * Matches a registration in any quote style, the event name on the next line included (gotgenes
 * writes `pi.on(\n "tool_call",`, which a same-line pattern missed, #496); a `.d.ts` overload
 * declares, never registers.
 */
const TOOL_CALL_REGISTRATION_PATTERN = /on\(\s*(["'`])tool_call\1/

function isScannableSource(fileName: string): boolean {
  if (fileName.endsWith('.test.ts') || fileName.endsWith('.d.ts')) return false
  return /\.(ts|tsx|js|mjs|cjs)$/.test(fileName)
}

/** Walk one directory tree for registration sites. `realpathSync` first — the vendor dirs are symlinks. */
function registrationSitesUnder(rootDirectory: string): string[] {
  const sites: string[] = []
  const resolvedRoot = realpathSync(rootDirectory)
  for (const dirEntry of readdirSync(resolvedRoot, { withFileTypes: true, recursive: true })) {
    if (!(dirEntry.isFile() && isScannableSource(dirEntry.name))) continue
    const absolutePath = join(dirEntry.parentPath, dirEntry.name)
    const treeRelative = relative(resolvedRoot, absolutePath)
    if (treeRelative.includes('__tests__') || treeRelative.includes('node_modules')) continue
    if (TOOL_CALL_REGISTRATION_PATTERN.test(readFileSync(absolutePath, 'utf8'))) {
      sites.push(treeRelative)
    }
  }
  return sites
}

/** Every tree that can put a handler in front of pi: our extensions + each declared vendor package. */
function declaredExtensionTrees(): { root: string; prefix: string }[] {
  const manifest = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')) as {
    pi?: { extensions?: string[] }
  }
  const trees: { root: string; prefix: string }[] = [{ root: join(harnessRoot, 'extensions'), prefix: 'extensions' }]
  for (const extensionEntry of manifest.pi?.extensions ?? []) {
    if (!extensionEntry.startsWith('node_modules/')) continue
    // The package directory: the first one or two path segments after node_modules/.
    const segments = extensionEntry.split('/')
    const packageEnd = segments[1]?.startsWith('@') === true ? 3 : 2
    const packageDir = segments.slice(0, packageEnd).join('/')
    trees.push({ root: join(harnessRoot, packageDir), prefix: packageDir })
  }
  return trees
}

// @pins guarded-tool-call/two-participants boot-and-launchers/manifest-order
test("⚠ exactly the two known tool_call participants — a third means #4's arbiter is due", () => {
  const found = declaredExtensionTrees()
    .flatMap(({ root, prefix }) => registrationSitesUnder(root).map((site) => join(prefix, site)))
    .toSorted()
  expect(found).toEqual([...ALLOWED_TOOL_CALL_PARTICIPANTS].toSorted())
})

test('the vendored participant list itself is current — every declared vendor tree was scanned', () => {
  // The tripwire is only as wide as its scan: every node_modules extension entry in the
  // manifest must resolve to a scannable tree, or a renamed vendor would silently drop
  // out of the participant count (the vacuous-pass shape).
  const vendorTrees = declaredExtensionTrees().filter(({ prefix }) => prefix.startsWith('node_modules/'))
  expect(vendorTrees.length).toBeGreaterThanOrEqual(2)
  for (const { root } of vendorTrees) {
    expect(() => realpathSync(root)).not.toThrow()
  }
})

test('every LOCAL manifest extension lives under the scanned extensions/ tree — the local half of the width pin', () => {
  // Same vacuous-pass shape from the other direction (PR #62 review): the local scan is
  // one fixed tree, so a future manifest entry like ./tools/foo.ts would sit in front of
  // pi without ever being scanned. Offenders named; whoever moves an extension out of
  // extensions/ extends the scan consciously, in this file.
  const manifest = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')) as {
    pi?: { extensions?: string[] }
  }
  const unscannedLocalEntries = (manifest.pi?.extensions ?? [])
    .filter((extensionEntry) => !extensionEntry.startsWith('node_modules/'))
    .filter((extensionEntry) => !extensionEntry.startsWith('./extensions/'))
  expect(unscannedLocalEntries).toEqual([])
})
