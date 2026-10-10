import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { extractDeclarationFromFile } from '../docs/extract-declaration.ts'
import { refreshFences } from '../docs/refresh-fences.ts'

/**
 * `bun scripts/docs/refresh-fences.ts <page>` (#168): the repair tool for the docs gate's sourced
 * fences and generated blocks. It fills what a marker names, and refuses — leaving the page as it
 * was — rather than skip or truncate (#838).
 */

const MARKER = '<!-- source: scripts/server-cli.ts#UsageError -->'
const DECLARATION = extractDeclarationFromFile(
  join(findRepoRoot(import.meta.url), 'scripts/server-cli.ts'),
  'UsageError',
).text
const scratch = mkdtempSync(join(tmpdir(), 'refresh-fences-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

test('a sourced fence is filled with the declaration its marker names, stale body replaced, the rest untouched', () => {
  expect(DECLARATION).toContain('export class UsageError extends Error')
  const page = ['# Page', '', MARKER, '```ts title="usage"', 'stale', 'lines', '```', '', 'After.'].join('\n')
  expect(refreshFences(page)).toEqual({
    text: ['# Page', '', MARKER, '```ts title="usage"', DECLARATION, '```', '', 'After.'].join('\n'),
    refreshed: 1,
  })
  // Already fresh: the same text back, still counted as refreshed.
  const fresh = refreshFences(page).text
  expect(refreshFences(fresh)).toEqual({ text: fresh, refreshed: 1 })
  expect(refreshFences('# Page\n\n```ts\nplain\n```')).toEqual({ text: '# Page\n\n```ts\nplain\n```', refreshed: 0 })
})

test('⚠ a marker over a fence it cannot fill, or a fence that never closes, is refused with its line', () => {
  expect(() => refreshFences(['# Page', MARKER, '```mermaid', 'graph', '```'].join('\n'))).toThrow(
    'line 2: source marker is not above a TypeScript or JavaScript fence',
  )
  expect(() => refreshFences(['# Page', MARKER, 'prose'].join('\n'))).toThrow(/^line 2: source marker is not above/)
  expect(() => refreshFences(['# Page', MARKER].join('\n'))).toThrow(/^line 2: source marker is not above/)
  expect(() => refreshFences(['# Page', MARKER, '```tsx', 'body'].join('\n'))).toThrow(
    'line 3: sourced fence is never closed',
  )
})

test("a generated block is replaced by its script's stdout; a failing script or an unclosed block is refused", () => {
  const script = join(scratch, 'generate.ts')
  writeFileSync(script, "process.stdout.write('| a | b |\\n|---|---|\\n\\n')\n")
  const block = (body: string): string =>
    ['# Page', `<!-- generated-block: ${script} -->`, body, '<!-- /generated-block -->', 'After.'].join('\n')
  expect(refreshFences(block('old\ntable'))).toEqual({ text: block('| a | b |\n|---|---|'), refreshed: 1 })

  const failing = join(scratch, 'fail.ts')
  writeFileSync(failing, "process.stderr.write('no data')\nprocess.exit(3)\n")
  expect(() => refreshFences(`<!-- generated-block: ${failing} -->\n<!-- /generated-block -->`)).toThrow(
    `${failing} exited 3: no data`,
  )
  expect(() => refreshFences(`intro\n<!-- generated-block: ${script} -->\nbody`)).toThrow(
    `line 2: generated-block for ${script} is never closed`,
  )
})
