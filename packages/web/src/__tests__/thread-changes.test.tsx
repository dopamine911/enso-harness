import { expect, test } from 'bun:test'
import type { EnsoGitFileChange, EnsoGitRepository } from '@enso/core'
import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadStoresContext } from '../store.ts'
import {
  type ChangesOutcome,
  DiffFocusContext,
  readThreadChanges,
  ThreadChanges,
  ThreadChangesView,
} from '../thread-changes.tsx'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'

/**
 * #452: the Diff view as a static render — every state said as what it is, the tree, and the
 * first file's diff side by side. Choosing a file, folding a directory and the refresh on a settled
 * call are the mounted pane's (`thread-pane.test.tsx`).
 */

const CHANGES_REPOSITORY: EnsoGitRepository = {
  kind: 'repository',
  root: '/work/shop-api',
  scope: '',
  head: 'f00d',
  branch: 'feature-x',
  upstream: 'origin/feature-x',
  baseline: { rule: 'upstream', ref: 'origin/feature-x', commit: 'beef' },
  ahead: 1,
  behind: 0,
  changes: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 },
  operation: null,
}

const APP_CHANGE: EnsoGitFileChange = {
  path: 'src/app.ts',
  oldPath: null,
  status: 'modified',
  added: 1,
  removed: 1,
  patch: ['diff --git a/src/app.ts b/src/app.ts', '@@ -1,2 +1,2 @@', ' keep', '-before', '+after', ''].join('\n'),
  omitted: null,
}

const LOGO: EnsoGitFileChange = {
  path: 'assets/logo.png',
  oldPath: null,
  status: 'added',
  added: null,
  removed: null,
  patch: null,
  omitted: 'binary',
}

const render = (outcome: ChangesOutcome): string => renderToStaticMarkup(<ThreadChangesView outcome={outcome} />)
const read = (files: EnsoGitFileChange[], truncated = false): ChangesOutcome => ({
  kind: 'read',
  payload: { threadId: 't1', cwd: '/work/shop-api', git: CHANGES_REPOSITORY, files, truncated, copy: null },
})

test('the tree lists every changed file, and the first in it is shown side by side', () => {
  const markup = render(read([APP_CHANGE, LOGO]))
  expect(markup).toContain('measured from the last push to origin/feature-x')
  expect(markup).toContain('2 files')
  // The tree: directories first — `assets/` before `src/` — so the logo is the first file shown.
  expect(markup.indexOf('assets')).toBeLessThan(markup.indexOf('src'))
  expect(markup).toContain('changes to assets/logo.png')
  expect(markup).toContain('A binary file: there are no lines to compare.')
})

test("a file's diff: the removed line on the left beside the added one on the right", () => {
  const markup = render(read([APP_CHANGE]))
  expect(markup).toContain('changes to src/app.ts')
  expect(markup).toMatch(/bg-refuse\/15[^>]*>.*before/s)
  expect(markup).toMatch(/bg-ok\/15[^>]*>.*after/s)
  expect(markup.indexOf('before')).toBeLessThan(markup.indexOf('after'))
})

// ── #920: the file a tool card's "open in Diff" asks for ─────────────────────────────────────

const changed = (path: string): EnsoGitFileChange => ({ ...APP_CHANGE, path })

/** The file the Diff view shows when a card asks for `path`. */
function shownFor(outcome: ChangesOutcome, path: string): string | undefined {
  const markup = renderToStaticMarkup(
    <DiffFocusContext.Provider value={{ path }}>
      <ThreadChangesView outcome={outcome} />
    </DiffFocusContext.Provider>,
  )
  return /aria-label="changes to ([^"]+)"/.exec(markup)?.[1]
}

test('#920: the file a call named wins over a deeper file of the same name — the tree lists the deeper first', () => {
  const outcome = read([changed('packages/web/package.json'), changed('package.json')])
  expect(shownFor(outcome, 'package.json')).toBe('package.json')
  expect(shownFor(outcome, './package.json')).toBe('package.json')
  expect(shownFor(outcome, 'packages/web/package.json')).toBe('packages/web/package.json')
  expect(shownFor(outcome, '/work/shop-api/package.json')).toBe('package.json')
  expect(shownFor(outcome, '/work/shop-api/packages/web/package.json')).toBe('packages/web/package.json')
})

