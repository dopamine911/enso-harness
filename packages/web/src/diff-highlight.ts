import type { GrammarState, HighlighterCore, ThemedToken } from 'shiki/core'

/**
 * Syntax highlighting for the Diff view (#461): a changed file's text, both sides, tokenised by
 * Shiki (MIT) and coloured with THE THEME'S OWN TOKENS — every role a `text-chart-*` or
 * `text-muted-foreground` class, so a highlighted line follows the theme Settings picks, and no
 * colour of Shiki's own reaches the page.
 *
 * ⚠ THE WHOLE FILE, NOT THE HUNK. A hunk can open inside a block comment or a template string, and
 * a grammar fed only the hunk would colour it as code. The file's text comes from
 * `GET …/changes/file`, which the view reads anyway to expand the lines between hunks.
 *
 * ⚠ LOADED WHEN FIRST ASKED, AND KEPT FEW. Shiki's core, its JavaScript regex engine (no
 * WebAssembly) and each grammar are dynamic imports, evaluated only when a Diff tab first
 * highlights a file. The dev server bundles without splitting, so every grammar named here is
 * still in the page's script: the set is the languages a project here is most often written in.
 * Measured with `Bun.build` (minified, no splitting): this set grows `main.tsx`'s bundle from 2.1 MB
 * to 3.3 MB; adding C++, C#, Swift, PHP, Ruby, Vue, Svelte, Lua, SCSS and Kotlin made it 4.8 MB.
 * JSX takes the TSX grammar, which reads it. A file in a language this map does not name is shown
 * as it is, never guessed at.
 */

/** A grammar this view highlights: the extensions it reads, lowercased, and its loader. */
interface Grammar {
  readonly extensions: readonly string[]
  /** Dynamic: the file's language picks one grammar at run time. */
  readonly load: () => Promise<{ readonly default: Parameters<HighlighterCore['loadLanguage']>[0] }>
}

/** Every language this view highlights, by Shiki's name for it. */
const LANGUAGES = [
  'css',
  'dockerfile',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'jsonc',
  'makefile',
  'markdown',
  'python',
  'rust',
  'shellscript',
  'sql',
  'toml',
  'tsx',
  'typescript',
  'xml',
  'yaml',
] as const

/** A language this view highlights. */
export type SyntaxLanguage = (typeof LANGUAGES)[number]

/** Each language's grammar. */
const GRAMMARS: Readonly<Record<SyntaxLanguage, Grammar>> = {
  css: { extensions: ['css'], load: () => import('shiki/langs/css.mjs') },
  dockerfile: { extensions: [], load: () => import('shiki/langs/dockerfile.mjs') },
  go: { extensions: ['go'], load: () => import('shiki/langs/go.mjs') },
  html: { extensions: ['html', 'htm'], load: () => import('shiki/langs/html.mjs') },
  java: { extensions: ['java'], load: () => import('shiki/langs/java.mjs') },
  javascript: { extensions: ['js', 'mjs', 'cjs'], load: () => import('shiki/langs/javascript.mjs') },
  json: { extensions: ['json'], load: () => import('shiki/langs/json.mjs') },
  jsonc: { extensions: ['jsonc'], load: () => import('shiki/langs/jsonc.mjs') },
  makefile: { extensions: [], load: () => import('shiki/langs/makefile.mjs') },
  markdown: { extensions: ['md', 'markdown'], load: () => import('shiki/langs/markdown.mjs') },
  python: { extensions: ['py'], load: () => import('shiki/langs/python.mjs') },
  rust: { extensions: ['rs'], load: () => import('shiki/langs/rust.mjs') },
  shellscript: { extensions: ['sh', 'bash', 'zsh'], load: () => import('shiki/langs/shellscript.mjs') },
  sql: { extensions: ['sql'], load: () => import('shiki/langs/sql.mjs') },
  toml: { extensions: ['toml'], load: () => import('shiki/langs/toml.mjs') },
  tsx: { extensions: ['tsx', 'jsx'], load: () => import('shiki/langs/tsx.mjs') },
  typescript: { extensions: ['ts', 'mts', 'cts'], load: () => import('shiki/langs/typescript.mjs') },
  xml: { extensions: ['xml', 'svg'], load: () => import('shiki/langs/xml.mjs') },
  yaml: { extensions: ['yaml', 'yml'], load: () => import('shiki/langs/yaml.mjs') },
}

/** A file's language by its whole name, for the files that have no extension to go by. */
const BY_NAME: Readonly<Record<string, SyntaxLanguage>> = {
  Dockerfile: 'dockerfile',
  GNUmakefile: 'makefile',
  Makefile: 'makefile',
}

/** The language `path` is highlighted as, by its name then its extension; `undefined` for none. */
export function languageOf(path: string): SyntaxLanguage | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined
  return (
    BY_NAME[name] ??
    LANGUAGES.find((language) => extension !== undefined && GRAMMARS[language].extensions.includes(extension))
  )
}

