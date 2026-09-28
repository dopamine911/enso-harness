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
 * place among the user messages, and only when the words agree as pi stores them (`storedAs`). A
 * message the branch does not hold (a prompt still queued behind a run, one pi stored rewritten
 * past recognising) is said, never guessed at.
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
 * Whether `stored` is how pi stored the page's `sent` words (PR #439 review). pi rewrites a prompt
 * before writing it (`agent-session.js` `prompt`): a converted or resized image appends its notes
 * after a blank line, and `/skill:name args` becomes the skill's block, then the args. Both keep
 * enough of the sent words to be recognised. A `/template` expansion keeps none, and is NOT taken
 * on position alone: a `/`-command pi ran as an extension command stores no entry at all, so the
 * place it seems to hold belongs to the prompt after it.
 */
function storedAs(stored: string, sent: string): boolean {
  if (stored === sent || stored.startsWith(`${sent}\n\n`)) return true
  if (!sent.startsWith(SKILL_COMMAND)) return false
  // pi's own split (`_expandSkillCommand`): the name runs to the first space, the rest is the args.
  const space = sent.indexOf(' ')
  const name = space === -1 ? sent.slice(SKILL_COMMAND.length) : sent.slice(SKILL_COMMAND.length, space)
  const args = space === -1 ? '' : sent.slice(space + 1).trim()
  return stored.startsWith(`<skill name="${name}" `) && (args === '' || stored.includes(`</skill>\n\n${args}`))
}

const SKILL_COMMAND = '/skill:'

/** Why a sent prompt has no entry to fork at, and what finds it — said by the refusal. */
const UNMATCHED_PROMPT =
  'it may still be queued behind a run, or pi stored it rewritten (a /template, an input handler). Once its run has settled, reload the page: a thread reopened from its stored branch forks at any prompt.'

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
  return counterpart !== undefined && storedAs(sentWords(counterpart), sentWords(target)) ? counterpart.id : undefined
}

/** The threads with a fork outstanding — keyed by the pane's stores, so a pane dropped takes its entry. */
const forking = new WeakSet<object>()

/** What a second fork press says while the first is outstanding. */
const FORK_UNDER_WAY = 'fork: a fork of this thread is already under way'

/**
 * Fork the pane's thread at a user message on `page`: the branch read, the entry found, the fork
 * route asked. Every failure is a notice on this thread, as a refused control's is; the receipt
 * only when the fork exists.
 *
 * ⚠ ONE AT A TIME PER THREAD (PR #438 review): every fork writes a new session, and the page opens
 * only the latest receipt — a double click, or `/fork` pressed twice, left the first fork on disk,
 * unopened, an orphan "forked from" row in the rail. A press while one is outstanding is said and
 * dropped, as Continue's second press is.
 */
export async function forkFromPage(
  stores: Pick<ThreadStores, 'threadId' | 'fetch' | 'connection' | 'notifications'>,
  page: readonly UIMessage[],
  messageId: string | undefined,
): Promise<EnsoForkReceipt | undefined> {
  const say = (text: string): void =>
    stores.notifications.push(`thread ${stores.threadId}: ${text}`, 'warning', 'run', ENSO_NOTICE_SOURCE)
  if (forking.has(stores)) {
    say(FORK_UNDER_WAY)
    return undefined
  }
  forking.add(stores)
  try {
    return await forkOnce(stores, page, messageId, say)
  } finally {
    forking.delete(stores)
  }
}

async function forkOnce(
  stores: Pick<ThreadStores, 'threadId' | 'fetch' | 'connection'>,
  page: readonly UIMessage[],
  messageId: string | undefined,
  say: (text: string) => void,
): Promise<EnsoForkReceipt | undefined> {
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
      page.some((message) => message.role === 'user')
        ? `fork: that prompt is not in its place on the thread's stored branch — ${UNMATCHED_PROMPT}`
        : 'fork: there is no prompt on this thread to fork from',
    )
    return undefined
  }
  return stores.connection.fork(entryId)
}
