import { afterEach, expect, test } from 'bun:test'
import type { UIMessage } from '@tanstack/ai-client'
import { forkEntryFor, forkFromPage } from '../fork-thread.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'

afterEach(() => clearThreadsForTest())

/**
 * #433: the fork route takes a pi entry id, and a prompt this page sent carries the id the
 * composer minted, not its entry's. `forkEntryFor` finds the entry on the stored branch — the
 * cases where guessing would fork the wrong prompt are the ones pinned.
 */

const prompt = (id: string, content: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', content }] })
const reply = (id: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', content: 'ok' }] })

/** The stored branch: two turns, under pi's entry ids. */
const BRANCH = [prompt('e-u1', 'first'), reply('e-a1'), prompt('e-u2', 'second'), reply('e-a2')]

test('a prompt mounted from the branch forks at its own id; one this page sent, at the entry in its place with the same words', () => {
  // Resumed with turn one, then turn two sent from this page: its id is the composer's.
  const page = [prompt('e-u1', 'first'), reply('e-a1'), prompt('client-7', 'second'), reply('client-8')]
  expect(forkEntryFor(page, 'e-u1', BRANCH)).toBe('e-u1')
  expect(forkEntryFor(page, 'client-7', BRANCH)).toBe('e-u2')
  // `/fork`: the last prompt.
  expect(forkEntryFor(page, undefined, BRANCH)).toBe('e-u2')
})

test('⚠ a prompt the branch does not hold, or holds with other words in its place, is not guessed at', () => {
  // Queued behind a run: on the page, not yet on the branch.
  const queued = [...BRANCH, prompt('client-9', 'third')]
  expect(forkEntryFor(queued, 'client-9', BRANCH)).toBeUndefined()
  expect(forkEntryFor(queued, undefined, BRANCH)).toBeUndefined()
  // The branch's second prompt says something else: the places disagree, so nothing is forked.
  const diverged = [prompt('e-u1', 'first'), reply('e-a1'), prompt('client-7', 'a different second')]
  expect(forkEntryFor(diverged, 'client-7', BRANCH)).toBeUndefined()
  // No prompt at all, and an id that is no prompt.
  expect(forkEntryFor([], undefined, BRANCH)).toBeUndefined()
  expect(forkEntryFor(BRANCH, 'e-a1', BRANCH)).toBeUndefined()
})

// PR #439 review: pi stores a prompt rewritten (`agent-session.js` `prompt`), so a prompt this page
// sent is found only where the rewrite keeps its words — and never on position alone.
test('⚠ a sent prompt pi rewrote is found where the rewrite keeps its words: image notes, a skill', () => {
  const skillBlock =
    '<skill name="tdd" location="/skills/tdd/SKILL.md">\nReferences are relative to /skills/tdd.\n\nred, green\n</skill>'
  const branch = [
    prompt('e-u1', 'look at this\n\n[Image: resized from 4000x3000 to 2000x1500]'),
    reply('e-a1'),
    prompt('e-u2', `${skillBlock}\n\nthe parser`),
    reply('e-a2'),
    prompt('e-u3', skillBlock),
  ]
  const page = [
    prompt('client-1', 'look at this'),
    reply('client-2'),
    prompt('client-3', '/skill:tdd the parser'),
    reply('client-4'),
    prompt('client-5', '/skill:tdd'),
  ]
  expect(forkEntryFor(page, 'client-1', branch)).toBe('e-u1')
  expect(forkEntryFor(page, 'client-3', branch)).toBe('e-u2')
  expect(forkEntryFor(page, 'client-5', branch)).toBe('e-u3')
  // The skill's args are part of what it keeps: other args in that place are another prompt.
  const otherArgs = [...page.slice(0, 2), prompt('client-3', '/skill:tdd the lexer')]
  expect(forkEntryFor(otherArgs, 'client-3', branch)).toBeUndefined()
})

test('⚠ a /command whose stored words are gone is not taken on position: an extension command stores no entry', () => {
  // `/deploy` ran as an extension command — nothing stored — so the branch's second prompt is the
  // page's third. Position alone would fork `/deploy` at "second".
  const page = [prompt('e-u1', 'first'), reply('e-a1'), prompt('client-7', '/deploy'), prompt('client-8', 'second')]
  expect(forkEntryFor(page, 'client-7', BRANCH)).toBeUndefined()
  // A /template pi expanded keeps none of its words either: refused, not guessed.
  const expanded = [prompt('e-u1', 'first'), prompt('e-u2', 'Review the diff for bugs.')]
  expect(forkEntryFor([prompt('e-u1', 'first'), prompt('client-9', '/review')], 'client-9', expanded)).toBeUndefined()
})

// PR #438 review: every fork writes a session and the page opens only the latest receipt — a double
// click left the first fork on disk, unopened.
test('⚠ a second fork press while one is outstanding forks nothing and says so; once it settles, the next press forks', async () => {
  const history = Promise.withResolvers<void>()
  const forkPosts: string[] = []
  const stores = mintThread((input: string, init?: RequestInit) => {
    if (input.endsWith('/history')) {
      return history.promise.then(() =>
        Response.json({
          threadId: 't',
          projectId: 'p',
          messages: BRANCH,
          permissionMode: { mode: 'default', available: [] },
          sessionRisk: { level: 'low', signals: 0 },
        }),
      )
    }
    if (input.endsWith('/fork') && init?.method === 'POST') {
      forkPosts.push(typeof init.body === 'string' ? init.body : '')
      return Promise.resolve(Response.json({ threadId: `fork-${forkPosts.length}`, prefill: 'second' }))
    }
    return Promise.resolve(new Response('not scripted', { status: 404 }))
  })
  const first = forkFromPage(stores, BRANCH, 'e-u2')
  expect(await forkFromPage(stores, BRANCH, 'e-u2')).toBeUndefined()
  expect(stores.notifications.get()).toHaveLength(1)
  history.resolve()
  expect(await first).toEqual({ threadId: 'fork-1', prefill: 'second' })
  expect(await forkFromPage(stores, BRANCH, 'e-u2')).toEqual({ threadId: 'fork-2', prefill: 'second' })
  expect(forkPosts).toEqual(['{"entryId":"e-u2"}', '{"entryId":"e-u2"}'])
})
