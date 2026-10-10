import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { runGenerator } from './generator-support.ts'

/**
 * Generates `docs/seams/ported-provenance.md` (#168): one row per file under
 * `components/ai-elements/` — the upstream path and commit its header names, and the
 * `Modified —` line that follows. The presentation gate holds that every file HAS a
 * header; this prints what the headers say, so the seam page never restates a pin by
 * hand. `test/docs-gate.test.ts` keeps the page equal to this output.
 */

const ROOT = findRepoRoot(import.meta.url)
const PORTED_DIRECTORY = 'packages/web/src/components/ai-elements'
const VENDORED_FROM = /Vendored from (\S+) — `([^`]+)`/
const AT_COMMIT = /at ([0-9a-f]{7,40})\. (\S+)\./
const MODIFIED = /^\s*\* (Modified[^\n]*)/

interface Port {
  readonly file: string
  readonly upstream: string
  readonly upstreamPath: string
  readonly commit: string
  readonly license: string
  readonly modified: string
}

function portOf(file: string): Port {
  const header = readFileSync(join(ROOT, PORTED_DIRECTORY, file), 'utf8')
    .split('\n')
    .slice(0, 12)
  const text = header.join('\n')
  const from = VENDORED_FROM.exec(text)
  const at = AT_COMMIT.exec(text)
  const modified = header.map((line) => MODIFIED.exec(line)?.[1]).find((line) => line !== undefined)
  return {
    file,
    upstream: from?.[1] ?? '**no provenance header**',
    upstreamPath: from?.[2] ?? '',
    commit: at?.[1]?.slice(0, 12) ?? '',
    license: at?.[2] ?? '',
    modified: modified ?? '—',
  }
}

export function portedProvenancePage(): string {
  const ports = readdirSync(join(ROOT, PORTED_DIRECTORY))
    .filter((fileName) => /\.tsx?$/.test(fileName))
    .toSorted()
    .map(portOf)

  return [
    '<!-- generated: scripts/docs/ported-provenance.ts -->',
    '# Ported presentation files',
    '',
    `Generated from the provenance headers under \`${PORTED_DIRECTORY}/\`. The presentation gate`,
    '(`test/presentation-gate.test.ts`) holds that every file here names its upstream pin and',
    'imports nothing from the state layer; this is what the headers say.',
    '',
    '| File | Upstream | At | License | Modified |',
    '|---|---|---|---|---|',
    ...ports.map(
      (port) =>
        `| \`${port.file}\` | ${port.upstream} \`${port.upstreamPath}\` | \`${port.commit}\` | ${port.license} | ${port.modified} |`,
    ),
    '',
  ].join('\n')
}

// Importable: `build-docs.ts#generatedPage` calls `portedProvenancePage` (#832); importing must not print a page.
if (import.meta.main) runGenerator('ported-provenance', portedProvenancePage)
