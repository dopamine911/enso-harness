import { expect, test } from 'bun:test'
import { codeOffenders, hasWordSequence, wordsOf } from './gate-support.ts'

/**
 * The seam has an owner: only the host and the pi extensions may name the vendor (#145).
 *
 * ⚠ Enforcement, not a unit test — the same shape as `logging-gate.test.ts`. Two lines,
 * both ratchets:
 *
 *   1. `@earendil-works/*` is imported only under `VENDOR_ROOTS`. Everything else — `@enso/core`,
 *      the server, the browser — talks our shapes, so a pi replacement is a rewrite of two
 *      directories rather than of the product (#69 is the pivot this survived once).
 *   2. A vendor extension's name (`picc`, `pi-multi-account`, `cc-safety-net`) appears in code
 *      only there. Prose may name them — a comment says why a guard exists; an identifier or a
 *      string literal is a dependency.
 *
 * The allowlist IS the leak inventory (`.local/refactor/goals.md` §2 has the table): each entry
 * names one site, its reason, and the leak it maps to. Fixing a leak deletes a line; a new
 * dependency site adds one and must say why. Adding a ROOT, or removing one, is a design
 * conversation — the two roots are the boundary this repo is built on.
 *
 * It reads WORDS, not substrings (PR #150 review), and skips comment lines — both now in
 * `gate-support.ts`, shared with the glossary gates (#165), with the reasons recorded there.
 *
 * A second sensor sits BESIDE this one, not instead of it: `.fallowrc.jsonc` → `boundaries`
 * (#173) checks the same rule on the import graph — re-export chains, type-only imports, a
 * barrel that leaks a zone — which a line scan cannot follow. This scan still catches what
 * the graph cannot: a vendor's NAME in a string literal. Architecture → *Ownership boundary*.
 *
 * What it still cannot catch, said up front: it is a line scan, not a type checker.
 * `EnsoThreadInspection.entries: unknown[]` carries pi's persistence format with no import and
 * no vendor name in it (goals L2). That needs a transcript type of ours. The third test this
 * header once anticipated — vendor-PREFIXED identifiers outside the host — is
 * `glossary-gate.test.ts` (#165), with L2's two files as its allowlist until the transcript
 * type lands. A vendor name assembled at runtime (`"pi" + "cc"`) is out of reach by construction.
 *
 * ⚠ REACH, measured, because "the allowlist IS the leak inventory" is only true of what the
 * walk visits (#215). It scanned three roots with `__tests__` skipped, which left `scripts/`,
 * `packages/web/e2e/` and every `__tests__/` directory invisible: widening to every source
 * root the repo has, tests included, surfaced 2 import lines and 45 name lines in 12 files
 * that the allowlist did not know about — the launcher's picc filter, the docs generator, and
 * ten test files. Every one is a row below now. What is STILL outside the walk, stated rather
 * than implied: `docs/**` (prose may name a vendor; `glossary-doc.test.ts` fences the glossary
 * page), comment lines anywhere (same reason), and MANIFESTS — `package.json`'s
 * `@ladbabynpm/picc-permission-modes` and `packages/harness/package.json`'s `pi.extensions`
 * are where a dependency is declared, not leaked, and `SOURCE_FILE` (`scripts/source-tree.ts`)
 * matches JS/TS only. `test/fallow-config.test.ts` is the gate that holds the manifest honest.
 */

/**
 * Every source root the repo has — `filesUnder` walks each one, `__tests__` included. A root
 * missing from here is a blind spot, not a scope decision: that was #215.
 */
const SEARCHED_ROOTS = [
  'packages/core/src',
  'packages/web/src',
  'packages/harness',
  'packages/web/e2e',
  'scripts',
  'test',
] as const
/** Where the vendor may be named. Removing one of these is a design conversation. */
const VENDOR_ROOTS = ['packages/web/src/host', 'packages/harness/extensions'] as const
/**
 * pi and its libraries, by package scope — in ANY string that names it, not only a
 * `from "…"` clause (PR #150 review): `import("@earendil-works/…")` and
 * `import.meta.resolve("@earendil-works/…")` are the same dependency by another spelling.
 */