test("#920: a relative path is the thread's folder's — a repository scoped below its top, and a copy's tree", () => {
  const files = [changed('packages/web/package.json'), changed('packages/package.json')]
  const scoped: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/work/shop-api/packages',
      git: { ...CHANGES_REPOSITORY, scope: 'packages/' },
      files,
      truncated: false,
      copy: null,
    },
  }
  expect(shownFor(scoped, 'package.json')).toBe('packages/package.json')
  expect(shownFor(scoped, 'web/package.json')).toBe('packages/web/package.json')
  const copied: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/enso/projects/p/trees/t1',
      git: { kind: 'not-a-repository' },
      files: [changed('src/web/app.ts'), changed('src/app.ts')],
      truncated: false,
      copy: { project: '/work/shop-api', base: 'a'.repeat(40) },
    },
  }
  expect(shownFor(copied, 'src/app.ts')).toBe('src/app.ts')
  expect(shownFor(copied, '/enso/projects/p/trees/t1/src/app.ts')).toBe('src/app.ts')
})

test('#920: a path outside the known root falls back to the longest file it ends in; none, the first file', () => {
  const outcome = read([changed('packages/web/package.json'), changed('package.json')])
  // The repository reached through a symlink: its absolute path never starts with the root.
  expect(shownFor(outcome, '/home/me/shop/packages/web/package.json')).toBe('packages/web/package.json')
  expect(shownFor(outcome, '/home/me/shop/package.json')).toBe('package.json')
  expect(shownFor(outcome, 'nowhere.md')).toBe('packages/web/package.json')
})

test("#920: a path pi reads as home or a file URL can't be placed here — the longest file it ends in", () => {
  // `assets/` is first in the tree: a lookup that names nothing opens it instead.
  const outcome = read([LOGO, changed('docs/a.md')])
  expect(shownFor(outcome, '~/work/shop-api/docs/a.md')).toBe('docs/a.md')
  expect(shownFor(outcome, 'file:///work/shop-api/docs/a.md')).toBe('docs/a.md')
})

test("#920: an `@` before a path is pi's mention mark, dropped as pi drops it — the path then places cleanly", () => {
  const outcome = read([LOGO, changed('docs/a.md')])
  expect(shownFor(outcome, '@docs/a.md')).toBe('docs/a.md')
  expect(shownFor(outcome, '@/work/shop-api/docs/a.md')).toBe('docs/a.md')
})

test('#920: a relative path through `..` is not placed — the longest file it ends in, though it lands under the root', () => {
  const scoped: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/work/shop-api/packages',
      git: { ...CHANGES_REPOSITORY, scope: 'packages/' },
      files: [changed('packages/assets/logo.png'), changed('packages/package.json')],
      truncated: false,
      copy: null,
    },
  }
  expect(shownFor(scoped, '../packages/package.json')).toBe('packages/package.json')
})

test('#920: a path placed cleanly under the root names that file or none — never a same-named file elsewhere', () => {
  // The named file is missing from the list (truncated, or written back to its baseline): Diff
  // opens the first file in the tree, not a deeper file that merely ends the same way.
  const top = read([changed('packages/web/package.json'), changed('docs/a.md')], true)
  expect(shownFor(top, 'package.json')).toBe('docs/a.md')
  expect(shownFor(top, '/work/shop-api/package.json')).toBe('docs/a.md')
  const scoped: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/work/shop-api/packages',
      git: { ...CHANGES_REPOSITORY, scope: 'packages/' },
      files: [changed('package.json'), changed('src/app.ts')],
      truncated: true,
      copy: null,
    },
  }
  // `web/package.json` here is `packages/web/package.json`, not listed: the root one is a different file.
  expect(shownFor(scoped, 'web/package.json')).toBe('src/app.ts')
  expect(shownFor(scoped, '/work/shop-api/packages/web/package.json')).toBe('src/app.ts')
})

// ── #847: what a screen reader is given of the diff ─────────────────────────────────────────

/** The diff's table in a render, parsed into a throwaway DOM (no globals, as `static-markup.ts`). */
function diffTableIn(markup: string): Element {
  const window = new Window({ url: 'http://localhost/' })
  window.document.body.innerHTML = markup
  const table = (window.document as unknown as Document).querySelector('table')
  if (table === null) throw new Error('the render draws no diff table')
  return table
}

/** What a reader is given of a node: its text less what is `aria-hidden`, after its `aria-label`. */
function heard(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== node.ELEMENT_NODE) return ''
  const element = node as Element
  if (element.getAttribute('aria-hidden') === 'true') return ''
  const content = [...element.childNodes].map(heard).join('')
  const label = element.getAttribute('aria-label')
  return label === null ? content : `${label} ${content}`
}

