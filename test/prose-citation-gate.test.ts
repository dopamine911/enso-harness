import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filesUnder, SOURCE_FILE } from '../scripts/source-tree.ts'
import { markdownFiles, REPOSITORY_ROOT } from './gate-support.ts'

/**
 * THE PROSE LINE CITATION, RESOLVED (#244, #320 review).
 *
 * `docs-gate.test.ts` resolves two shapes: a `<!-- source: path#Symbol -->` fence against the
 * declaration it quotes, and a symbol named beside a markdown link against the file it links.
 * A bare `` `followThread` (`server/follow.ts` line 110) `` is neither — it is prose, and
 * nothing read it. The seam pages are sold as the substitute for reading the code
 * (`docs/architecture.md`), so a number that lands on `}` or inside an unrelated docblock
 * sends the reader to the wrong construct and quietly spends the page's authority.
 *
 * It recurred three times in one week, each time the same way and never as a hand-edit:
 * #244 corrected eleven of them; the #226/#227 edit to `web-search/index.ts` moved nine of
 * those out from under `web-providers.md` nine lines; #316's `thread-read.ts` extraction moved
 * `server/follow.ts` by 54 and broke two more on `observation.md`. A citation that only a
 * human re-derives is a citation that rots at the next edit to the file it cites.
 *
 * WHAT IS CHECKED, and why it is this and not more. The claim a number can be held to is
 * CONTAINMENT: a symbol named in backticks, immediately followed by a line citation, must
 * cite a line inside that symbol's own declaration — its doc comment through its closing
 * line. That is the shape `followThread` (110 against 126–160) failed and the shape
 * `answerThreadDialog` (306, 309, 316, 320, 321, all inside 306–328) passes, because a page
 * legitimately points at a branch within a function it just named.
 *
 * FOUR SKIPS, each because the sentence is not making that claim:
 *   • a symbol the file does not declare exactly once (`settled` is an observation kind, not a
 *     declaration; an imported name is not one either — imports are blanked before the scan);
 *   • a citation more than `ADJACENCY` characters from the symbol, or with a comma or full
 *     stop between them: "`false` for `confirm`, on every non-answer outcome (lines 259–260)"
 *     cites where the value is computed, not where `confirm` lives;
 *   • a citation saying "header", which is the FILE's header in "`vocabulary.ts` … its header
 *     (lines 3–5)" and the construct's in others — one word, two referents;
 *   • a range that overlaps the declaration at all, since a range spanning four sibling
 *     methods is cited beside the last of them.
 *
 * ⚠ A RANGE WITH NO SYMBOL BESIDE IT IS STILL UNHELD — "(lines 134–141)" on its own has no
 * anchor to resolve against, and inventing one would mean the page restating what the code
 * says. This gate catches the anchored majority; the unanchored remainder is why the pages
 * should prefer `path#symbol` where a symbol exists, as #244 already asked.
 */

/** Characters allowed between the symbol and its citation: "`name` (line 12)" and little else. */
const ADJACENCY = 12

/** Where a cited file may live. A doc names it short (`map-events.ts`); the suffix resolves it. */
const SOURCE_ROOTS: readonly string[] = ['packages', 'scripts']

/**
 * A backticked literal, or a parenthesised line citation, whichever comes next. One scan, so
 * the symbol and the file a citation resolves against are the ones that actually precede it.
 */
const TOKEN = /`([^`\n]+)`|\(([^)]*?\blines?\s+(\d+)(?:\s*[–-]\s*(\d+))?[^)]*)\)/g
/** The `:12` or `:12–20` a mention may carry: `vocabulary.ts:3-5` is a file, not an identifier. */
const MENTION_LINES: string = String.raw`(?::\d+(?:[–-]\d+)?)?$`
/**
 * A backticked literal that names a source file. ⚠ DERIVED from the walker's own extension
 * set, never restated (PR #323 review): a narrower copy does not report a `.cjs` or `.mts`
 * mention as wrong, it stops seeing it — the literal matches neither this nor `IDENTIFIER`,
 * so the citation beside it is dropped and the page goes unchecked. That is the silent
 * staleness this gate exists to close, reopened for one extension.
 */
const SOURCE_MENTION: RegExp = new RegExp(SOURCE_FILE.source.replace(/\$$/, '') + MENTION_LINES)
/** The same set again, as a file named INSIDE a citation: "(`server/follow.ts` line 126)". */
const CITED_FILE: RegExp = new RegExp(String.raw`\`([^\`]+${SOURCE_FILE.source.replace(/\$$/, '')})\``)
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
/** An import statement, blanked before the declaration scan: an imported name is not declared here. */
const IMPORT_STATEMENT = /^import[\s\S]*?from\s+'[^']*'$/gm

