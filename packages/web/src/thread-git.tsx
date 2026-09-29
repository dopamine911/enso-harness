import { type EnsoGitRepository, type EnsoGitState, EnsoThreadGit } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { GitBranchIcon } from 'lucide-react'
import type { FetchLike } from './browser-logging.ts'
import { useReadOnUsage } from './read-on-usage.ts'
import { readSchemaRoute } from './route-read.ts'

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
 * fetches, and the tooltip says so. A thread nothing has run in yet (404) shows nothing; a
 * failed read shows `git ?` with the server's words, never a stale readout.
 */

/** What the bar holds: nothing yet (or a thread nothing has run in), git's state, or why not. */
export type GitOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'read'; readonly git: EnsoGitState }
  | { readonly kind: 'failed'; readonly problem: string }

const NONE: GitOutcome = { kind: 'none' }

/** `GET /api/threads/:threadId/git`, as the bar holds it. */
export async function readThreadGit(threadId: string, fetchImpl: FetchLike): Promise<GitOutcome> {
  const read = await readSchemaRoute(
    `/api/threads/${encodeURIComponent(threadId)}/git`,
    EnsoThreadGit,
    'git',
    fetchImpl,
  )
  if (read.kind === 'absent') return NONE
  return read.kind === 'read' ? { kind: 'read', git: read.payload.git } : read
}

/** Tool results in the transcript — each one a moment the tree may have changed. */
export function settledToolResults(messages: ReadonlyArray<UIMessage>): number {
  let settled = 0
  for (const message of messages) {
    for (const part of message.parts) if (part.type === 'tool-result') settled += 1
  }
  return settled
}

/**
 * The thread's git state, read on mount, whenever `moment` changes (a tool result settled, the run
 * started or ended) and whenever the thread's usage moves (`read-on-usage.ts`).
 */
export function useThreadGit(moment: string): GitOutcome {
  return useReadOnUsage(readThreadGit, NONE, moment)
}

/** Where the baseline came from, in words — the tooltip's first line. */
function baselineText(repository: EnsoGitRepository): string {
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

function RepositoryReadout({ repository }: { readonly repository: EnsoGitRepository }): React.ReactNode {
  const name =
    repository.branch ?? (repository.head === null ? 'no commits' : `detached ${repository.head.slice(0, SHORT_SHA)}`)
  const title = [
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
  const { git } = outcome
  if (git.kind === 'not-a-repository')
    return <span title="this thread's project is not in a git repository">no git</span>
  if (git.kind === 'unavailable') return <span title={`git could not answer: ${git.reason}`}>git unavailable</span>
  return <RepositoryReadout repository={git} />
}
