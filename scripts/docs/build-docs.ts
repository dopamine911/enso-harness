import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreExportsPage } from './core-exports.ts'
import { decisionsPage } from './decisions.ts'
import { envAndConfigPage } from './env-and-config.ts'
import { builtFeaturePages, writeFeaturePages } from './feature-pages.ts'
import { flowDiagramsPage } from './flow-diagrams.ts'
import { builtFlowPages, writeFlowPages } from './flow-pages.ts'
import { ROOT } from './flow-tags.ts'
import { observationsPage } from './observations.ts'
import { portedProvenancePage } from './ported-provenance.ts'
import { routesPage } from './routes.ts'
import { verificationInventoryPage } from './verification-inventory.ts'

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

/**
 * Each generated reference page, the generator script that prints it (`bun <script>`), and that
 * script's page function. ⚠ Called in-process, never spawned (#832): Bun does not instrument a
 * subprocess, so a spawned generator is code no test measures.
 */
export const GENERATED_PAGES: readonly {
  readonly page: string
  readonly script: string
  readonly generate: () => string
}[] = [
  { page: 'docs/reference/core-exports.md', script: 'scripts/docs/core-exports.ts', generate: coreExportsPage },
  { page: 'docs/reference/decisions.md', script: 'scripts/docs/decisions.ts', generate: decisionsPage },
  { page: 'docs/reference/env-and-config.md', script: 'scripts/docs/env-and-config.ts', generate: envAndConfigPage },
  { page: 'docs/reference/flows.md', script: 'scripts/docs/flow-diagrams.ts', generate: flowDiagramsPage },
  { page: 'docs/reference/observations.md', script: 'scripts/docs/observations.ts', generate: observationsPage },
  { page: 'docs/reference/routes.md', script: 'scripts/docs/routes.ts', generate: routesPage },
  {
    page: 'docs/reference/verification-inventory.md',
    script: 'scripts/docs/verification-inventory.ts',
    generate: verificationInventoryPage,
  },
  {
    page: 'docs/seams/ported-provenance.md',
    script: 'scripts/docs/ported-provenance.ts',
    generate: portedProvenancePage,
  },
]

/** Every page this build writes, repository-relative: what `.gitignore` and the link gate must know. */
export function builtDocPages(): string[] {
  return [...GENERATED_PAGES.map((generated) => generated.page), ...builtFlowPages(), ...builtFeaturePages()]
}

/** A generated page's text, straight from its generator — never from a copy on disk. */
export function generatedPage(page: string): string {
  const generated = GENERATED_PAGES.find((candidate) => candidate.page === page)
  if (generated === undefined) throw new Error(`build-docs: ${page} is not a generated page`)
  try {
    return generated.generate()
  } catch (error) {
    throw new Error(
      `build-docs: ${generated.script} refused: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

if (import.meta.main) {
  const pages = GENERATED_PAGES.map((generated) => {
    writeFileSync(join(ROOT, generated.page), generatedPage(generated.page))
    return generated.page
  })
  pages.push(...writeFlowPages(), ...writeFeaturePages())
  process.stdout.write(`build-docs: built ${pages.length} pages\n`)
}