const sources = SOURCE_ROOTS.flatMap((root) => filesUnder(join(REPOSITORY_ROOT, root)))

/** The one source file a doc's mention names, or nothing when it names none or several. */
function resolveSource(mention: string): string | undefined {
  const path = mention.replace(/:\d+(?:[–-]\d+)?$/, '')
  const found = sources.filter((source) => source.endsWith(`/${path}`))
  return found.length === 1 ? found[0] : undefined
}

/**
 * Does a body open here? Scanned from the candidate line to the end of its signature: a
 * declaration's opening line, or the line its parameter list closes on, ends in `{`;
 * `writeFrame(` at statement position closes on `)` and ends in nothing.
 *
 * ⚠ The `{` test comes FIRST and covers the closing paren too (PR #323 review), which is why
 * there is no separate branch for `)`: `): void {` already ended in `{`, and a bare `)` is a
 * call — the dedent test below it is what stops the scan, and returning false there says the
 * same thing once.
 */
function opensABody(lines: readonly string[], first: number): boolean {
  const indent = /^\s*/.exec(lines[first - 1] ?? '')?.[0] ?? ''
  for (let index = first - 1; index < lines.length; index += 1) {
    const text = lines[index] ?? ''
    if (text.trimEnd().endsWith('{')) return true
    // Out of the signature: a line at or left of the candidate's indent belongs to something else.
    if (index > first - 1 && !text.startsWith(`${indent} `) && text.trim() !== '') return false
  }
  return false
}

/**
 * The lines a symbol's declaration occupies: its doc comment through the line that closes it.
 * Nothing when the file declares it other than exactly once — an ambiguous name is not a claim
 * this gate can hold, and a name it declares zero times is a use, not a declaration.
 *
 * ⚠ A CALL AT STATEMENT POSITION READS AS A MEMBER DECLARATION, and the member form is needed:
 * `answerDialog(…): void {` and `openDialogs(): ZenOpenDialog[] {` are how a runtime contract
 * is written, and pages cite them. `writeFrame(` on its own line is a call, and taking it for
 * a declaration would hold a page to the span of an unrelated statement. The body is what
 * separates them: a declaration opens one.
 */
function declarationSpan(source: string, name: string): { start: number; end: number } | undefined {
  const lines = source.replace(IMPORT_STATEMENT, (block) => block.replace(/[^\n]/g, ' ')).split('\n')
  const statement = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|type|interface|class|enum)\\s+${name}\\b`,
  )
  const member = new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`)
  const declared = lines.flatMap((text, index) =>
    statement.test(text) || (member.test(text) && opensABody(lines, index + 1)) ? [index + 1] : [],
  )
  if (declared.length !== 1) return undefined
  const first = declared[0] ?? 0
  const indent = /^\s*/.exec(lines[first - 1] ?? '')?.[0] ?? ''
  let start = first
  // The construct's own header is part of it: a page citing a rule stated above the `function`
  // line is citing that construct, and `#244` corrected several citations INTO doc comments.
  while (start > 1 && /^\s*(?:\/\*\*|\*|\*\/|\/\/)/.test(lines[start - 2] ?? '')) start -= 1
  for (let index = first; index < lines.length; index += 1) {
    const text = lines[index] ?? ''
    if (text.startsWith(`${indent}}`) || text.startsWith(`${indent})`)) return { start, end: index + 1 }
  }
  return { start, end: first }
}

