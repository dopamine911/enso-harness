import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/index.ts'
import { extractDeclarationFromFile } from './extract-declaration.ts'

/**
 * Refreshes every sourced fence in a page from the source it names (#168): the authoring
 * and repair tool for `test/docs-gate.test.ts`. Write the marker and an empty fence —
 *
 *     <!-- source: packages/core/src/thread-runtime.ts#ThreadRuntime -->
 *     ```ts
 *     ```
 *
 * — run `bun scripts/docs/refresh-fences.ts docs/seams/thread-runtime.md`, and the fence
 * holds the declaration. When the gate goes red after a source change, the same command is
 * the fix; the diff it produces is the review.
 */

const ROOT = findRepoRoot(import.meta.url)
const SOURCE_MARKER = /^<!--\s*source:\s*(\S+?)#(\w+)\s*-->$/
const TS_FENCE_OPEN = /^```(?:ts|typescript)\s*$/
const FENCE_CLOSE = /^```\s*$/

export function refreshFences(text: string): { text: string; refreshed: number } {
  const lines = text.split('\n')
  const output: string[] = []
  let refreshed = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    output.push(line)
    const marker = SOURCE_MARKER.exec(line)
    if (marker === null) continue
    if (!TS_FENCE_OPEN.test(lines[lineIndex + 1] ?? '')) continue
    const closeIndex = lines.findIndex((candidate, index) => index > lineIndex + 1 && FENCE_CLOSE.test(candidate))
    if (closeIndex === -1) break
    const declaration = extractDeclarationFromFile(join(ROOT, marker[1] ?? ''), marker[2] ?? '')
    output.push(lines[lineIndex + 1] ?? '', declaration.text, lines[closeIndex] ?? '')
    refreshed += 1
    lineIndex = closeIndex
  }
  return { text: output.join('\n'), refreshed }
}

if (import.meta.main) {
  const pages = process.argv.slice(2)
  if (pages.length === 0) {
    process.stderr.write('usage: bun scripts/docs/refresh-fences.ts <page.md> [...]\n')
    process.exit(2)
  }
  for (const page of pages) {
    const before = readFileSync(page, 'utf8')
    const after = refreshFences(before)
    if (after.text !== before) writeFileSync(page, after.text)
    process.stdout.write(
      `${page}: ${after.refreshed} fence(s) refreshed${after.text === before ? ' (unchanged)' : ''}\n`,
    )
  }
}
