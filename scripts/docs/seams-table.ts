import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { assertExactKeys, runGenerator } from './generator-support.ts'

/**
 * Generates the seams table (#162 workstream 11, #167 item 4) — the block `docs/architecture.md`
 * embeds between `<!-- generated-block: … -->` markers. One row per page under `docs/seams/`: the
 * seam's name from its H1, the LEAK COLUMN VERBATIM from the bold lead of its *What crosses it
 * that should not* section, and two columns of checked metadata (domain, gate) keyed by file, so a
 * page added or removed fails here rather than going unlisted.
 *
 * ⚠ THAT CLAIM WAS FALSE FOR ONE CASE, AND IT WAS THE GROWTH CASE (#213). The page list used to
 * be filtered by `PAGE_TITLE` before the exhaustiveness check ran, so a new page whose H1 did not
 * literally begin `# Seam: ` was dropped before anything could miss it: absent from the table,
 * absent from the metadata, generator exit 0, `bun run check` green. A silent omission in an
 * inventory generator is the bug the generator exists to prevent. Now a `.md` file under
 * `docs/seams/` is either a NAMED non-seam (`NON_SEAM_PAGES`) or a seam row, and neither can
 * arrive quietly: an unnamed file must be in the metadata, and a page in the metadata must
 * carry the title and leak section `seamRow` reads.
 *
 * The leak column is the reason this is generated: the hand-written table said L2, L3 and "the
 * parallel `enso.*` names" for a week after each was closed. A page's own leak section is the
 * one place that is kept current (it is what a reviewer is handed), so the table reads it.
 */

const ROOT = findRepoRoot(import.meta.url)
/** The pages directory. Overridable by argv so the gate can run this generator over a fixture (#213). */
const SEAMS_DIRECTORY = resolve(ROOT, process.argv[2] ?? 'docs/seams')
const LEAK_SECTION = '## What crosses it that should not'
const PAGE_TITLE = /^# Seam: (.+)$/m
const BOLD_LEAD = /^\*\*(.+?)\*\*/

/**
 * The `.md` files under `docs/seams/` that are NOT seam pages, by name — the inventory's only
 * exclusion, so adding one is a decision in this file. `README.md` is the directory's index;
 * `ported-provenance.md` is a generated inventory beside `presentation.md`.
 */
const NON_SEAM_PAGES: Record<string, true> = { 'README.md': true, 'ported-provenance.md': true }

interface SeamMetadata {
  /** The glossary domains the contract belongs to. */
  readonly domain: string
  /** The gate(s) that name the boundary; `—` when only the page's own tests do. */
  readonly gate: string
}

/** By page basename; every page not named in `NON_SEAM_PAGES` must appear here. */
const SEAM_METADATA: Record<string, SeamMetadata> = {
  'thread-runtime.md': { domain: 'Thread, Control', gate: 'vendor gate; glossary gate; boundaries' },
  'storage.md': {
    domain: 'Thread, Record',
    gate: '`no-duplicate-paths`; boundaries (the forbidden-call rule)',
  },
  'observation.md': {
    domain: 'Observation',
    gate: 'kinds sweeps over `@enso/core/observation-kinds`; `observations.md` generated',
  },
  'dialog.md': { domain: 'Control', gate: 'extension-UI-context tests' },
  'permission-mode.md': { domain: 'Permission', gate: 'vendor gate; `code-offenders` stale-row check' },
  'guards.md': { domain: 'Permission', gate: '`tool-call-participants`; analyzer contract test' },
  'tool-result.md': { domain: 'Surface', gate: '—' },
  'presentation.md': { domain: 'Surface', gate: 'presentation gate; `ported-provenance.md` generated' },
  'logging.md': { domain: 'Record', gate: 'logging gate' },
  'web-providers.md': { domain: 'Permission (egress), Control', gate: 'vendor gate' },
}

interface SeamRow {
  readonly file: string
  readonly name: string
  readonly leak: string
}

function seamRow(file: string): SeamRow {
  const text = readFileSync(join(SEAMS_DIRECTORY, file), 'utf8')
  const title = PAGE_TITLE.exec(text)?.[1]
  if (title === undefined) throw new Error(`${file} has no "# Seam: …" title, and is not a named non-seam page`)
  const sectionStart = text.indexOf(LEAK_SECTION)
  if (sectionStart < 0) throw new Error(`${file} has no "${LEAK_SECTION}" section`)
  const sectionBody = text.slice(sectionStart + LEAK_SECTION.length).trimStart()
  const lead = BOLD_LEAD.exec(sectionBody)?.[1]
  if (lead === undefined) {
    throw new Error(`${file}'s leak section does not open with a bold lead sentence`)
  }
  return { file, name: title, leak: lead.replace(/\|/g, '\\|') }
}

function generate(): string {
  const pages = readdirSync(SEAMS_DIRECTORY)
    .filter((file) => file.endsWith('.md') && NON_SEAM_PAGES[file] !== true)
    .sort()
  assertExactKeys('seam page', pages, Object.keys(SEAM_METADATA))
  const rows = pages.map(seamRow).map((row) => {
    const metadata = SEAM_METADATA[row.file]
    if (metadata === undefined) throw new Error(`no metadata for ${row.file}`)
    return `| [${row.name}](./seams/${row.file}) | ${metadata.domain} | ${metadata.gate} | ${row.leak} |`
  })
  return [
    '| Seam | Domain | Gate | What crosses it that should not (the page\u2019s own words) |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

runGenerator('seams-table', generate)
