import { ENSO_NOTICE_SOURCE, type EnsoForkReceipt, EnsoThreadHistory } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { createContext } from 'react'
import { Check } from 'typebox/value'
import { describeFailedResponse, threadHistoryUrl } from './stored-threads.ts'
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

/** One page of the thread's stored branch (#739) — or why it could not be read. */
async function historyPageOf(
  stores: Pick<ThreadStores, 'threadId' | 'fetch'>,
  before: string | undefined,
): Promise<EnsoThreadHistory | string> {
  try {
    const response = await stores.fetch(threadHistoryUrl(stores.threadId, before))
    if (!response.ok) throw new Error(await describeFailedResponse(response))
    const history: unknown = await response.json()
    if (!Check(EnsoThreadHistory, history)) throw new Error("the server's history payload did not match its schema")
    return history
  } catch (error) {
    return `the thread's branch could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * The thread's stored branch from the message `page` starts at, as messages — or why it could not
 * be read. ⚠ `/history` answers a PAGE (#739), and the match below is by place among the prompts,
 * so the branch must start where the page does: it is read back a page at a time until it holds
 * the page's first message (one mounted from a history carries its entry's id), or holds the
 * branch from its start (a page that minted the thread holds it from its start too).
 */
async function storedBranch(
  stores: Pick<ThreadStores, 'threadId' | 'fetch'>,
  page: readonly UIMessage[],
  before?: string,
  later: readonly UIMessage[] = [],
): Promise<UIMessage[] | string> {
  const history = await historyPageOf(stores, before)
  if (typeof history === 'string') return history
  const branch = [...reviveHistoryMessages(history.messages), ...later]
  const start = branch.findIndex(({ id }) => id === page[0]?.id)
  if (start !== -1) return branch.slice(start)
  const first = branch[0]
  if (history.earlier === undefined || first === undefined) return branch
  return storedBranch(stores, page, first.id, branch)
}

/** The pi entry for `messageId` on the stored branch, or the refusal that says why there is none. */
async function entryOnBranch(
  stores: Pick<ThreadStores, 'threadId' | 'fetch'>,
  page: readonly UIMessage[],
  messageId: string | undefined,
  verb: string,
): Promise<{ entryId: string } | { refusal: string }> {
  const branch = await storedBranch(stores, page)
  if (typeof branch === 'string') return { refusal: `${verb}: ${branch}` }
  const entryId = forkEntryFor(page, messageId, branch)
  if (entryId !== undefined) return { entryId }
  return {
    refusal: page.some((message) => message.role === 'user')
      ? `${verb}: that prompt is not in its place on the thread's stored branch — ${UNMATCHED_PROMPT}`
      : `${verb}: there is no prompt on this thread to ${verb} from`,
  }
}

async function forkOnce(
  stores: Pick<ThreadStores, 'threadId' | 'fetch' | 'connection'>,
  page: readonly UIMessage[],
  messageId: string | undefined,
  say: (text: string) => void,
): Promise<EnsoForkReceipt | undefined> {
  const found = await entryOnBranch(stores, page, messageId, 'fork')
  if ('refusal' in found) {
    say(found.refusal)
    return undefined
  }
  return stores.connection.fork(found.entryId)
}

/**
 * Restore the thread's files to a prompt on this pane (#551): the conversation stays as it is,
 * the tree's current files are kept as a safety snapshot first. Set where a page offers it.
 */
export const RestoreContext = createContext<((messageId: string) => void) | undefined>(undefined)

/** What the restore route answers on success: the restored snapshot and the safety one. */
export interface RestoreReceipt {
  readonly hash: string
  readonly safety: string
}

/** A commit hash as the notice shows it. */
const SHORT_HASH = 7

/** The notice action that undoes the last restore (#565). */
export const UNDO_RESTORE_LABEL = 'Undo last restore'

type RestoreStores = Pick<ThreadStores, 'threadId' | 'fetch' | 'notifications'>

/** A restore route's answer read as its receipt; a refusal or a mis-shaped body throws its words. */
async function restoreReceiptOf(response: Response): Promise<RestoreReceipt> {
  if (!response.ok) throw new Error(await describeFailedResponse(response))
  const receipt: unknown = await response.json()
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    !('hash' in receipt) ||
    !('safety' in receipt) ||
    typeof receipt.hash !== 'string' ||
    typeof receipt.safety !== 'string'
  ) {
    throw new Error("the server's restore receipt did not match its shape")
  }
  return { hash: receipt.hash, safety: receipt.safety }
}