/** Every cell a reader reaches, by its name (its heard text), in reading order. */
const cellNames = (table: Element): string[] =>
  [...table.querySelectorAll('td')]
    .filter((cell) => cell.getAttribute('aria-hidden') !== 'true')
    .map((cell) => heard(cell).trim())

const timesHeard = (table: Element, phrase: string): number => heard(table).split(phrase).length - 1

const NEW_LINES = Array.from({ length: 12 }, (_, lineIndex) => `<p>paragraph ${lineIndex + 1}</p>`)

const NEW_PAGE: EnsoGitFileChange = {
  path: 'index.html',
  oldPath: null,
  status: 'added',
  added: NEW_LINES.length,
  removed: 0,
  patch: ['diff --git a/index.html b/index.html', '@@ -0,0 +1,12 @@', ...NEW_LINES.map((text) => `+${text}`), ''].join(
    '\n',
  ),
  omitted: null,
}

test('#847: an added file reads as its lines once, its missing old side said once for the file', () => {
  const table = diffTableIn(render(read([NEW_PAGE])))
  expect(timesHeard(table, 'the old side has no lines: every line here is added')).toBe(1)
  expect(timesHeard(table, 'no line on this side')).toBe(0)
  // Every line reachable as a cell by its text, each once: its number, then the line — no marker per line.
  expect(cellNames(table)).toEqual([
    '@@ -0,0 +1,12 @@',
    ...NEW_LINES.flatMap((text, lineIndex) => [String(lineIndex + 1), text]),
  ])
})

test('#847: a deleted file says once that its new side has no lines', () => {
  const deleted: EnsoGitFileChange = {
    ...NEW_PAGE,
    status: 'deleted',
    added: 0,
    removed: 2,
    patch: ['diff --git a/index.html b/index.html', '@@ -1,2 +0,0 @@', '-<h1>gone</h1>', '-<p>also gone</p>', ''].join(
      '\n',
    ),
  }
  const table = diffTableIn(render(read([deleted])))
  expect(timesHeard(table, 'the new side has no lines: every line here is removed')).toBe(1)
  expect(cellNames(table)).toEqual(['@@ -1,2 +0,0 @@', '1', '<h1>gone</h1>', '2', '<p>also gone</p>'])
})

test('#847: in a file with both sides, each changed line says whether it was removed or added', () => {
  const grown: EnsoGitFileChange = {
    ...APP_CHANGE,
    added: 2,
    patch: ['diff --git a/src/app.ts b/src/app.ts', '@@ -1,2 +1,3 @@', ' keep', '-before', '+after', '+more', ''].join(
      '\n',
    ),
  }
  const table = diffTableIn(render(read([grown])))
  expect(table.getAttribute('aria-label')).toBeNull()
  expect(cellNames(table)).toEqual([
    '@@ -1,2 +1,3 @@',
    '1',
    'keep',
    '1',
    'keep',
    '2',
    '− before',
    '2',
    '+ after',
    '3',
    '+ more',
  ])
})

// ⚠ #847: with `diff.context = 0` git writes no context lines, so a plain insertion into an existing file is
// all `+` lines, and its header can be exactly a new file's: `@@ -0,0 +1 @@` at the top of the file.
test('#847: an insertion git diffed without context is not read as a one-sided file; an added file still is', () => {
  const insertion = (header: string): EnsoGitFileChange => ({
    ...APP_CHANGE,
    removed: 0,
    patch: ['diff --git a/src/app.ts b/src/app.ts', header, '+NEW', ''].join('\n'),
  })
  for (const header of ['@@ -2,0 +3 @@', '@@ -0,0 +1 @@']) {
    const table = diffTableIn(render(read([insertion(header)])))
    expect(table.getAttribute('aria-label')).toBeNull()
    expect(cellNames(table)).toContain('+ NEW')
  }
  const created = diffTableIn(render(read([{ ...insertion('@@ -0,0 +1 @@'), status: 'added' }])))
  expect(timesHeard(created, 'the old side has no lines: every line here is added')).toBe(1)
  expect(cellNames(created)).toContain('NEW')
})

