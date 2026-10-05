import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createNotificationsStore,
  NotificationLine,
  NotificationLines,
  type NotificationsStore,
  placeLines,
} from '../notifications.tsx'
import { ThreadStoresContext } from '../store.ts'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'

/**
 * #29's browser half: notify messages become visible transcript lines. One store per
 * thread (#90 PR 3): the store contract is tested on a fresh instance, and the block is
 * rendered inside a minted thread's context, the way a pane provides it.
 */

let store: NotificationsStore
beforeEach(() => {
  store = createNotificationsStore()
})
afterEach(() => clearThreadsForTest())

test('a pushed notification appears in the snapshot, in order', () => {
  store.push('first', 'info', 'run')
  store.push('second', undefined, 'run')
  const snapshot = store.get()
  expect(snapshot.map((notification) => notification.message)).toEqual(['first', 'second'])
  expect(snapshot[1]?.notifyType).toBeUndefined()
})

test('subscribers are told about a push, and unsubscribe stops that', () => {
  let notified = 0
  const unsubscribe = store.subscribe(() => {
    notified += 1
  })
  store.push('a', 'info', 'run')
  expect(notified).toBe(1)
  unsubscribe()
  store.push('b', 'info', 'run')
  expect(notified).toBe(1)
})

// ⚠ Notify is unbounded input (any extension, any volume) — the store must degrade to
// "the newest lines", never an ever-growing render list.
test('the store keeps only the newest 100, dropping the oldest', () => {
  for (let sequence = 1; sequence <= 105; sequence++) {
    store.push(`n${sequence}`, undefined, 'run')
  }
  const snapshot = store.get()
  expect(snapshot.length).toBe(100)
  expect(snapshot[0]?.message).toBe('n6')
  expect(snapshot.at(-1)?.message).toBe('n105')
})

// ⚠ #382: a line follows the message it happened after. The stream's message wins over the
// rendered transcript's last (React lags the stream), the transcript's last stands in when the
// stream names none, and a startup notice is never anchored — it precedes every run.
test('⚠ a line anchors to the stream’s message, else the transcript’s last; a startup notice to neither', () => {
  let streaming: string | undefined
  const anchored = createNotificationsStore(() => streaming)
  anchored.push('before anything', 'info', 'run')
  anchored.setTranscriptTail('stored-reply')
  anchored.push('after the stored reply', 'info', 'run')
  streaming = 'live-bubble'
  anchored.push('mid-run', 'error', 'run')
  anchored.push('replayed startup notice', 'error', 'session-start')
  expect(anchored.get().map(({ message, after }) => [message, after])).toEqual([
    ['before anything', undefined],
    ['after the stored reply', 'stored-reply'],
    ['mid-run', 'live-bubble'],
    ['replayed startup notice', undefined],
  ])
})

test('placed lines: unanchored head the transcript, anchored follow their message, an anchor gone falls to the tail — each in arrival order', () => {
  let current: string | undefined
  const placed = createNotificationsStore(() => current)
  placed.push('h1', 'info', 'run')
  current = 'm1'
  placed.push('a1', 'info', 'run')
  current = 'gone'
  placed.push('t1', 'info', 'run')
  current = 'm1'
  placed.push('a2', 'info', 'run')
  placed.push('h2', 'info', 'session-start')
  const { head, after, tail } = placeLines(placed.get(), new Set(['m1', 'm2']))
  const messages = (lines: readonly { message: string }[] | undefined): string[] =>
    (lines ?? []).map(({ message }) => message)
  expect(messages(head)).toEqual(['h1', 'h2'])
  expect(messages(after.get('m1'))).toEqual(['a1', 'a2'])
  expect(after.has('m2')).toBe(false)
  expect(messages(tail)).toEqual(['t1'])
})

test('a notification line renders its message', () => {
  const rendered = renderToStaticMarkup(
    <NotificationLine
      notification={{
        id: 1,
        message: 'Mode set to Plan Mode',
        notifyType: 'info',
        origin: 'run',
        at: new Date(0),
        after: undefined,
      }}
    />,
  )
  expect(rendered).toContain('Mode set to Plan Mode')
  expect(rendered).toContain('role="status"')
})

// #387: who acted leads the line, so a reader knows what fixes it; a line with no source reads as
// it always did.
test('a line’s source leads its message; a line without one has no label', () => {
  const line = (source?: string): string =>
    renderToStaticMarkup(
      <NotificationLine
        notification={{
          id: 1,
          message: 'no recoverable account',
          notifyType: 'warning',
          origin: 'run',
          source,
          at: new Date(0),
          after: undefined,
        }}
      />,
    ).replace(/<[^>]*>/g, '')
  expect(line('pi-multi-account')).toBe('pi-multi-account · no recoverable account')
  expect(line()).toBe('no recoverable account')
})

// ⚠ DELETED (#236): "an error notification styles with the destructive token; others stay muted"
// asserted `toContain('text-destructive')` and `toContain('text-muted-foreground')` — Tailwind
// class names, which go red on a token rename that breaks nothing and stay green on any
// behaviour change. What a reader observes of a notification is its message and its role, and
// the test above asserts both. The error/info difference that remains is the colour token and
// which lucide icon renders; neither is behaviour a test can pin without pinning a vendored
// component's markup, so it is deliberately NOT gated. Do not restore a class assertion here.

