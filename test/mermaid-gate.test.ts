import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { GENERATED_PAGES, generatedPage } from '../scripts/docs/build-docs.ts'
import { collectFlows } from '../scripts/docs/flow-tags.ts'
import { markdownFiles, REPOSITORY_ROOT } from './gate-support.ts'

/**
 * EVERY DIAGRAM IN THE DOCS PARSES (#188).
 *
 * ⚠ A MERMAID FENCE THAT DOES NOT PARSE FAILS NOTHING. Markdown does not read inside a fence,
 * the docs gate compares text, the site build renders the block and exits 0, and the link crawl
 * sees an element with no links in it. The diagram becomes a red `Error rendering diagram: Parse
 * error on line N` in the reader's browser, and nothing upstream ever said a word.
 *
 * Measured the day the site was first published: FIVE of the eight flow diagrams were broken,
 * and had been since they were written — `guarded-tool-call`, `abort-clear-restore`,
 * `dialog-ask-answer-settled`, `follow-snapshot-frames`, `web-search-call`.
 *
 * THE CAUSE, worth knowing because it reads as ordinary punctuation: `;` is mermaid's STATEMENT
 * SEPARATOR, inside message and note text as much as anywhere else. `A->>B: bash only; a throw
 * is a deny` is not a message containing a semicolon — it is a message, and then `a throw is a
 * deny` as a second statement, which is a syntax error. Seven of them across five files. They
 * are `·` now, the separator those same diagrams already used everywhere else.
 *
 * WHAT IT DOES NOT HOLD: that a diagram is TRUE, or readable, or that it agrees with the prose
 * beside it. Only that mermaid can read it. For the two GENERATED diagrams their generator
 * answers the first question (`flow-diagrams.ts`); for the hand-written ones nothing mechanical
 * can, which is why they are prose pages with a picture rather than a source of truth.
 */

// ⚠ Flowcharts call `DOMPurify.addHook` while parsing and throw without a document; sequence
// diagrams do not. Registered here rather than through `packages/web`'s helper, which belongs to
// another project in the build and is not on this one's file list.
GlobalRegistrator.register()
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g

/** Every mermaid fence in `text`, with the page and the line it opens on. */
function fencesIn(page: string, text: string): { page: string; line: number; source: string }[] {
  return [...text.matchAll(MERMAID_FENCE)].map((match) => ({
    page,
    line: text.slice(0, match.index).split('\n').length,
    source: match[1] ?? '',
  }))
}

/**
 * Every mermaid diagram the site shows: the fences in the committed pages, the fences each
 * generator prints, and every diagram a test records for a flow page (#482). Built pages are
 * gitignored (`markdownFiles` skips them), so their diagrams are read where they are made, from
 * the generator and the snapshots, whether or not a build has run.
 */
function diagrams(): { page: string; line: number; source: string }[] {
  const committed = markdownFiles(join(REPOSITORY_ROOT, 'docs')).flatMap((path) =>
    fencesIn(relative(REPOSITORY_ROOT, path), readFileSync(path, 'utf8')),
  )
  const generated = GENERATED_PAGES.flatMap(({ page }) => fencesIn(`${page} (generated)`, generatedPage(page)))
  const recorded = collectFlows().diagrams.map((diagram) => ({
    page: `${diagram.file} (recorded: ${diagram.caption})`,
    line: 1,
    source: diagram.diagram,
  }))
  return [...committed, ...generated, ...recorded]
}

/**
 * ⚠ Dynamic ON PURPOSE, and it is the same ordering trap `dom-environment.ts` documents for
 * `react-dom/client`: bun evaluates a static `node_modules` import before this file's own
 * statements, so a statically imported mermaid would initialise against no document.
 */
async function parser(): Promise<{ parse: (source: string) => Promise<unknown> }> {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false })
  return mermaid
}

test('⚠ every mermaid diagram in the docs parses (#188)', async () => {
  const mermaid = await parser()
  const broken: string[] = []
  for (const diagram of diagrams()) {
    try {
      await mermaid.parse(diagram.source)
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
      // Named, not counted: the output IS the diagram to fix, with mermaid's own line number.
      broken.push(`${diagram.page}:${diagram.line}: ${reason}`)
    }
  }
  expect(broken).toEqual([])
})

test('the parser can fail, and the corpus is not empty (#188)', async () => {
  // A gate that parses nothing passes: the flow pages, six architecture blocks, two generated, and the recorded ones.
  expect(diagrams().length).toBeGreaterThan(12)
  const mermaid = await parser()
  // ⚠ A `parse` that accepted anything would make the test above green over the exact breakage
  // it exists for — one of each shape the docs use.
  const refused: string[] = []
  for (const source of ['sequenceDiagram\n  A->>B: text; and a second statement', 'flowchart LR\n  A[unclosed --> B']) {
    try {
      await mermaid.parse(source)
    } catch {
      refused.push(source)
    }
  }
  expect(refused.length).toBe(2)
})
