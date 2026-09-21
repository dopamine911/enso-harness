import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
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
 *
 * The same command refreshes a generated block — `<!-- generated-block: <script> -->` …
 * `<!-- /generated-block -->` — from the script's stdout (#162 workstream 11).
 */

const ROOT = findRepoRoot(import.meta.url)
const SOURCE_MARKER = /^<!--\s*source:\s*(\S+?)#(\w+)\s*-->$/
/**
 * A fence open line with its language tag captured, tolerating an info string after the tag. The
 * tag may be empty — a bare fence is still a fence, and `test/docs-gate.test.ts` has to see it.
 */
export const FENCE_OPEN = /^```(\S*)/
/**
 * The languages a `source:` marker can quote: every TypeScript and JavaScript flavour, because the
 * extractor works on a top-level declaration and does not care which extension it came from.
 * Anchored, so it matches a fence's whole language tag and never a prefix of one.
 *
 * ⚠ Exported because the gate and this refresher MUST read the same surface (#258). They were two
 * copies of a pattern that accepted only `ts` and `typescript` with nothing after them, and a
 * fence the gate demands be sourced but the refresher silently skips is a red gate with no repair
 * command. One pattern, imported twice.
 */
export const SOURCEABLE_FENCE_LANGUAGE = /^(?:tsx?|typescript|mts|cts|jsx?|javascript|mjs|cjs)$/

/** A fence's language tag, lowercased; `''` for a bare fence and for a line that opens none. */
export function fenceLanguage(line: string): string {
  return (FENCE_OPEN.exec(line)?.[1] ?? '').toLowerCase()
}
const FENCE_CLOSE = /^```\s*$/
const BLOCK_OPEN = /^<!--\s*generated-block:\s*(\S+)\s*-->$/
const BLOCK_CLOSE = /^<!--\s*\/generated-block\s*-->$/

export function refreshFences(text: string): { text: string; refreshed: number } {
  const lines = text.split('\n')
  const output: string[] = []
  let refreshed = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    output.push(line)
    const block = BLOCK_OPEN.exec(line)
    if (block !== null) {
      const closeIndex = lines.findIndex((candidate, index) => index > lineIndex && BLOCK_CLOSE.test(candidate))
      // Refuse, never truncate: a page with an unclosed block is left exactly as it was.
      if (closeIndex === -1) throw new Error(`line ${lineIndex + 1}: generated-block for ${block[1]} is never closed`)
      const generated = Bun.spawnSync(['bun', block[1] ?? ''], { cwd: ROOT })
      if (generated.exitCode !== 0)
        throw new Error(`${block[1]} exited ${generated.exitCode}: ${generated.stderr.toString()}`)
      output.push(generated.stdout.toString().trimEnd(), lines[closeIndex] ?? '')
      refreshed += 1
      lineIndex = closeIndex
      continue
    }
    const marker = SOURCE_MARKER.exec(line)
    if (marker === null) continue
    // Refuse, never skip: a marker above a fence the extractor cannot fill — a diagram, a shell
    // block — is exactly what the gate refuses, so the repair tool must not quietly walk past it.
    if (!SOURCEABLE_FENCE_LANGUAGE.test(fenceLanguage(lines[lineIndex + 1] ?? '')))
      throw new Error(`line ${lineIndex + 1}: source marker is not above a TypeScript or JavaScript fence`)
    const closeIndex = lines.findIndex((candidate, index) => index > lineIndex + 1 && FENCE_CLOSE.test(candidate))
    // Refuse, never truncate — the same rule as the generated block above.
    if (closeIndex === -1) throw new Error(`line ${lineIndex + 2}: sourced fence is never closed`)
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
