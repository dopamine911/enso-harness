import { afterAll, expect, test } from 'bun:test'
import type { EnsoGitFileChange, EnsoGitFileText, EnsoGitRepository } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type { ChangedFileOutcome, ReadChangedFile } from '../changed-file.ts'
import { highlightLines } from '../diff-highlight.ts'
import type * as ThreadChangesModule from '../thread-changes.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { waitUntil } from './wait-until.ts'

/**
 * #461: the Diff view mounted — a `N unchanged lines` count opens those lines, numbered on both
 * sides, from the file read whole; a file too large to send stays unexpandable and says so; and a
 * file that changed after its patch is never shown under the patch's numbers. Each line takes its
 * syntax's theme-token classes.
 */

// Dynamic, not static: react-dom/client must load after the DOM exists (`dom-environment.ts`).
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ThreadChangesView }: typeof ThreadChangesModule = await import('../thread-changes.tsx')
afterAll(releaseDom)

const REPOSITORY: EnsoGitRepository = {
  kind: 'repository',
  root: '/work/shop-api',
  scope: '',
  head: 'f00d',
  branch: 'main',
  upstream: 'origin/main',
  baseline: { rule: 'upstream', ref: 'origin/main', commit: 'beef' },
  ahead: 0,
  behind: 0,
  changes: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
  operation: null,
}

/** Lines 1–14 of the old file; the new one renames `alpha` and `kappa`. */
const OLD = ['// config', 'const alpha = 1', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'const kappa = 2', 'l', 'm', 'n']
const NEW = OLD.map((line) => line.replace('alpha', 'ALPHA').replace('kappa', 'KAPPA'))

const CONFIG: EnsoGitFileChange = {
  path: 'src/config.ts',
  oldPath: null,
  status: 'modified',
  added: 2,
  removed: 2,
  patch: [
    'diff --git a/src/config.ts b/src/config.ts',
    '@@ -1,3 +1,3 @@',
    ' // config',
    '-const alpha = 1',
    '+const ALPHA = 1',
    ' b',
    '@@ -10,3 +10,3 @@',
    ' i',
    '-const kappa = 2',
    '+const KAPPA = 2',
    ' l',
    '',
  ].join('\n'),
  omitted: null,
}

const text = (lines: readonly string[]): EnsoGitFileText => ({ kind: 'text', text: `${lines.join('\n')}\n` })

/** A reader that answers `newText` for the new side, the old file for the old one. */
const answering =
  (newText: EnsoGitFileText, oldText: EnsoGitFileText = text(OLD)): ReadChangedFile =>
  (change): Promise<ChangedFileOutcome> =>
    Promise.resolve({ kind: 'read', file: { threadId: 't1', ...change, oldText, newText } })

async function mount(readFile: ReadChangedFile): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ThreadChangesView
        outcome={{
          kind: 'read',
          payload: {
            threadId: 't1',
            cwd: '/work/shop-api',
            git: REPOSITORY,
            files: [CONFIG],
            truncated: false,
            copy: null,
          },
        }}
        readFile={readFile}
      />,
    )
  })
  return container
}

const countButton = (container: HTMLElement, words: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('table button')].find((button) =>
    button.textContent?.includes(words),
  )

/** Every row's two line numbers and its text on the old side, in order. */
const rowsOf = (container: HTMLElement): string[][] =>
  [...container.querySelectorAll('tbody tr')]
    .filter((row) => row.querySelectorAll('td').length === 4)
    .map((row) => {
      const cells = [...row.querySelectorAll('td')]
      return [cells[0]?.textContent ?? '', cells[2]?.textContent ?? '', (cells[1]?.textContent ?? '').trim()]
    })

test('clicking `N unchanged lines` shows those lines, numbered on both sides, and the lines after the last hunk too', async () => {
  const container = await mount(answering(text(NEW)))
  await waitUntil(() => countButton(container, '6 unchanged lines') !== undefined)
  const between = countButton(container, '6 unchanged lines')
  expect(between?.getAttribute('aria-expanded')).toBe('false')
  await act(async () => between?.click())
  expect(between?.getAttribute('aria-expanded')).toBe('true')
  const rows = rowsOf(container)
  const opened = rows.slice(
    rows.findIndex((row) => row[0] === '4'),
    rows.findIndex((row) => row[0] === '9') + 1,
  )
  expect(opened).toEqual([
    ['4', '4', 'c'],
    ['5', '5', 'd'],
    ['6', '6', 'e'],
    ['7', '7', 'f'],
    ['8', '8', 'g'],
    ['9', '9', 'h'],
  ])
  // The file reads on past the last hunk: two more lines, counted and opened the same way.
  const after = countButton(container, '2 unchanged lines')
  await act(async () => after?.click())
  expect(rowsOf(container).slice(-2)).toEqual([
    ['13', '13', 'm'],
    ['14', '14', 'n'],
  ])
  // A second click hides them again.
  await act(async () => between?.click())
  expect(rowsOf(container).some((row) => row[2] === 'e')).toBe(false)
})

test('a file too large to send stays unexpandable, and says so', async () => {
  const large: EnsoGitFileText = { kind: 'too-large', bytes: 700 * 1024 }
  const container = await mount(answering(large, large))
  await waitUntil(() => (container.textContent ?? '').includes('too large to expand'))
  expect(countButton(container, 'unchanged lines')).toBeUndefined()
  expect(container.textContent).toContain('6 unchanged lines')
  expect(container.querySelector('[title="the file is 700 KiB, past the most sent to the page"]')).not.toBeNull()
})

test('⚠ a file that changed after its patch was read is never shown under the patch’s numbers', async () => {
  // The agent wrote again between the two reads: line 10 is no longer what the patch shows.
  const moved = NEW.with(9, 'i, edited since')
  const container = await mount(answering(text(moved), text(OLD.with(9, 'i, also edited'))))
  await waitUntil(() => (container.textContent ?? '').includes('changed since this diff'))
  expect(countButton(container, 'unchanged lines')).toBeUndefined()
  // The old side alone agreeing is enough: the unchanged lines are the same on both sides.
  const fromOld = await mount(answering(text(moved)))
  await waitUntil(() => countButton(fromOld, '6 unchanged lines') !== undefined)
  await act(async () => countButton(fromOld, '6 unchanged lines')?.click())
  expect(rowsOf(fromOld).find((row) => row[0] === '6')).toEqual(['6', '6', 'e'])
})

test("a line takes its syntax's theme-token classes once the file is tokenised", async () => {
  // The grammar loads once per process, outside the mounted wait's two seconds.
  await highlightLines('', 'typescript')
  const container = await mount(answering(text(NEW)))
  // `const` is a keyword: the theme's magenta, `text-chart-4`; the comment the muted text.
  await waitUntil(() => container.querySelector('table .text-chart-4') !== null)
  expect(container.querySelector('table .text-chart-4')?.textContent).toBe('const')
  expect(container.querySelector('table .text-muted-foreground:not(td)')).not.toBeNull()
  // The text a reader copies is unchanged.
  expect(rowsOf(container).find((row) => row[0] === '2')?.[2]).toBe('− const alpha = 1')
})
