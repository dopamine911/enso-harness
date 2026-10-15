/**
 * An HTML page as the text a reader sees (#927) — what `web_fetch` hands the model for a
 * `text/html` response instead of the markup.
 *
 * Raw HTML costs the model about ten times its content: on a docs page most of the bytes are the
 * repeated sidebar, theme scripts and inline SVG icons (measured on www.enso.engineer, #927: the
 * text was 8.7% and 13.7% of two pages). This keeps headings, paragraphs, lists, links (as
 * `text <url>`), code and tables in a markdown-like form, and drops the rest: scripts, styles,
 * SVG, forms' controls, and the site's chrome — `nav`, `aside`, and a `header`/`footer` that
 * belongs to the page rather than to an article (the ARIA banner/contentinfo rule).
 *
 * ⚠ HIDDEN CONTENT IS DROPPED, not just unstyled: comments, `<template>`, raw-text elements, an
 * element carrying `hidden`, `aria-hidden="true"`, an inline `display:none` /
 * `visibility:hidden` or a screen-reader-only class (`sr-only`, …), and a `<dialog>` that is not
 * open. A page can hide instructions for a model where no human looks; not surfacing them shrinks
 * that injection surface. It does not close it: content hidden by any other STYLESHEET rule is
 * invisible to a parser that runs no CSS, and comes through. The external-content notice in front
 * of the text is still what marks it as data.
 *
 * Pure TypeScript, no DOM and no dependency: the harness also runs under Node in the terminal
 * (`docs/concepts/distribution.md`), where Bun's `HTMLRewriter` does not exist. The tokenizer is
 * the part of HTML's that decides what is text — tags with quoted attributes, comments, and
 * raw-text elements whose content is never markup — and the few implied end tags (`li`, `td`,
 * `tr`, …) that decide where a list item or a table cell ends. An element hidden with its end
 * tag omitted hides until a matching end tag: an error toward dropping, never toward surfacing.
 *
 * @module
 */

// The tables below are Sets and Maps, not object literals: they are looked up with tag and entity
// names straight from the page, which must never reach an inherited property (`constructor`,
// `__proto__`), and HTML's names (`p`, `td`) are not this repo's property keys.

/** Elements whose content is never markup: the tokenizer scans past it to the matching end tag. */
const RAW_TEXT_ELEMENTS: readonly string[] = [
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]

/** Elements that never have content, so never open anything. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** `<svg/>` and `<math/>` really are empty — foreign content honours the self-closing slash. */
const FOREIGN_ELEMENTS: ReadonlySet<string> = new Set(['svg', 'math'])

/** Elements that are not the page's readable content: dropped with everything inside them. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  ...RAW_TEXT_ELEMENTS,
  'template',
  'svg',
  'canvas',
  'object',
  'video',
  'audio',
  'nav',
  'aside',
  'button',
  'select',
])

/** `header`/`footer` are the PAGE's banner and footer, and dropped, unless one of these holds them. */
const SECTIONING_ELEMENTS: ReadonlySet<string> = new Set(['article', 'main', 'section'])
const LANDMARK_ELEMENTS: ReadonlySet<string> = new Set(['header', 'footer'])

/** Line breaks around an element that starts a block — 2 is a blank line. */
const BLOCK_BREAKS: ReadonlyMap<string, number> = new Map([
  ...['p', 'blockquote', 'figure', 'details', 'dl', 'address', 'fieldset'].map((element) => [element, 2] as const),
  ...[
    'div',
    'section',
    'article',
    'main',
    'header',
    'footer',
    'dt',
    'dd',
    'summary',
    'figcaption',
    'caption',
    'legend',
    'form',
  ].map((element) => [element, 1] as const),
])

/** An open element a start tag implicitly closes, searched for no further out than `scope`. */
interface ImpliedEnd {
  readonly closes: ReadonlySet<string>
  readonly scope: ReadonlySet<string>
}
const LIST_ITEM_END: ImpliedEnd = { closes: new Set(['li']), scope: new Set(['ul', 'ol', 'menu']) }
const DEFINITION_END: ImpliedEnd = { closes: new Set(['dt', 'dd']), scope: new Set(['dl']) }
const CELL_END: ImpliedEnd = { closes: new Set(['td', 'th']), scope: new Set(['tr', 'table']) }
const ROW_END: ImpliedEnd = { closes: new Set(['tr']), scope: new Set(['table', 'thead', 'tbody', 'tfoot']) }
const IMPLIED_ENDS: ReadonlyMap<string, ImpliedEnd> = new Map([
  ['li', LIST_ITEM_END],
  ['dt', DEFINITION_END],
  ['dd', DEFINITION_END],
  ['td', CELL_END],
  ['th', CELL_END],
  ['tr', ROW_END],
])