test('#847: what a sighted reader sees is unchanged — a shaded empty cell beside every added line', () => {
  const table = diffTableIn(render(read([NEW_PAGE])))
  const empty = [...table.querySelectorAll('td')].filter((cell) => cell.childNodes.length === 0)
  expect(empty).toHaveLength(NEW_LINES.length)
  for (const cell of empty) {
    expect(cell.getAttribute('colspan')).toBe('2')
    expect(cell.className).toBe('bg-muted/40')
  }
  // The `+` still stands before every line on screen.
  const lineCells = [...table.querySelectorAll('td')].filter((cell) => cell.className.includes('whitespace-pre-wrap'))
  expect(lineCells.map((cell) => cell.textContent)).toEqual(NEW_LINES.map((text) => `+ ${text}`))
})

test('a rename names both paths; too many files says so; nothing changed says so', () => {
  const renamed = render(read([{ ...APP_CHANGE, status: 'renamed', oldPath: 'src/old.ts' }]))
  expect(renamed).toContain('src/old.ts → src/app.ts')
  expect(render(read([APP_CHANGE], true))).toContain('More files differ than are shown here')
  expect(render(read([]))).toContain('Nothing differs: the tree matches the baseline.')
})

test('outside a repository, git unable to answer, a failed read and no answer yet are each said apart', () => {
  const outside: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/tmp',
      git: { kind: 'not-a-repository' },
      files: [],
      truncated: false,
      copy: null,
    },
  }
  // #650: the cwd is what git was asked about — never claimed of the project, which may be a repository.
  expect(render(outside)).toContain('folder is not in a git repository, so there is nothing to compare with.')
  expect(render(outside)).not.toContain('project is not')
  const unavailable: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/tmp',
      git: { kind: 'unavailable', reason: 'fatal: bad object' },
      files: [],
      truncated: false,
      copy: null,
    },
  }
  expect(render(unavailable)).toContain('git could not answer: fatal: bad object')
  expect(render({ kind: 'failed', problem: '500 boom' })).toContain('could not be read: 500 boom')
  expect(render({ kind: 'none' })).toContain('Nothing has run in this thread yet.')
})

// ⚠ #657, from an arena run: the tab said "Nothing has run in this thread yet" until its first read
// came back, and an agent that looked at once was told so on a thread that had run. A static render
// runs no effect, so it shows exactly what the tab shows before any answer.
test('⚠ the Diff tab says it is reading until its first answer, never that nothing has run', () => {
  const stores = mintThread(() => new Promise<Response>(() => undefined))
  try {
    const first = renderToStaticMarkup(
      <ThreadStoresContext.Provider value={stores}>
        <ThreadChanges moment="" />
      </ThreadStoresContext.Provider>,
    )
    expect(first).toContain('reading the changes…')
    expect(first).not.toContain('Nothing has run')
  } finally {
    clearThreadsForTest()
  }
})

// #650: a project with no commit yet runs in a copy, which has no `.git`; its changes come from its store.
test("a copy's files show in the same tree and diff, under a header naming the project's copy — no baseline, no branch", () => {
  const copied: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/enso/projects/p/trees/t1',
      git: { kind: 'not-a-repository' },
      files: [APP_CHANGE, { ...APP_CHANGE, path: 'src/new.ts', status: 'added' }],
      truncated: false,
      copy: { project: '/work/shop-api', base: 'a'.repeat(40) },
    },
  }
  const markup = render(copied)
  expect(markup).toContain('copy of shop-api since the copy was made')
  expect(markup).toContain('2 files')
  expect(markup).toContain('changes to src/app.ts')
  expect(markup).toMatch(/bg-ok\/15[^>]*>.*after/s)
  expect(markup).not.toContain('not in a git repository')
  expect(markup).not.toContain('measured from')
  const unchanged: ChangesOutcome = { ...copied, payload: { ...copied.payload, files: [] } }
  expect(render(unchanged)).toContain('Nothing differs: the copy matches the project as it was copied.')
})

test('the route read: a payload, a thread nothing has run in, and a schema miss', async () => {
  const answering = (response: Response) => (): Promise<Response> => Promise.resolve(response)
  const payload = {
    threadId: 't1',
    cwd: '/work',
    git: CHANGES_REPOSITORY,
    files: [APP_CHANGE],
    truncated: false,
    copy: null,
  }
  expect(await readThreadChanges('t1', answering(Response.json(payload)))).toEqual({ kind: 'read', payload })
  expect(await readThreadChanges('t1', answering(new Response('no', { status: 404 })))).toEqual({ kind: 'none' })
  expect(await readThreadChanges('t1', answering(Response.json({ threadId: 't1' })))).toEqual({
    kind: 'failed',
    problem: "the server's changes payload did not match its schema",
  })
})
