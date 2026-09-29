import type { EnsoGitState, EnsoThreadGit } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/git` (#453): git's state in the thread's cwd — the repository, the
 * branch, the last-push baseline and the work not yet pushed (`@enso/core/git`). Read when asked:
 * the working tree moves under a run, so nothing is cached, and nothing is recorded.
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

export function createThreadGitRoute(
  deps: ThreadGitRouteDeps,
): (threadId: string) => Promise<EnsoThreadGit | undefined> {
  return async (threadId: string): Promise<EnsoThreadGit | undefined> => {
    const cwd = deps.threads.peek(threadId)?.hosted.inspect().cwd ?? (await deps.host.storedThreadDirectory(threadId))
    if (cwd === undefined || !deps.servesDirectory(cwd)) return undefined
    return { threadId, cwd, git: await deps.readGit(cwd) }
  }
}
