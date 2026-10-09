import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { filesUnder } from '../source-tree.ts'
import { runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/decisions.md` (#170): one row for each owned source file whose
 * first comment/header block cites an issue. It deliberately inventories code-local decision
 * headers, not arbitrary issue mentions in implementations, fixtures, or prose later in a file.
 */

const ROOT = findRepoRoot(import.meta.url)
const SOURCE_ROOTS = ['packages', 'scripts', 'test'] as const
const VENDORED_COMPONENTS = 'packages/web/src/components/'
const HEADER_LINE_LIMIT = 80
const ISSUE = /#(\d+)/g
const SENTENCE_CLOSERS = '"\'`)]'

interface Header {
  readonly startLine: number
  readonly lines: string[]
  readonly style: 'block' | 'line'
}

interface DecisionRow {
  readonly file: string
  readonly issues: number[]
  readonly decision: string
  readonly unclassified: boolean
}

/** Owned source only: the vendored components' headers are their upstream's decisions, not ours. */
function sourceFiles(directory: string): string[] {
  return filesUnder(directory, {
    keep: (_name: string, path: string): boolean =>
      !relative(ROOT, path).replaceAll('\\', '/').startsWith(VENDORED_COMPONENTS),
  })
}

/** The first comment block or run of line comments that STARTS within the limit, read to its end wherever that is. */
function leadingHeader(source: string): Header | undefined {
  const lines = source.split('\n')
  for (let lineIndex = 0; lineIndex < Math.min(lines.length, HEADER_LINE_LIMIT); lineIndex += 1) {
    const trimmed = (lines[lineIndex] ?? '').trimStart()
    if (trimmed.startsWith('/*')) return blockHeader(lines, lineIndex)
    if (trimmed.startsWith('//')) return lineCommentHeader(lines, lineIndex)
  }
  return undefined
}

/** The block comment opening at `start`, through the line that closes it or the file's last line. */
function blockHeader(lines: readonly string[], start: number): Header {
  const headerLines = [lines[start] ?? '']
  let lineIndex = start
  while (!headerLines.at(-1)?.includes('*/') && lineIndex + 1 < lines.length) {
    lineIndex += 1
    headerLines.push(lines[lineIndex] ?? '')
  }
  return { startLine: start + 1, lines: headerLines, style: 'block' }
}

/** The run of `//` lines starting at `start`. */
function lineCommentHeader(lines: readonly string[], start: number): Header {
  const headerLines = [lines[start] ?? '']
  let lineIndex = start
  while ((lines[lineIndex + 1] ?? '').trimStart().startsWith('//')) {
    lineIndex += 1
    headerLines.push(lines[lineIndex] ?? '')
  }
  return { startLine: start + 1, lines: headerLines, style: 'line' }
}

function normalizedHeader(header: Header): string {
  const lines = header.lines.map((line, index) => {
    if (header.style === 'line') return line.replace(/^\s*\/\/\s?/, '').trim()
    let cleaned = line
    if (index === 0) cleaned = cleaned.replace(/^\s*\/\*+\s?/, '')
    if (index === header.lines.length - 1) cleaned = cleaned.replace(/\s*\*\/\s*$/, '')
    return cleaned.replace(/^\s*\*\s?/, '').trim()
  })
  return lines
    .filter((line) => line.length > 0)
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function firstCompleteSentence(text: string): string | undefined {
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    const character = text[characterIndex] ?? ''
    if (!'.!?'.includes(character)) continue
    let afterSentence = characterIndex + 1
    while (text[afterSentence] !== undefined && SENTENCE_CLOSERS.includes(text[afterSentence] ?? '')) {
      afterSentence += 1
    }
    const next = text[afterSentence]
    if (next !== undefined && !/\s/.test(next)) continue
    const sentence = text.slice(0, afterSentence).trim()
    if (sentence.length > 0) return sentence
  }
  return undefined
}

function decisions(): DecisionRow[] {
  const rows: DecisionRow[] = []
  const seen = new Set<string>()
  const files = SOURCE_ROOTS.flatMap((sourceRoot) => sourceFiles(join(ROOT, sourceRoot))).toSorted()
  for (const path of files) {
    const file = relative(ROOT, path).replaceAll('\\', '/')
    if (seen.has(file)) throw new Error(`duplicate decision path: ${file}`)
    seen.add(file)
    const header = leadingHeader(readFileSync(path, 'utf8'))
    if (header === undefined) continue
    const text = normalizedHeader(header)
    const issues = [...new Set([...text.matchAll(ISSUE)].map((match) => Number(match[1])))]
      .filter((issue) => Number.isInteger(issue))
      .toSorted((left, right) => left - right)
    if (issues.length === 0) continue
    const sentence = firstCompleteSentence(text)
    rows.push({
      file,
      issues,
      decision: sentence ?? `UNCLASSIFIED — leading header at line ${header.startLine} has no complete sentence`,
      unclassified: sentence === undefined,
    })
  }
  return rows
}

function tableText(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function generate(rows: readonly DecisionRow[]): string {
  return [
    '<!-- generated: scripts/docs/decisions.ts -->',
    '# Code-local decisions',
    '',
    `**Decision headers: ${rows.length}.**`,
    '',
    'This is an inventory of decisions recorded in leading source-file headers. It is not an index of every',
    'issue mention: implementation comments, tests and fixture prose after the leading header are deliberately',
    'outside the inventory. Each qualifying file appears exactly once, with every issue cited by that header.',
    '',
    '| File | Issues | First complete decision sentence |',
    '|---|---|---|',
    ...rows.map(
      (row) =>
        `| \`${row.file}\` | ${row.issues.map((issue) => `\`#${issue}\``).join(', ')} | ${tableText(row.decision)} |`,
    ),
    '',
    '**Parser limit.** The parser considers the first block or contiguous line comment beginning within the',
    `first ${HEADER_LINE_LIMIT} lines of TypeScript/JavaScript source under \`packages/\`, \`scripts/\`,`,
    'and `test/`.',
    'It skips generated type output, dependencies, coverage output, and vendored web components. Sentence',
    'reduction uses the first `.`, `!`, or `?`, optionally followed by closing quotes/brackets and then',
    'whitespace or the end of the header; a qualifying header that does not fit that current source shape',
    'is emitted as `UNCLASSIFIED` and makes generation fail.',
    '',
  ].join('\n')
}

runGenerator('decisions', () => {
  const rows = decisions()
  const unclassified = rows.filter((row) => row.unclassified).map((row) => row.file)
  if (unclassified.length > 0) {
    throw new Error(`${unclassified.length} qualifying header(s) are UNCLASSIFIED: ${unclassified.join(', ')}`)
  }
  return generate(rows)
})