// --- the tokenizer ----------------------------------------------------------------------------

interface StartTag {
  readonly name: string
  readonly attributes: ReadonlyMap<string, string>
  readonly selfClosing: boolean
}

interface TokenSink {
  characters(content: string): void
  startTag(tag: StartTag): void
  endTag(name: string): void
}

const ASCII_LETTER = /^[a-zA-Z]$/
const TAG_NAME = /[a-zA-Z][^\t\n\f\r />]*/y
/**
 * One step through a tag's remainder: whitespace and stray slashes, then either the closing `>`
 * (group 1) or one attribute — its name (2) and a double-quoted (3), single-quoted (4) or bare (5)
 * value. Every match consumes at least one character, so a loop over it ends.
 */
const ATTRIBUTE_STEP =
  /[\t\n\f\r /]*(?:(>)|([^\t\n\f\r />][^\t\n\f\r />=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"?|'([^']*)'?|([^\t\n\f\r >]*)))?)/y
/** Per raw-text element, its end tag: `</script` then whitespace, `/` or `>`, case-insensitive. */
const RAW_TEXT_END_TAGS: ReadonlyMap<string, RegExp> = new Map(
  RAW_TEXT_ELEMENTS.map((element) => [element, new RegExp(`</${element}[\\t\\n\\f\\r />]`, 'gi')]),
)

function tokenize(html: string, sink: TokenSink): void {
  let position = 0
  while (position < html.length) {
    const tagStart = html.indexOf('<', position)
    const textEnd = tagStart === -1 ? html.length : tagStart
    if (textEnd > position) sink.characters(decodeEntities(html.slice(position, textEnd)))
    position = tagStart === -1 ? html.length : readMarkup(html, tagStart, sink)
  }
}

/** Read the markup at `at` (a `<`) and return where the text after it starts. */
function readMarkup(html: string, at: number, sink: TokenSink): number {
  const next = html.charAt(at + 1)
  if (html.startsWith('<!--', at)) return skipComment(html, at)
  if (next === '!' || next === '?') return skipPast(html, '>', at + 2)
  if (next === '/') return readEndTag(html, at + 2, sink)
  if (ASCII_LETTER.test(next)) return readStartTag(html, at + 1, sink)
  sink.characters('<')
  return at + 1
}

/** A comment ends at its first `-->`; `<!-->` and `<!--->` are whole, empty comments. */
function skipComment(html: string, at: number): number {
  for (const emptyComment of ['<!-->', '<!--->']) {
    if (html.startsWith(emptyComment, at)) return at + emptyComment.length
  }
  return skipPast(html, '-->', at + '<!--'.length)
}

function skipPast(html: string, terminator: string, from: number): number {
  const end = html.indexOf(terminator, from)
  return end === -1 ? html.length : end + terminator.length
}

function tagNameAt(html: string, from: number): string | undefined {
  TAG_NAME.lastIndex = from
  return TAG_NAME.exec(html)?.[0]
}

/** An end tag; one whose name does not start with a letter (`</>`, `</ x>`) is a bogus comment. */
function readEndTag(html: string, from: number, sink: TokenSink): number {
  const name = tagNameAt(html, from)
  if (name === undefined) return skipPast(html, '>', from)
  sink.endTag(name.toLowerCase())
  return readTagRemainder(html, from + name.length).end
}

function readStartTag(html: string, from: number, sink: TokenSink): number {
  const name = (tagNameAt(html, from) ?? '').toLowerCase()
  const remainder = readTagRemainder(html, from + name.length)
  sink.startTag({ name, attributes: remainder.attributes, selfClosing: remainder.selfClosing })
  const rawTextEnd = RAW_TEXT_END_TAGS.get(name)
  if (rawTextEnd === undefined) return remainder.end
  rawTextEnd.lastIndex = remainder.end
  const endTag = rawTextEnd.exec(html)
  sink.endTag(name)
  return endTag === null ? html.length : readTagRemainder(html, endTag.index + name.length + 2).end
}

interface TagRemainder {
  readonly attributes: ReadonlyMap<string, string>
  readonly selfClosing: boolean
  /** Where the text after the tag starts. */
  readonly end: number
}

/** A tag's attributes, through its `>`; the first of a repeated attribute wins, as in HTML. */
function readTagRemainder(html: string, from: number): TagRemainder {
  const attributes = new Map<string, string>()
  let position = from
  for (;;) {
    ATTRIBUTE_STEP.lastIndex = position
    const step = ATTRIBUTE_STEP.exec(html)
    if (step === null) return { attributes, selfClosing: false, end: html.length }
    position = ATTRIBUTE_STEP.lastIndex
    if (step[1] !== undefined) return { attributes, selfClosing: html.charAt(position - 2) === '/', end: position }
    const attributeName = (step[2] ?? '').toLowerCase()
    if (!attributes.has(attributeName)) {
      attributes.set(attributeName, decodeEntities(step[3] ?? step[4] ?? step[5] ?? ''))
    }
  }
}

// --- character references -----------------------------------------------------------------------

/** The named references docs pages use; any other stays as written. */
const NAMED_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['ensp', '\u2002'],
  ['emsp', '\u2003'],
  ['thinsp', '\u2009'],
  ['shy', '\u00ad'],
  ['ndash', '–'],
  ['mdash', '—'],
  ['hellip', '…'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['bull', '•'],
  ['middot', '·'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['times', '×'],
  ['divide', '÷'],
  ['deg', '°'],
  ['para', '¶'],
  ['sect', '§'],
  ['larr', '←'],
  ['rarr', '→'],
  ['uarr', '↑'],
  ['darr', '↓'],
  ['harr', '↔'],
  ['le', '≤'],
  ['ge', '≥'],
  ['ne', '≠'],
  ['euro', '€'],
  ['pound', '£'],
])

const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][a-zA-Z\d]{1,31}));/g
const MAX_CODE_POINT = 0x10_ff_ff
const SURROGATES_FIRST = 0xd8_00
const SURROGATES_LAST = 0xdf_ff
const REPLACEMENT_CHARACTER = 0xff_fd

