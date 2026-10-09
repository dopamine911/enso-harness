import { readFileSync } from 'node:fs'

/**
 * The docs gate's one primitive (#168): a top-level declaration, by name, whole.
 *
 * `docs/seams/*.md` quote the contract they describe; the quote must equal the source or
 * the page is wrong. This finds `export const X = …`, `export type X = …`,
 * `export interface X {…}`, `export function X(…) {…}` (and the unexported forms) at
 * column 0, takes the doc comment sitting directly above it, and runs to the statement's
 * end: the line at which every bracket opened since the declaration has closed and the
 * line does not continue an expression (`=`, `|`, `&`, `,`, `(` at its end; `|`, `&`, `.`
 * or `)` opening the next).
 *
 * ⚠ Text, not the TypeScript AST, on purpose. The pages fence declarations line for line,
 * so a text extractor has nothing to lose to a printer's whitespace choices, and no
 * compiler dependency to drift under. It reads WHOLE LINES and counts brackets
 * outside string and comment lexemes — a `{` in a doc comment or a template literal does
 * not open a scope. Declarations that nest a top-level-looking line (a `function` inside a
 * template) are not in this repo's shapes and would be found by the gate going red, not
 * by silently matching the wrong span.
 *
 * ⚠ ONE class of line is dropped rather than quoted: `@group`/`@category`, which file a
 * symbol in the generated API index and say nothing about the contract a seam page is
 * quoting (`withoutOrganisingTags`). The gate and the fence writer share this function, so
 * neither can see a line the other keeps.
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
    text: withoutOrganisingTags(lines.slice(startLine, endLine + 1)).join('\n'),
  }
}

/** `@group`/`@category`, and a one-line comment that carries nothing else. */
const ORGANISING_TAG = /^\s*(?:\/\*\*\s*)?\*?\s*@(?:group|category)\b/
const TAG_ONLY_COMMENT = /^\s*\/\*\*\s*@(?:group|category)\b[^*]*\*\/\s*$/
const COMMENT_SEPARATOR = /^\s*\*\s*$/
const COMMENT_CLOSE = /^\s*\*\/\s*$/

/**
 * The declaration without the tags that organise TypeDoc's index (#188).
 *
 * `@group Follow wire` tells the generated API page which section a symbol belongs in. It
 * says nothing to a reader of `docs/seams/observation.md`, which quotes the declaration to
 * show a CONTRACT — so the quote carries the contract and not the filing instruction.
 *
 * ⚠ The gate and the fence writer both read `text`, so removing a tag here removes it from
 * both at once; a fence and its source cannot disagree about a line that neither can see.
 * Nothing else is filtered: this is the one class of comment that documents the docs rather
 * than the code.
 */
function withoutOrganisingTags(lines: readonly string[]): string[] {
  const kept: string[] = []
  for (const line of lines) {
    if (TAG_ONLY_COMMENT.test(line) || ORGANISING_TAG.test(line)) continue
    // The blank `*` that separated prose from the tags now sits against the closer.
    if (COMMENT_CLOSE.test(line) && COMMENT_SEPARATOR.test(kept.at(-1) ?? '')) kept.pop()
    kept.push(line)
  }
  return kept
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

interface BracketCount {
  opens: number
  closes: number
  quote: Quote
}

/**
 * Bracket opens and closes on one line, ignoring string, template and comment lexemes, and
 * the quote still open at the line's end — a template literal spans lines, and its interior
 * is not code. A comment line counts nothing: prose has apostrophes (`the
 * repo's rule`), and an apostrophe read as a quote would swallow the `)` after it (measured
 * on `agent-host.ts:99`). Inside an open template a `*`-led line is template text, not a
 * comment, so the skip applies only when no quote is open.
 *
 * ⚠ A template nested inside a template's `${…}` is REFUSED, not scanned: the inner backtick would read as the outer's close and the rest of the line as
 * code — wrong and self-consistent, the one failure this extractor must not have. The repo
 * has two such lines (`log-bundle.ts:100,103`), both inside a function body no page fences;
 * fencing one turns the gate red with this message rather than a drifted span.
 */
function bracketDelta(line: string, openQuote: Quote): BracketCount {
  const count: BracketCount = { opens: 0, closes: 0, quote: openQuote }
  if (openQuote === undefined && COMMENT_LINE.test(line)) return count
  for (let characterIndex = 0; characterIndex < line.length; characterIndex += 1) {
    if (count.quote !== undefined) {
      const skipped = insideQuote(line, characterIndex, count.quote)
      characterIndex = skipped.characterIndex
      count.quote = skipped.quote
      continue
    }
    if (line.startsWith('//', characterIndex)) break
    countCodeCharacter(count, line[characterIndex])
  }
  // A `'` or `"` cannot span a line; only a template carries over.
  return { opens: count.opens, closes: count.closes, quote: count.quote === '`' ? count.quote : undefined }
}

/** One character of code: a quote opens a lexeme, a bracket counts, anything else counts nothing. */
function countCodeCharacter(count: BracketCount, character: string | undefined): void {
  if (character === '"' || character === "'" || character === '`') count.quote = character
  else if (character === '{' || character === '(' || character === '[') count.opens += 1
  else if (character === '}' || character === ')' || character === ']') count.closes += 1
}

/** One character inside a string or template: an escape skips the next; the delimiter closes; a nested template refuses. */
function insideQuote(line: string, characterIndex: number, quote: Quote): { characterIndex: number; quote: Quote } {
  const character = line[characterIndex]
  if (character === '\\') return { characterIndex: characterIndex + 1, quote }
  if (character === quote) return { characterIndex, quote: undefined }
  if (quote === '`' && character === '$' && /^\{[^}]*`/.test(line.slice(characterIndex + 1))) {
    throw new Error(`a template literal nested in another's \${…} is not supported: \`${line.trim()}\``)
  }
  return { characterIndex, quote }
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
