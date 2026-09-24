import type { EnsoContextRequestDetail, EnsoThreadContext } from '@enso/core'
import type { AgentHost, StoredThreadContext } from '../host/agent-host.ts'
import { liveOrStored } from './live-or-stored.ts'
import type { ThreadRegistry, ThreadView } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/context` (#361): the thread's context, request by request — the
 * Context view reads it. Everything is pi's branch (`branch-context.ts`) and pi's context meter;
 * no log is read, so a thread of any age answers in full. Live or cold as `live-or-stored.ts`
 * reads; looking builds nothing (#86), and writes no record.
 */

export interface ThreadContextRouteDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'readStoredThreadContext' | 'readStoredRequestDetail'>
}

/** A live thread's half, from pi's memory: its meter and its branch walked. */
function liveContext(view: ThreadView): StoredThreadContext {
  return { usage: view.hosted.runtime.sessionUsage(), context: view.hosted.branchContext() }
}

export function createThreadContextRoute(
  deps: ThreadContextRouteDeps,
): (threadId: string) => Promise<EnsoThreadContext | undefined> {
  return async (threadId: string): Promise<EnsoThreadContext | undefined> => {
    const read = await liveOrStored(deps.threads, threadId, liveContext, () =>
      deps.host.readStoredThreadContext(threadId),
    )
    if (read === undefined) return undefined
    const { usage, context, live } = read
    return {
      threadId,
      live,
      usage: usage.context,
      next: context.next,
      requests: context.requests,
      events: context.events,
      files: context.files,
    }
  }
}

/**
 * `GET /api/threads/:threadId/context/:request` (#361 phase 3): one request's context, element by
 * element — a turn's number, or `next`. Read when the Context Browser opens a request, so the
 * trend's read stays small. Undefined — the route's 404 — for a thread held nowhere or a turn
 * its branch does not have.
 */
export function createContextRequestRoute(
  deps: ThreadContextRouteDeps,
): (threadId: string, request: number | 'next') => Promise<EnsoContextRequestDetail | undefined> {
  return async (threadId: string, request: number | 'next'): Promise<EnsoContextRequestDetail | undefined> => {
    const read = await liveOrStored(
      deps.threads,
      threadId,
      (view) => ({ detail: view.hosted.branchRequestDetail(request) }),
      async () => ({ detail: await deps.host.readStoredRequestDetail(threadId, request) }),
    )
    if (read?.detail === undefined) return undefined
    return { threadId, request, ...read.detail }
  }
}
