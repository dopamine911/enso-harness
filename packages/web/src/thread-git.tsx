import { type EnsoGitRepository, EnsoThreadGit } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { GitBranchIcon } from 'lucide-react'
import type { FetchLike } from './browser-logging.ts'
import { TREE_READ_INTERVAL_MS, useReadOnUsage } from './read-on-usage.ts'
import { readThreadRoute, THREAD_READ_NONE, type ThreadReadOutcome } from './route-read.ts'

/**
 * The status bar's git readout (#453): the branch, how far it is ahead of and behind the last
 * push, and the work in the tree — off `GET /api/threads/:threadId/git`, whose tooltip names the
 * baseline and the rule that chose it (`@enso/core` `git-state.ts`).
 *
 * ⚠ READ WHEN THE TREE MAY HAVE MOVED, NEVER ON A TIMER. A tool call settling is when a write, an
 * edit or a `git commit` lands; the run ending is when the last one has. So the read runs on
 * mount, whenever the count of settled tool results or the run flag changes, and when the
 * thread's usage moves (the Stats view's rule, `read-on-usage.ts`) — the page has nothing that
 * says a tool touched the tree, so every settled result asks. Only the latest read is shown.
 *
 * ⚠ SAID AS WHAT IT IS. "Last push" is what this clone last saw of the remote; Enso never
 * fetches, and the tooltip says so. A failed read shows `git ?` with the server's words, never a
 * stale readout.
 *
 * ⚠ A THREAD WITH NOTHING TO READ IS NOT ASKED (#620). The route serves a live session's tree or a
 * stored thread's; a new thread has neither until its session is built (#484), and every read
 * before that was a 404 — three per new thread, each a console error the browser logs on its own.
 * The bar asks once the thread has a live model or messages, and shows nothing until then.
 */

/** What the bar holds: nothing yet (or a thread nothing has run in), git's state, or why not. */
export type GitOutcome = ThreadReadOutcome<EnsoThreadGit>

/** `GET /api/threads/:threadId/git`, as the bar holds it. */
export const readThreadGit = (threadId: string, fetchImpl: FetchLike): Promise<GitOutcome> =>
  readThreadRoute(threadId, 'git', EnsoThreadGit, fetchImpl)

/** Tool results in the transcript — each one a moment the tree may have changed. */
export function settledToolResults(messages: ReadonlyArray<UIMessage>): number {
  let settled = 0
  for (const message of messages) {
    for (const part of message.parts) if (part.type === 'tool-result') settled += 1
  }
  return settled
}

/** A thread with nothing the route could serve: nothing is asked, and nothing is shown (#620). */
const readNothing = (): Promise<GitOutcome> => Promise.resolve(THREAD_READ_NONE)

/**
 * The thread's git state, read on mount, whenever `moment` changes (a tool result settled, the run
 * started or ended) and whenever the thread's usage moves (`read-on-usage.ts`) — once `readable`:
 * the thread has a live session or a stored branch. The reader changing re-runs the read, so the
 * first one goes out as the session appears. The re-reads are paced, at most one per
 * `TREE_READ_INTERVAL_MS` with the last of a burst read at the window's end (#739).
 */
export function useThreadGit(moment: string, readable: boolean): GitOutcome {
  return useReadOnUsage(readable ? readThreadGit : readNothing, THREAD_READ_NONE, moment, TREE_READ_INTERVAL_MS)
}

/** Where the baseline came from, in words — the tooltip's first line. */
export function baselineText(repository: EnsoGitRepository): string {
  const { baseline } = repository
  switch (baseline.rule) {
    case 'upstream':
      return `measured from the last push to ${baseline.ref ?? 'the upstream'}`
    case 'remote-branch':
      return `measured from the last push to ${baseline.ref ?? 'the remote'} (no upstream is set)`
    case 'remote-default':
      return `never pushed — measured from where it branched off ${baseline.ref ?? 'the remote'}`
    case 'head':
      return 'no remote to compare with — only uncommitted changes count'
    case 'none':
      return 'no commits yet'
  }
}

/** The operation git stopped in, as the bar says it. */
const OPERATION_WORD: Readonly<Record<NonNullable<EnsoGitRepository['operation']>, string>> = {
  merge: 'merging',
  rebase: 'rebasing',
  'cherry-pick': 'cherry-picking',
  revert: 'reverting',
  bisect: 'bisecting',
}

/** `2 staged · 1 unstaged · 3 untracked`, nonzero parts only; `clean` for a tree with none. */
export function changesText(changes: EnsoGitRepository['changes']): string {
  const parts = [
    [changes.conflicted, 'conflicted'],
    [changes.staged, 'staged'],
    [changes.unstaged, 'unstaged'],
    [changes.untracked, 'untracked'],
  ] as const
  const said = parts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`)
  return said.length === 0 ? 'clean' : said.join(' · ')
}

const SHORT_SHA = 7

/**
 * A thread tree's branch, `enso/<thread id>` (`host/thread-trees.ts` `treeLocation`), as the strip
 * shows it: the id's first block, the way the review's `Worktree · f4b35c4d` does (#417) — the whole
 * uuid took a third of the strip. The full name stays in the tooltip; any other branch is shown whole.
 */
const THREAD_BRANCH = /^(enso\/[0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function RepositoryReadout({ repository }: { readonly repository: EnsoGitRepository }): React.ReactNode {
  const unnamed = repository.head === null ? 'no commits' : `detached ${repository.head.slice(0, SHORT_SHA)}`
  const name = repository.branch === null ? unnamed : (THREAD_BRANCH.exec(repository.branch)?.[1] ?? repository.branch)
  const title = [
    ...(repository.branch === null ? [] : [`branch ${repository.branch}`]),
    baselineText(repository),
    ...(repository.baseline.commit === null
      ? []
      : [`baseline commit ${repository.baseline.commit.slice(0, SHORT_SHA)}`]),
    ...(repository.baseline.ref === null ? [] : ['as this clone last saw the remote — Enso never fetches']),
    `repository ${repository.root}`,
  ].join('\n')
  const operation = repository.operation === null ? null : OPERATION_WORD[repository.operation]
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="text-foreground">{name}</span>
      {repository.ahead === 0 ? null : <span aria-label={`${repository.ahead} ahead`}>↑{repository.ahead}</span>}
      {repository.behind === 0 ? null : <span aria-label={`${repository.behind} behind`}>↓{repository.behind}</span>}
      {operation === null ? null : <span className="text-refuse">{operation}</span>}
      <span>· {changesText(repository.changes)}</span>
    </span>
  )
}

/** Pure view of the readout: nothing until there is something to say. */
export function GitIndicator({ outcome }: { readonly outcome: GitOutcome }): React.ReactNode {
  if (outcome.kind === 'none') return null
  if (outcome.kind === 'failed') return <span title={`git state could not be read: ${outcome.problem}`}>git ?</span>
  const { git } = outcome.payload
  if (git.kind === 'not-a-repository')
    return <span title="this thread's folder is not in a git repository">no git</span>
  if (git.kind === 'unavailable') return <span title={`git could not answer: ${git.reason}`}>git unavailable</span>
  return <RepositoryReadout repository={git} />
}