/** One resolved claim: this symbol, in this file, said to be at these lines. */
interface Citation {
  readonly symbol: string
  readonly file: string
  readonly from: number
  readonly to: number
}

interface Offence {
  readonly page: string
  readonly symbol: string
  readonly cited: string
  readonly span: string
  readonly file: string
}

/** What the scan carries forward inside one paragraph: the file and symbol most recently named. */
interface Naming {
  file: string | undefined
  symbol: string | undefined
  symbolEnd: number
}

/** A backticked literal renames the file, the symbol, or neither. */
function readLiteral(literal: string, at: number, naming: Naming): void {
  if (SOURCE_MENTION.test(literal)) naming.file = resolveSource(literal) ?? naming.file
  else if (IDENTIFIER.test(literal)) {
    naming.symbol = literal
    naming.symbolEnd = at
  }
}

/** The claim a citation makes, or nothing when it makes none this gate can hold. */
function readCitation(paragraph: string, match: RegExpExecArray, naming: Naming): Citation | undefined {
  const citation = match[2] ?? ''
  const { symbol, symbolEnd } = naming
  if (symbol === undefined || symbolEnd < 0) return undefined
  const between = paragraph.slice(symbolEnd, match.index)
  if (between.length > ADJACENCY || /[,.;:]/.test(between) || /\bheaders?\b/.test(citation)) return undefined
  const named = CITED_FILE.exec(citation)?.[1]
  const file = named === undefined ? naming.file : resolveSource(named)
  if (file === undefined) return undefined
  const from = Number(match[3])
  return { symbol, file, from, to: match[4] === undefined ? from : Number(match[4]) }
}

/** Every claim one paragraph makes, in the order it makes them. */
function citationsIn(paragraph: string): Citation[] {
  const found: Citation[] = []
  const naming: Naming = { file: undefined, symbol: undefined, symbolEnd: -1 }
  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(paragraph); match !== null; match = TOKEN.exec(paragraph)) {
    const literal = match[1]
    if (literal !== undefined) readLiteral(literal, TOKEN.lastIndex, naming)
    else {
      const citation = readCitation(paragraph, match, naming)
      if (citation !== undefined) found.push(citation)
    }
  }
  return found
}

function offencesIn(page: string, text: string): Offence[] {
  const offences: Offence[] = []
  // Paragraph by paragraph, so a file named in one does not resolve a citation three
  // paragraphs down; a fenced block is code, and its own line numbers are not citations.
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (paragraph.trimStart().startsWith('```')) continue
    for (const { symbol, file, from, to } of citationsIn(paragraph)) {
      const span = declarationSpan(readFileSync(file, 'utf8'), symbol)
      if (span === undefined || (to >= span.start && from <= span.end)) continue
      offences.push({
        page,
        symbol,
        cited: from === to ? `${from}` : `${from}–${to}`,
        span: `${span.start}–${span.end}`,
        file: file.slice(REPOSITORY_ROOT.length + 1),
      })
    }
  }
  return offences
}

test('⚠ a line cited beside a symbol lands inside that symbol (#244, #320 review)', () => {
  const offenders = markdownFiles(join(REPOSITORY_ROOT, 'docs')).flatMap((path: string) =>
    offencesIn(path.slice(REPOSITORY_ROOT.length + 1), readFileSync(path, 'utf8')).map(
      (offence) =>
        `${offence.page}: \`${offence.symbol}\` cited at ${offence.cited}, but it is ${offence.span} in ${offence.file}`,
    ),
  )
  expect(offenders).toEqual([])
})

// The resolver's own contract. Both of its failures are silent — a citation it cannot parse is
// a citation nobody checks, and a span it measures short turns a correct page red — so the
// shapes the seam pages actually use are pinned here rather than left to the corpus above,
// which is green precisely when nothing is drifting.
const FIXTURE = [
  '/** What it does. */', // 1
  'export async function followThread(deps: Deps): Promise<void> {', // 2
  '  writeFrame(', // 3
  '    threads,', // 4
  '  )', // 5
  '}', // 6
  '', // 7
  'const other = 1', // 8
].join('\n')

