import { expect, test } from 'bun:test'
import type { EnsoGitFileChange, EnsoGitRepository } from '@enso/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { type ChangesOutcome, readThreadChanges, ThreadChangesView } from '../thread-changes.tsx'

/**
 * #452: the Changes view as a static render — every state said as what it is, the tree, and the
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
  payload: { threadId: 't1', cwd: '/work/shop-api', git: CHANGES_REPOSITORY, files, truncated },
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

test('a rename names both paths; too many files says so; nothing changed says so', () => {
  const renamed = render(read([{ ...APP_CHANGE, status: 'renamed', oldPath: 'src/old.ts' }]))
  expect(renamed).toContain('src/old.ts → src/app.ts')
  expect(render(read([APP_CHANGE], true))).toContain('More files differ than are shown here')
  expect(render(read([]))).toContain('Nothing differs: the tree matches the baseline.')
})

test('outside a repository, git unable to answer, a failed read and no answer yet are each said apart', () => {
  const outside: ChangesOutcome = {
    kind: 'read',
    payload: { threadId: 't1', cwd: '/tmp', git: { kind: 'not-a-repository' }, files: [], truncated: false },
  }
  expect(render(outside)).toContain('not in a git repository')
  const unavailable: ChangesOutcome = {
    kind: 'read',
    payload: {
      threadId: 't1',
      cwd: '/tmp',
      git: { kind: 'unavailable', reason: 'fatal: bad object' },
      files: [],
      truncated: false,
    },
  }
  expect(render(unavailable)).toContain('git could not answer: fatal: bad object')
  expect(render({ kind: 'failed', problem: '500 boom' })).toContain('could not be read: 500 boom')
  expect(render({ kind: 'none' })).toContain('Nothing has run in this thread yet.')
})

test('the route read: a payload, a thread nothing has run in, and a schema miss', async () => {
  const answering = (response: Response) => (): Promise<Response> => Promise.resolve(response)
  const payload = { threadId: 't1', cwd: '/work', git: CHANGES_REPOSITORY, files: [APP_CHANGE], truncated: false }
  expect(await readThreadChanges('t1', answering(Response.json(payload)))).toEqual({ kind: 'read', payload })
  expect(await readThreadChanges('t1', answering(new Response('no', { status: 404 })))).toEqual({ kind: 'none' })
  expect(await readThreadChanges('t1', answering(Response.json({ threadId: 't1' })))).toEqual({
    kind: 'failed',
    problem: "the server's changes payload did not match its schema",
  })
})
