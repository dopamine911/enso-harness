import type { ThreadRegistry, ThreadView } from './thread-registry.ts'

/**
 * A thread's answer from pi's memory when it is live, from its file when it is not (#45, #361) —
 * READ THE WAY `thread-read.ts` READS: peek, read the file if not live, re-peek. A thread built
 * during the file's read is answered from memory, which is fresher than the file. Held neither
 * live nor on disk, the answer is `undefined` — a route's 404. Looking builds nothing (#86).
 */
export async function liveOrStored<Source extends object>(
  threads: Pick<ThreadRegistry, 'peek'>,
  threadId: string,
  live: (view: ThreadView) => Source,
  stored: () => Promise<Source | undefined>,
): Promise<(Source & { readonly live: boolean }) | undefined> {
  const fromFile = threads.peek(threadId) === undefined ? await stored() : undefined
  const nowLive = threads.peek(threadId)
  if (nowLive !== undefined) return { ...live(nowLive), live: true }
  return fromFile === undefined ? undefined : { ...fromFile, live: false }
}