test('the span is the doc comment through the closing line, and a use is not a declaration', () => {
  expect(declarationSpan(FIXTURE, 'followThread')).toEqual({ start: 1, end: 6 })
  // `writeFrame` is CALLED here, never declared: a citation beside it is not this gate's claim.
  expect(declarationSpan(FIXTURE, 'writeFrame')).toBeUndefined()
  // An imported name is not declared in the file that imports it.
  expect(declarationSpan("import { type Frame } from './frame.ts'\nconst x = 1", 'Frame')).toBeUndefined()
})

/**
 * ⚠ THE NUMBERS ARE DERIVED, NOT WRITTEN. This test cites a real file, which makes it the one
 * thing it is about: a hand-written `line 33` here rots the moment `source-tree.ts` grows a
 * line, and it did — between writing this file and reviewing it. So the span is measured and
 * the prose is built from it; what is asserted is the RELATIONSHIP, which is the contract.
 */
test('a citation is read when it is beside its symbol, and skipped when it is only near one', () => {
  const page = (prose: string): string[] => offencesIn('fixture.md', prose).map((offence) => offence.cited)
  const walker = 'scripts/source-tree.ts'
  const span = declarationSpan(readFileSync(join(REPOSITORY_ROOT, walker), 'utf8'), 'filesUnder')
  if (span === undefined) throw new Error(`${walker} no longer declares filesUnder exactly once`)
  const outside = span.start - 1
  const inside = span.start
  // The shape that broke twice: a symbol, its file, a number outside the declaration.
  expect(page(`\`filesUnder\` (\`${walker}\` line ${outside}) walks`)).toEqual([`${outside}`])
  // …and the same citation landing inside it is silent.
  expect(page(`\`filesUnder\` (\`${walker}\` line ${inside}) walks`)).toEqual([])
  // A range that touches the declaration passes whole: one range, four sibling members.
  expect(page(`\`filesUnder\` (\`${walker}\` lines ${outside}–${span.end})`)).toEqual([])
  // Prose between the two is a different claim — the number is not about the symbol.
  expect(page(`\`filesUnder\` in \`${walker}\`, called by every gate (line ${outside})`)).toEqual([])
  // "header" is the file's in one page and the construct's in another: one word, two referents.
  expect(page(`\`filesUnder\` (\`${walker}\` header lines ${outside}–${outside})`)).toEqual([])
  // A fenced block carries its own numbers, and they are not citations.
  expect(page(`\`\`\`ts\n\`filesUnder\` (\`${walker}\` line ${outside})\n\`\`\``)).toEqual([])
})

// ⚠ The extension surface, asserted rather than assumed (PR #323 review). An unrecognised
// mention is not a reported offence — it is a citation this gate never sees, so a narrow copy
// of the walker's set reopens exactly the silent staleness above for whichever flavour is
// added next. These are the flavours `scripts/source-tree.ts` walks; none is in the tree
// today, which is the point: the day one arrives it is cited and checked, not skipped.
test('a mention in every flavour the walker reads is a file, not an unread literal (#323 review)', () => {
  for (const mention of [
    'follow.ts',
    'chat-screen.tsx',
    'bundled.mjs',
    'legacy.js',
    'widget.jsx',
    'tool.cjs',
    'shim.mts',
    'shim.cts',
    'vocabulary.ts:3-5',
  ]) {
    expect(SOURCE_MENTION.test(mention)).toBe(true)
  }
  // …and a backticked identifier is still a symbol, not a file.
  for (const symbol of ['followThread', 'ZenFollowFrame', 'settled']) {
    expect(SOURCE_MENTION.test(symbol)).toBe(false)
    expect(IDENTIFIER.test(symbol)).toBe(true)
  }
  // The same set inside a citation: "(`server/follow.ts` line 126)".
  expect(CITED_FILE.exec('`scripts/zen.ts` line 4')?.[1]).toBe('scripts/zen.ts')
  expect(CITED_FILE.exec('`packages/web/src/shim.mts` line 4')?.[1]).toBe('packages/web/src/shim.mts')
})
