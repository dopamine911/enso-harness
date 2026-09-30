import type { EnsoGitFileChange, EnsoGitRepository, EnsoGitState, EnsoThreadChanges, EnsoThreadGit } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/git` (#453): git's state in the thread's cwd — the repository, the
 * branch, the last-push baseline and the work not yet pushed (`@enso/core/git`). And
 * `GET /api/threads/:threadId/changes` (#452): that state, with every file that differs from the
 * baseline and its patch — what the Diff view draws. Read when asked: the working tree moves
 * under a run, so nothing is cached, and nothing is recorded.
 *
 * The cwd comes from pi's memory for a live thread and from the session file's header otherwise.
 * Looking builds nothing (#86). A stored thread whose project this server no longer serves is no
 * answer: git is never run in a directory the server does not serve.
 */

export interface ThreadGitRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'storedThreadDirectory'>
  /** The server's projects rule (#395): a directory git may be run in. */
  readonly servesDirectory: (directory: string) => boolean
  /** `readGitState` over the real git runner; a test hands in its own. */
  readonly readGit: (cwd: string) => Promise<EnsoGitState>
}

export interface ThreadChangesRouteDeps extends ThreadGitRouteDeps {
  /** `readGitChanges` over the real git runner; a test hands in its own. */
  readonly readChanges: (repository: EnsoGitRepository) => Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>
}

/** The thread's cwd, when git may be run there: live or stored, and in a directory this server serves. */
async function servedCwd(deps: ThreadGitRouteDeps, threadId: string): Promise<string | undefined> {
  const cwd = deps.threads.peek(threadId)?.hosted.inspect().cwd ?? (await deps.host.storedThreadDirectory(threadId))
  return cwd !== undefined && deps.servesDirectory(cwd) ? cwd : undefined
}

export function createThreadGitRoute(
  deps: ThreadGitRouteDeps,
): (threadId: string) => Promise<EnsoThreadGit | undefined> {
  return async (threadId: string): Promise<EnsoThreadGit | undefined> => {
    const cwd = await servedCwd(deps, threadId)
    return cwd === undefined ? undefined : { threadId, cwd, git: await deps.readGit(cwd) }
  }
}

/**
 * A diff git could not produce after naming the repository reads as git unavailable, with its
 * reason — never as a tree with nothing changed.
 */
export function createThreadChangesRoute(
  deps: ThreadChangesRouteDeps,
): (threadId: string) => Promise<EnsoThreadChanges | undefined> {
  return async (threadId: string): Promise<EnsoThreadChanges | undefined> => {
    const cwd = await servedCwd(deps, threadId)
    if (cwd === undefined) return undefined
    const git = await deps.readGit(cwd)
    if (git.kind !== 'repository') return { threadId, cwd, git, files: [], truncated: false }
    try {
      return { threadId, cwd, git, ...(await deps.readChanges(git)) }
    } catch (error) {
      const reason = error instanceof Error && error.message !== '' ? error.message : 'git could not diff the tree'
      return { threadId, cwd, git: { kind: 'unavailable', reason }, files: [], truncated: false }
    }
  }
}
