import type { EnsoInterruptedTail, EnsoModelState, EnsoOpenDialog, EnsoPermissionModeState } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import type { AgentHost } from '../host/agent-host.ts'
import type { ThreadRegistry } from './thread-registry.ts'
import { interruptedTail, transcriptToMessages } from './transcript-to-messages.ts'

/**
 * THE LIVE-OR-COLD READ, ONCE (#214).
 *
 * What the server holds for one thread, as a pane mounts it: the branch as messages, whether it
 * is live, and the mode it opens in. `GET …/follow`'s snapshot and `GET …/history`'s payload
 * are the same question asked by two routes; they were implemented twice and had drifted apart
 * in two visible ways. The follow re-peeked the registry after the awaited cold read and the
 * history route did not, so a thread built DURING the read was served the FILE's messages and
 * the FILE's permission mode by `/history`, while the follow opened a tick later reported the
 * same thread live with pi's own branch and the session's own mode. That is the shape invariant
 * 5 refuses — a surface presenting one state while the server holds another — with no MISMATCH
 * to name it, because each side is internally consistent. It is on the boot path: boot adopts a
 * named thread from `/history` before showing a pane, so another tab or `enso-thread` prompting
 * the same id during that fetch is enough.
 *
 * ⚠ THE RE-PEEK IS THE POINT, and it is why the cold read is awaited BEFORE anything is
 * decided: a thread that went live during the read is then read from pi's memory, which is
 * fresher than the file and resumable. Deciding any field from the PRE-await peek is the
 * bug this file exists to have exactly one copy of.
 *
 * The two routes differ in one thing, and it is a contract rather than drift: for an id the
 * server holds neither live nor on disk, `/history` is a 404 while a follow is an EMPTY
 * snapshot — observation may precede the first prompt, and must, or the prompt's opening
 * events have no follower. `present` is that difference, and the only branch a caller takes.
 *
 * The cost, stated: `/history` asks for `busy`, `generation` and `openDialogs` it does not
 * send. One read of a live runtime's open questions is cheaper than two shapes of this
 * answer — two shapes is what drifted.
 *
 * Named for what it produces rather than #214's suggested `readThreadView`: `ThreadView` is
 * already the registry's word for a live entry, and this is the answer a pane mounts with,
 * live or cold.
 */

export interface ThreadReadDeps {
  readonly threads: ThreadRegistry
  readonly host: AgentHost
}

/** One thread as of this read: what a pane mounts with, and what the follow's snapshot says. */
export interface ThreadMount {
  /** Does the server hold this id at all — a live thread or a file? `false` is `/history`'s 404. */
  readonly present: boolean
  /** The branch as the messages a chat mounts with: pi's memory when live, the file when cold. */
  readonly messages: UIMessage[]
  /** Set only when the branch ends inside a turn (#109). */
  readonly interrupted: EnsoInterruptedTail | undefined
  readonly live: boolean
  readonly busy: boolean
  readonly generation: number
  /** The live session's own mode, or the one this branch persists. */
  readonly permissionMode: EnsoPermissionModeState
  /** The live session's model and thinking level (#338 slice 2); `null` when not live — a file does not say what pi would run. */
  readonly model: EnsoModelState | null
  /** Every question pi is blocked on, oldest first (#114); empty when the thread is not live. */
  readonly openDialogs: EnsoOpenDialog[]
  /** The tree pi runs this thread in (#44): the live session's own, or the one this host builds every session in. */
  readonly cwd: string
}

export async function readThreadMount(deps: ThreadReadDeps, threadId: string): Promise<ThreadMount> {
  const { threads, host } = deps
  const live = threads.peek(threadId)
  /** The file, read only for a thread that is not live here — nothing is built to answer (#86). */
  const stored = live === undefined ? await host.readTranscript(threadId) : undefined
  const nowLive = threads.peek(threadId)
  const inspection = nowLive?.hosted.inspect()
  const transcript = inspection === undefined ? (stored ?? []) : inspection.entries
  const messages = transcriptToMessages(transcript)
  return {
    present: nowLive !== undefined || stored !== undefined,
    messages,
    // The ENTRIES, not the messages this function just mapped (#220): a transcript's last
    // entry can be a tool result or a custom entry, and asking the mapped messages answers
    // about the last MESSAGE instead. The merge that brought #220 here left this call reading
    // the wrong one.
    interrupted: interruptedTail(transcript),
    live: nowLive !== undefined,
    busy: nowLive?.busy ?? false,
    generation: nowLive?.generation ?? 0,
    permissionMode:
      nowLive === undefined ? host.storedPermissionMode(transcript) : nowLive.hosted.runtime.permissionModeState(),
    model: nowLive === undefined ? null : nowLive.hosted.runtime.modelState(),
    openDialogs: nowLive === undefined ? [] : nowLive.hosted.runtime.openDialogs(),
    cwd: inspection?.cwd ?? host.cwd,
  }
}
