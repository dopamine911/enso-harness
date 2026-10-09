/**
 * Bun's line coverage as an Istanbul coverage map, so fallow scores CRAP from measured coverage (#826).
 *
 *   bun run coverage:istanbul      → coverage/coverage-final.json, from coverage/lcov.info
 *
 * `bun test` writes LCOV with line hits (`DA:`) and no function records; `fallow health --coverage`
 * reads Istanbul's `coverage-final.json` or raw V8 coverage. This writes the Istanbul map from the
 * LCOV plus each listed source's TypeScript syntax tree:
 *
 * - one statement per `DA:` line, spanning the line's text from its first non-blank character;
 * - one function per body-bearing function in the tree (declarations, methods, accessors,
 *   constructors, arrows, function expressions), spanning its source text, its count taken from
 *   the first `DA:` line inside it.
 *
 * How fallow 3.33 reads that map, which is what this shape is for: a function named
 * `(anonymous_N)` matches fallow's function starting at the same position (within a line of it),
 * whatever fallow calls it; a real name must equal fallow's own name for the function or it
 * matches nothing. So every entry here is `(anonymous_N)` and matches by position. A matched function's coverage is
 * the share of hit statements lying wholly inside its span (statements in nested functions count
 * for the outer one too); its count `f` decides only when no statement lies inside, as for a
 * one-line callback, whose line is shared with the code around it.
 *
 * ⚠ It is line coverage as Bun counts lines, nothing finer: a line that ran counts whole, and
 * there are no branches (`branchMap` stays empty). A one-line callback reads as covered when its
 * line ran, whether or not the callback did.
 *
 * Left out, so fallow keeps its estimate for them rather than read a zero nobody measured: a
 * listed file missing on disk (deleted or moved since the run), a listed file with no `DA:` lines
 * (Bun found nothing executable), and a function with no `DA:` line inside it (⚠ unless an entry
 * starts within a line of it: fallow then scores it from that neighbour's). Files the run never
 * loaded are not in the LCOV at all, and Bun leaves test files out.
 *
 * ⚠ fallow reads `coverage/coverage-final.json` whenever it exists, `--coverage` or not, so once
 * this has run every `fallow health` in the tree scores CRAP from it, however old its LCOV. The
 * gate's health steps are untouched only because `.fallowrc.jsonc` keeps `health.maxCrap: 0`.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import typescript from 'typescript'
import { findRepoRoot } from '../packages/core/src/paths.ts'
import { MINIMUM_REPORTED_FILES } from './check-coverage.ts'

const ROOT = findRepoRoot(import.meta.url)
export const LCOV_PATH = join(ROOT, 'coverage', 'lcov.info')
export const ISTANBUL_PATH = join(ROOT, 'coverage', 'coverage-final.json')

/** One `SF:` record: its path as Bun wrote it (repository-relative) and its hits by 1-based line. */
interface LcovFile {
  readonly path: string
  readonly lines: ReadonlyMap<number, number>
}

interface Position {
  readonly line: number
  readonly column: number
}

interface Span {
  readonly start: Position
  readonly end: Position
}

interface FunctionEntry {
  readonly name: string
  readonly decl: Span
  readonly loc: Span
  readonly line: number
}

/** Istanbul's format names its hit tables with one letter: statements, functions, branches. */
const STATEMENT_HITS = 's'
const FUNCTION_HITS = 'f'
const BRANCH_HITS = 'b'

/** Istanbul's per-file record; lines are 1-based and columns 0-based, as Istanbul writes them. */
interface FileCoverage {
  readonly path: string
  readonly statementMap: Readonly<Record<string, Span>>
  readonly [STATEMENT_HITS]: Readonly<Record<string, number>>
  readonly fnMap: Readonly<Record<string, FunctionEntry>>
  readonly [FUNCTION_HITS]: Readonly<Record<string, number>>
  readonly branchMap: Readonly<Record<string, never>>
  readonly [BRANCH_HITS]: Readonly<Record<string, never>>
}

/** Every `SF:` record and its `DA:` hits; the other LCOV records (`FNF`, `LF`, …) are totals this does not need. */
export function parseLcov(text: string): LcovFile[] {
  const files: LcovFile[] = []
  let path: string | undefined
  let lines = new Map<number, number>()
  for (const record of text.split('\n')) {
    if (record.startsWith('SF:')) {
      path = record.slice(3)
      lines = new Map()
    } else if (record.startsWith('DA:')) {
      const [line = '', hits = ''] = record.slice(3).split(',')
      lines.set(Number(line), Number(hits))
    } else if (record === 'end_of_record' && path !== undefined) {
      files.push({ path, lines })
      path = undefined
    }
  }
  return files
}

/** The function-like nodes fallow scores; an overload signature or abstract method has no body, so no code to cover. */
function isCoverableFunction(node: typescript.Node): node is typescript.FunctionLikeDeclaration {
  return (
    (typescript.isFunctionDeclaration(node) ||
      typescript.isMethodDeclaration(node) ||
      typescript.isConstructorDeclaration(node) ||
      typescript.isGetAccessorDeclaration(node) ||
      typescript.isSetAccessorDeclaration(node) ||
      typescript.isFunctionExpression(node) ||
      typescript.isArrowFunction(node)) &&
    node.body !== undefined
  )
}

