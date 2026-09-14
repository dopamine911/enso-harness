import { readFileSync } from 'node:fs'

/**
 * The docs gate's one primitive (#168): a top-level declaration, verbatim, by name.
 *
 * `docs/seams/*.md` quote the contract they describe; the quote must equal the source or
 * the page is wrong. This finds `export const X = …`, `export type X = …`,
 * `export interface X {…}`, `export function X(…) {…}` (and the unexported forms) at
 * column 0, takes the doc comment sitting directly above it, and runs to the statement's
 * end: the line at which every bracket opened since the declaration has closed and the
 * line does not continue an expression (`=`, `|`, `&`, `,`, `(` at its end; `|`, `&`, `.`
 * or `)` opening the next).
 *
 * ⚠ Text, not the TypeScript AST, on purpose. The pages fence declarations character for
 * character, so a text extractor has nothing to lose to a printer's whitespace choices,
 * and no compiler dependency to drift under. It reads WHOLE LINES and counts brackets
 * outside string and comment lexemes — a `{` in a doc comment or a template literal does
 * not open a scope. Declarations that nest a top-level-looking line (a `function` inside a
 * template) are not in this repo's shapes and would be found by the gate going red, not
 * by silently matching the wrong span.
 */

const DECLARATION_KEYWORDS = ['const', 'let', 'type', 'interface', 'function', 'class', 'enum'] as const
const CONTINUES_LINE = /[=|&,(]\s*$/
const CONTINUES_FROM_NEXT = /^\s*[|&.)]/

export interface Declaration {
  readonly symbol: string
  /** 1-based, first line of the doc comment (or of the declaration when it has none). */
  readonly startLine: number
  /** 1-based, inclusive. */
  readonly endLine: number
  readonly text: string
}

/** The declaration named `symbol` in `source`, or undefined when no top-level line declares it. */
export function extractDeclaration(source: string, symbol: string): Declaration | undefined {
  const lines = source.split('\n')
  const opener = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:${DECLARATION_KEYWORDS.join('|')})\\s+${symbol}\\b`)
  const declaredAt = lines.findIndex((line) => opener.test(line))
  if (declaredAt === -1) return undefined
  const startLine = docCommentStart(lines, declaredAt)
  const endLine = statementEnd(lines, declaredAt)
  return {
    symbol,
    startLine: startLine + 1,
    endLine: endLine + 1,
    text: lines.slice(startLine, endLine + 1).join('\n'),
  }
}

/** The first line of the `/** … *\/` block ending on the line above `declaredAt`, else `declaredAt`. */
function docCommentStart(lines: readonly string[], declaredAt: number): number {
  const above = lines[declaredAt - 1] ?? ''
  if (/^\s*\/\*\*.*\*\/\s*$/.test(above)) return declaredAt - 1
  if (!/^\s*\*\/\s*$/.test(above)) return declaredAt
  let commentStart = declaredAt - 1
  while (commentStart > 0 && !/^\s*\/\*\*/.test(lines[commentStart] ?? '')) commentStart -= 1
  return /^\s*\/\*\*/.test(lines[commentStart] ?? '') ? commentStart : declaredAt
}

/** The last line of the statement opening at `declaredAt`: brackets balanced and no continuation either side. */
function statementEnd(lines: readonly string[], declaredAt: number): number {
  let depth = 0
  let opened = false
  let quote: Quote
  for (let lineIndex = declaredAt; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const delta = bracketDelta(line, quote)
    quote = delta.quote
    if (delta.opens > 0) opened = true
    depth += delta.opens - delta.closes
    if (depth > 0 || quote !== undefined) continue
    if (opened && depth < 0) return lineIndex
    if (CONTINUES_LINE.test(stripTrailingComment(line))) continue
    if (CONTINUES_FROM_NEXT.test(lines[lineIndex + 1] ?? '')) continue
    return lineIndex
  }
  return lines.length - 1
}

/** Reads `path` and extracts `symbol`; throws with the path when the symbol is not declared there. */
export function extractDeclarationFromFile(path: string, symbol: string): Declaration {
  if (!/^\w+$/.test(symbol)) throw new Error(`\`${symbol}\` is not an identifier`)
  const found = extractDeclaration(readFileSync(path, 'utf8'), symbol)
  if (found === undefined) throw new Error(`${path} declares no top-level \`${symbol}\``)
  return found
}

/** A line that is only a comment: `//`, a block opener, or a block's `*`-led body. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

type Quote = '"' | "'" | '`' | undefined

/**
 * Bracket opens and closes on one line, ignoring string, template and comment lexemes, and
 * the quote still open at the line's end — a template literal spans lines, and its interior
 * is not code (PR #169 review). A comment line counts nothing: prose has apostrophes (`the
 * repo's rule`), and an apostrophe read as a quote would swallow the `)` after it (measured
 * on `agent-host.ts:99`). Inside an open template a `*`-led line is template text, not a
 * comment, so the skip applies only when no quote is open.
 */
function bracketDelta(line: string, openQuote: Quote): { opens: number; closes: number; quote: Quote } {
  let opens = 0
  let closes = 0
  let quote: Quote = openQuote
  if (quote === undefined && COMMENT_LINE.test(line)) return { opens, closes, quote }
  for (let characterIndex = 0; characterIndex < line.length; characterIndex += 1) {
    const character = line[characterIndex]
    if (quote !== undefined) {
      if (character === '\\') characterIndex += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '/' && line[characterIndex + 1] === '/') break
    if (character === '"' || character === "'" || character === '`') quote = character
    else if (character === '{' || character === '(' || character === '[') opens += 1
    else if (character === '}' || character === ')' || character === ']') closes += 1
  }
  // A `'` or `"` cannot span a line; only a template carries over.
  return { opens, closes, quote: quote === '`' ? quote : undefined }
}

function stripTrailingComment(line: string): string {
  const at = line.indexOf('//')
  return at === -1 ? line : line.slice(0, at)
}

if (import.meta.main) {
  const [reference] = process.argv.slice(2)
  const [path, symbol] = reference?.split('#') ?? []
  if (path === undefined || symbol === undefined) {
    process.stderr.write('usage: bun scripts/docs/extract-declaration.ts <path>#<Symbol>\n')
    process.exit(2)
  }
  process.stdout.write(`${extractDeclarationFromFile(path, symbol).text}\n`)
}