/**
 * The thread's newest restore notice that still offers its undo, per thread (#565): a later
 * restore takes the action off it, since only the newest restore can be undone (PR #561 review).
 */
const offeredUndo = new WeakMap<RestoreStores['notifications'], { readonly line: number; readonly message: string }>()

/**
 * Say a restore — or an undo, which is one — on the thread, with "Undo last restore" on the line
 * (#565): the safety the dialog promised, one press away. Pressed, it undoes THAT restore — the
 * undo names the notice's safety, and the server refuses it once a later restore replaced those
 * files — and a press that did not (refused, or not reached) puts the action back, so the only way
 * to undo is not used up by a press that undid nothing. The notice before loses its undo, and says
 * what became of it: `before` — undone, or replaced by a later restore.
 */
function sayRestored(stores: RestoreStores, receipt: RestoreReceipt, what: string, before: string): void {
  const previous = offeredUndo.get(stores.notifications)
  if (previous !== undefined) stores.notifications.resolveLine(previous.line, `${previous.message} — ${before}`)
  const message = `thread ${stores.threadId}: ${what} ${receipt.hash.slice(0, SHORT_HASH)}; the files before are kept as ${receipt.safety.slice(0, SHORT_HASH)}`
  const action = {
    label: UNDO_RESTORE_LABEL,
    run: (): void => {
      void undoFromPage(stores, receipt.safety).then((undone) => {
        if (undone === undefined) stores.notifications.restoreAction(line, action)
      })
    },
  }
  const line = stores.notifications.pushWithAction({
    message,
    notifyType: 'info',
    origin: 'run',
    source: ENSO_NOTICE_SOURCE,
    action,
  })
  offeredUndo.set(stores.notifications, { line, message })
}

/**
 * Post a restore route of the thread and say how it went: the receipt with its undo, or the
 * refusal's reason as `<action> refused: …`. The receipt only when the files moved.
 */
async function postRestore(
  stores: RestoreStores,
  route: 'restore' | 'restore/undo',
  init: RequestInit,
  said: { readonly done: string; readonly action: string; readonly before: string },
): Promise<RestoreReceipt | undefined> {
  try {
    const receipt = await restoreReceiptOf(
      await stores.fetch(`/api/threads/${encodeURIComponent(stores.threadId)}/${route}`, init),
    )
    sayRestored(stores, receipt, said.done, said.before)
    return receipt
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const line = `thread ${stores.threadId}: ${said.action} refused: ${reason}`
    stores.notifications.push(line, 'warning', 'run', ENSO_NOTICE_SOURCE)
    return undefined
  }
}

/**
 * Restore the pane's thread's files to the snapshot at a user message on `page`: the entry found
 * as a fork finds it, then `POST …/restore`. The outcome — the short hashes, with the undo, or the
 * refusal's reason — is a notice on this thread; the receipt only when the files were restored.
 */
export async function restoreFromPage(
  stores: RestoreStores,
  page: readonly UIMessage[],
  messageId: string,
): Promise<RestoreReceipt | undefined> {
  const found = await entryOnBranch(stores, page, messageId, 'restore')
  if ('refusal' in found) {
    stores.notifications.push(`thread ${stores.threadId}: ${found.refusal}`, 'warning', 'run', ENSO_NOTICE_SOURCE)
    return undefined
  }
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId: found.entryId }),
  }
  return postRestore(stores, 'restore', init, {
    done: 'files restored to',
    action: 'restore',
    before: 'a later restore replaced it',
  })
}

/**
 * Undo the restore that kept `safety` (#565): `POST …/restore/undo { safety }`, said as a restore of
 * its own — undoable in turn. The server refuses it when a later restore replaced those files.
 */
function undoFromPage(stores: RestoreStores, safety: string): Promise<RestoreReceipt | undefined> {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ safety }) }
  return postRestore(stores, 'restore/undo', init, {
    done: 'last restore undone: files back to',
    action: 'undo',
    before: 'undone',
  })
}
