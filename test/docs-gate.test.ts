import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractDeclaration } from '../scripts/docs/extract-declaration.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The docs cannot drift (#168, goals §3.3): a page either quotes source and is checked
 * against it, or is generated from source and is diffed against it.
 *
 * ⚠ Enforcement, not a unit test — the shape of the other gates. Two markers:
 *
 *   `<!-- source: <path>#<Symbol> -->` on the line above a ```` ```ts ```` fence: the fence
 *   must equal that top-level declaration, with its doc comment, character for character.
 *   A symbol that no longer exists is an offender that names the page, so a rename fails
 *   the docs before it fails a reader.
 *
 *   `<!-- generated: <script> -->` on a page's first line: the page must equal the
 *   script's stdout. Regenerate with `bun <script> > <page>`.
 *
 * And one rule for `docs/seams/`: every ```` ```ts ```` fence carries a `source:` marker.
 * Prose may surround a fence; prose may not restate what a fence says, and a fence with no
 * source is prose wearing a code font.
 *
 * The allowlist is EMPTY and stays so. A page that cannot keep its fences equal to the
 * source is describing a different program.
 */

const DOCS_ROOT = join(REPOSITORY_ROOT, 'docs')
/** Where every fence must be sourced. Other docs are checked only where they carry a marker. */
const SOURCED_FENCE_DIRECTORIES = ['docs/seams'] as const
const SOURCE_MARKER = /^<!--\s*source:\s*(\S+?)#(\w+)\s*-->$/
const GENERATED_MARKER = /^<!--\s*generated:\s*(\S+)\s*-->$/
const TS_FENCE_OPEN = /^```(?:ts|typescript)\s*$/
const FENCE_CLOSE = /^```\s*$/

function markdownFiles(directory: string): string[] {
  const found: string[] = []
  for (const dirent of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, dirent.name)
    if (dirent.isDirectory()) found.push(...markdownFiles(path))
    else if (dirent.name.endsWith('.md')) found.push(path)
  }
  return found
}

interface Fence {
  readonly openLine: number
  readonly body: string
  readonly source: { path: string; symbol: string } | undefined
}

/** Every ```` ```ts ```` fence in a page, with the `source:` marker directly above it when there is one. */
function fencesOf(lines: readonly string[]): Fence[] {
  const fences: Fence[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!TS_FENCE_OPEN.test(lines[lineIndex] ?? '')) continue
    const closeIndex = lines.findIndex((line, index) => index > lineIndex && FENCE_CLOSE.test(line))
    if (closeIndex === -1) break
    const marker = SOURCE_MARKER.exec(lines[lineIndex - 1] ?? '')
    fences.push({
      openLine: lineIndex + 1,
      body: lines.slice(lineIndex + 1, closeIndex).join('\n'),
      source: marker ? { path: marker[1] ?? '', symbol: marker[2] ?? '' } : undefined,
    })
    lineIndex = closeIndex
  }
  return fences
}

function sourcedFenceOffenders(page: string, lines: readonly string[], fenceMustBeSourced: boolean): string[] {
  const offenders: string[] = []
  for (const fence of fencesOf(lines)) {
    if (fence.source === undefined) {
      if (fenceMustBeSourced) offenders.push(`${page}:${fence.openLine}: ts fence without a <!-- source: --> marker`)
      continue
    }
    const sourcePath = join(REPOSITORY_ROOT, fence.source.path)
    if (!existsSync(sourcePath)) {
      offenders.push(`${page}:${fence.openLine}: source ${fence.source.path} does not exist`)
      continue
    }
    const declaration = extractDeclaration(readFileSync(sourcePath, 'utf8'), fence.source.symbol)
    if (declaration === undefined) {
      offenders.push(`${page}:${fence.openLine}: ${fence.source.path} declares no top-level \`${fence.source.symbol}\``)
      continue
    }
    if (declaration.text.trim() !== fence.body.trim()) {
      offenders.push(
        `${page}:${fence.openLine}: fence differs from ${fence.source.path}#${fence.source.symbol} (${fence.source.path}:${declaration.startLine}-${declaration.endLine})`,
      )
    }
  }
  return offenders
}

function generatedOffenders(page: string, text: string): string[] {
  const marker = GENERATED_MARKER.exec(text.split('\n')[0] ?? '')
  if (!marker) return []
  const script = marker[1] ?? ''
  if (!existsSync(join(REPOSITORY_ROOT, script))) return [`${page}:1: generator ${script} does not exist`]
  const generated = Bun.spawnSync(['bun', script], { cwd: REPOSITORY_ROOT })
  if (generated.exitCode !== 0)
    return [`${page}:1: ${script} exited ${generated.exitCode}: ${generated.stderr.toString().trim()}`]
  if (generated.stdout.toString().trim() !== text.trim())
    return [`${page}: differs from \`bun ${script}\` — regenerate`]
  return []
}

test('⚠ every sourced fence equals its declaration; every seam-page fence is sourced (#168)', () => {
  const offenders: string[] = []
  for (const path of markdownFiles(DOCS_ROOT)) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    const lines = readFileSync(path, 'utf8').split('\n')
    const mustSource = SOURCED_FENCE_DIRECTORIES.some((directory) => page.startsWith(`${directory}/`))
    offenders.push(...sourcedFenceOffenders(page, lines, mustSource))
  }
  expect(offenders).toEqual([])
})

test('⚠ every generated page equals its generator (#168)', () => {
  const offenders: string[] = []
  for (const path of markdownFiles(DOCS_ROOT)) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    offenders.push(...generatedOffenders(page, readFileSync(path, 'utf8')))
  }
  expect(offenders).toEqual([])
})

test('the extractor takes the doc comment, the whole statement, and nothing after it', () => {
  const source = [
    '/** Above. */',
    'export const First = Type.Object({',
    "  kind: Type.Literal('first'), // a ) in a comment",
    '  text: Type.String({ description: "a } in a string" }),',
    '})',
    'export type First = Static<typeof First>',
    '',
    '/**',
    " * Two lines, with the repo's apostrophe.",
    ' */',
    'export type Union =',
    "  | 'a'",
    "  | 'b'",
    'export function after(): void {}',
    'export const Templated = Type.String({',
    '  description: `a template that spans lines',
    '  with an unbalanced { brace and a ( paren',
    '  * and a star-led line that is template text, not a comment',
    '  before it closes`,',
    '})',
    'export const Last = 1',
  ].join('\n')
  expect(extractDeclaration(source, 'First')?.text).toBe(source.split('\n').slice(0, 5).join('\n'))
  expect(extractDeclaration(source, 'Union')?.text).toBe(source.split('\n').slice(7, 13).join('\n'))
  expect(extractDeclaration(source, 'after')?.startLine).toBe(14)
  // A template literal's interior is not code: its braces and its `*`-led line count nothing
  // (PR #169 review), so the statement ends at `})`, not inside the template or past `Last`.
  expect(extractDeclaration(source, 'Templated')?.text).toBe(source.split('\n').slice(14, 20).join('\n'))
  expect(extractDeclaration(source, 'Missing')).toBeUndefined()
  // A template nested in a template's `${…}` is refused, never scanned as code (PR #169 review, round 2).
  const nested = [`export const Nested = \`outer $${'{`inner`}'}`, '  still outer`', 'export const After = 1'].join(
    '\n',
  )
  expect(() => extractDeclaration(nested, 'Nested')).toThrow(/nested in another/)
})
