import typescript from 'typescript'

/**
 * Every comment in a source file, with what it is about, taken from the TypeScript syntax tree
 * (#482, PR #488 review): the docs builders read comments the way the compiler does, never by
 * matching text. A `//` inside a string, a template or JSX text is not a comment, and the parser is
 * the one thing that knows that.
 *
 * WHAT A COMMENT IS ABOUT:
 *   • `owner`: the declaration it documents. A comment sitting DIRECTLY on a declaration (no blank
 *     line between) documents that declaration: a function, a class, an interface, a type, a
 *     `const`, a method, an object-literal property. A `//` comment anywhere else belongs to the
 *     nearest named declaration around it, so a note inside a function body is about that
 *     function. ⚠ A `/** *\/` comment a blank line cuts from its declaration documents nothing,
 *     the way TypeScript attaches none: its owner is `undefined`, never whatever moves in below.
 *   • `test`: the literal title, when the comment sits directly on a `test('<title>', …)` statement.
 *
 * Only parsing, no type-checking: every file stands alone, so the cost is one `createSourceFile`.
 */

export interface SourceComment {
  /** 1-based line the comment starts on. */
  readonly line: number
  readonly style: 'block' | 'line'
  /** The comment's lines with the markers removed: `//`, `/**`, `*\/` and a block's leading `*`. */
  readonly lines: readonly string[]
  readonly owner: { readonly symbol: string; readonly line: number } | undefined
  readonly test: string | undefined
}

interface Range {
  readonly pos: number
  readonly end: number
  readonly kind: typescript.CommentKind
}

/** A comment's text as lines, the comment markers stripped the way a reader skips them. */
function textLines(raw: string, kind: typescript.CommentKind): string[] {
  if (kind === typescript.SyntaxKind.SingleLineCommentTrivia) return [withoutFirstSpace(raw.slice(2))]
  const inner = raw.slice(2, -2)
  const body = inner.startsWith('*') ? inner.slice(1) : inner
  return body.split('\n').map((line) => {
    const trimmed = line.trimStart()
    return trimmed.startsWith('*') ? withoutFirstSpace(trimmed.slice(1)) : line
  })
}

const withoutFirstSpace = (text: string): string => (text.startsWith(' ') ? text.slice(1) : text)

type NamedDeclaration =
  | typescript.FunctionDeclaration
  | typescript.ClassDeclaration
  | typescript.InterfaceDeclaration
  | typescript.TypeAliasDeclaration
  | typescript.EnumDeclaration
  | typescript.MethodDeclaration
  | typescript.MethodSignature
  | typescript.PropertyAssignment
  | typescript.PropertyDeclaration
  | typescript.PropertySignature
  | typescript.GetAccessorDeclaration
  | typescript.SetAccessorDeclaration
  | typescript.VariableDeclaration

function isNamedDeclaration(node: typescript.Node): node is NamedDeclaration {
  return (
    typescript.isFunctionDeclaration(node) ||
    typescript.isClassDeclaration(node) ||
    typescript.isInterfaceDeclaration(node) ||
    typescript.isTypeAliasDeclaration(node) ||
    typescript.isEnumDeclaration(node) ||
    typescript.isMethodDeclaration(node) ||
    typescript.isMethodSignature(node) ||
    typescript.isPropertyAssignment(node) ||
    typescript.isPropertyDeclaration(node) ||
    typescript.isPropertySignature(node) ||
    typescript.isGetAccessorDeclaration(node) ||
    typescript.isSetAccessorDeclaration(node) ||
    typescript.isVariableDeclaration(node)
  )
}

/**
 * Whether a variable is a symbol a page can name: one at module level, or one that holds a
 * function wherever it is. A local VALUE (`const resolved = …` inside a function) is part of that
 * function's body, and a note beside it is about the function.
 */
function isDocumentableVariable(declaration: typescript.VariableDeclaration): boolean {
  const initializer = declaration.initializer
  if (
    initializer !== undefined &&
    (typescript.isArrowFunction(initializer) || typescript.isFunctionExpression(initializer))
  )
    return true
  return typescript.isSourceFile(declaration.parent.parent.parent)
}

/**
 * The name a declaration introduces; a `const` statement's is its first binding's. `namedOnly`:
 * refuse a local value, which is part of its function rather than a symbol of its own.
 */
function declaredName(file: typescript.SourceFile, node: typescript.Node, namedOnly: boolean): string | undefined {
  const declaration = typescript.isVariableStatement(node) ? node.declarationList.declarations[0] : node
  if (declaration === undefined || !isNamedDeclaration(declaration) || declaration.name === undefined) return undefined
  if (namedOnly && typescript.isVariableDeclaration(declaration) && !isDocumentableVariable(declaration))
    return undefined
  return typescript.isIdentifier(declaration.name) ? declaration.name.text : declaration.name.getText(file)
}

