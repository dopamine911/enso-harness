import { expect, test } from 'bun:test'
import type { EnsoGitRepository } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { renderToStaticMarkup } from 'react-dom/server'
import { changesText, GitIndicator, type GitOutcome, readThreadGit, settledToolResults } from '../thread-git.tsx'

/**
 * #453: the status bar's git readout — the pure view in every state git can be in, the read of
 * its route in every way it can go, and the count whose change asks again. The mounted pane's
 * refresh on a settled call is `thread-pane.test.tsx`'s.
 */

const REPOSITORY: EnsoGitRepository = {
  kind: 'repository',
  root: '/work/shop-api',
  head: '0123456789abcdef',
  branch: 'feature-x',
  upstream: 'origin/feature-x',
  baseline: { rule: 'upstream', ref: 'origin/feature-x', commit: 'fedcba9876543210' },
  ahead: 2,
  behind: 1,
  changes: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
  operation: null,
}

const render = (outcome: GitOutcome): string => renderToStaticMarkup(<GitIndicator outcome={outcome} />)
const read = (repository: Partial<EnsoGitRepository>): GitOutcome => ({
  kind: 'read',
  git: { ...REPOSITORY, ...repository },
})

test('a repository reads as its branch, ahead and behind, and its changes; the tooltip names the last push', () => {
  const markup = render(read({}))
  expect(markup).toContain('feature-x')
  expect(markup).toContain('↑2')
  expect(markup).toContain('↓1')
  expect(markup).toContain('1 staged · 2 unstaged · 3 untracked')
  expect(markup).toContain('measured from the last push to origin/feature-x')
  expect(markup).toContain('baseline commit fedcba9')
  expect(markup).toContain('Enso never fetches')
})

test('nothing ahead or behind says nothing; a clean tree says clean', () => {
  const markup = render(read({ ahead: 0, behind: 0, changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } }))
  expect(markup).not.toContain('↑')
  expect(markup).not.toContain('↓')
  expect(markup).toContain('· clean')
})

test('each baseline rule is said as what it means', () => {
  expect(render(read({ baseline: { rule: 'remote-branch', ref: 'origin/x', commit: 'c' } }))).toContain(
    'measured from the last push to origin/x (no upstream is set)',
  )
  expect(render(read({ baseline: { rule: 'remote-default', ref: 'origin/main', commit: 'c' } }))).toContain(
    'never pushed — measured from where it branched off origin/main',
  )
  const head = render(read({ upstream: null, baseline: { rule: 'head', ref: null, commit: 'c' } }))
  expect(head).toContain('no remote to compare with — only uncommitted changes count')
  // No remote ref, so nothing to say about fetching.
  expect(head).not.toContain('never fetches')
  expect(render(read({ head: null, baseline: { rule: 'none', ref: null, commit: null } }))).toContain('no commits yet')
})

test('a detached HEAD names its commit; a stopped operation is said in the refusal colour', () => {
  expect(render(read({ branch: null }))).toContain('detached 0123456')
  const rebasing = render(read({ operation: 'rebase' }))
  expect(rebasing).toContain('<span class="text-refuse">rebasing</span>')
})

test('outside a repository, git unable to answer, a failed read and no answer yet are each said apart', () => {
  expect(render({ kind: 'read', git: { kind: 'not-a-repository' } })).toContain('no git')
  const unavailable = render({ kind: 'read', git: { kind: 'unavailable', reason: 'detected dubious ownership' } })
  expect(unavailable).toContain('git unavailable')
  expect(unavailable).toContain('detected dubious ownership')
  expect(render({ kind: 'failed', problem: '500 boom' })).toContain('git ?')
  expect(render({ kind: 'none' })).toBe('')
})

test('conflicted files come first in the changes', () => {
  expect(changesText({ staged: 0, unstaged: 1, untracked: 0, conflicted: 2 })).toBe('2 conflicted · 1 unstaged')
})

test('the route read: a payload, a thread nothing has run in, a failure in the server words, a schema miss', async () => {
  const answering = (response: Response) => (): Promise<Response> => Promise.resolve(response)
  const payload = { threadId: 't1', cwd: '/work/shop-api', git: REPOSITORY }
  expect(await readThreadGit('t1', answering(Response.json(payload)))).toEqual({ kind: 'read', git: REPOSITORY })
  expect(await readThreadGit('t1', answering(new Response('no', { status: 404 })))).toEqual({ kind: 'none' })
  expect(await readThreadGit('t1', answering(new Response('boom', { status: 500 })))).toEqual({
    kind: 'failed',
    problem: '500 boom',
  })
  expect(await readThreadGit('t1', answering(Response.json({ threadId: 't1' })))).toEqual({
    kind: 'failed',
    problem: "the server's git payload did not match its schema",
  })
})

test('every tool result in the transcript counts as a moment the tree may have moved', () => {
  const messages: UIMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'go' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{}', state: 'input-complete' },
        { type: 'tool-result', toolCallId: 'c1', content: 'ok', state: 'complete' },
        { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}', state: 'input-complete' },
      ],
    },
  ]
  expect(settledToolResults(messages)).toBe(1)
})
