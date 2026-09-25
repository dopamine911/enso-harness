import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXTERNAL_CONTRACT_KEYS } from '../scripts/lint/naming-policy.ts'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The naming gate's exemption for externally-fixed KEYS (#82, PR #83 review), and the
 * severity that decides whether a tier blocks (#250) or merely mentions.
 *
 * ⚠ `EXTERNAL_CONTRACT_KEYS` (scripts/lint/naming-policy.ts) replaced two per-line
 * suppressions, so it is load-bearing in a way the old comments were not: it is the only thing
 * keeping `dir` (Bun.serve's static-route option bag) spellable. The failure mode to defend
 * against is someone "simplifying" it into `NAME_ALLOWLIST`, which exempts EVERY tier — `const
 * dir = …` would silently become legal across the codebase and nothing would say so. So the
 * gate's behaviour is asserted by running oxlint itself, through the repository's config.
 *
 * ⚠ SEVERITY, not just position (#250). A linter exits 0 on warnings, so a tier registered at
 * `warn` reports and lands anyway: under Biome, `export const v = 1` printed its diagnostic and
 * exited 0 for as long as the single-character tier carried `warn`, while `export const dir =
 * …` beside it exited 1. A gate that collects only the LINES a rule reported on cannot tell
 * those two apart, which is how a non-blocking tier passed for a blocking one. Reading the
 * severity is what closes that: the assertions below name `error` per line, so demoting any
 * flagging tier is a red gate rather than a quiet downgrade. (The advisory `generic-iteration`
 * tier is deliberately `warn` and says so in `oxlint.config.ts`; nothing here asserts on it.)
 */

const oxlintBinary = join(REPOSITORY_ROOT, 'node_modules', '.bin', 'oxlint')
const oxlintConfig = join(REPOSITORY_ROOT, 'oxlint.config.ts')

interface NamingDiagnostic {
  /** 1-based line of the fixture the rule reported on. */
  readonly line: number
  /** What oxlint will DO about it: `error` blocks the run, `warning` does not. */
  readonly severity: string
}

interface OxlintReport {
  readonly diagnostics: readonly {
    readonly code?: string
    readonly severity: string
    readonly labels: readonly { readonly span: { readonly line: number } }[]
  }[]
}

/**
 * Lints one fixture through the REPO's config and returns every NAMING diagnostic — the
 * `enso/abbreviated-*` tiers, not any other rule — as a line and the severity that decides
 * whether it blocks.
 *
 * ⚠ The fixture lives outside the repo tree on purpose. A temp file written under
 * `packages/` would be visible to the other source-walking tests (the coverage manifest, the
 * duplicate-shape gate) while it existed, and bun runs test files concurrently — that is a
 * flake waiting to happen. `-c` gives an out-of-tree file the repo's rules.
 *
 * `--format=json`: oxlint's structured report carries the rule, the severity and the line on
 * every diagnostic, so nothing here scrapes a human-facing format. Positions and severities,
 * not message text: a `not.toContain` on a reworded message would go silently green rather
 * than red.
 */
function namingGateDiagnostics(source: string): NamingDiagnostic[] {
  const directory = mkdtempSync(join(tmpdir(), 'enso-naming-gate-'))
  try {
    const fixture = join(directory, 'fixture.ts')
    writeFileSync(fixture, source)
    const linted = Bun.spawnSync(['bun', '--bun', oxlintBinary, '-c', oxlintConfig, '--format=json', fixture], {
      cwd: REPOSITORY_ROOT,
    })
    const report: OxlintReport = JSON.parse(linted.stdout.toString())
    const found: NamingDiagnostic[] = []
    for (const diagnostic of report.diagnostics) {
      const line = diagnostic.labels[0]?.span.line
      if (diagnostic.code?.startsWith('enso(abbreviated-') === true && line !== undefined) {
        found.push({ line, severity: diagnostic.severity })
      }
    }
    // ⚠ A parse that finds nothing where oxlint reported something is a HOLE, not a pass (PR
    // #321 review): a report shape that moved under an upgrade would otherwise turn every
    // severity assertion below into a vacuous `[]`, and the gate would go quiet exactly when
    // it stopped working. A non-zero exit with no parsed naming diagnostic is refused here.
    if (found.length === 0 && linted.exitCode !== 0) {
      throw new Error(
        `naming gate: oxlint exited ${linted.exitCode} and this parser read no naming diagnostic from:\n${linted.stdout.toString()}${linted.stderr.toString()}`,
      )
    }
    return found.sort((left, right) => left.line - right.line)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('⚠ the externally-fixed name is exempt as a KEY, refused as a BINDING, and every tier BLOCKS', () => {
  const flagged = namingGateDiagnostics(
    [
      // 1 — the receipted key: the wire/API shape we owe its spelling to. Clean.
      "export const stamp = { dir: 'static' }",
      // 2 — the SAME word as our own binding. The split, and what breaks if the contract keys are
      // ever folded into `NAME_ALLOWLIST`.
      "export const dir = 'static'",
      // 3 — the single-character binding tier. `error`, so the run stops (#250).
      'export const v = 1',
      // 4 — the same tier at the other site naming-policy.ts claims it covers ("keyword-agnostic —
      // const/let/var, a parameter, …"): nothing else here exercises that claim.
      'export function at(q: number): number {',
      '  return q',
      '}',
      // 7 — `v` as a KEY. Exempt until #251 retired the exemption; now refused like any
      // other one-letter field name, which is what retiring it has to MEAN.
      'export const stamp2 = { v: 1 }',
      '',
    ].join('\n'),
  )
  expect(flagged).toEqual([
    { line: 2, severity: 'error' },
    { line: 3, severity: 'error' },
    { line: 4, severity: 'error' },
    { line: 7, severity: 'error' },
  ])
})

// ── the exemption's blast radius, pinned in both directions ───────────────────
// The suppressions this replaced were scoped to one line each; a predicate keyed on the NAME
// is broader, so the call sites are pinned here instead. A second `{ dir: … }` in first-party
// code is a design question — whether we really owe that spelling to something external —
// and it should surface as a failing gate, not pass silently.
//
// ⚠ And the other direction (#251): an exemption that no file spells is a hole nobody is
// watching. `v` sat in the predicate after #112 removed the run path its stamp belonged to,
// with a receipt naming `packages/web/src/server/session.ts` — a module that no longer
// exists — and the one-directional check could not say so, because it compared the RELYING
// files against a hand-written list and a dead name has no relying file to compare. So the
// exempted names are read out of the gate's own policy and each one must be spelled somewhere,
// which is the same rule `codeOffenders` applies to an allowlist row that matches nothing.
//
// Only property keys can slip through: `dir` as a BINDING is still refused by the tier
// asserted above, so it cannot legally exist as an identifier to be mistaken for a key.

// Alphabetical, because the comparison below sorts what it finds: what is asserted is
// MEMBERSHIP, not order — `readdirSync` order is filesystem-defined and not stable across
// runners (PR #83 review).
const EXEMPTED_KEY_SITES = [
  // Bun.serve's static directory-route option bag.
  'packages/web/src/server/dev-web.ts',
  // (TanStack's `tanstack:interruptBinding` stamp was the second site until #112 retired the
  // run path; #251 then retired the `v` exemption the stamp was the receipt for.)
] as const
const SCANNED_ROOTS = ['packages', 'scripts'] as const
/** The first-party files that spell `name` as a property key — what the exemption is FOR. */
function filesSpellingKey(name: string): string[] {
  const asKey = new RegExp(`(?:^|[^A-Za-z0-9_$.])${name}\\s*:`)
  const found: string[] = []
  for (const root of SCANNED_ROOTS) {
    for (const path of filesUnder(join(REPOSITORY_ROOT, root))) {
      const repositoryRelative = path.slice(REPOSITORY_ROOT.length + 1)
      // Tests are excluded from the naming rules entirely, so their fixtures rely on nothing.
      if (repositoryRelative.includes('.test.')) continue
      if (asKey.test(readFileSync(path, 'utf8'))) found.push(repositoryRelative)
    }
  }
  return found.sort()
}

test('⚠ every key exemption is spelled by a receipted file, and every receipted file is found (#251)', () => {
  const drift: string[] = []
  const spelled = new Set<string>()
  for (const name of EXTERNAL_CONTRACT_KEYS) {
    const spelling = filesSpellingKey(name)
    // An exemption no file spells is the `v` failure: the leak has gone, the hole stayed.
    // Reported per NAME, which is the unit that can rot — the file list below cannot say it.
    if (spelling.length === 0) drift.push(`${name} (exempted, no first-party file spells it)`)
    for (const file of spelling) spelled.add(file)
  }
  // Named, not counted, so a failure says which file to open. Compared as a sorted SET of
  // files: the receipt is per file (a second wire key in an already-receipted file is the
  // same contract, not a new site), and `readdirSync` order is not something to assert on.
  expect(drift).toEqual([])
  expect([...spelled].sort()).toEqual([...EXEMPTED_KEY_SITES])
})
