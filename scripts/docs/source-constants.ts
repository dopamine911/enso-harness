import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import typescript from 'typescript'
import { ROOT } from './flow-tags.ts'

/**
 * A top-level constant's VALUE, read out of a source file with the TypeScript parser (#482).
 *
 * A docs builder may import only `@enso/core` (the `scripts` zone, `.fallowrc.jsonc`), but a page
 * quotes facts the browser, the host and the harness own: the guard verdict words, picc's mode
 * list, a size limit. Reading the constant beats re-typing it, and parsing beats the regex readers
 * in `gate-source.ts`: a bracket in a comment or a string can't end an array early here.
 *
 * It evaluates LITERALS only: strings, numbers, booleans, `null`, arrays, objects, arithmetic on
 * numbers, `new Set([…])` (as its array), and a name that is another top-level `const` in the same
 * file. `as const`, `satisfies` and parentheses are looked through.
 *
 * ⚠ Anything else is a refusal naming the file, the constant and the line (a call, a spread, an
 * import). A value this cannot read is one a page would otherwise quote wrong, so it never guesses.
 */

export type LiteralValue = string | number | boolean | null | readonly LiteralValue[] | LiteralObject
export interface LiteralObject {
  readonly [key: string]: LiteralValue
}

type Evaluate = (expression: typescript.Expression) => LiteralValue

/** The top-level `const` initializers of a file, by name. */
function constantsOf(file: typescript.SourceFile): Map<string, typescript.Expression> {
  const initializers = new Map<string, typescript.Expression>()
  for (const statement of file.statements) {
    if (!typescript.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & typescript.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (typescript.isIdentifier(declaration.name) && declaration.initializer !== undefined)
        initializers.set(declaration.name.text, declaration.initializer)
    }
  }
  return initializers
}

/** What wraps a value without changing it: `as const`, `satisfies T`, `(…)`, `<T>…`. */
function unwrapped(expression: typescript.Expression): typescript.Expression {
  let inner = expression
  while (
    typescript.isAsExpression(inner) ||
    typescript.isSatisfiesExpression(inner) ||
    typescript.isParenthesizedExpression(inner) ||
    typescript.isTypeAssertionExpression(inner)
  )
    inner = inner.expression
  return inner
}

const ARITHMETIC: Readonly<Partial<Record<typescript.SyntaxKind, (left: number, right: number) => number>>> = {
  [typescript.SyntaxKind.AsteriskToken]: (left, right) => left * right,
  [typescript.SyntaxKind.PlusToken]: (left, right) => left + right,
  [typescript.SyntaxKind.MinusToken]: (left, right) => left - right,
  [typescript.SyntaxKind.SlashToken]: (left, right) => left / right,
}

function propertyName(name: typescript.PropertyName): string | undefined {
  if (typescript.isIdentifier(name) || typescript.isStringLiteral(name) || typescript.isNumericLiteral(name))
    return name.text
  return undefined
}

function objectValue(expression: typescript.ObjectLiteralExpression, evaluate: Evaluate): LiteralValue | undefined {
  const entries: [string, LiteralValue][] = []
  for (const property of expression.properties) {
    if (typescript.isShorthandPropertyAssignment(property)) entries.push([property.name.text, evaluate(property.name)])
    else if (!typescript.isPropertyAssignment(property)) return undefined
    else {
      const key = propertyName(property.name)
      if (key === undefined) return undefined
      entries.push([key, evaluate(property.initializer)])
    }
  }
  return Object.fromEntries(entries)
}

