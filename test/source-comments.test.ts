import { expect, test } from 'bun:test'
import { commentsIn } from '../scripts/docs/source-comments.ts'

/**
 * WHICH DECLARATION A COMMENT IS ABOUT, FROM THE SYNTAX TREE (#482, PR #488 review).
 *
 * ⚠ Enforcement for the docs builders: a flow page names the symbol each rule is stated at, and
 * links its line. The rules below are the ones a text scan got wrong or could not see. The first two
 * are the cases where the regex scanner this replaced and the parser disagreed on the real tree:
 * `web-fetch-gates` sat inside `execute: async (…) =>`, which no line pattern read as a
 * declaration, and three notes sat above local values inside the function they were about.
 */

const SOURCE = [
  'export function register(tool: { add(spec: object): void }): void {',
  '  tool.add({',
  '    execute: async () => {',
  '      // @invariant demo/gates A note inside an object-literal handler.',
  '      const decision = 1',
  '      return decision',
  '    },',
  '  })',
  '}',
  '',
  'export function resolve(): number {',
  '  // A note beside a local value, not about the value.',
  '  const resolved = 2',
  '  /** A doc comment on a local variable documents that variable. */',
  '  const documented = 3',
  '  return resolved + documented',
  '  // A last note in the body, before its closing brace.',
  '}',
  '',
  "const url = 'http://example.invalid/not-a-comment'",
  '',
  '/**',
  ' * A doc comment a blank line cuts from its declaration.',
  ' */',
  '',
  'export const later = url',
  '',
  '// @pins demo/gates',
  "test(`a title with ${'a substitution'} in it`, () => {})",
].join('\n')

const comments = commentsIn('fixture.ts', SOURCE)
const about = (text: string): (typeof comments)[number] | undefined =>
  comments.find((comment) => comment.lines.some((line) => line.includes(text)))

test('⚠ a note inside an object-literal method belongs to that method, not the function around it', () => {
  expect(about('object-literal handler')?.owner).toEqual({ symbol: 'execute', line: 3, end: 7 })
})

test('⚠ a note beside a local value belongs to the function; a doc comment on a local variable belongs to the variable', () => {
  expect(about('beside a local value')?.owner).toEqual({ symbol: 'resolve', line: 11, end: 18 })
  expect(about('documents that variable')?.owner).toEqual({ symbol: 'documented', line: 15, end: 15 })
})

test('a note no statement follows is still seen, and belongs to the function whose body it closes', () => {
  expect(about('before its closing brace')?.owner).toEqual({ symbol: 'resolve', line: 11, end: 18 })
})

test('⚠ a doc comment a blank line cuts from its declaration documents nothing', () => {
  expect(about('a blank line cuts')?.owner).toBeUndefined()
})

test('text that only looks like a comment, inside a string, is not one', () => {
  expect(about('not-a-comment')).toBeUndefined()
  expect(comments).toHaveLength(6)
})

test('a pin reads its test title as the source spells it, template substitutions included', () => {
  expect(about('@pins demo/gates')?.test).toBe("a title with ${'a substitution'} in it")
})
