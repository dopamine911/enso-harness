import { expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractDeclaration } from '../scripts/docs/extract-declaration.ts'
import {
  detectedExceptionConstants,
  numericConstant,
  stringArray,
  stringConstant,
} from '../scripts/docs/gate-source.ts'
import { FENCE_OPEN, SOURCEABLE_FENCE_LANGUAGE } from '../scripts/docs/refresh-fences.ts'
import { markdownFiles, REPOSITORY_ROOT } from './gate-support.ts'

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
 *   `<!-- generated-block: <script> -->` … `<!-- /generated-block -->` inside a hand-written
 *   page: the lines between must equal the script's stdout (#162 workstream 11 — the seams
 *   table lives in architecture.md and is read off the seam pages). Refresh with
 *   `bun scripts/docs/refresh-fences.ts <page>`, which handles both marker kinds.
 *
 *   `<!-- test: <path>#<exact test title> -->` (#167 item 3, `docs/flows/`): the file must
 *   exist and declare a test with exactly that title. A flow page's claim "this test pins
 *   it" is checked, so a renamed or deleted test fails the page that cites it. Every flow
 *   page must cite at least one.
 *
 * And one rule for `docs/seams/` and `docs/flows/`: EVERY fence carries a `source:` marker, or is a
 * `mermaid` diagram. Prose may surround a fence; prose may not restate what a fence says, and a
 * fence with no source is prose wearing a code font.
 *
 * ⚠ The rule is over the fence, not over one language tag (#258). The open pattern used to accept
 * exactly ```` ```ts ```` and `typescript`, so a `tsx` fence, an `sh` fence, or a `ts`
 * fence carrying an info string was invisible to the WHOLE gate — neither required to carry a
 * marker in a seam page nor checked against source when it had one. Measured 2026-09-18: three
 * such fences planted in a seam page ran green. The docs spell two languages today (81 `ts`, 14
 * `mermaid`, measured by grepping every fence-open line under `docs/`), and the rule is
 * deliberately not that list: of any language a page could use, only TypeScript and JavaScript
 * can BE a declaration, so those are the sourceable set, `mermaid` is exempt by name because a
 * diagram is not a quote of source, and anything else in a seam or flow page is an offender
 * rather than an oversight.
 *
 * The allowlist is EMPTY and stays so. A page that cannot keep its fences equal to the
 * source is describing a different program.
 */

const DOCS_ROOT = join(REPOSITORY_ROOT, 'docs')
/** Where every fence must be sourced. Other docs are checked only where they carry a marker. */
const SOURCED_FENCE_DIRECTORIES = ['docs/seams', 'docs/flows'] as const
const SOURCE_MARKER = /^<!--\s*source:\s*(\S+?)#(\w+)\s*-->$/
const GENERATED_MARKER = /^<!--\s*generated:\s*(\S+)\s*-->$/
const BLOCK_OPEN = /^<!--\s*generated-block:\s*(\S+)\s*-->$/
const TEST_MARKER = /^<!--\s*test:\s*(\S+?)#(.+?)\s*-->$/
/** Where every page must cite at least one pinning test. */
const TEST_CITING_DIRECTORIES = ['docs/flows'] as const
const BLOCK_CLOSE = /^<!--\s*\/generated-block\s*-->$/
// `FENCE_OPEN` and `SOURCEABLE_FENCE_LANGUAGE` come from the refresher, which owns them: the gate
// that demands a sourced fence and the tool that fills one must read the same surface (#258).
/**
 * The one unsourced fence a seam or flow page may carry. A mermaid diagram cannot equal a
 * declaration, so requiring a marker on it would be a rule nothing could satisfy; `docs/flows`
 * holds eight of them. Naming the exemption keeps it a decision instead of a hole.
 */
const DIAGRAM_FENCE_LANGUAGE = 'mermaid'
const FENCE_CLOSE = /^```\s*$/

interface Fence {
  readonly openLine: number
  /** The fence's language tag, lowercased; `''` for a bare ```` ``` ````. */
  readonly language: string
  readonly body: string
  readonly source: { path: string; symbol: string } | undefined
}

/**
 * EVERY fence in a page, with its language and the `source:` marker directly above it when there
 * is one. An unclosed fence is an offender, not the end of the scan: the page after it is
 * unreadable as markdown, and a fence the scan cannot see is a fence it cannot check.
 *
 * The scan jumps to each fence's close before looking for the next open, which is what lets the
 * same `^```` pattern serve as both: a bare ```` ``` ```` is an opening delimiter when the walk is
 * outside a fence and a closing one when it is inside, exactly as markdown reads it.
 */
function fencesOf(page: string, lines: readonly string[], offenders: string[]): Fence[] {
  const fences: Fence[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const open = FENCE_OPEN.exec(lines[lineIndex] ?? '')
    if (open === null) continue
    const closeIndex = lines.findIndex((line, index) => index > lineIndex && FENCE_CLOSE.test(line))
    if (closeIndex === -1) {
      offenders.push(`${page}:${lineIndex + 1}: fence is never closed`)
      break
    }
    const marker = SOURCE_MARKER.exec(lines[lineIndex - 1] ?? '')
    fences.push({
      openLine: lineIndex + 1,
      language: (open[1] ?? '').toLowerCase(),
      body: lines.slice(lineIndex + 1, closeIndex).join('\n'),
      source: marker ? { path: marker[1] ?? '', symbol: marker[2] ?? '' } : undefined,
    })
    lineIndex = closeIndex
  }
  return fences
}

/** How a fence with no marker reads in an offender line: `sh`, or `unlabelled` for a bare fence. */
function describeLanguage(language: string): string {
  return language === '' ? 'unlabelled' : `\`${language}\``
}

function sourcedFenceOffenders(page: string, lines: readonly string[], fenceMustBeSourced: boolean): string[] {
  const offenders: string[] = []
  for (const fence of fencesOf(page, lines, offenders)) {
    const sourceable = SOURCEABLE_FENCE_LANGUAGE.test(fence.language)
    if (fence.source === undefined) {
      // A page that must source its fences: TypeScript needs a marker, a diagram is exempt by
      // name, and anything else is a third thing the rule never decided to allow.
      if (!fenceMustBeSourced) continue
      if (fence.language === DIAGRAM_FENCE_LANGUAGE) continue
      offenders.push(
        sourceable
          ? `${page}:${fence.openLine}: ${describeLanguage(fence.language)} fence without a <!-- source: --> marker`
          : `${page}:${fence.openLine}: ${describeLanguage(fence.language)} fence — a fence here is a sourced quote or a mermaid diagram, nothing else`,
      )
      continue
    }
    // A marker above a fence the extractor cannot fill is a claim nothing checks — the half of
    // the blind spot that hid a MARKED fence rather than an unmarked one (#258).
    if (!sourceable) {
      offenders.push(
        `${page}:${fence.openLine}: <!-- source: --> marker above a ${describeLanguage(fence.language)} fence — only a TypeScript or JavaScript fence can equal a declaration`,
      )
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

/** The script's stdout, or the offender line when it cannot be produced. */
function generatorOutput(page: string, line: number, script: string): { text: string } | { offender: string } {
  if (!existsSync(join(REPOSITORY_ROOT, script)))
    return { offender: `${page}:${line}: generator ${script} does not exist` }
  const generated = Bun.spawnSync(['bun', script], { cwd: REPOSITORY_ROOT })
  if (generated.exitCode !== 0) {
    return {
      offender: `${page}:${line}: ${script} exited ${generated.exitCode}: ${generated.stderr.toString().trim()}`,
    }
  }
  return { text: generated.stdout.toString() }
}

function generatedOffenders(page: string, text: string): string[] {
  const lines = text.split('\n')
  const marker = GENERATED_MARKER.exec(lines[0] ?? '')
  if (marker) {
    const output = generatorOutput(page, 1, marker[1] ?? '')
    if ('offender' in output) return [output.offender]
    return output.text.trim() === text.trim() ? [] : [`${page}: differs from \`bun ${marker[1] ?? ''}\` — regenerate`]
  }
  const offenders: string[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const open = BLOCK_OPEN.exec(lines[lineIndex] ?? '')
    if (!open) continue
    const script = open[1] ?? ''
    const closeIndex = lines.findIndex((candidate, index) => index > lineIndex && BLOCK_CLOSE.test(candidate))
    if (closeIndex === -1) {
      offenders.push(`${page}:${lineIndex + 1}: generated-block for ${script} is never closed`)
      break
    }
    const output = generatorOutput(page, lineIndex + 1, script)
    if ('offender' in output) offenders.push(output.offender)
    else if (
      output.text.trim() !==
      lines
        .slice(lineIndex + 1, closeIndex)
        .join('\n')
        .trim()
    ) {
      offenders.push(`${page}:${lineIndex + 1}: block differs from \`bun ${script}\` — refresh`)
    }
    lineIndex = closeIndex
  }
  return offenders
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

test('⚠ every generated page, and every generated block, equals its generator (#168)', () => {
  const offenders: string[] = []
  for (const path of markdownFiles(DOCS_ROOT)) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    offenders.push(...generatedOffenders(page, readFileSync(path, 'utf8')))
  }
  expect(offenders).toEqual([])
})

/**
 * The paths `docs/architecture.md` → *Package structure* names, resolved by indentation (two
 * spaces per level; several names on one line are siblings; a `*` is a glob and is not checked).
 */
function architectureTreePaths(text: string): string[] {
  const start = text.indexOf('## Package structure')
  const open = text.indexOf('```\n', start)
  const close = text.indexOf('\n```', open + 4)
  if (start < 0 || open < 0 || close < 0) throw new Error('architecture.md has no Package structure tree')
  // Each stack level is the directory a deeper line nests under. A line naming several
  // siblings (`skills/ prompts/ themes/`) pushes no directory: a child under it would have
  // no unambiguous parent, so such a child is refused rather than resolved against the first.
  const stack: (string | undefined)[] = []
  const paths: string[] = []
  for (const line of text.slice(open + 4, close).split('\n')) {
    const names = (line.split('#')[0] ?? '').trim()
    if (names === '') continue
    const depth = ((/^ */.exec(line)?.[0].length ?? 0) / 2) | 0
    stack.length = depth
    if (stack.some((segment) => segment === undefined)) {
      throw new Error(`architecture.md tree: "${names}" nests under a line that names several siblings`)
    }
    const parent = stack.join('')
    const siblings = names.split(/\s+/)
    for (const name of siblings) {
      if (!name.includes('*')) paths.push(parent + name)
    }
    stack.push(siblings.length === 1 ? siblings[0] : undefined)
  }
  return paths
}

/** A path git ignores is not in a checkout — CI has no `.enso/` — so its absence is not drift. */
function isGitIgnored(path: string): boolean {
  return Bun.spawnSync(['git', 'check-ignore', '-q', path], { cwd: REPOSITORY_ROOT }).exitCode === 0
}

test('⚠ every path the architecture tree names exists, or is gitignored (#162 workstream 11)', () => {
  const text = readFileSync(join(DOCS_ROOT, 'architecture.md'), 'utf8')
  // the root line is the repository itself
  const paths = architectureTreePaths(text).map((path) => path.replace(/^Enso\//, ''))
  expect(paths.length).toBeGreaterThan(20)
  const missing = paths.filter((path) => !(existsSync(join(REPOSITORY_ROOT, path)) || isGitIgnored(path)))
  expect(missing).toEqual([])
})

/**
 * Relative links in a page — `](./x.md)`, `](../y/z.json)` and the bare `](docs/x.md)` README
 * uses — with the line they sit on. Skipped: URLs with a scheme, absolute paths, `#anchor`-only.
 */
function relativeLinks(text: string): { target: string; line: number }[] {
  const links: { target: string; line: number }[] = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] ?? ''
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue
      links.push({ target, line: index + 1 })
    }
  })
  return links
}

/** The `test:` markers in a page, with the line they sit on. */
function testMarkers(text: string): { path: string; title: string; line: number }[] {
  const markers: { path: string; title: string; line: number }[] = []
  text.split('\n').forEach((line, index) => {
    const match = TEST_MARKER.exec(line)
    if (match) markers.push({ path: match[1] ?? '', title: match[2] ?? '', line: index + 1 })
  })
  return markers
}

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does `source` declare `test('<title>'` (any quote style, `test` or `test.skip`/`.only` refused)? */
function declaresTest(source: string, title: string): boolean {
  const escaped = escapeForRegExp(title)
  return new RegExp(`^\\s*test\\(\\s*(?:'${escaped}'|"${escaped}"|\`${escaped}\`)\\s*,`, 'm').test(source)
}

test('⚠ every cited test exists with exactly that title; every flow page cites one (#167 item 3)', () => {
  const offenders: string[] = []
  for (const path of markdownFiles(DOCS_ROOT)) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    const text = readFileSync(path, 'utf8')
    const markers = testMarkers(text)
    const isFlowPage =
      TEST_CITING_DIRECTORIES.some((directory) => page.startsWith(`${directory}/`)) && !page.endsWith('/README.md')
    if (isFlowPage && markers.length === 0) {
      offenders.push(`${page}: a flow page cites no pinning test (<!-- test: <path>#<title> -->)`)
    }
    for (const marker of markers) {
      const testPath = join(REPOSITORY_ROOT, marker.path)
      if (!existsSync(testPath)) {
        offenders.push(`${page}:${marker.line}: ${marker.path} does not exist`)
        continue
      }
      if (!declaresTest(readFileSync(testPath, 'utf8'), marker.title)) {
        offenders.push(`${page}:${marker.line}: ${marker.path} declares no test titled "${marker.title}"`)
      }
    }
  }
  expect(offenders).toEqual([])
})

test('⚠ every relative link under docs/ and in README resolves to a file (#162 workstream 11)', () => {
  const offenders: string[] = []
  for (const path of [...markdownFiles(DOCS_ROOT), join(REPOSITORY_ROOT, 'README.md')]) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    for (const link of relativeLinks(readFileSync(path, 'utf8'))) {
      if (!existsSync(join(path, '..', link.target))) offenders.push(`${page}:${link.line}: ${link.target}`)
    }
  }
  expect(offenders).toEqual([])
})

/** A `[text](target.ts)` link, and the prose since the previous link on that line. */
function sourceCitations(text: string): { file: string; claimed: string[]; line: number }[] {
  const citations: { file: string; claimed: string[]; line: number }[] = []
  text.split('\n').forEach((line, index) => {
    let cursor = 0
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)#\s]+\.tsx?)(?:#[^)]*)?\)/g)) {
      const before = line.slice(cursor, match.index)
      cursor = (match.index ?? 0) + match[0].length
      // The identifiers this stretch of prose says are in the file it then links.
      const claimed = [...before.matchAll(/`([A-Z][A-Za-z0-9_]*)`/g)].map((name) => name[1] ?? '')
      if (claimed.length > 0) citations.push({ file: match[1] ?? '', claimed, line: index + 1 })
    }
  })
  return citations
}

