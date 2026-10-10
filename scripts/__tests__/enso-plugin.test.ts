import { expect, test } from 'bun:test'
import { parseSync } from 'oxc-parser'
import plugin from '../lint/enso-plugin.ts'

/**
 * The `enso` plugin's own rules in-process (#838): oxc parses each case into the ESTree oxlint hands
 * a JS plugin, and the rule's visitors run here, so coverage sees them. The lint gate runs them in
 * oxlint's subprocess, which no test measures; `test/naming-gate.test.ts` still lints through the
 * repo's real config, and covers the naming tiers, which need oxlint's whole context.
 *
 * ⚠ Not oxlint's `RuleTester` (`oxlint/plugins-dev`): it refuses to run under Bun.
 */

interface AstNode {
  readonly type: string
  readonly start: number
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

/** Every node in source order, parents before children — the order a linter's visitors see them. */
function nodesOf(value: unknown): AstNode[] {
  if (Array.isArray(value)) return value.flatMap(nodesOf)
  if (typeof value !== 'object' || value === null) return []
  const children = Object.values(value).flatMap(nodesOf)
  return isNode(value) ? [value, ...children] : children
}

/** What a rule reported on `source`: each reported node's name (or type), and its message's lead clause. */
function reports(ruleName: 'generic-iteration' | 'no-export-all', source: string): string[] {
  const parsed = parseSync('case.ts', source)
  expect(parsed.errors).toEqual([])
  const reported: string[] = []
  const visitor = plugin.rules[ruleName].create({
    report: ({ node, message }) => {
      // Every report names its node, so the editor can underline it.
      if (!isNode(node)) throw new Error(`a report without a node: ${message}`)
      const label = 'name' in node ? String(node.name) : node.type
      reported.push(`${label}: ${message.split(/ — |: /)[0]}`)
    },
  })
  for (const node of nodesOf(parsed.program)) visitor[node.type]?.(node as never)
  return reported
}

const GENERIC = 'Generic iteration variable'
const flagged = (...names: readonly string[]): string[] => names.map((name) => `${name}: ${GENERIC}`)

test('generic-iteration: the element parameter of an iteration callback, by method and arity', () => {
  expect(reports('generic-iteration', 'rows.map((item) => item)')).toEqual(flagged('item'))
  expect(reports('generic-iteration', 'rows.forEach((value, position) => position)')).toEqual(flagged('value'))
  expect(reports('generic-iteration', 'rows.filter((entry, data) => entry === data)')).toEqual(flagged('entry'))
  expect(reports('generic-iteration', 'rows.flatMap((text) => [text])')).toEqual(flagged('text'))
  // `reduce` names its element second: the accumulator is free, whatever it is called.
  expect(reports('generic-iteration', 'rows.reduce((result, item) => result + item, 0)')).toEqual(flagged('item'))
  expect(reports('generic-iteration', 'rows.map((row) => row)')).toEqual([])
})

test('generic-iteration: a shape the rule does not name is allowed', () => {
  const allowed = [
    // An arity the method's entry does not list: a third parameter, `some`'s second, `reduce`'s only one.
    'rows.map((item, position, all) => all[position] ?? item)',
    'rows.some((row, item) => row === item)',
    'rows.reduce((item) => item)',
    // A computed or unknown member, a bare call, a function expression, a callback that is not first.
    'rows["map"]((item) => item)',
    'rows.sort((item) => item)',
    'map((item) => item)',
    'rows.map(function named(item) { return item })',
    'rows.map(convert, (item) => item)',
    'rows.map()',
    // A destructured parameter is not checked as a whole name.
    'rows.map(({ item }) => item)',
  ]
  expect(allowed.flatMap((source) => reports('generic-iteration', source))).toEqual([])
})

test('generic-iteration: every name a loop header binds, destructuring at any depth', () => {
  expect(reports('generic-iteration', 'for (let index = 0; index < 3; index += 1) {}')).toEqual(flagged('index'))
  expect(reports('generic-iteration', 'let count = 0, id = 0\nfor (id of rows) {}')).toEqual(flagged('id'))
  expect(
    reports('generic-iteration', 'for (const { id, nested: [value = 1, , ...items], ...data } of rows) {}'),
  ).toEqual(flagged('id', 'value', 'data'))
  expect(reports('generic-iteration', 'for (const [first, ...name] of rows) {}')).toEqual(flagged('name'))
  expect(reports('generic-iteration', 'for (let row = 0, count = 0; row < 3; row += 1) {}')).toEqual(flagged('count'))
  // Nothing bound: an empty header, an assignment, a member target, a renamed property.
  const allowed = [
    'for (;;) break',
    'let index = 0\nfor (index = 1; index < 3; index += 1) {}',
    'for (holder.item of rows) {}',
    'for (const { item: row } of rows) {}',
  ]
  expect(allowed.flatMap((source) => reports('generic-iteration', source))).toEqual([])
})

test('no-export-all: a wildcard re-export, named or not, is refused; a named one is not', () => {
  const refusal =
    'ExportAllDeclaration: Re-export the names this module means to expose, not everything (`export * from …`)'
  expect(reports('no-export-all', "export * from './parse.ts'")).toEqual([refusal])
  expect(reports('no-export-all', "export * as parsing from './parse.ts'")).toEqual([refusal])
  expect(
    reports('no-export-all', "export { parse } from './parse.ts'\nexport type { Parsed } from './parse.ts'"),
  ).toEqual([])
})