function decodeEntities(encoded: string): string {
  if (!encoded.includes('&')) return encoded
  return encoded.replace(
    CHARACTER_REFERENCE,
    (whole: string, decimal?: string, hexadecimal?: string, named?: string): string => {
      if (decimal !== undefined) return codePointCharacter(Number.parseInt(decimal, 10))
      if (hexadecimal !== undefined) return codePointCharacter(Number.parseInt(hexadecimal, 16))
      return NAMED_CHARACTERS.get(named ?? '') ?? whole
    },
  )
}

function codePointCharacter(codePoint: number): string {
  const isScalar =
    codePoint > 0 && codePoint <= MAX_CODE_POINT && (codePoint < SURROGATES_FIRST || codePoint > SURROGATES_LAST)
  return String.fromCodePoint(isScalar ? codePoint : REPLACEMENT_CHARACTER)
}

// --- what is dropped --------------------------------------------------------------------------

/** An inline style that hides the element, once CSS comments and whitespace are gone. */
const HIDING_DECLARATION = /(?:^|;)(?:display:none|visibility:(?:hidden|collapse))(?:!important)?(?:;|$)/
const CSS_COMMENT_OR_WHITESPACE = /\/\*[\s\S]*?\*\/|\s+/g
/**
 * The conventional screen-reader-only classes (Tailwind/Starlight, Bootstrap, WordPress): text no
 * reader of the page sees — "Section titled …" after every heading of a Starlight page.
 */
const SCREEN_READER_ONLY_CLASS = /(?:^|\s)(?:sr-only|visually-hidden|screen-reader-text)(?:\s|$)/

function isHiddenByAttributes(attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.has('hidden')) return true
  if (attributes.get('aria-hidden')?.trim().toLowerCase() === 'true') return true
  if (SCREEN_READER_ONLY_CLASS.test(attributes.get('class') ?? '')) return true
  const style = attributes.get('style')
  return style !== undefined && HIDING_DECLARATION.test(style.replace(CSS_COMMENT_OR_WHITESPACE, '').toLowerCase())
}