/** The Retired table's left column: names that deliberately exist nowhere in the tree. */
function retiredNames(): Set<string> {
  const glossary = readFileSync(join(DOCS_ROOT, 'glossary.md'), 'utf8')
  const retired = glossary.slice(glossary.indexOf('## Retired'))
  return new Set([...retired.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9_]*)`/gm)].map((row) => row[1] ?? ''))
}

/**
 * ⚠ A LINK THAT RESOLVES IS NOT A CITATION THAT HOLDS (PR #307 review). The gate above
 * proves the file exists, which is what let the leak inventory say `RuntimeEvent` was
 * renamed "in `thread-runtime.ts`" — a real file, which has never declared it; L2 moved the
 * event below the seam to `host/runtime-event.ts`, as the glossary said all along. The row
 * contradicted the page it cites, in the one table whose whole job is to say where each leak
 * went, and nothing failed.
 *
 * So: a name in backticks, in the prose leading to a source link, has to be declared in that
 * file. Three exemptions, each because the claim is held elsewhere or is not a location claim:
 *   • the SEAM pages only — a generated page's citations are its generator's, diffed above,
 *     and those rows legitimately name a schema a route USES rather than declares;
 *   • a retired name, whose whole claim is that it exists nowhere (`glossary-gate.test.ts`);
 *   • the `Pi*` class, which is L1's subject and retired as a class, not row by row.
 */
test('⚠ a symbol named beside a source link is declared in the file it links (#245)', () => {
  const retired = retiredNames()
  const offenders: string[] = []
  for (const path of markdownFiles(join(DOCS_ROOT, 'seams'))) {
    const page = path.slice(REPOSITORY_ROOT.length + 1)
    for (const citation of sourceCitations(readFileSync(path, 'utf8'))) {
      const target = join(path, '..', citation.file)
      if (!existsSync(target)) continue // the link gate above names this one
      const source = readFileSync(target, 'utf8')
      for (const name of citation.claimed) {
        if (retired.has(name) || /^Pi[A-Z]/.test(name)) continue
        if (new RegExp(`\\b(?:type|interface|class|function|const|enum)\\s+${name}\\b`).test(source)) continue
        offenders.push(`${page}:${citation.line}: ${citation.file} declares no ${name}`)
      }
    }
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

test('the extractor drops the tags that file a symbol in the API index, and nothing else (#188)', () => {
  const source = [
    '/**',
    ' * What the contract is.',
    ' *',
    ' * @group Follow wire',
    ' * @category Message stream',
    ' */',
    'export const Tagged = 1',
    '/** @group Logging */',
    'export type TagOnly = string',
    '/** @remarks a tag the pages DO quote. */',
    'export const Other = 2',
  ].join('\n')
  // The prose survives; the filing instruction and the `*` that separated it do not.
  expect(extractDeclaration(source, 'Tagged')?.text).toBe(
    ['/**', ' * What the contract is.', ' */', 'export const Tagged = 1'].join('\n'),
  )
  // A comment that carried only the tag goes whole — an empty `/** */` above a declaration is worse.
  expect(extractDeclaration(source, 'TagOnly')?.text).toBe('export type TagOnly = string')
  // ⚠ Only these two tags: anything else a comment says is the page's to quote.
  expect(extractDeclaration(source, 'Other')?.text).toBe(
    ['/** @remarks a tag the pages DO quote. */', 'export const Other = 2'].join('\n'),
  )
})

// ── the seam inventory (#213) ────────────────────────────────────────────────────────

/**
 * The real generator over a COPY of `docs/seams/` — its one argument is the pages
 * directory, and the metadata keys it checks are still the real ones, so a fixture can add
 * or retitle a page without touching the pages this repo ships. `edit` is what the
 * thirteenth author does.
 */
function seamsTableOver(edit: (directory: string) => void): { exitCode: number; stdout: string; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), 'enso-seams-'))
  cpSync(join(DOCS_ROOT, 'seams'), directory, { recursive: true })
  edit(directory)
  const run = Bun.spawnSync(['bun', 'scripts/docs/seams-table.ts', directory], { cwd: REPOSITORY_ROOT })
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

test('the seams table has one row per page under docs/seams, the named non-seams aside (#213)', () => {
  const generated = seamsTableOver(() => undefined)
  expect(generated.stderr).toBe('')
  expect(generated.exitCode).toBe(0)
  const listed = [...generated.stdout.matchAll(/]\(\.\/seams\/([^)]+)\)/g)].map((row) => row[1] ?? '').sort()
  const onDisk = readdirSync(join(DOCS_ROOT, 'seams'))
    .filter((file) => file.endsWith('.md') && file !== 'README.md' && file !== 'ported-provenance.md')
    .sort()
  expect(listed).toEqual(onDisk)
})

// ⚠ AN INVENTORY THAT CAN OMIT IS NOT AN INVENTORY (#213). The generator's header promises
// "a page added or removed fails here rather than going unlisted", and for one case it did
// not: the page list was filtered by the `# Seam: …` title BEFORE the exhaustiveness check,
// so a page whose H1 read anything else was dropped before anything could miss it — absent
// from the table in `architecture.md`, absent from the metadata, generator exit 0, the gate
// green. That is the growth case: a thirteenth seam page titled `# The context seam`. A red
// line here means the seams table can again understate the inventory, and a contract nobody
// is handed on review is a contract nobody reviews.
test('⚠ a page under docs/seams the generator cannot classify is REFUSED, never omitted (#213)', () => {
  const added = seamsTableOver((directory: string) => {
    writeFileSync(
      join(directory, 'context.md'),
      '# The context seam\n\n## What crosses it that should not\n\n**Nothing yet.**\n',
    )
  })
  expect(added.exitCode).not.toBe(0)
  expect(added.stderr).toContain('context.md')
  expect(added.stdout).toBe('')

  // A page the table already lists, retitled: refused by name and by the title it needs,
  // not by an exhaustiveness message that says only that a key went missing.
  const retitled = seamsTableOver((directory: string) => {
    const page = join(directory, 'storage.md')
    writeFileSync(page, readFileSync(page, 'utf8').replace(/^# Seam: .+$/m, '# Storage'))
  })
  expect(retitled.exitCode).not.toBe(0)
  expect(retitled.stderr).toContain('storage.md has no "# Seam: …" title')

  // The leak column is each page's own claim, not prose: a leak section whose first
  // paragraph is not the bold lead cannot become a cell, and says so.
  const unbolded = seamsTableOver((directory: string) => {
    const page = join(directory, 'dialog.md')
    writeFileSync(
      page,
      readFileSync(page, 'utf8').replace(
        '## What crosses it that should not\n',
        '## What crosses it that should not\n\nA note before the lead.\n',
      ),
    )
  })
  expect(unbolded.exitCode).not.toBe(0)
  expect(unbolded.stderr).toContain("dialog.md's leak section does not open with a bold lead sentence")
})

/**
 * The inventory's completeness claim, which used to have a silent escape hatch (#262).
 *
 * The exception detector name-matches every allowlist-shaped constant in a gate file and then
 * decides whether it can read it. A `try/catch` decided that, so "no array under this name" and
 * "an array I cannot read flat" were the same answer: an allowlist written as a spread, a regex
 * literal or a nested array simply left `detectedExceptions`, the exactness check passed because
 * the author never had to record it, and `docs/reference/verification-inventory.md` published as
 * the exception inventory with that allowlist absent. This gate could not see it either — it
 * diffs the page against the same generator, so both sides omitted the row.
 *
 * ⚠ A red line here means an unreadable allowlist can go missing from the published inventory
 * again. The two answers must stay different: one skips, the other refuses by name.
 */
test('⚠ an allowlist the reader cannot parse is REFUSED, not skipped (#262)', () => {
  // The shapes the reader knows — bare array, `new Set` wrapper, and the per-entry comments the
  // gates actually carry: detected, so the author has to record each one.
  expect(detectedExceptionConstants("const VENDORED_PATHS = ['a/b.ts']", 'probe.ts')).toEqual(['VENDORED_PATHS'])
  expect(detectedExceptionConstants("const SKIPPED_NAMES = new Set(['a'])", 'probe.ts')).toEqual(['SKIPPED_NAMES'])
  expect(detectedExceptionConstants("const EXEMPT_PATHS = ['a', /* upstream's */ 'b']", 'probe.ts')).toEqual([
    'EXEMPT_PATHS',
  ])
  // A name match that declares no array is a legitimate miss, not an allowlist.
  expect(detectedExceptionConstants('const MAX_ALLOWED_DEPTH = 5', 'probe.ts')).toEqual([])
  // Found, and unreadable: each must name the file and the constant rather than disappear.
  for (const unreadable of [
    'const EXEMPT_PATHS = [...BASE, 1]',
    'const EXEMPT_PATHS = [/^a/]',
    "const EXEMPT_PATHS = [['a']]",
  ]) {
    expect(() => detectedExceptionConstants(unreadable, 'probe.ts')).toThrow(
      /probe\.ts: EXEMPT_PATHS is not a flat string array/,
    )
  }
})

// The other three readers, answered directly (PR #300 review). The split's stated reason was
// that a reader is a question about a string and needs no generator to ask — which applies to
// all of them, not only the detector. Each publishes a row of the inventory, so a reader that
// silently returns the wrong value publishes a wrong claim about what a gate enforces.
test('each gate-source reader answers its shape, and refuses rather than guessing', () => {
  // The comment mask is the subtle one: a `//` inside a quoted entry is an entry, not a comment.
  expect(stringArray("const A = ['packages/a.ts', 'https://x/y'] // trailing", 'A', 'probe.ts')).toEqual([
    'packages/a.ts',
    'https://x/y',
  ])
  // ⚠ A `]` inside an ENTRY is content, not the end of the array (PR #302 review). The
  // non-greedy capture this replaced stopped there: the comment case published a short count
  // (13 read as 9) and the entry case made the whole declaration unreadable, which the
  // generator then reported as "absent from source" — the wrong cause, naming the author.
  expect(stringArray("const A = ['packages/a[1].tsx', 'packages/b.ts']", 'A', 'probe.ts')).toEqual([
    'packages/a[1].tsx',
    'packages/b.ts',
  ])
  // …and a bracket in a REASON comment is not the array's end either.
  expect(stringArray("const A = [\n  // see index[0]\n  'packages/b.ts',\n]", 'A', 'probe.ts')).toEqual([
    'packages/b.ts',
  ])
  // An EMPTY allowlist is the state the gates aim for, not a parse failure.
  expect(stringArray('const A: readonly string[] = []', 'A', 'probe.ts')).toEqual([])
  expect(() => stringArray('const B = []', 'A', 'probe.ts')).toThrow(/probe\.ts: cannot parse string array A/)
  expect(stringConstant("const ROOT = 'packages/web'", 'ROOT', 'probe.ts')).toBe('packages/web')
  expect(() => stringConstant('const ROOT = someCall()', 'ROOT', 'probe.ts')).toThrow(
    /probe\.ts: cannot parse string constant ROOT/,
  )
  // Exported and fractional, because a threshold is both (`.fallowrc` pins a two-decimal percentage).
  expect(numericConstant('export const FLOOR = 91.5', 'FLOOR', 'probe.ts')).toBe(91.5)
  expect(() => numericConstant('const FLOOR = computed', 'FLOOR', 'probe.ts')).toThrow(
    /probe\.ts: cannot parse numeric constant FLOOR/,
  )
})
