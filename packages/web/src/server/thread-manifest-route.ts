import type { EnsoForkPoint } from '@enso/core'
import type { AgentHost } from '../host/agent-host.ts'
import { liveOrStored } from './live-or-stored.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/manifest` (#435): the thread's fork point — its identity, then the
 * conditions it runs under (recorded model and level, mode, cwd, the latest `enso-run-context`) —
 * off the branch the host walks (`host/fork-point.ts`). Live or cold as `live-or-stored.ts` reads;
 * looking builds nothing (#86), and writes no record.
 */

export interface ThreadManifestRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'readStoredForkPoint'>
}

export function createThreadManifestRoute(
  deps: ThreadManifestRouteDeps,
): (threadId: string) => Promise<EnsoForkPoint | undefined> {
  return async (threadId: string): Promise<EnsoForkPoint | undefined> => {
    // Both halves are promises the host settles; `liveOrStored` only chooses which one to await.
    const read = await liveOrStored(
      deps.threads,
      threadId,
      (view) => ({ point: view.hosted.forkPoint() }),
      async () => {
        const point = await deps.host.readStoredForkPoint(threadId)
        return point === undefined ? undefined : { point: Promise.resolve(point) }
      },
    )
    return read === undefined ? undefined : await read.point
  }
}