function isDropped(tag: StartTag, openElements: readonly string[]): boolean {
  if (DROPPED_ELEMENTS.has(tag.name)) return true
  if (LANDMARK_ELEMENTS.has(tag.name) && !openElements.some((open) => SECTIONING_ELEMENTS.has(open))) {
    return true
  }
  if (tag.name === 'dialog' && !tag.attributes.has('open')) return true
  return isHiddenByAttributes(tag.attributes)
}

/**
 * The tree the writer sees: dropped subtrees removed, implied end tags made explicit, every
 * element closed in order.
 */
class ReadableContent implements TokenSink {
  private readonly openElements: string[] = []
  /** The dropped element being skipped, and how many of its own name are open inside it. */
  private dropped: { readonly name: string; depth: number } | undefined

  private readonly writer: ReadableTextWriter

  constructor(writer: ReadableTextWriter) {
    this.writer = writer
  }

  characters(content: string): void {
    if (this.dropped === undefined) this.writer.characters(content)
  }

  startTag(tag: StartTag): void {
    if (this.dropped !== undefined) {
      if (tag.name === this.dropped.name && !VOID_ELEMENTS.has(tag.name)) this.dropped.depth += 1
      return
    }
    const childless = VOID_ELEMENTS.has(tag.name) || (tag.selfClosing && FOREIGN_ELEMENTS.has(tag.name))
    if (isDropped(tag, this.openElements)) {
      if (!childless) this.dropped = { name: tag.name, depth: 1 }
      return
    }
    if (childless) {
      this.writer.open(tag.name, tag.attributes)
      return
    }
    this.closeImplied(tag.name)
    this.openElements.push(tag.name)
    this.writer.open(tag.name, tag.attributes)
  }

  endTag(name: string): void {
    if (this.dropped !== undefined) {
      if (name === this.dropped.name) this.dropped.depth -= 1
      if (this.dropped.depth === 0) this.dropped = undefined
      return
    }
    const openAt = this.openElements.lastIndexOf(name)
    if (openAt !== -1) this.closeFrom(openAt)
  }

  private closeImplied(name: string): void {
    const impliedEnd = IMPLIED_ENDS.get(name)
    if (impliedEnd === undefined) return
    for (let depth = this.openElements.length - 1; depth >= 0; depth -= 1) {
      const open = this.openElements[depth] ?? ''
      if (impliedEnd.closes.has(open)) {
        this.closeFrom(depth)
        return
      }
      if (impliedEnd.scope.has(open)) return
    }
  }

  private closeFrom(depth: number): void {
    while (this.openElements.length > depth) this.writer.close(this.openElements.pop() ?? '')
  }
}

// --- the writer -------------------------------------------------------------------------------

