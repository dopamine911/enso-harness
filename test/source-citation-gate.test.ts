import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  citationsIn,
  declarationsIn,
  lineReferencesIn,
  linkCitations,
  pageProblems,
  resolveCitation,
} from '../scripts/docs/source-citations.ts'
import { markdownFiles, REPOSITORY_ROOT } from './gate-support.ts'

/**
 * A HAND-WRITTEN PAGE POINTS AT CODE BY DECLARATION, AND EVERY POINTER HOLDS (#482).
 *
 * ⚠ Enforcement first. Every `path#Name` citation on a hand-written page (built pages are their
 * generators') resolves with the TypeScript parser to one file and a name declared in it, and no
 * page types a line number into this repository's source: `path:N` anywhere, "line N" on a seam
 * page. The site build renders each citation as a link to its line (`linkCitations`), so the
 * number a reader lands on is computed, never typed. Replaces `prose-citation-gate`, which held
 * only a number written right beside its symbol, and let the rest drift unread.
 */
test('⚠ every source citation on a hand-written page resolves, and none types a line number (#482)', () => {
  const pages = [...markdownFiles(join(REPOSITORY_ROOT, 'docs')), join(REPOSITORY_ROOT, 'README.md')]
  // A floor: a walk that found no page would pass.
  expect(pages.length).toBeGreaterThan(20)
  const problems = pages.flatMap((path) =>
    pageProblems(path.slice(REPOSITORY_ROOT.length + 1), readFileSync(path, 'utf8')),
  )
  expect(problems).toEqual([])
})

const SOURCE = [
  '/** Above the function: its doc comment. */',
  'export function outer(): void {',
  '  const finish = (): void => undefined',
  '  function helper(): void {',
  '    const outer = 1',
  '  }',
  '}',
  'const shape = { answer: (): number => 42, method() { return 1 } }',
  'interface Contract {',
  '  readonly openDialogs: () => void',
  '}',
].join('\n')

test('a name is declared at any depth, the shallowest one wins, and its line is past its doc comment', () => {
  const declarations = declarationsIn('fixture.ts', SOURCE)
  // The function, not the `const outer` inside `helper`, and the `export function` line, not its doc comment's.
  expect(declarations.get('outer')).toBe(2)
  expect(declarations.get('finish')).toBe(3)
  expect(declarations.get('helper')).toBe(4)
  expect(declarations.get('answer')).toBe(8)
  expect(declarations.get('method')).toBe(8)
  expect(declarations.get('openDialogs')).toBe(10)
  expect(declarations.has('void')).toBe(false)
})

test('⚠ a citation resolves to exactly one file: an ambiguous path is refused with what it matched, never guessed', () => {
  expect(resolveCitation('follow.ts', 'followThread')).toBe(
    'follow.ts names 2 files (packages/core/src/follow.ts, packages/web/src/server/follow.ts); give more of its path',
  )
  expect(resolveCitation('server/follow.ts', 'followThread')).toMatchObject({
    file: 'packages/web/src/server/follow.ts',
  })
  expect(resolveCitation('secrets.ts', 'noSuchThing')).toBe('packages/core/src/secrets.ts declares no noSuchThing')
  expect(resolveCitation('src/core/tools/bash.ts', 'resolveTimeoutMs')).toBe(
    'src/core/tools/bash.ts is no source file of this repository',
  )
})

test("a citation is a code span of its own: not in a fence, not a link's text, not a span with more in it", () => {
  const page = [
    'Asked by `awaitDialog`, in `host/extension-ui-context.ts#awaitDialog`.',
    '```ts',
    'const cited = `fenced.ts#Inside`',
    '```',
    'A link [`secrets.ts#readSecret`](../x.ts), and `see secrets.ts#readSecret too`.',
  ].join('\n')
  expect(citationsIn(page)).toEqual([{ line: 1, path: 'host/extension-ui-context.ts', name: 'awaitDialog' }])
})

test("⚠ a typed line number is refused for this repository's files, kept for a vendor's, and bare only on a seam page", () => {
  const page = [
    'Read by `readSecret` (`secrets.ts:83-86`), as `src/core/tools/bash.ts:29` does in pi.',
    'The wait (line 326), and lines 413–459; the handler (:4-9), then `:365-368`, at 02:08.',
    'A range split by the wrap: lines',
    '840–862.',
  ].join('\n')
  expect(lineReferencesIn(page, false).map((reference) => reference.text)).toEqual(['secrets.ts:83-86'])
  expect(lineReferencesIn(page, true)).toEqual([
    { line: 1, text: 'secrets.ts:83-86' },
    { line: 2, text: 'line 326' },
    { line: 2, text: 'lines 413–459' },
    { line: 2, text: ':4-9' },
    { line: 2, text: ':365-368' },
    { line: 3, text: 'lines 840–862' },
  ])
})

test("the site link lands on the declaration's own line; what does not resolve is left as written", () => {
  const blob = 'https://example.invalid/blob/main'
  const linked = linkCitations(
    'By `secrets.ts#readSecret`, not `secrets.ts#gone`.\n```\n`secrets.ts#readSecret`\n```',
    blob,
  )
  const [, file = '', line = '0'] = /\]\(https:\/\/example\.invalid\/blob\/main\/([^#)]+)#L(\d+)\)/.exec(linked) ?? []
  expect(file).toBe('packages/core/src/secrets.ts')
  const source = readFileSync(join(REPOSITORY_ROOT, file), 'utf8').split('\n')
  expect(source[Number(line) - 1]).toStartWith('export function readSecret(')
  expect(linked).toContain('not `secrets.ts#gone`.')
  // A fence is source: its text is not a citation to link.
  expect(linked.endsWith('```\n`secrets.ts#readSecret`\n```')).toBe(true)
})
