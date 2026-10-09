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
  'packages/arena',
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
const VENDOR_WORD = 'gotgenes'
/** …and the ones spelled in several words, however they are joined (`cc-safety-net`, `ccSafetyNet`). */
const VENDOR_WORD_SEQUENCES = [
  ['cc', 'safety', 'net'],
  ['pi', 'multi', 'account'],
  // The permission engine's package name (#496); `picc`, its predecessor, left with it.
  ['pi', 'permission', 'system'],
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
  // Dogfood Arena's agent runner (#556, #584): the agent under test IS a pi `Agent` over a bare
  // model call, given one tool, and it reaches the model through pi's `ModelRuntime` over the
  // home's login, the same one Enso's sessions use. The runner's UI-only boundary is that tool
  // list, so the import is the boundary. It is a test bench driving Enso from outside, not part
  // of the product. Leaves if the runner moves to another agent library, or with the package.
  'packages/arena/src/agent.ts',
  // Its test drives that runner with pi-ai's scripted faux model, so a model asking for a shell
  // can be shown to run nothing. Leaves with the runner.
  'packages/arena/src/__tests__/arena-agent.test.ts',
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
  // The refusal card's verdict words, one per rule in `ENSO_GUARD_RULES` — and one rule is named
  // after the analyzer whose verdict it carries (`cc-safety-net`). The leak is the vocabulary's,
  // and this file spells it as a key. Leaves when that rule is named for what it guards.
  'packages/web/src/tool-refusal.tsx',
  // `PERMISSION_ENGINE_FRAGMENT` — the print variant exists to REMOVE the permission engine from
  // the manifest (#20: no permission prompts under `--print`), so it must name the extension it
  // filters, in the constant and in the shape error that fires when no entry matches. Leaves when
  // the harness owns the print manifest instead of a launcher deriving it.
  'scripts/print-harness.ts',
  // `permissionEngineConfigPath` (#496): the engine reads its policy only from
  // `<agentDir>/extensions/pi-permission-system/config.json`, so linking the user's
  // `ENSO_HOME/permissions.json` there has to spell the engine's directory. Both launch surfaces
  // call it. Leaves when the engine takes a config path, or the harness owns the link.
  'packages/core/src/permission-rules.ts',
  // The Guards page's rule table (#482) keys its reader's words by rule id, and one rule is named
  // for the extension whose verdict it carries: `cc-safety-net`. The table is the page's inventory
  // of rules; leaves when that rule is renamed for what it refuses.
  'scripts/docs/features/guards-and-receipts.ts',
  // ── The gates that have to spell the names ──
  // This file: it names the vendors in order to refuse them. Never leaves.
  'test/vendor-gate.test.ts',
  // The glossary page's own fence names the same vendors as the words it permits only under
  // `## Retired`. Never leaves, for the same reason.
  'test/glossary-doc.test.ts',
  // ── Tests that pin a vendor-shaped input ──
  // The launcher tests carry `pi.extensions` manifests verbatim —
  // `node_modules/@gotgenes/pi-permission-system/src/index.ts` and `node_modules/pi-multi-account/index.ts`
  // are the resources whose linking, filtering and missing-path refusal is under test. A fake
  // manifest that did not name the real vendors would not be testing the real manifest.
  'scripts/__tests__/link-vendor-packages.test.ts',
  'scripts/__tests__/print-harness.test.ts',
  // `scripts/__tests__/enso-launch.test.ts` is back (#482), for a different reason than the one it
  // left with (#221): its end-to-end launch recording asserts the print mirror dropped the
  // permission engine's entry. That is exactly the leak `scripts/print-harness.ts` holds; the test
  // names what it checks. Leaves with it.
  'scripts/__tests__/enso-launch.test.ts',
  // Same manifests as the launcher tests above, moved to `@enso/core` with #221.
  'packages/core/src/__tests__/pi-manifest.test.ts',
  // The server's refusal names the missing vendor path, so the test that pins the message
  // names it too. Leaves with `scripts/__tests__/link-vendor-packages.test.ts`.
  'packages/web/src/server/__tests__/vendor-links.test.ts',
  // Two pi-multi-account startup banners, verbatim, because the bug was the banner being read
  // as an assistant message and swallowing a guard refusal. The strings ARE the fixture.
  // Leaves when that extension leaves the manifest.
  'packages/web/src/__tests__/notifications.test.tsx',
  // The env reference lists the switch the host sets for pi-multi-account (#351): the
  // variable's own name is the vendor's. Its row lives in the generator's inventory tables (#593).
  // Leaves when that extension leaves the manifest.
  'scripts/docs/inventory/env-and-config.ts',
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

/**
 * Rule 6's second half (#558, `docs/concepts/durable-room.md`): INSIDE the two roots, the files that
 * import the vendor, a baseline that only shrinks. The roots let any file there name pi, so the
 * pivot cost grew with every new file and no gate noticed. A file leaving the set leaves this list
 * in the same PR (a stale row fails, as "allowlisted, matches nothing"). A new importer fails by
 * name: put the policy in `@enso/core` or `packages/harness/core` as pure functions and keep the
 * vendor import in an existing glue file, or, when a new glue file is really needed, add it here in
 * the same PR with a comment saying why. Files, not lines: the file is the greppable unit, and a
 * line count is a figure for the page, not a gate. Tests are outside it: they pin vendor shapes.
 */
const VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS: readonly string[] = [
  // ── The pi extensions: one glue file each, plus the guards' judge backends ──
  'packages/harness/extensions/ask-user/index.ts',
  'packages/harness/extensions/guards/index.ts',
  'packages/harness/extensions/guards/judge-backends.ts',
  'packages/harness/extensions/incident-report/index.ts',
  'packages/harness/extensions/logging/index.ts',
  'packages/harness/extensions/permission-modes/index.ts',
  'packages/harness/extensions/run-context/index.ts',
  'packages/harness/extensions/system-prompt/index.ts',
  'packages/harness/extensions/web-fetch/index.ts',
  'packages/harness/extensions/web-search/index.ts',
  // ── The host ──
  'packages/web/src/host/agent-host.ts',
  'packages/web/src/host/branch-context.ts',
  'packages/web/src/host/branch-eval.ts',
  'packages/web/src/host/branch-incident-history.ts',
  'packages/web/src/host/branch-judge-cases.ts',
  'packages/web/src/host/branch-stats.ts',
  'packages/web/src/host/context-elements.ts',
  'packages/web/src/host/context-history.ts',
  'packages/web/src/host/extension-ui-context.ts',
  'packages/web/src/host/map-events.ts',
  'packages/web/src/host/notice-sender.ts',
  'packages/web/src/host/permission-call-questions.ts',
  'packages/web/src/host/project-trust.ts',
  'packages/web/src/host/provider-refusal.ts',
  'packages/web/src/host/restore-note.ts',
  'packages/web/src/host/session-events.ts',
  'packages/web/src/host/session-models.ts',
  'packages/web/src/host/session-usage.ts',
  'packages/web/src/host/system-prompt-preview.ts',
  'packages/web/src/host/system-prompt.ts',
]

test('⚠ inside the two roots, only the baseline files import the vendor, and the baseline only shrinks (#558)', () => {
  const offenders = codeOffenders({
    roots: VENDOR_ROOTS,
    allowed: VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS,
    lineMatches: (line) => VENDOR_IMPORT.test(line),
  })
  expect(
    offenders.map((offender) =>
      offender.endsWith('matches nothing)')
        ? `${offender}: it no longer imports the vendor, so remove it from VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS`
        : `${offender}: a new vendor importer; keep the import in an existing glue file, or add the file to VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS saying why`,
    ),
  ).toEqual([])
})

// The gate can only be a ratchet if its matcher sees what a reader would call a mention. The
// first two rows are the ones a `\b` boundary and a both-sides lookaround each missed.
test('the matcher reads words, not substrings: a vendor name counts wherever it is spelled', () => {
  for (const line of [
    "import { readGotgenesPolicy } from '@enso/core';", // camelCase — missed by lookarounds
    'export const GOTGENES_CONFIG_PATH = "";', // `_` bounded — missed by \b
    'const dirs = [".cc-safety-net"];',
    'const config = ccSafetyNetConfig;',
    'await loadPiMultiAccount();',
    "import { getPermissionsService } from '@gotgenes/pi-permission-system';",
    "the engine's review log lives under pi-permission-system/logs",
  ]) {
    expect(namesVendor(line)).toBe(true)
  }
  // Words that merely share a prefix are not the vendor.
  for (const line of [
    'const gotgenesque = 1;',
    "import { pick } from './x.ts';",
    'const netSafetyCc = 2;',
    'const piPermission = 3;',
  ]) {
    expect(namesVendor(line)).toBe(false)
  }
})
