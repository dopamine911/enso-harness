import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The naming gate's exemption for externally-fixed KEYS (#82, PR #83 review), and the
 * severity that decides whether a tier blocks (#250) or merely mentions.
 *
 * ⚠ `is_external_contract_key` in `.biome/naming.grit` replaced two per-line suppressions,
 * so it is now load-bearing in a way the old comments were not: it is the only thing keeping
 * `dir` (Bun.serve's static-route option bag) spellable. The failure mode to defend against
 * is someone "simplifying" it into `is_allowlisted`, which exempts EVERY tier — `const dir =
 * …` would silently become legal across the codebase and nothing would say so. The repo has
 * no grit harness, so the gate's behaviour is asserted by running Biome itself.
 *
 * ⚠ SEVERITY, not just position (#250). `biome check` exits 0 on warnings, so a tier
 * registered at `warn` reports and lands anyway: `export const v = 1` printed its diagnostic
 * and exited 0 for as long as `single_char_binding` carried `warn`, while `export const dir
 * = …` beside it exited 1. A gate that collects only the LINES a plugin reported on cannot
 * tell those two apart, which is how a non-blocking tier passed for a blocking one. Reading
 * the severity is what closes that: the assertions below name `error` per line, so demoting
 * any flagging tier is a red gate rather than a quiet downgrade. (The advisory `info` tier is
 * deliberately non-blocking and says so in the grit header; nothing here asserts on it.)
 */

const biomeBinary = join(REPOSITORY_ROOT, 'node_modules', '.bin', 'biome')
const namingGrit = join(REPOSITORY_ROOT, '.biome', 'naming.grit')

interface NamingDiagnostic {
  /** 1-based line of the fixture the plugin reported on. */
  readonly line: number
  /** What Biome will DO about it: `error` blocks the run, `warning` and `notice` do not. */
  readonly severity: string
}

/**
 * Lints one fixture through the REPO's config and returns every NAMING PLUGIN diagnostic —
 * not any other rule — as a line and the severity that decides whether it blocks.
 *
 * ⚠ The fixture lives outside the repo tree on purpose. A temp file written under
 * `packages/` would be visible to the other source-walking tests (the coverage manifest, the
 * duplicate-shape gate) while it existed, and bun runs test files concurrently — that is a
 * flake waiting to happen. `--config-path` gives an out-of-tree file the repo's rules, and
 * the plugin override's `**` include still matches it.
 *
 * ⚠ `--reporter=github` because it is the one reporter whose line carries the severity, the
 * line NUMBER and the category together (`::error title=plugin,file=…,line=N,…`). The
 * pretty reporter's diagnostic header has the position and category but no severity token —
 * the severity is only in the `×`/`⚠` glyph beside the message — and the JSON reporter
 * reports `span: null` for a plugin diagnostic, so neither can say "this line BLOCKS".
 *
 * Positions and severities, not message text (PR #83 review): the diagnostic wording is ours,
 * in `naming.grit`, and a `not.toContain` on a reworded message would go silently green
 * rather than red. Scoping to `title=plugin` also ignores unrelated rules (`useExplicitType`,
 * the formatter) that may legitimately land on the same lines.
 */
function namingGateDiagnostics(source: string): NamingDiagnostic[] {
  const directory = mkdtempSync(join(tmpdir(), 'zen-naming-gate-'))
  try {
    const fixture = join(directory, 'fixture.ts')
    writeFileSync(fixture, source)
    const linted = Bun.spawnSync([
      biomeBinary,
      'check',
      `--config-path=${REPOSITORY_ROOT}`,
      '--reporter=github',
      fixture,
    ])
    const report = `${linted.stdout.toString()}${linted.stderr.toString()}`
    const found: NamingDiagnostic[] = []
    for (const match of report.matchAll(/^::(\w+) title=plugin,file=[^,]*fixture\.ts,line=(\d+)\b/gm)) {
      found.push({ line: Number(match[2]), severity: match[1] ?? '' })
    }
    // ⚠ A parse that finds nothing where biome reported something is a HOLE, not a pass (PR
    // #321 review). This reads `--reporter=github`'s annotation shape, which is a third
    // party's output format and not an API: a biome upgrade that reformats that line would
    // otherwise turn every severity assertion below into a vacuous `[]`, and the gate would
    // go quiet exactly when it stopped working. A non-zero exit with no parsed diagnostic is
    // that reformatting, and it is refused here rather than read as "clean".
    if (found.length === 0 && linted.exitCode !== 0) {
      throw new Error(
        `naming gate: biome exited ${linted.exitCode} and this parser read no diagnostic from:\n${report}`,
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
      // 2 — the SAME word as our own binding. The split, and what breaks if the predicate is
      // ever folded into `is_allowlisted`.
      "export const dir = 'static'",
      // 3 — the single-character binding tier. `error`, so the run stops (#250).
      'export const v = 1',
      // 4 — the same tier at the other AST site the grit header claims it covers
      // ("keyword-agnostic — const/let/var and function/callback parameters are covered
      // uniformly"): a parameter is a `JsIdentifierBinding` too, and nothing else here
      // exercises that claim.
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
// exempted names are read out of the gate itself and each one must be spelled somewhere,
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
/**
 * The exempted names, read out of the gate rather than restated here: a hand-copied list is
 * the thing that rotted. Pinned to the predicate's exact shape on purpose — reformatting it
 * throws, which is a red gate asking for this reader to be updated, not a silent pass.
 */
function exemptedKeyNames(): string[] {
  const grit = readFileSync(namingGrit, 'utf8')
  const predicate = /predicate is_external_contract_key\(\$name\) \{ \$name <: r"\^\(\?:([^)]*)\)\$" \}/.exec(grit)
  if (predicate === null) throw new Error('naming.grit: is_external_contract_key is no longer in its pinned shape')
  return (predicate[1] ?? '').split('|')
}

/** The first-party files that spell `name` as a property key — what the exemption is FOR. */
function filesSpellingKey(name: string): string[] {
  const asKey = new RegExp(`(?:^|[^A-Za-z0-9_$.])${name}\\s*:`)
  const found: string[] = []
  for (const root of SCANNED_ROOTS) {
    for (const path of filesUnder(join(REPOSITORY_ROOT, root))) {
      const repositoryRelative = path.slice(REPOSITORY_ROOT.length + 1)
      // Tests are excluded from the plugin entirely, so their fixtures rely on nothing.
      if (repositoryRelative.includes('.test.')) continue
      if (asKey.test(readFileSync(path, 'utf8'))) found.push(repositoryRelative)
    }
  }
  return found.sort()
}

test('⚠ every key exemption is spelled by a receipted file, and every receipted file is found (#251)', () => {
  const drift: string[] = []
  const spelled = new Set<string>()
  for (const name of exemptedKeyNames()) {
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
