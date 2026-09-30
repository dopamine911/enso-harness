import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtFeaturePages, writeFeaturePages } from './feature-pages.ts'
import { builtFlowPages, writeFlowPages } from './flow-pages.ts'
import { ROOT } from './flow-tags.ts'

/**
 * Builds every docs page that is BUILD OUTPUT (#482): the reference pages each generator prints and
 * the flow pages `flow-pages.ts` assembles. None of them is committed: `.gitignore` names them, the
 * site build runs this first, and `bun run docs:build` runs it for a reader who wants them on disk.
 * A page that is never committed cannot drift from its generator, so there is nothing to regenerate
 * by hand after a change moves a line.
 *
 * ⚠ The gates never read these files from disk (`test/gate-support.ts#markdownFiles` skips them): a
 * copy left behind by an earlier build is stale the moment the code moves, and a gate that read it
 * would fail on history. What a gate needs from one of these pages it takes from the generator
 * itself (`generatedPage`).
 */

/** Each generated reference page and the generator whose stdout it is. */
export const GENERATED_PAGES: readonly { readonly page: string; readonly script: string }[] = [
  { page: 'docs/reference/core-exports.md', script: 'scripts/docs/core-exports.ts' },
  { page: 'docs/reference/decisions.md', script: 'scripts/docs/decisions.ts' },
  { page: 'docs/reference/env-and-config.md', script: 'scripts/docs/env-and-config.ts' },
  { page: 'docs/reference/flows.md', script: 'scripts/docs/flow-diagrams.ts' },
  { page: 'docs/reference/observations.md', script: 'scripts/docs/observations.ts' },
  { page: 'docs/reference/routes.md', script: 'scripts/docs/routes.ts' },
  { page: 'docs/reference/verification-inventory.md', script: 'scripts/docs/verification-inventory.ts' },
  { page: 'docs/seams/ported-provenance.md', script: 'scripts/docs/ported-provenance.ts' },
]

/** Every page this build writes, repository-relative: what `.gitignore` and the link gate must know. */
export function builtDocPages(): string[] {
  return [...GENERATED_PAGES.map((generated) => generated.page), ...builtFlowPages(), ...builtFeaturePages()]
}

/** A generated page's text, straight from its generator — never from a copy on disk. */
export function generatedPage(page: string): string {
  const generated = GENERATED_PAGES.find((candidate) => candidate.page === page)
  if (generated === undefined) throw new Error(`build-docs: ${page} is not a generated page`)
  const run = Bun.spawnSync(['bun', generated.script], { cwd: ROOT, stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`build-docs: ${generated.script} refused: ${run.stderr.toString().trim()}`)
  return run.stdout.toString()
}

if (import.meta.main) {
  const pages = GENERATED_PAGES.map((generated) => {
    writeFileSync(join(ROOT, generated.page), generatedPage(generated.page))
    return generated.page
  })
  pages.push(...writeFlowPages(), ...writeFeaturePages())
  process.stdout.write(`build-docs: built ${pages.length} pages\n`)
}