function functionNodes(file: typescript.SourceFile): typescript.FunctionLikeDeclaration[] {
  const found: typescript.FunctionLikeDeclaration[] = []
  const visit = (node: typescript.Node): void => {
    if (isCoverableFunction(node)) found.push(node)
    typescript.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function position(file: typescript.SourceFile, offset: number): Position {
  const { line, character } = file.getLineAndCharacterOfPosition(offset)
  return { line: line + 1, column: character }
}

/** One statement per `DA:` line: from the first non-blank character to the last, so it lies inside every function whose span holds that text. */
function statementSpan(lineText: string, line: number): Span {
  const end = lineText.trimEnd().length
  const start = end - lineText.trimEnd().trimStart().length
  return { start: { line, column: start }, end: { line, column: end } }
}

/** The Istanbul record for one source, from its text and its LCOV line hits; `path` is written as given. */
export function istanbulFileCoverage(path: string, source: string, lines: ReadonlyMap<number, number>): FileCoverage {
  const sourceLines = source.split('\n')
  const hitLines = [...lines.entries()].toSorted(([left], [right]) => left - right)
  const statementMap: Record<string, Span> = {}
  const statementHits: Record<string, number> = {}
  for (const [statementIndex, [line, hits]] of hitLines.entries()) {
    statementMap[statementIndex] = statementSpan(sourceLines[line - 1] ?? '', line)
    statementHits[statementIndex] = hits
  }
  const kind = extname(path) === '.tsx' ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS
  const file = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, true, kind)
  const fnMap: Record<string, FunctionEntry> = {}
  const functionHits: Record<string, number> = {}
  for (const node of functionNodes(file)) {
    const loc = { start: position(file, node.getStart(file)), end: position(file, node.getEnd()) }
    const firstHit = hitLines.find(([line]) => line >= loc.start.line && line <= loc.end.line)
    if (firstHit === undefined) continue
    const functionIndex = Object.keys(fnMap).length
    const decl =
      node.name === undefined
        ? loc
        : { start: position(file, node.name.getStart(file)), end: position(file, node.name.getEnd()) }
    fnMap[functionIndex] = { name: `(anonymous_${functionIndex})`, decl, loc, line: loc.start.line }
    functionHits[functionIndex] = firstHit[1]
  }
  return {
    path,
    statementMap,
    [STATEMENT_HITS]: statementHits,
    fnMap,
    [FUNCTION_HITS]: functionHits,
    branchMap: {},
    [BRANCH_HITS]: {},
  }
}

/** What one conversion wrote and left out, for the line the caller prints. */
interface Conversion {
  readonly records: number
  readonly files: number
  readonly functions: number
  readonly missing: readonly string[]
  readonly withoutLines: readonly string[]
}

/** Convert `coverage/lcov.info` into `coverage/coverage-final.json`, keyed by absolute path as Istanbul writes it. */
export function writeIstanbulCoverage(): Conversion {
  const coverage: Record<string, FileCoverage> = {}
  const missing: string[] = []
  const withoutLines: string[] = []
  let functions = 0
  const records = parseLcov(readFileSync(LCOV_PATH, 'utf8'))
  for (const { path, lines } of records) {
    const absolute = join(ROOT, path)
    if (!existsSync(absolute)) missing.push(path)
    else if (lines.size === 0) withoutLines.push(path)
    else {
      coverage[absolute] = istanbulFileCoverage(absolute, readFileSync(absolute, 'utf8'), lines)
      functions += Object.keys(coverage[absolute].fnMap).length
    }
  }
  writeFileSync(ISTANBUL_PATH, JSON.stringify(coverage))
  return { records: records.length, files: Object.keys(coverage).length, functions, missing, withoutLines }
}

/** How long ago the LCOV was written, in whole minutes or hours: what the coverage describes is that run's tree. */
function lcovAge(): string {
  const minutes = Math.floor((Date.now() - statSync(LCOV_PATH).mtimeMs) / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

/** The conversion in one line, with the files it left out named and a partial report called out. */
export function conversionSummary(conversion: Conversion): string {
  const leftOut = [
    ...conversion.missing.map((path) => `${path} (missing on disk)`),
    ...conversion.withoutLines.map((path) => `${path} (no DA lines)`),
  ]
  // A targeted `bun test <file>` overwrites the whole suite's LCOV (#234); its CRAP reads every unloaded file as estimated.
  const partial =
    conversion.records < MINIMUM_REPORTED_FILES
      ? `; ⚠ ${conversion.records} file records, fewer than the ${MINIMUM_REPORTED_FILES} of a whole-suite run: a targeted run's LCOV`
      : ''
  return (
    `${conversion.files} files, ${conversion.functions} functions from coverage/lcov.info (written ${lcovAge()})` +
    (leftOut.length === 0 ? '' : `; left out: ${leftOut.join(', ')}`) +
    partial
  )
}

if (import.meta.main) {
  if (!existsSync(LCOV_PATH)) {
    process.stderr.write('coverage:istanbul: coverage/lcov.info is missing; run `bun test` first.\n')
    process.exit(1)
  }
  process.stdout.write(
    `coverage:istanbul: wrote coverage/coverage-final.json: ${conversionSummary(writeIstanbulCoverage())}\n`,
  )
}
