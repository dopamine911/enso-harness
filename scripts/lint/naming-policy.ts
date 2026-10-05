/**
 * The naming gate's policy, as data: what counts as an abbreviation, which names are exempt, and
 * where. `scripts/lint/enso-plugin.ts` turns it into rules, `oxlint.config.ts` registers them, and
 * `test/naming-gate.test.ts` reads it back. One list, three readers, nothing hand-copied.
 *
 * Detection is upstream's: `eslint-plugin-unicorn`'s `name-replacements` (the rule this dictionary
 * was first ported from, as `prevent-abbreviations`) finds the bindings and the keys; this file
 * only says which NAMES it looks for. Two tiers, the same two the GritQL plugin had:
 *
 *   • binding — a declared name: const/let/var, a parameter, a function/class name, a catch
 *     binding, an import's local name. Keyword-agnostic, as the grit's `JsIdentifierBinding` was.
 *   • key     — an object-literal key, a class member, a TS type member, and (upstream's addition)
 *     a property written through assignment (`holder.cnt = 1`).
 *
 * Test files are exempt (see `oxlint.config.ts`): a test's throwaway bindings and wire-format
 * fixtures are not the code readers navigate.
 *
 * TUNING — three knobs, do not confuse them:
 *   • Project vocabulary → `NAME_ALLOWLIST`. Exempts a name from EVERY tier.
 *   • Abbreviation coverage → `ABBREVIATIONS`.
 *   • Single-character exemptions → `SINGLE_CHARACTER_EXEMPTIONS` (both tiers) and
 *     `SINGLE_CHARACTER_KEY_EXEMPTIONS` (keys only). `i`/`j`/`k` are NOT exempt in either tier —
 *     name what the loop walks (naming-and-style.md, "Index and Counter Variables").
 */

/**
 * Whole names, matched exactly and case-sensitively — never a word inside a camelCase name
 * (`logsDir` passes; `dir` does not). Ported from unicorn's dictionary MINUS its sanctioned
 * conventions here (`err` catch bindings, `opts` option bags, `args`, `env`, `props`, `ref`, …)
 * and PLUS the names this codebase kept writing (`ts`, `cnt`, `cmd`, `dur`, …).
 */
export const ABBREVIATIONS: readonly string[] = [
  'acc',
  'amt',
  'arr',
  'attr',
  'attrs',
  'attType',
  'auth',
  'btn',
  'buf',
  'cb',
  'cc',
  'cfg',
  'cn',
  'cnt',
  'conf',
  'cr',
  'ctx',
  'cur',
  'curr',
  'cx',
  'df',
  'dir',
  'dirs',
  'dist',
  'doc',
  'docs',
  'dst',
  'el',
  'elem',
  'elems',
  'ev',
  'evt',
  'ext',
  'exts',
  'func',
  'hdr',
  'idx',
  'inp',
  'len',
  'lib',
  'mod',
  'msg',
  'num',
  'obj',
  'out',
  'pkg',
  'qs',
  'qty',
  'req',
  'res',
  'ret',
  'retval',
  'sep',
  'sig',
  'sn',
  'src',
  'stdDev',
  'str',
  'tbl',
  'td',
  'temp',
  'tit',
  'tmp',
  'ts',
  'util',
  'utils',
  'val',
  'vars',
  'ver',
  'win',
  'bx',
  'cmd',
  'dec',
  'dur',
  'hi',
  'lo',
  'mem',
  'prs',
  'wf',
  'sk',
  'er',
]

/**
 * Names that must NEVER be flagged, in any tier. A name here is exempt as a binding AND as a key.
 *
 * EMPTY BY DEFAULT in spirit: an allowlist is one project's sanctioned vocabulary, and inheriting
 * another project's list silently permits abbreviations that mean nothing here. Add a name only
 * with a RECEIPT — the published field, the spec term — never merely because the gate flagged it.
 *
 * `cn` is shadcn/ui's class-merge helper, imported under that exact name by the vendored
 * components under packages/web/src/components (lint-excluded, but they resolve the import from
 * our lib/utils.ts) — renaming it forks an ecosystem-wide convention.
 */
export const NAME_ALLOWLIST: readonly string[] = ['cn']

/**
 * Keys whose spelling is fixed by an EXTERNAL contract — a wire format or a third-party API's
 * option bag. Exempt as property KEYS only; the same word is still refused as a binding, so
 * `const dir = …` in our own code keeps failing. That split is why this is not `NAME_ALLOWLIST`.
 *
 * Each entry needs a RECEIPT naming the contract:
 *   • `dir` — `Bun.serve`'s static directory-route option bag is `{ dir }`
 *             (packages/web/src/server/dev-web.ts).
 *
 * ⚠ Keyed on the NAME, so it reaches further than one line. `test/naming-gate.test.ts` holds
 * this list against the files that actually spell each key, in both directions (#251).
 */
export const EXTERNAL_CONTRACT_KEYS: readonly string[] = ['dir']

/** One-letter names exempt in both tiers: the discard `_` and the conventional `z`. */
export const SINGLE_CHARACTER_EXEMPTIONS: readonly string[] = ['_', 'z']

/** One-letter KEYS exempt on top of the above. */
export const SINGLE_CHARACTER_KEY_EXEMPTIONS: readonly string[] = ['e']

/**
 * The generic iteration names: where the surrounding collection NAMES a better variable for free
 * (`sessions.map((s) => …)` → `(session) => …`). Blocking since #592, as the other tiers are.
 */
export const GENERIC_ITERATION_NAMES: readonly string[] = [
  'index',
  'count',
  'value',
  'result',
  'data',
  'item',
  'entry',
  'text',
  'name',
  'id',
  'obj',
  'arr',
]