function numberOperand(value: LiteralValue): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** A literal's value, `undefined` when the expression is not one this reads. */
function literalValue(expression: typescript.Expression, evaluate: Evaluate): LiteralValue | undefined {
  if (typescript.isStringLiteral(expression) || typescript.isNoSubstitutionTemplateLiteral(expression))
    return expression.text
  if (typescript.isNumericLiteral(expression)) return Number(expression.text.replaceAll('_', ''))
  if (expression.kind === typescript.SyntaxKind.TrueKeyword) return true
  if (expression.kind === typescript.SyntaxKind.FalseKeyword) return false
  if (expression.kind === typescript.SyntaxKind.NullKeyword) return null
  if (typescript.isArrayLiteralExpression(expression)) {
    if (expression.elements.some(typescript.isSpreadElement)) return undefined
    return expression.elements.map(evaluate)
  }
  if (typescript.isObjectLiteralExpression(expression)) return objectValue(expression, evaluate)
  if (
    typescript.isPrefixUnaryExpression(expression) &&
    expression.operator === typescript.SyntaxKind.MinusToken &&
    typeof evaluate(expression.operand) === 'number'
  )
    return -(evaluate(expression.operand) as number)
  if (typescript.isBinaryExpression(expression)) {
    const operation = ARITHMETIC[expression.operatorToken.kind]
    const left = numberOperand(evaluate(expression.left))
    const right = numberOperand(evaluate(expression.right))
    return operation === undefined || left === undefined || right === undefined ? undefined : operation(left, right)
  }
  const [argument] = typescript.isNewExpression(expression) ? (expression.arguments ?? []) : []
  if (typescript.isNewExpression(expression) && expression.expression.getText() === 'Set' && argument !== undefined)
    return evaluate(argument)
  return undefined
}

/** The value of the top-level constant `name` in `source`; `path` names the file in a refusal. */
export function literalConstant(path: string, source: string, name: string): LiteralValue {
  const kind = path.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS
  const file = typescript.createSourceFile(path, source, typescript.ScriptTarget.Latest, true, kind)
  const initializers = constantsOf(file)
  const resolving: string[] = []
  const resolve = (constant: string): LiteralValue => {
    const initializer = initializers.get(constant)
    if (initializer === undefined) throw new Error(`source-constants: ${path} has no top-level const ${constant}`)
    if (resolving.includes(constant))
      throw new Error(`source-constants: ${path}: ${[...resolving, constant].join(' → ')} refers to itself`)
    resolving.push(constant)
    const evaluate: Evaluate = (expression) => {
      const inner = unwrapped(expression)
      if (typescript.isIdentifier(inner)) return resolve(inner.text)
      const value = literalValue(inner, evaluate)
      if (value !== undefined) return value
      const { line } = file.getLineAndCharacterOfPosition(inner.getStart())
      throw new Error(
        `source-constants: ${path}:${line + 1}: ${name} is not a literal here (\`${inner.getText().slice(0, 60)}\`)`,
      )
    }
    const value = evaluate(initializer)
    resolving.pop()
    return value
  }
  return resolve(name)
}

/** `literalConstant` over a repository file. */
export function constantIn(path: string, name: string): LiteralValue {
  return literalConstant(path, readFileSync(join(ROOT, path), 'utf8'), name)
}

/** A constant that must be an array of strings. */
export function stringsIn(path: string, name: string): string[] {
  const value = constantIn(path, name)
  if (Array.isArray(value) && value.every((listed) => typeof listed === 'string')) return value as string[]
  throw new Error(`source-constants: ${path}: ${name} is not an array of strings`)
}

/** A constant that must be a number. */
export function numberIn(path: string, name: string): number {
  const value = constantIn(path, name)
  if (typeof value === 'number') return value
  throw new Error(`source-constants: ${path}: ${name} is not a number`)
}

/** A constant that must be a string. */
export function stringIn(path: string, name: string): string {
  const value = constantIn(path, name)
  if (typeof value === 'string') return value
  throw new Error(`source-constants: ${path}: ${name} is not a string`)
}

/** A constant that must be an object of strings. */
export function stringRecordIn(path: string, name: string): Readonly<Record<string, string>> {
  const value = constantIn(path, name)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.every(([, listed]) => typeof listed === 'string')) return value as Readonly<Record<string, string>>
  }
  throw new Error(`source-constants: ${path}: ${name} is not an object of strings`)
}
