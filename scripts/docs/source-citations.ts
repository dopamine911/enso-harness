import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import typescript from 'typescript'
import { filesUnder, SOURCE_FILE } from '../source-tree.ts'
import { ROOT } from './flow-tags.ts'

/**
 * SOURCE CITATIONS IN THE HAND-WRITTEN DOCS (#482): `path#Name` in a code span, never a line number.
 *
 * A seam page is sold as the substitute for reading the code, so where it points has to hold. A
 * typed line number does not: it is right the day it is written and drifts at the next edit to
 * the file, and only the numbers written beside their symbol were ever checked
 * (`prose-citation-gate`, which `test/source-citation-gate.test.ts` replaces). Sampled on 2026-09-30, two of six in
 * `dialog.md` pointed at the wrong line.
 *
 * So a page names the declaration, `` `extension-ui-context.ts#awaitDialog` ``, and:
 *   • `test/source-citation-gate.test.ts` resolves every one with the TypeScript parser: the path
 *     is the unique source file it is a suffix of, and the name is declared in that file at any
 *     depth (a method, a local function);
 *   • the site build turns each into a link to that line on GitHub (`linkCitations`), so a
 *     reader still lands on the line, computed when the page is built.
 *
 * A line number for a file of THIS repository (`secrets.ts:83`, "line 250" on a seam page) is
 * refused. A vendor's file (pi's `src/core/tools/bash.ts:29`) resolves to nothing here, and
 * keeps its number: its lines move only when its pinned version does.
 */

/** Where a cited file may live. A page names it short (`map-events.ts`); the suffix resolves it. */
const SOURCE_ROOTS: readonly string[] = ['packages', 'scripts', 'test']

/** A source path, as a pattern: the walker's own extension set (`SOURCE_FILE`), so a file it reads is one a page may cite. */
const SOURCE_PATH = String.raw`((?:[\w@.-]+\/)*[\w.-]+${SOURCE_FILE.source.replace(/\$$/, '')})`
/** A cited path, `#`, a name: what a code span carries when it points at a declaration. */
const CITATION = new RegExp(String.raw`^${SOURCE_PATH}#([A-Za-z_$][\w$]*)$`)
/** A code span, whatever it holds; a span that is a link's text is followed by `](`. */
const CODE_SPAN = /`([^`\n]+)`(\]\()?/g
/** "line 12", "lines 12–20": a number with nothing to resolve it against. Across a wrap, too: "lines\n840–862". */
const BARE_LINE = /\blines?\s+\d+(?:\s*[–-]\s*\d+)?/g
/**
 * A path's `:12` without its path, `(:4-9)` or `` `:365-368` `` after a file named earlier. Not
 * after a word, a dot, a slash or a bracket: `secrets.ts:83` is `PATH_LINE`'s, `02:08` is a time.
 */
const BARE_SUFFIX = /(?<![\w./\]])(?::\d+(?:[–-]\d+)?(?:,\s*\d+)*)/g
/** `path.ts:12` or `path.ts:12-20`, in or out of a code span. */
const PATH_LINE = new RegExp(String.raw`${SOURCE_PATH}:\d+(?:[–-]\d+)?`, 'g')

export interface Citation {
  /** The page line it is on, 1-based. */
  readonly line: number
  readonly path: string
  readonly name: string
}

export interface LineReference {
  readonly line: number
  readonly text: string
}

let sourceFiles: readonly string[] | undefined

/** Every source file a citation may name, repository-relative. */
function sources(): readonly string[] {
  sourceFiles ??= SOURCE_ROOTS.flatMap((root) => filesUnder(join(ROOT, root))).map((path) =>
    relative(ROOT, path).replaceAll('\\', '/'),
  )
  return sourceFiles
}

/** The repository files `path` names: itself, or those it is a trailing path of. */
export function filesNamed(path: string, files: readonly string[] = sources()): string[] {
  return files.filter((file) => file === path || file.endsWith(`/${path}`))
}

const declarationCache = new Map<string, ReadonlyMap<string, number>>()

/** A named declaration's name, for every kind a page may cite. */
function declaredName(node: typescript.Node): string | undefined {
  const named =
    typescript.isFunctionDeclaration(node) ||
    typescript.isClassDeclaration(node) ||
    typescript.isInterfaceDeclaration(node) ||
    typescript.isTypeAliasDeclaration(node) ||
    typescript.isEnumDeclaration(node) ||
    typescript.isVariableDeclaration(node) ||
    typescript.isMethodDeclaration(node) ||
    typescript.isMethodSignature(node) ||
    typescript.isPropertyDeclaration(node) ||
    typescript.isPropertySignature(node) ||
    typescript.isPropertyAssignment(node) ||
    typescript.isGetAccessorDeclaration(node)
  if (!named || node.name === undefined || !typescript.isIdentifier(node.name)) return undefined
  return node.name.text
}

/**
 * Every name `source` declares, with the line its declaration starts on (1-based, past its doc
 * comment). ⚠ The SHALLOWEST declaration of a name wins, then the first: `finish` inside
 * `awaitDialog` is found, but a file-level `finish` would be the one a page means.
 */
export function declarationsIn(path: string, source: string): ReadonlyMap<string, number> {
  const kind = path.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS
  const file = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, true, kind)
  const found = new Map<string, { line: number; depth: number }>()
  const visit = (node: typescript.Node, depth: number): void => {
    const name = declaredName(node)
    const previous = name === undefined ? undefined : found.get(name)
    if (name !== undefined && (previous === undefined || depth < previous.depth)) {
      found.set(name, { line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, depth })
    }
    typescript.forEachChild(node, (child) => visit(child, depth + 1))
  }
  visit(file, 0)
  return new Map([...found].map(([name, { line }]) => [name, line]))
}

function declarationsOf(file: string): ReadonlyMap<string, number> {
  let declarations = declarationCache.get(file)
  if (declarations === undefined) {
    declarations = declarationsIn(file, readFileSync(join(ROOT, file), 'utf8'))
    declarationCache.set(file, declarations)
  }
  return declarations
}

/** Where `path#name` points, or why it points nowhere. */
export function resolveCitation(
  path: string,
  name: string,
  files: readonly string[] = sources(),
): { readonly file: string; readonly line: number } | string {
  const [file, ...others] = filesNamed(path, files)
  if (file === undefined) return `${path} is no source file of this repository`
  if (others.length > 0)
    return `${path} names ${others.length + 1} files (${[file, ...others].join(', ')}); give more of its path`
  const line = declarationsOf(file).get(name)
  return line === undefined ? `${file} declares no ${name}` : { file, line }
}