const HTML_WHITESPACE_RUN = /[\t\n\f\r ]+/g
const EDGE_SPACE = /^ | $/g
const NO_BREAK_SPACE = /\u00a0/g
const CODE_LANGUAGE = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/
const LANGUAGE_NAME = /^[\w+#.-]+$/
const FENCE = '```'

/** A code block's language, from `data-language` or a `language-…` class; empty when unnamed. */
function languageOf(attributes: ReadonlyMap<string, string>): string {
  const named = attributes.get('data-language') ?? CODE_LANGUAGE.exec(attributes.get('class') ?? '')?.[1] ?? ''
  return LANGUAGE_NAME.test(named) ? named : ''
}

/** A link's target as the model can fetch it: absolute http(s), never a same-page fragment. */
function linkTarget(href: string | undefined, page: URL): string | undefined {
  const written = href?.trim() ?? ''
  if (written === '' || written.startsWith('#')) return undefined
  const target = URL.parse(written, page.href)
  return target?.protocol === 'http:' || target?.protocol === 'https:' ? target.href : undefined
}

interface OpenList {
  readonly ordered: boolean
  items: number
}
interface OpenTable {
  rows: number
  cells: number
  headerCells: number
}
interface OpenLink {
  readonly target: string | undefined
  readonly start: number
}

/**
 * Writes the markdown-like text. Breaks and spaces are REQUESTED and written only before the next
 * text, so runs of markup collapse to one break, and a block's marker (`- `, `## `, a fence) is a
 * pending prefix written with its first text — an empty block writes nothing.
 */
class ReadableTextWriter {
  private written = ''
  private breakLines = 0
  private space = false
  private prefix = ''
  private readonly lists: OpenList[] = []
  private readonly tables: OpenTable[] = []
  private readonly links: OpenLink[] = []
  private cellDepth = 0
  private preformattedDepth = 0
  private preformattedStart = false
  private codeDepth = 0

  private readonly page: URL

  constructor(page: URL) {
    this.page = page
  }

  characters(content: string): void {
    if (this.preformattedDepth > 0) {
      this.preformattedCharacters(content)
      return
    }
    const collapsed = content.replace(HTML_WHITESPACE_RUN, ' ')
    if (collapsed.startsWith(' ')) this.space = true
    const words = collapsed.replace(EDGE_SPACE, '').replace(NO_BREAK_SPACE, ' ')
    if (words !== '') this.emit(words)
    if (collapsed.endsWith(' ')) this.space = true
  }

  open(name: string, attributes: ReadonlyMap<string, string>): void {
    switch (name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.startBlock(2, `${'#'.repeat(Number(name.charAt(1)))} `)
        return
      case 'ul':
      case 'ol':
      case 'menu':
        this.block(this.lists.length === 0 ? 2 : 1)
        this.lists.push({ ordered: name === 'ol', items: 0 })
        return
      case 'li':
        this.openItem()
        return
      case 'pre':
        this.openPreformatted(attributes)
        return
      case 'code':
      case 'kbd':
      case 'samp':
        this.openCode(attributes)
        return
      case 'a':
        this.links.push({ target: linkTarget(attributes.get('href'), this.page), start: this.written.length })
        return
      case 'table':
        this.block(2)
        this.tables.push({ rows: 0, cells: 0, headerCells: 0 })
        return
      case 'tr':
        this.openRow()
        return
      case 'td':
      case 'th':
        this.openCell(name === 'th')
        return
      case 'br':
        if (this.preformattedDepth > 0) this.emit('\n')
        else this.block(1)
        return
      case 'hr':
        this.block(2)
        this.emit('---')
        this.block(2)
        return
      default:
        this.block(BLOCK_BREAKS.get(name) ?? 0)
    }
  }

  close(name: string): void {
    switch (name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.endBlock(2)
        return
      case 'ul':
      case 'ol':
      case 'menu':
        this.lists.pop()
        this.block(this.lists.length === 0 ? 2 : 1)
        return
      case 'li':
        this.endBlock(1)
        return
      case 'pre':
        this.closePreformatted()
        return
      case 'code':
      case 'kbd':
      case 'samp':
        this.closeCode()
        return
      case 'a':
        this.closeLink()
        return
      case 'table':
        this.tables.pop()
        this.block(2)
        return
      case 'tr':
        this.closeRow()
        return
      case 'td':
      case 'th':
        this.cellDepth = Math.max(0, this.cellDepth - 1)
        return
      default:
        this.block(BLOCK_BREAKS.get(name) ?? 0)
    }
  }

  /** The text, each line's trailing whitespace and every run of blank lines past one removed. */
  result(): string {
    if (this.preformattedDepth > 0 && this.prefix === '') this.written += `\n${FENCE}`
    return this.written
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  /** Write text, after the requested break or space and the pending prefix. */
  private emit(content: string): void {
    if (this.written !== '' && this.breakLines > 0) {
      this.written += '\n'.repeat(this.breakLines) + '  '.repeat(Math.max(0, this.lists.length - 1))
    } else if (this.space && this.written !== '' && !/\s$/.test(this.written)) {
      this.written += ' '
    }
    this.written += this.prefix + content
    this.breakLines = 0
    this.space = false
    this.prefix = ''
  }

  /**
   * Request `lines` line breaks before the next text. Inside a table cell a break is a space (the
   * row is one line); inside a code block it is one newline; while a block's prefix is pending,
   * the block that set it owns the break.
   */
  private block(lines: number): void {
    if (lines === 0) return
    if (this.preformattedDepth > 0) {
      if (this.prefix === '' && !this.written.endsWith('\n')) this.written += '\n'
    } else if (this.cellDepth > 0) {
      this.space = true
    } else if (this.prefix === '') {
      this.breakLines = Math.max(this.breakLines, lines)
    }
  }

  /** A block with a marker; nested in a block whose marker is still pending, the markers join. */
  private startBlock(lines: number, prefix: string): void {
    if (this.prefix === '') this.block(lines)
    this.prefix += prefix
  }

  /** End a block with a marker; still pending, the block was empty and the marker is dropped. */
  private endBlock(lines: number): void {
    this.prefix = ''
    this.block(lines)
  }

  private openItem(): void {
    const list = this.lists.at(-1)
    if (list !== undefined) list.items += 1
    // An empty item before this one leaves its marker pending; this item's replaces it. And an
    // item after the first starts on the next line, whatever blocks ended the one before.
    this.prefix = ''
    if (list !== undefined && list.items > 1) this.breakLines = 0
    this.startBlock(1, list?.ordered === true ? `${list.items}. ` : '- ')
  }

  private openPreformatted(attributes: ReadonlyMap<string, string>): void {
    this.preformattedDepth += 1
    if (this.preformattedDepth > 1) return
    this.startBlock(2, `${FENCE}${languageOf(attributes)}\n`)
    this.preformattedStart = true
  }

  private preformattedCharacters(content: string): void {
    // HTML drops the newline that directly follows `<pre>`.
    const kept = this.preformattedStart ? content.replace(/^\r?\n/, '') : content
    if (kept === '') return
    this.preformattedStart = false
    this.emit(kept.replace(NO_BREAK_SPACE, ' '))
  }

  private closePreformatted(): void {
    if (this.preformattedDepth === 0) return
    this.preformattedDepth -= 1
    if (this.preformattedDepth > 0) return
    if (this.prefix === '') this.written += `${this.written.endsWith('\n') ? '' : '\n'}${FENCE}`
    this.endBlock(2)
  }

  /** Inline code is wrapped in backticks; `<code>` in a code block only names its language. */
  private openCode(attributes: ReadonlyMap<string, string>): void {
    if (this.preformattedDepth > 0) {
      const unnamedFence = `${FENCE}\n`
      if (this.prefix.endsWith(unnamedFence)) {
        this.prefix = `${this.prefix.slice(0, -1)}${languageOf(attributes)}\n`
      }
      return
    }
    this.codeDepth += 1
    if (this.codeDepth === 1) this.prefix += '`'
  }

  private closeCode(): void {
    if (this.preformattedDepth > 0 || this.codeDepth === 0) return
    this.codeDepth -= 1
    if (this.codeDepth > 0) return
    if (this.prefix.endsWith('`')) this.prefix = this.prefix.slice(0, -1)
    else this.written += '`'
  }

  /** A link is its text, then its target in angle brackets — unless it has no text, or is its own text. */
  private closeLink(): void {
    const link = this.links.pop()
    if (link?.target === undefined || this.preformattedDepth > 0) return
    const label = this.written.slice(link.start).trim()
    if (label === '' || label === link.target) return
    this.written += ` <${link.target}>`
  }

  private openRow(): void {
    const table = this.tables.at(-1)
    if (table !== undefined) {
      table.cells = 0
      table.headerCells = 0
    }
    this.prefix = ''
    this.startBlock(1, '| ')
  }

  private openCell(header: boolean): void {
    const table = this.tables.at(-1)
    if (table !== undefined) {
      table.cells += 1
      if (header) table.headerCells += 1
      if (table.cells > 1) {
        this.space = false
        this.emit(' | ')
      }
    }
    this.cellDepth += 1
  }

  /** A row ends its line; the first row, when it is headings, is followed by markdown's rule. */
  private closeRow(): void {
    this.cellDepth = 0
    if (this.prefix !== '') {
      this.prefix = ''
      return
    }
    this.written += ' |'
    const table = this.tables.at(-1)
    if (table !== undefined) {
      if (table.rows === 0 && table.headerCells > 0) {
        this.block(1)
        this.emit(`|${' --- |'.repeat(table.cells)}`)
      }
      table.rows += 1
    }
    this.block(1)
  }
}

/**
 * The readable text of an HTML page: headings, paragraphs, lists, links as `text <url>` (relative
 * targets resolved against `pageUrl`), code and tables, in a markdown-like form — and nothing the
 * page hides or that is not its content (see the module header for the list).
 *
 * @group Web fetch policy
 */
export function readableTextOfHtml(html: string, pageUrl: URL): string {
  const writer = new ReadableTextWriter(pageUrl)
  tokenize(html, new ReadableContent(writer))
  return writer.result()
}