/** A minted thread's head block: with no message and no stream yet, every line is there. */
function blockOf(thread: ThreadStores): string {
  return renderToStaticMarkup(
    <ThreadStoresContext.Provider value={thread}>
      <NotificationLines lines={placeLines(thread.notifications.get(), new Set()).head} />
    </ThreadStoresContext.Provider>,
  )
}

test("the session block renders nothing while the thread's store is empty, then every line", () => {
  const thread = mintThread()
  const block = (): string => blockOf(thread)
  expect(block()).toBe('')
  thread.notifications.push('one', 'info', 'run')
  thread.notifications.push('two', 'warning', 'run')
  const rendered = block()
  expect(rendered).toContain('one')
  expect(rendered).toContain('two')
})

// ⚠ THE REASON STORES ARE PER THREAD. A line pushed into one thread must not render in
// another's transcript — before #90 PR 3 there was one list per page and it would have.
test("⚠ a notification belongs to its thread: another thread's block does not show it", () => {
  const first = mintThread()
  const second = mintThread()
  first.notifications.push('only in the first', 'info', 'run')
  expect(blockOf(second)).toBe('')
})

// ── startup notices fold (#96) ────────────────────────────────────────────────────
// Every thread opened with multi-account's two lines before the user asked anything. They are
// grouped, not dropped (#29's rule), and the tag is the host's — never "before the first
// assistant message", which would swallow a guard refusal.

const STARTUP_ONE = 'pi-multi-account v1.21.0: seamless in-place resume is not available on this Pi build'
const STARTUP_TWO = 'pi-multi-account v1.21.0 loaded (enabled). 1 account(s) in rotation.'

test('⚠ session-start info notices render as ONE collapsed line; the notices are inside it verbatim, not open', () => {
  const thread = mintThread()
  thread.notifications.push(STARTUP_ONE, 'info', 'session-start')
  thread.notifications.push(STARTUP_TWO, undefined, 'session-start')
  const rendered = blockOf(thread)
  expect(rendered.match(/<details/g)).toHaveLength(1)
  expect(rendered).not.toContain('<details open')
  expect(rendered).toContain('2 startup notices from extensions')
  expect(rendered).toContain(STARTUP_ONE)
  expect(rendered).toContain(STARTUP_TWO)
  // Both lines are behind the summary: nothing renders as an open status line.
  expect(rendered.match(/role="status"/g)).toHaveLength(2)
  expect(rendered.indexOf('<summary')).toBeLessThan(rendered.indexOf(STARTUP_ONE))
  // The singular reads as one line too — a lone notice is still startup chatter.
  const lone = mintThread()
  lone.notifications.push(STARTUP_TWO, 'info', 'session-start')
  expect(blockOf(lone)).toContain('1 startup notice from extensions')
})

test('⚠ a warning or error from session_start stays OPEN, outside the fold: a failed extension is not noise', () => {
  const thread = mintThread()
  thread.notifications.push(STARTUP_ONE, 'info', 'session-start')
  thread.notifications.push('extension X failed to load', 'error', 'session-start')
  thread.notifications.push('token expires soon', 'warning', 'session-start')
  const rendered = blockOf(thread)
  expect(rendered).toContain('1 startup notice from extensions')
  const detailsEnd = rendered.indexOf('</details>')
  expect(rendered.indexOf('extension X failed to load')).toBeGreaterThan(detailsEnd)
  expect(rendered.indexOf('token expires soon')).toBeGreaterThan(detailsEnd)
})

test("a run's notice renders as it always did — open, no fold — even when it is the first thing in the thread", () => {
  const thread = mintThread()
  thread.notifications.push('bash: `env` is refused (#89)', 'info', 'run')
  const rendered = blockOf(thread)
  expect(rendered).not.toContain('<details')
  expect(rendered).toContain('bash: `env` is refused (#89)')
  expect(rendered).toContain('role="status"')
})

test('the fold sits at the head of the block; run notices follow it in order', () => {
  const thread = mintThread()
  thread.notifications.push(STARTUP_ONE, 'info', 'session-start')
  thread.notifications.push('Mode: default', 'info', 'run')
  thread.notifications.push('later', 'info', 'run')
  const rendered = blockOf(thread)
  const fold = rendered.indexOf('</details>')
  expect(fold).toBeGreaterThan(-1)
  expect(rendered.indexOf('Mode: default')).toBeGreaterThan(fold)
  expect(rendered.indexOf('later')).toBeGreaterThan(rendered.indexOf('Mode: default'))
})

// #388: a login URL in a line was plain text — unclickable, and one 500-character token that
// pushed the transcript sideways. A URL is a link to the WHOLE address, read as its host and path;
// the sentence keeps its own period; nothing but http(s) becomes an href.
test('a URL in a line links the whole address, reads as host and path, and leaves the sentence its period', () => {
  const rendered = renderToStaticMarkup(
    <NotificationLine
      notification={{
        id: 1,
        message:
          'To log in to Faux, open https://auth.faux.invalid/oauth/authorize?client_id=a&state=b. Or file:///etc/x',
        notifyType: 'info',
        origin: 'run',
        at: new Date(0),
        after: undefined,
      }}
    />,
  )
  expect(rendered).toContain('href="https://auth.faux.invalid/oauth/authorize?client_id=a&amp;state=b"')
  expect(rendered).toContain('>auth.faux.invalid/oauth/authorize…</a>.')
  expect(rendered).toContain('target="_blank"')
  expect(rendered).not.toContain('href="file:')
})
