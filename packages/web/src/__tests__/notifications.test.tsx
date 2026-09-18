import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createNotificationsStore,
  NotificationLine,
  type NotificationsStore,
  ThreadNotifications,
} from '../notifications.tsx'
import { ThreadStoresContext } from '../store.ts'
import { clearThreadsForTest, mintThread } from '../thread-stores.ts'

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

test('a notification line renders its message', () => {
  const rendered = renderToStaticMarkup(
    <NotificationLine
      notification={{ id: 1, message: 'Mode set to Plan Mode', notifyType: 'info', origin: 'run', at: new Date(0) }}
    />,
  )
  expect(rendered).toContain('Mode set to Plan Mode')
  expect(rendered).toContain('role="status"')
})

// ⚠ DELETED (#236): "an error notification styles with the destructive token; others stay muted"
// asserted `toContain('text-destructive')` and `toContain('text-muted-foreground')` — Tailwind
// class names, which go red on a token rename that breaks nothing and stay green on any
// behaviour change. What a reader observes of a notification is its message and its role, and
// the test above asserts both. The error/info difference that remains is the colour token and
// which lucide icon renders; neither is behaviour a test can pin without pinning a vendored
// component's markup, so it is deliberately NOT gated. Do not restore a class assertion here.

test("the session block renders nothing while the thread's store is empty, then every line", () => {
  const thread = mintThread()
  const block = (): string =>
    renderToStaticMarkup(
      <ThreadStoresContext.Provider value={thread}>
        <ThreadNotifications />
      </ThreadStoresContext.Provider>,
    )
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
  const rendered = renderToStaticMarkup(
    <ThreadStoresContext.Provider value={second}>
      <ThreadNotifications />
    </ThreadStoresContext.Provider>,
  )
  expect(rendered).toBe('')
})

// ── startup notices fold (#96) ────────────────────────────────────────────────────
// Every thread opened with multi-account's two lines before the user asked anything. They are
// grouped, not dropped (#29's rule), and the tag is the host's — never "before the first
// assistant message", which would swallow a guard refusal.

const STARTUP_ONE = 'pi-multi-account v1.21.0: seamless in-place resume is not available on this Pi build'
const STARTUP_TWO = 'pi-multi-account v1.21.0 loaded (enabled). 1 account(s) in rotation.'

function blockOf(thread: ReturnType<typeof mintThread>): string {
  return renderToStaticMarkup(
    <ThreadStoresContext.Provider value={thread}>
      <ThreadNotifications />
    </ThreadStoresContext.Provider>,
  )
}

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
