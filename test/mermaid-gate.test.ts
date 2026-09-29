import { afterAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { collectFlows } from '../scripts/docs/flow-tags.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

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

/**
 * Every markdown page under `docs/`.
 *
 * ⚠ Not `filesUnder` (`scripts/source-tree.ts`): it walks SOURCE files and returned nothing here,
 * which made the parse test above pass by parsing zero diagrams. The floor in the second test is
 * what reported that, which is the whole reason a "for all" assertion carries one.
 */
function documentationPages(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) documentationPages(path, found)
    else if (name.endsWith('.md')) found.push(path)
  }
  return found
}

/**
 * Every mermaid fence in the documentation, with the page and the line it opens on, and every
 * diagram a test records for a built flow page (#482): the page is gitignored, so its diagrams
 * are read where they are kept, in the snapshots, whether or not a build has run.
 */
function diagrams(): { page: string; line: number; source: string }[] {
  const found: { page: string; line: number; source: string }[] = []
  for (const path of documentationPages(join(REPOSITORY_ROOT, 'docs'))) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(MERMAID_FENCE)) {
      found.push({
        page: relative(REPOSITORY_ROOT, path),
        line: text.slice(0, match.index).split('\n').length,
        source: match[1] ?? '',
      })
    }
  }
  for (const recorded of collectFlows().diagrams) {
    found.push({ page: `${recorded.file} (recorded: ${recorded.caption})`, line: 1, source: recorded.diagram })
  }
  return found
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