const VENDOR_IMPORT = /["']@earendil-works\//
/** One word is the whole name. */
const VENDOR_WORD = 'picc'
/** …and the ones spelled in several words, however they are joined (`cc-safety-net`, `ccSafetyNet`). */
const VENDOR_WORD_SEQUENCES = [
  ['cc', 'safety', 'net'],
  ['pi', 'multi', 'account'],
] as const

function namesVendor(line: string): boolean {
  const words = wordsOf(line)
  return words.includes(VENDOR_WORD) || VENDOR_WORD_SEQUENCES.some((sequence) => hasWordSequence(words, sequence))
}

/**
 * The bundle has none, and the gate keeps it so. #149 removed the bundle's import of pi's
 * `VERSION`; L6 (#162) removed the last two — pi-ai's `Model<Api>` type and its env-key
 * fallback at the provider seam — when `web-search`'s contract named its own `SearchModel` and
 * took the env reader as a parameter (`extensions/web-search/index.ts#searchModelOf`, the one
 * conversion). The single row is what widening the walk to `__tests__` found (#215): it was
 * always there, the walk just never reached it. A new row is a new dependency site, and must
 * say why.
 */
const VENDOR_IMPORT_ALLOWED: readonly string[] = [
  // `import.meta.resolve('@earendil-works/pi-coding-agent')` twice, to load pi's own
  // `utils/paths.js` and pin the guard's replica of `resolveToCwd` and
  // `normalizeWindowsShellPath` against it on every input. The corpus IS the vendor's
  // implementation, so the import is the test. Leaves when the replica does — i.e. when the
  // runtime exports those two functions, or the guard stops needing to agree with them.
  'packages/harness/core/__tests__/paths.test.ts',
  // `import.meta.resolve('@earendil-works/pi-coding-agent')` once, to read the WORKSPACE pi's
  // version and assert the launcher's supported range still covers the pi that corpus is
  // pinned against (#217, arrived with #294). Naming the package IS the question it asks:
  // which pi did `import.meta` reach. Leaves with the range, or with the replica it protects.
  'scripts/__tests__/pi-version-parity.test.ts',
]

/**
 * The leak inventory. Most rows arrived with #215's widening — the sites were live and
 * unlisted, not new — and #221's move brought the two under `packages/core/src/__tests__/`.
 * Grouped by what a pi replacement would have to do with each. No count in this sentence: the
 * generated inventory reads one off the constant, and a second one written here went stale
 * inside a single PR (#222 review).
 */
const VENDOR_NAMED_ALLOWED: readonly string[] = [
  // ── Production code ──
  // The guard's write-allowlist names cc-safety-net's state directory: a path, not an import.
  // Leaves when the harness owns the list of directories an extension may write.
  'packages/core/src/guard.ts',
  // `PICC_EXTENSION_FRAGMENT` — the print variant exists to REMOVE picc from the manifest
  // (#20: no permission modes under `--print`), so it must name the extension it filters, in
  // the constant and in the shape error that fires when no entry matches. Leaves when the
  // harness owns the print manifest instead of a launcher deriving it.
  'scripts/print-harness.ts',
  // One inventory row's `seam` prose says a fake serves "a picc-shaped inspection" — it is
  // generated INTO docs/reference/verification-inventory.md, so the name is data here, not a
  // comment. Leaves when that fake stops replicating picc's `modes` custom entry.
  'scripts/docs/verification-inventory.ts',
  // ── The gates that have to spell the names ──
  // This file: it names the vendors in order to refuse them. Never leaves.
  'test/vendor-gate.test.ts',
  // The glossary page's own fence names the same vendors as the words it permits only under
  // `## Retired`. Never leaves, for the same reason.
  'test/glossary-doc.test.ts',
  // ── Tests that pin a vendor-shaped input ──
  // The launcher tests carry `pi.extensions` manifests verbatim —
  // `node_modules/@ladbabynpm/picc-permission-modes/index.ts` and `node_modules/pi-multi-account/index.ts`
  // are the resources whose linking, filtering and missing-path refusal is under test. A fake
  // manifest that did not name the real vendors would not be testing the real manifest.
  'scripts/__tests__/link-vendor-packages.test.ts',
  'scripts/__tests__/print-harness.test.ts',
  // ⚠ `scripts/__tests__/enso-launch.test.ts` is NOT here any more: `declaredResources` and
  // `missingVendorPaths` moved to `@enso/core` with #221, the manifests moved with them, and
  // the gate reported the leftover row as `allowlisted, matches nothing` rather than letting
  // it sit. The inventory shrinks when the leak does; that is the half of a ratchet that is
  // easy to omit.
  // Same manifests, same reason, new home.
  'packages/core/src/__tests__/pi-manifest.test.ts',
  // The corpus contract reads picc's own `permissionContext.ts` and its `package.json`
  // version out of `node_modules`, and asserts our replica still agrees with it. Naming the
  // package IS the contract — a corpus taken against a fake would pin nothing. Leaves when
  // the replica does.
  'packages/core/src/__tests__/picc-corpus-contract.test.ts',
  // The server's refusal names the missing vendor path, so the test that pins the message
  // names it too. Leaves with `scripts/__tests__/link-vendor-packages.test.ts`.
  'packages/web/src/server/__tests__/vendor-links.test.ts',
  // `piccShapedInspection` — the fake host hands out the session-file layout and `modes`
  // custom entry as picc writes them (L2: the inspection's untyped `entries` array carries
  // pi's persistence format). Leaves with L2, when a transcript type of ours replaces it.
  'packages/web/src/server/__tests__/server-handler.test.ts',
  // `piccEntry` — same L2 shape, from the browser side.
  'packages/web/src/__tests__/thread-debug.test.tsx',
  // Two pi-multi-account startup banners, verbatim, because the bug was the banner being read
  // as an assistant message and swallowing a guard refusal. The strings ARE the fixture.
  // Leaves when that extension leaves the manifest.
  'packages/web/src/__tests__/notifications.test.tsx',
  // One test name says whose the permission modes are to declare. Prose, but in a string
  // literal, which this gate correctly refuses to treat as a comment.
  'packages/web/src/__tests__/permission-mode.test.tsx',
  // The env reference lists the switch the host sets for pi-multi-account (#351): the
  // variable's own name is the vendor's. Leaves when that extension leaves the manifest.
  'scripts/docs/env-and-config.ts',
]

function offendersMatching(lineMatches: (line: string) => boolean, allowed: readonly string[]): string[] {
  return codeOffenders({ roots: SEARCHED_ROOTS, includeTests: true, exemptRoots: VENDOR_ROOTS, allowed, lineMatches })
}

test('⚠ @earendil-works/* is named only by the host and the pi extensions (#145)', () => {
  expect(offendersMatching((line) => VENDOR_IMPORT.test(line), VENDOR_IMPORT_ALLOWED)).toEqual([])
})

test('⚠ a vendor extension is named in code only there — the allowlist is the leak inventory (#145)', () => {
  expect(offendersMatching(namesVendor, VENDOR_NAMED_ALLOWED)).toEqual([])
})

// The gate can only be a ratchet if its matcher sees what a reader would call a mention. The
// first two rows are the ones a `\b` boundary and a both-sides lookaround each missed.
test('the matcher reads words, not substrings: a vendor name counts wherever it is spelled', () => {
  for (const line of [
    "import { readPiccPersistedMode } from '@enso/core';", // camelCase — missed by lookarounds
    'export const PICC_PERMISSION_MODES = [] as const;', // `_` bounded — missed by \b
    'const dirs = [".cc-safety-net"];',
    'const config = ccSafetyNetConfig;',
    'await loadPiMultiAccount();',
    "a fresh thread starts in picc's default",
  ]) {
    expect(namesVendor(line)).toBe(true)
  }
  // Words that merely share a prefix are not the vendor.
  for (const line of ['const piccolo = 1;', "import { pick } from './x.ts';", 'const netSafetyCc = 2;']) {
    expect(namesVendor(line)).toBe(false)
  }
})