/** The page's lines outside fenced code, with their line numbers: a fence is source, not prose. */
function proseLines(markdown: string): { text: string; line: number }[] {
  let fenced = false
  return markdown.split('\n').flatMap((text, index) => {
    if (text.trimStart().startsWith('```')) {
      fenced = !fenced
      return []
    }
    return fenced ? [] : [{ text, line: index + 1 }]
  })
}

/** Every `path#Name` citation in a page's prose. A span that is a link's text is the link's, not one. */
export function citationsIn(markdown: string): Citation[] {
  return proseLines(markdown).flatMap(({ text, line }) =>
    [...text.matchAll(CODE_SPAN)].flatMap((span) => {
      const cited = span[2] === undefined ? CITATION.exec(span[1] ?? '') : null
      return cited === null ? [] : [{ line, path: cited[1] ?? '', name: cited[2] ?? '' }]
    }),
  )
}

/** The page with its fenced code blanked, line for line: a fence is source, and the numbering stays the page's. */
function withoutFences(markdown: string): string {
  let fenced = false
  return markdown
    .split('\n')
    .map((pageLine) => {
      if (!pageLine.trimStart().startsWith('```')) return fenced ? '' : pageLine
      fenced = !fenced
      return ''
    })
    .join('\n')
}

/**
 * The typed line numbers in a page's prose that point into this repository: `path:N` for a
 * path that is one of its source files, and, where `bare` (the seam pages, whose every number is
 * this repository's), "line N" and `:N` on their own. Scanned over the whole prose, not line by
 * line, so a range the wrap split is still one reference, on the line it starts.
 */
export function lineReferencesIn(
  markdown: string,
  bare: boolean,
  files: readonly string[] = sources(),
): LineReference[] {
  const prose = withoutFences(markdown)
  const found = (pattern: RegExp): (LineReference & { readonly at: number; readonly path: string })[] =>
    [...prose.matchAll(pattern)].map((match) => ({
      at: match.index,
      line: prose.slice(0, match.index).split('\n').length,
      text: match[0].replaceAll(/\s+/g, ' '),
      path: match[1] ?? '',
    }))
  return [
    ...found(PATH_LINE).filter((reference) => filesNamed(reference.path, files).length > 0),
    ...(bare ? [...found(BARE_LINE), ...found(BARE_SUFFIX)] : []),
  ]
    .sort((left, right) => left.at - right.at)
    .map(({ line, text }) => ({ line, text }))
}

/**
 * The page with every citation that resolves made a link to its line under `blob` (the site
 * build's view of the repository). One that does not resolve is left as written: the gate names it.
 */
export function linkCitations(markdown: string, blob: string, files: readonly string[] = sources()): string {
  let fenced = false
  return markdown
    .split('\n')
    .map((pageLine) => {
      if (pageLine.trimStart().startsWith('```')) fenced = !fenced
      if (fenced || pageLine.trimStart().startsWith('```')) return pageLine
      return pageLine.replace(CODE_SPAN, (whole, span: string, linkText: string | undefined) => {
        const cited = linkText === undefined ? CITATION.exec(span) : null
        if (cited === null) return whole
        const resolved = resolveCitation(cited[1] ?? '', cited[2] ?? '', files)
        return typeof resolved === 'string' ? whole : `[\`${span}\`](${blob}/${resolved.file}#L${resolved.line})`
      })
    })
    .join('\n')
}

/** Where a page's bare "line N" is refused as well as `path:N`: the pages about this repository's seams. */
const BARE_LINES_REFUSED_UNDER = 'docs/seams/'

/** Why a hand-written page's citations do not hold, one line each; empty when they do. */
export function pageProblems(page: string, markdown: string, files: readonly string[] = sources()): string[] {
  const unresolved = citationsIn(markdown).flatMap((cited) => {
    const resolved = resolveCitation(cited.path, cited.name, files)
    return typeof resolved === 'string' ? [`${page}:${cited.line}: \`${cited.path}#${cited.name}\`: ${resolved}`] : []
  })
  const numbers = lineReferencesIn(markdown, page.startsWith(BARE_LINES_REFUSED_UNDER), files).map(
    (reference) => `${page}:${reference.line}: "${reference.text}" is a typed line number; cite \`path#Name\` instead`,
  )
  return [...unresolved, ...numbers]
}

if (import.meta.main) {
  const problems = process.argv.slice(2).flatMap((page) => pageProblems(page, readFileSync(join(ROOT, page), 'utf8')))
  process.stdout.write(problems.length === 0 ? 'source-citations: every citation holds\n' : `${problems.join('\n')}\n`)
  process.exitCode = problems.length === 0 ? 0 : 1
}