/**
 * The one theme: Shiki's css-variables theme, each role a `var(--syntax-token-…)` — a variable never
 * set anywhere, only read back off the token to choose its class ({@link ROLE_CLASS}).
 */
const THEME_NAME = 'enso-theme-tokens'

/**
 * Each role's theme token — the terminal colours the themes map `chart-1…6` from (`styles/themes.css`):
 * keywords magenta, strings green, functions and types blue, constants orange, parameters yellow,
 * links cyan, comments the muted text. A role not named here — plain text, punctuation — keeps the
 * line's own colour.
 */
const ROLE_CLASS: Readonly<Record<string, string>> = {
  'var(--syntax-token-keyword)': 'text-chart-4',
  'var(--syntax-token-string)': 'text-chart-2',
  'var(--syntax-token-string-expression)': 'text-chart-2',
  'var(--syntax-token-function)': 'text-chart-1',
  'var(--syntax-token-constant)': 'text-chart-6',
  'var(--syntax-token-parameter)': 'text-chart-3',
  'var(--syntax-token-link)': 'text-chart-5',
  'var(--syntax-token-comment)': 'text-muted-foreground',
  'var(--syntax-token-inserted)': 'text-ok',
  'var(--syntax-token-deleted)': 'text-refuse',
  'var(--syntax-token-changed)': 'text-evidence',
}

/** Shiki's font-style bits: italic, bold, underline. */
const FONT_STYLE_CLASSES: ReadonlyArray<readonly [number, string]> = [
  [1, 'italic'],
  [2, 'font-semibold'],
  [4, 'underline'],
]

/** One run of a line, and the classes that colour it; `''` for text in the line's own colour. */
export interface SyntaxToken {
  readonly text: string
  readonly className: string
}

/** A file's lines as tokens: line N at index N − 1. */
export type HighlightedLines = ReadonlyArray<readonly SyntaxToken[]>

/**
 * The longest line tokenised, in characters: a minified line past it is one plain token, so one
 * line of a bundle cannot hold the page.
 */
const MAX_TOKENIZED_LINE = 1000

/**
 * Lines tokenised between two yields to the page. Shiki tokenises synchronously, about 4 ms per
 * 1000 characters of TypeScript once its grammar is warm (measured: a 69 kB file in 264 ms, a
 * 484 kB one in 2 s) — so the file goes through in slices, the grammar's state carried from one to
 * the next, and a click or a keystroke between two of them is answered at once.
 */
const LINES_PER_SLICE = 200

let highlighter: Promise<HighlighterCore> | undefined

function tokenOf(token: ThemedToken): SyntaxToken {
  const fontStyle = token.fontStyle ?? 0
  const classes = [
    ROLE_CLASS[token.color ?? ''] ?? '',
    ...FONT_STYLE_CLASSES.filter(([bit]) => (fontStyle & bit) !== 0).map(([, className]) => className),
  ]
  return { text: token.content, className: classes.filter((className) => className !== '').join(' ') }
}

/**
 * Shiki's core with its JavaScript regex engine and the one theme above — dynamic, so the page
 * loads them only when a Diff tab first highlights a file, never for a page that opens none.
 */
async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createCssVariablesTheme, createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ])
  const theme = createCssVariablesTheme({ name: THEME_NAME, variablePrefix: '--syntax-' })
  return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() })
}

/** A tokenising pass: the highlighter and language, the file's lines, and the tokens so far. */
interface TokenisingPass {
  readonly highlighter: HighlighterCore
  readonly language: SyntaxLanguage
  readonly lines: readonly string[]
  readonly highlighted: SyntaxToken[][]
}

/**
 * The pass's lines from `first` on, a slice now and the rest after a yield to the page, the
 * grammar's state carried across — so a block comment open at a slice's end stays open in the next.
 */
async function tokeniseFrom(pass: TokenisingPass, first: number, grammarState?: GrammarState): Promise<void> {
  if (first >= pass.lines.length) return
  const slice = pass.highlighter.codeToTokens(pass.lines.slice(first, first + LINES_PER_SLICE).join('\n'), {
    lang: pass.language,
    theme: THEME_NAME,
    tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
    ...(grammarState === undefined ? {} : { grammarState }),
  })
  pass.highlighted.push(...slice.tokens.map((line) => line.map(tokenOf)))
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await promise
  await tokeniseFrom(pass, first + LINES_PER_SLICE, slice.grammarState)
}

/**
 * `text` as `language`'s tokens, line by line, a slice at a time ({@link LINES_PER_SLICE}) — the
 * highlighter and its grammar loaded on first use.
 */
export async function highlightLines(text: string, language: SyntaxLanguage): Promise<HighlightedLines> {
  highlighter ??= createHighlighter()
  const loaded = await highlighter
  if (!loaded.getLoadedLanguages().includes(language))
    await loaded.loadLanguage((await GRAMMARS[language].load()).default)
  const pass: TokenisingPass = { highlighter: loaded, language, lines: text.split('\n'), highlighted: [] }
  await tokeniseFrom(pass, 0)
  return pass.highlighted
}