/**
 * The title of a `test(<title>, …)` statement as its source spells it: a literal's text, or a
 * template's between its backticks (`${version}` included), the way the docs gate matches it.
 */
function testTitle(file: typescript.SourceFile, node: typescript.Node): string | undefined {
  if (!typescript.isExpressionStatement(node) || !typescript.isCallExpression(node.expression)) return undefined
  const call = node.expression
  if (!typescript.isIdentifier(call.expression) || call.expression.text !== 'test') return undefined
  const [title] = call.arguments
  if (title === undefined) return undefined
  if (typescript.isStringLiteral(title) || typescript.isNoSubstitutionTemplateLiteral(title)) return title.text
  return typescript.isTemplateExpression(title) ? title.getText(file).slice(1, -1) : undefined
}

const lineOf = (file: typescript.SourceFile, position: number): number =>
  file.getLineAndCharacterOfPosition(position).line

/** The comments leading `node`, each run of `//` lines on consecutive lines merged into one range list. */
function leadingRuns(file: typescript.SourceFile, node: typescript.Node): Range[][] {
  const runs: Range[][] = []
  for (const range of typescript.getLeadingCommentRanges(file.text, node.getFullStart()) ?? []) {
    const run = runs.at(-1)
    const last = run?.at(-1)
    const continues =
      last !== undefined &&
      last.kind === typescript.SyntaxKind.SingleLineCommentTrivia &&
      range.kind === typescript.SyntaxKind.SingleLineCommentTrivia &&
      lineOf(file, range.pos) === lineOf(file, last.end) + 1
    if (continues) run?.push(range)
    else runs.push([range])
  }
  return runs
}

function describe(file: typescript.SourceFile, run: readonly Range[], node: typescript.Node): SourceComment {
  const first = run[0] as Range
  const last = run.at(-1) as Range
  const style = first.kind === typescript.SyntaxKind.SingleLineCommentTrivia ? 'line' : 'block'
  const lines = run.flatMap((range) => textLines(file.text.slice(range.pos, range.end), range.kind))
  // Directly on: the node starts on the line after the comment ends, or on the same line.
  const directly = !typescript.isToken(node) && lineOf(file, node.getStart(file)) - lineOf(file, last.end) <= 1
  return {
    line: lineOf(file, first.pos) + 1,
    style,
    lines,
    owner: ownerOf(file, style, directly, node),
    test: directly ? testTitle(file, node) : undefined,
  }
}

/**
 * A doc comment (`/** *\/`) owns whatever it sits directly on, a local variable included: that is
 * where TypeScript attaches it. A `//` note owns only a symbol a page can name (a local VALUE is part
 * of its function), and otherwise belongs to the nearest such symbol around it.
 */
function ownerOf(
  file: typescript.SourceFile,
  style: 'block' | 'line',
  directly: boolean,
  node: typescript.Node,
): SourceComment['owner'] {
  const own = directly ? declaredName(file, node, style === 'line') : undefined
  if (own !== undefined) return { symbol: own, line: lineOf(file, node.getStart(file)) + 1 }
  if (style === 'block') return undefined
  for (let around = node.parent; around !== undefined; around = around.parent) {
    const symbol = declaredName(file, around, true)
    if (symbol !== undefined) return { symbol, line: lineOf(file, around.getStart(file)) + 1 }
  }
  return undefined
}

/**
 * Every comment in `source`, each once, in file order.
 *
 * ⚠ THE WALK IS OVER TOKENS, NOT ONLY NODES: a comment that no statement follows, the last lines
 * of a block before its `}` or of a file before its end, leads a token, and walking nodes alone
 * would never see it. Parents come first, so a comment goes to the OUTERMOST node it leads
 * (`export const x`, not the identifier inside it). A syntax list claims nothing: its first
 * element starts where it does, and is the node the comment is about. JSDoc nodes are the comments
 * themselves, not what they lead.
 */
export function commentsIn(path: string, source: string): SourceComment[] {
  const kind = path.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS
  const file = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, true, kind)
  const seen = new Set<number>()
  const comments: SourceComment[] = []
  const visit = (node: typescript.Node): void => {
    if (typescript.isJSDoc(node)) return
    if (node.kind !== typescript.SyntaxKind.SyntaxList) {
      for (const run of leadingRuns(file, node)) {
        const start = (run[0] as Range).pos
        if (seen.has(start)) continue
        seen.add(start)
        comments.push(describe(file, run, node))
      }
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  for (const child of file.getChildren(file)) visit(child)
  return comments.sort((left, right) => left.line - right.line)
}
