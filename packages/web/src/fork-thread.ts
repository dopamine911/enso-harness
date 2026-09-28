import { ENSO_NOTICE_SOURCE, type EnsoForkReceipt, EnsoThreadHistory } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { createContext } from 'react'
import { Check } from 'typebox/value'
import { describeFailedResponse } from './stored-threads.ts'
import { reviveHistoryMessages, type ThreadStores } from './thread-stores.ts'

/**
 * Forking from the page (#433): a user message's fork action and the palette's `/fork` both land
 * here, and the page opens what the fork route answers.
 *
 * ⚠ THE ROUTE TAKES A PI ENTRY ID, AND NOT EVERY MESSAGE ON THE PAGE HAS ONE. A message the page
 * mounted from a history or a snapshot carries its entry's id (`transcript-to-messages.ts`); one
 * this page SENT carries the id the composer minted, and pi's entry id never crosses the live
 * stream. So the entry is read off the thread's stored branch at the moment of the fork — the
 * `/history` read the rail's resume makes, pi's memory for a live thread and the file for a cold
 * one — and the page's message is matched to it: by id when it has the entry's, else by its
 * place among the user messages, and only when the words agree. A message the branch does not
 * hold (a prompt still queued behind a run) is said, never guessed at.
 */

/**
 * Fork at a user message on this pane — `undefined` for the last one (`/fork`). Absent where no
 * page opens what a fork answers (a pane mounted alone): the fork action is not offered there.
 */
export const ForkContext = createContext<((messageId: string | undefined) => void) | undefined>(undefined)

/** The words a user message sent, as its text parts joined — what a fork's prefill is compared by. */
function sentWords(message: UIMessage): string {
  return message.parts.map((part) => (part.type === 'text' ? part.content : '')).join('')
}

/**
 * The pi entry id of the page's user message `messageId` (the last one when `undefined`), read off
 * the stored branch's messages — or `undefined` when the branch does not hold it.
 */
export function forkEntryFor(
  page: readonly UIMessage[],
  messageId: string | undefined,
  branch: readonly UIMessage[],
): string | undefined {
  const pagePrompts = page.filter((message) => message.role === 'user')
  const branchPrompts = branch.filter((message) => message.role === 'user')
  const target = messageId === undefined ? pagePrompts.at(-1) : pagePrompts.find(({ id }) => id === messageId)
  if (target === undefined) return undefined
  if (branchPrompts.some(({ id }) => id === target.id)) return target.id
  const counterpart = branchPrompts[pagePrompts.indexOf(target)]
  return counterpart !== undefined && sentWords(counterpart) === sentWords(target) ? counterpart.id : undefined
}

/**
 * Fork the pane's thread at a user message on `page`: the branch read, the entry found, the fork
 * route asked. Every failure is a notice on this thread, as a refused control's is; the receipt
 * only when the fork exists.
 */
export async function forkFromPage(
  stores: Pick<ThreadStores, 'threadId' | 'fetch' | 'connection' | 'notifications'>,
  page: readonly UIMessage[],
  messageId: string | undefined,
): Promise<EnsoForkReceipt | undefined> {
  const say = (text: string): void =>
    stores.notifications.push(`thread ${stores.threadId}: ${text}`, 'warning', 'run', ENSO_NOTICE_SOURCE)
  let branch: UIMessage[]
  try {
    const response = await stores.fetch(`/api/threads/${encodeURIComponent(stores.threadId)}/history`)
    if (!response.ok) throw new Error(await describeFailedResponse(response))
    const history: unknown = await response.json()
    if (!Check(EnsoThreadHistory, history)) throw new Error("the server's history payload did not match its schema")
    branch = reviveHistoryMessages(history.messages)
  } catch (error) {
    say(`fork: the thread's branch could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const entryId = forkEntryFor(page, messageId, branch)
  if (entryId === undefined) {
    say(
      messageId === undefined
        ? 'fork: there is no prompt on this thread to fork from'
        : 'fork: that prompt is not on the thread’s stored branch yet — fork it once its run has settled',
    )
    return undefined
  }
  return stores.connection.fork(entryId)
}
