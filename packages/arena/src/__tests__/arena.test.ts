import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { THREAD_STATUS_WORDS } from '@enso/core'
import { ensoProjectsDir, projectIdOf, projectSnapshotsDir, realpathOrSelf } from '@enso/core/paths'
import {
  type ArenaAction,
  attentionOf,
  createChangeBaseline,
  describeArenaAction,
  dialogForChange,
  LONGEST_WAIT_MS,
  pageForChange,
  parseArenaAction,
  perceptionRefusal,
  questionOf,
  typedSecretRefusal,
  waitForPage,
} from '../actions.ts'
import { collectEnsoEvidence } from '../evidence.ts'
import { type ArenaEvidence, foldArenaManifest } from '../manifest.ts'
import { arenaActCommand, arenaBrief, arenaReviewBrief, githubRepositoryOf, SNAKE_SCENARIO } from '../scenario.ts'
import { type ArenaClock, type ArenaEventBody, openTimeline, pagePlace, readTimeline } from '../timeline.ts'

/**
 * Dogfood Arena's own logic (#556): what the agent may send, how the timeline is stamped and read
 * back, what the manifest folds out of it, and how missing Enso evidence is said. The recorder's
 * browser and process half is proven by a live run, not here.
 */

const THREAD = '0f6c1c4e-5a3b-4c55-9d43-6c1f0a8e2b71'

/** A clock one second further on at each event: the k-th event is at 12:00:0k, k seconds into the run. */
function steppingClock(): ArenaClock {
  let tick = 0
  return {
    wallNow: () => new Date(Date.UTC(2026, 9, 1, 12, 0, ++tick)),
    monotonicNow: () => tick * 1000,
  }
}

test('an action is only what a reader of the page could do', () => {
  expect(parseArenaAction({ action: 'click', target: { role: 'button', name: 'send', nth: 1 } })).toEqual({
    ok: true,
    action: { action: 'click', target: { role: 'button', name: 'send', nth: 1 } },
  })
  expect(parseArenaAction({ action: 'fill', target: { placeholder: 'ask' }, text: '' })).toMatchObject({ ok: true })
  expect(parseArenaAction({ action: 'press', key: 'Enter' })).toEqual({
    ok: true,
    action: { action: 'press', key: 'Enter' },
  })
  // No selector, no test id, no script.
  expect(parseArenaAction({ action: 'click', target: { selector: '#send' } })).toMatchObject({ ok: false })
  expect(parseArenaAction({ action: 'evaluate', script: 'fetch("/api/threads")' })).toMatchObject({ ok: false })
  expect(parseArenaAction('click')).toMatchObject({ ok: false })
})

test('every action reads back as one line, and a malformed one says what it takes', () => {
  const lines = [
    { action: 'goto', path: '/' },
    { action: 'hover', target: { text: 'Stats', nth: 2 } },
    { action: 'select', target: { label: 'Mode' }, option: 'default' },
    { action: 'press', key: 'Escape', target: { role: 'dialog' } },
    { action: 'press', key: 'Enter' },
    { action: 'wait', ms: 5 },
    { action: 'note', note: 'friction', trying: 'a', happened: 'b' },
    { action: 'stop', reason: 'done' },
    { action: 'stop' },
    { action: 'reload' },
    { action: 'tabs' },
    { action: 'switch-tab', tab: 1 },
    { action: 'close-tab' },
    { action: 'close-tab', tab: 2 },
    { action: 'click', x: 512.4, y: 300 },
    { action: 'click', x: 10, y: 20, double: true },
    { action: 'click', x: 10, y: 20, button: 'right' },
    { action: 'click', x: 10, y: 20, button: 'right', double: true },
    { action: 'move', x: 643, y: 588 },
    { action: 'scroll', x: 512, y: 400, dy: 600 },
    { action: 'drag', x: 100, y: 200, toX: 300, toY: 200 },
    { action: 'type', text: 'hello' },
  ].map((request) => {
    const parsed = parseArenaAction(request)
    if (!parsed.ok) throw new Error(parsed.error)
    return describeArenaAction(parsed.action, [])
  })
  expect(lines).toEqual([
    'goto /',
    'hover text "Stats" #2',
    'select "default" in label "Mode"',
    'press Escape in dialog',
    'press Enter',
    'wait 5 ms',
    'note friction',
    'stop: done',
    'stop',
    'reload',
    'tabs',
    'switch-tab 1',
    'close-tab',
    'close-tab 2',
    'click at 512,300',
    'double-click at 10,20',
    'right-click at 10,20',
    'double-right-click at 10,20',
    'move to 643,588',
    'scroll 0,600 at 512,400',
    'drag 100,200 to 300,200',
    'type "hello"',
  ])
  for (const malformed of [
    { action: 'fill', target: { label: 'x' } },
    { action: 'select', target: { label: 'x' } },
    { action: 'press' },
    { action: 'press', key: 'Enter', target: 'composer' },
    { action: 'wait', ms: -1 },
    { action: 'click', target: { role: '' } },
    { action: 'switch-tab' },
    { action: 'switch-tab', tab: -1 },
    { action: 'close-tab', tab: 1.5 },
    // A point must be on the 1024×640 view the agent was shown (#680).
    { action: 'click', x: 1100, y: 10 },
    { action: 'click', x: 10 },
    { action: 'move', x: -1, y: 10 },
    { action: 'scroll', x: 10, y: 10 },
    { action: 'drag', x: 10, y: 10, toX: 20 },
    { action: 'type', text: '' },
  ]) {
    expect(parseArenaAction(malformed)).toMatchObject({ ok: false })
  }
})

// ⚠ #680: the two perceptions are compared run against run, so neither may borrow the other's sense:
// a visual agent never gets the tree or a control by name; a tree agent never points at a picture.
test('⚠ each perception refuses the other’s moves, and both keep keys, tabs, waits, notes and the stop', () => {
  const parsed = (request: object): ArenaAction => {
    const result = parseArenaAction(request)
    if (!result.ok) throw new Error(result.error)
    return result.action
  }
  const tree = [
    { action: 'read' },
    { action: 'click', target: { role: 'button', name: 'Start session' } },
    { action: 'fill', target: { label: 'Prompt' }, text: 'x' },
    { action: 'press', key: 'Enter', target: { role: 'textbox' } },
  ].map(parsed)
  const visual = [
    { action: 'click', x: 10, y: 10 },
    { action: 'move', x: 10, y: 10 },
    { action: 'scroll', x: 10, y: 10, dy: 5 },
    { action: 'drag', x: 1, y: 1, toX: 2, toY: 2 },
  ].map(parsed)
  const both = [
    { action: 'type', text: 'x' },
    { action: 'press', key: 'Enter' },
    { action: 'screenshot' },
    { action: 'wait', ms: 5, until: 'attention' },
    { action: 'goto', path: '/' },
    { action: 'tabs' },
    { action: 'note', note: 'friction', trying: 'a', happened: 'b' },
    { action: 'stop' },
  ].map(parsed)
  for (const action of tree) expect(perceptionRefusal(action, 'visual')).toContain('screenshot')
  for (const action of visual) expect(perceptionRefusal(action, 'tree')).toContain('by name')
  for (const action of [...tree, ...both]) expect(perceptionRefusal(action, 'tree')).toBeUndefined()
  for (const action of [...visual, ...both]) expect(perceptionRefusal(action, 'visual')).toBeUndefined()
})

test('typed text that looks like a credential is refused from type as from fill (#680)', () => {
  const secret = 'sk-live-notarealsecret-0123456789'
  const typed = parseArenaAction({ action: 'type', text: `my key is ${secret}` })
  if (!typed.ok) throw new Error(typed.error)
  expect(typedSecretRefusal(typed.action, [secret])).toContain('looks like a credential')
})

test('goto stays on the web origin and off the API', () => {
  expect(parseArenaAction({ action: 'goto', path: '/?thread=abc' })).toEqual({
    ok: true,
    action: { action: 'goto', path: '/?thread=abc' },
  })
  for (const path of [
    '/api/threads',
    '/api',
    '/api?x=1',
    'http://127.0.0.1:5179/api/threads',
    '//evil.example/',
    'debug.html',
    // As the browser reads them, not as typed (PR #562 review): encoded, dot-segment, case and backslash forms.
    '/%61pi/threads',
    '/%2561pi/threads',
    '/x/../api/threads',
    '/./api',
    '/x/%252e%252e/api/threads',
    '/API/threads',
    '/\\evil.example/',
    '/%E0%A4%A',
  ]) {
    expect(parseArenaAction({ action: 'goto', path })).toMatchObject({ ok: false })
  }
})

test('a wait is capped, a note needs what was tried and what happened', () => {
  expect(parseArenaAction({ action: 'wait', ms: 10 * LONGEST_WAIT_MS })).toEqual({
    ok: true,
    action: { action: 'wait', ms: LONGEST_WAIT_MS },
  })
  expect(parseArenaAction({ action: 'note', note: 'wish', trying: 'find the diff' })).toMatchObject({ ok: false })
  expect(parseArenaAction({ action: 'note', note: 'complaint', trying: 'a', happened: 'b' })).toMatchObject({
    ok: false,
  })
  expect(parseArenaAction({ action: 'note', note: 'wish', trying: 'a', happened: 'b', wanted: 'c' })).toEqual({
    ok: true,
    action: { action: 'note', note: 'wish', trying: 'a', happened: 'b', wanted: 'c' },
  })
})

test('a wait until change is parsed, capped and worded as one; any other `until` is refused (#637)', () => {
  expect(parseArenaAction({ action: 'wait', ms: 10 * LONGEST_WAIT_MS, until: 'change' })).toEqual({
    ok: true,
    action: { action: 'wait', ms: LONGEST_WAIT_MS, until: 'change' },
  })
  expect(parseArenaAction({ action: 'wait', ms: 1000, until: 'idle' })).toEqual({
    ok: false,
    error: 'wait "until" takes "change" or "attention"',
  })
  expect(parseArenaAction({ action: 'wait', ms: 1000, until: 'attention' })).toEqual({
    ok: true,
    action: { action: 'wait', ms: 1000, until: 'attention' },
  })
  expect(describeArenaAction({ action: 'wait', ms: 60_000, until: 'change' }, [])).toBe(
    'wait until change, up to 60000 ms',
  )
  expect(describeArenaAction({ action: 'wait', ms: 60_000, until: 'attention' }, [])).toBe(
    'wait until attention, up to 60000 ms',
  )
  expect(describeArenaAction({ action: 'wait', ms: 30_000 }, [])).toBe('wait 30000 ms')
})

// ⚠ #637, measured on a live run: while a permission card waits, the rail's relative age is the only
// thing on the page that moves (now → 6s → 11s … → 1m). A wait that counted it would return at once.
test('⚠ the rail’s ages are not a change; a new control is, and so is an age-shaped name outside the rail', () => {
  // The shape of a live read: the rail's navigation, then the chat with the card.
  const page = (age: string, chat = '  - button "Yes"'): string =>
    `- navigation "threads":\n  - button "waiting on you Write notes.md… ${age}"\n- tabpanel "Chat":\n${chat}`
  for (const age of ['6s', '1m', '3h', '2d']) expect(pageForChange(page(age))).toBe(pageForChange(page('now')))
  expect(pageForChange(page('6s', '  - button "Yes"\n  - button "No"'))).not.toBe(pageForChange(page('6s')))
  // PR #646 review: the same shape outside the rail is the page's words, and its change counts.
  expect(pageForChange(page('6s', '  - button "Snooze 2h"'))).not.toBe(
    pageForChange(page('6s', '  - button "Snooze 1h"')),
  )
})

/** A clock that moves only when the wait sleeps: each outcome's `waitedMs` is exact. */
function sleepingClock(): { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } {
  let at = 0
  return {
    now: () => at,
    sleep: (ms) => {
      at += ms
      return Promise.resolve()
    },
  }
}

test('⚠ a wait until change returns at the first look that differs, and at its limit unchanged (#637)', async () => {
  const looks = ['same', 'same', 'card']
  const changed = await waitForPage({
    until: 'change',
    baseline: 'same',
    look: () => Promise.resolve(looks.shift() ?? 'card'),
    ms: 60_000,
    pollMs: 1000,
    ...sleepingClock(),
  })
  expect(changed).toEqual({ changed: true, waitedMs: 3000 })
  expect(looks).toEqual([])

  // Nothing moves: it waits out the limit exactly, the last sleep cut to fit.
  const unchanged = await waitForPage({
    until: 'change',
    baseline: 'same',
    look: () => Promise.resolve('same'),
    ms: 2500,
    pollMs: 1000,
    ...sleepingClock(),
  })
  expect(unchanged).toEqual({ changed: false, waitedMs: 2500 })
})

// ⚠ PR #646 review proposed, twice, forgetting the page at the agent's move and looking at the wait's
// start instead. A card that appears in between — during the agent's own model call — then becomes
// the baseline, the page holds still, and the wait sits out its limit: the bug #637 fixes.
test('⚠ a card that appears between the agent’s move and its wait is a change; a failed look leaves nothing', async () => {
  let page = 'the page'
  const lastSeen = createChangeBaseline(() => Promise.resolve(page))
  lastSeen.saw('the page')
  page = 'the page, prompt typed'
  await lastSeen.moved()
  page = 'the page, prompt typed, a card' // Enso asks while the agent is still thinking.
  const waited = await waitForPage({
    until: 'change',
    baseline: await lastSeen.baseline(),
    look: () => Promise.resolve(page),
    ms: 60_000,
    pollMs: 1000,
    ...sleepingClock(),
  })
  expect(waited).toEqual({ changed: true, waitedMs: 1000 })

  // A move whose look fails leaves no baseline: the wait starts from the page it finds.
  const failing = createChangeBaseline(() => Promise.reject(new Error('the page closed')))
  failing.saw('stale')
  await failing.moved()
  await expect(failing.baseline()).rejects.toThrow('the page closed')
})

/** A page read with the bar as Enso renders it: the activity word, and the question when one waits. */
const barPage = (activity: string, question = false, chat = '  - paragraph: hello'): string =>
  [
    '- tabpanel "Chat":',
    chat,
    `- contentinfo "${THREAD_STATUS_WORDS.region}":`,
    `  - text: ${activity}`,
    ...(question ? [`  - status: ${THREAD_STATUS_WORDS.questionWaiting}`] : []),
    '  - text: 1 prompt 2 tool calls',
  ].join('\n')

test('the bar says what needs the agent: a question, the run at rest, the server gone, a browser dialog (#648)', () => {
  expect(attentionOf(barPage('running write', true))).toBe('question')
  expect(attentionOf(barPage(THREAD_STATUS_WORDS.idle))).toBe('idle')
  expect(attentionOf(barPage(THREAD_STATUS_WORDS.disconnected))).toBe('disconnected')
  expect(attentionOf(dialogForChange('alert', 'Game over'))).toBe('dialog')
  for (const working of ['working', 'thinking', 'responding', 'running bash']) {
    expect(attentionOf(barPage(working))).toBeUndefined()
  }
  // The words count in the bar only: "idle" said in the chat is the chat's.
  expect(attentionOf(barPage('working', false, '  - text: idle'))).toBeUndefined()
})

/** A wait until attention over these looks, one a second, from `baseline`. */
function attentionWait(baseline: string, looks: readonly string[]): ReturnType<typeof waitForPage> {
  const queue = [...looks]
  return waitForPage({
    until: 'attention',
    baseline,
    look: () => Promise.resolve(queue.length > 1 ? (queue.shift() ?? '') : (queue[0] ?? '')),
    ms: 10_000,
    pollMs: 1000,
    ...sleepingClock(),
  })
}

// ⚠ #648, measured: a change wait sent with its own click returned on Enso merely starting, and the
// agent gave up on it. Attention returns when there is something for the agent — and only then.
test('⚠ a wait until attention passes over Enso working, and returns at the card or the run’s end (#648)', async () => {
  const idle = barPage(THREAD_STATUS_WORDS.idle)
  // Start just clicked: the baseline is idle, the run not begun. Working is no return; the card is.
  expect(
    await attentionWait(idle, [barPage('working'), barPage('running write'), barPage('running write', true)]),
  ).toEqual({
    changed: true,
    waitedMs: 3000,
    attention: 'question',
  })
  // The same `idle` as the baseline returns once Enso has been seen working: the run's end.
  const done = barPage(THREAD_STATUS_WORDS.idle, false, '  - paragraph: the reply')
  expect(await attentionWait(idle, [barPage('responding'), done])).toEqual({
    changed: true,
    waitedMs: 2000,
    attention: 'idle',
  })
  // A state the baseline did not have returns at once, work seen or not.
  expect(await attentionWait(barPage('running bash', true), [barPage(THREAD_STATUS_WORDS.disconnected)])).toMatchObject(
    {
      attention: 'disconnected',
      waitedMs: 1000,
    },
  )
})

// ⚠ Live (#648): after the agent's Yes the baseline still showed the card; the tool ran inside one
// look and the next card came — same `question`, no work seen — and the wait sat out its minute.
test('⚠ the next card after an answer returns; idle changing as the dialog closes does not; a still page waits out the limit (#648)', async () => {
  const firstCard = barPage('running write', true, '  - group: write a.md')
  const nextCard = barPage('running write', true, '  - group: write a.md\n  - group: write b.md')
  expect(await attentionWait(firstCard, [nextCard])).toEqual({ changed: true, waitedMs: 1000, attention: 'question' })
  // Start just clicked: the dialog closes while the thread is still idle — not the run's end.
  const idleDialog = barPage(THREAD_STATUS_WORDS.idle, false, '  - dialog "Start a session"')
  const idleClosed = barPage(THREAD_STATUS_WORDS.idle, false, '  - paragraph: the prompt')
  expect(await attentionWait(idleDialog, [idleClosed])).toEqual({ changed: true, waitedMs: 10_000 })
  expect(await attentionWait(idleDialog, [idleClosed, barPage('working'), firstCard])).toMatchObject({
    attention: 'question',
    waitedMs: 3000,
  })
  // A card nobody answers: the page holds still, and the wait runs to its limit unchanged.
  expect(await attentionWait(firstCard, [firstCard])).toEqual({ changed: false, waitedMs: 10_000 })
  expect(await attentionWait(firstCard, [dialogForChange('confirm', 'Leave?')])).toMatchObject({ attention: 'dialog' })
})

/**
 * A question card as a real page read shows it (`EnsoDialogCard`), copied from an arena transcript:
 * its group named by the question's title, and its first line going on with the dialog's method.
 */
const cardFor = (title: string): string =>
  `  - 'group "Permission Required ${title}"':\n    - text: pi is asking select\n    - button "Yes"`

// ⚠ #693, from two arena runs: after a Yes the next card was on screen before the move's look, so the
// baseline already asked it, the page held still, and the wait sat out its minute behind a question.
test('⚠ a question the agent had not seen before its move returns at once; the one it just answered does not', async () => {
  const asking = (title: string): string => barPage('running bash', true, cardFor(title))
  const holdStill = (page: string, before: string | undefined): ReturnType<typeof waitForPage> =>
    waitForPage({
      until: 'attention',
      baseline: page,
      before,
      look: () => Promise.resolve(page),
      ms: 10_000,
      pollMs: 1000,
      ...sleepingClock(),
    })
  // The agent answered `sort`; the card for `node *` came before the move's look.
  expect(await holdStill(asking('command : node *'), asking('command : sort'))).toEqual({
    changed: true,
    waitedMs: 0,
    attention: 'question',
  })
  // It sent a prompt with no question open, and a card came before the look: new, so at once too.
  expect(await holdStill(asking('command : sort'), barPage('working'))).toMatchObject({
    waitedMs: 0,
    attention: 'question',
  })
  // ⚠ The SAME question still on screen — the card just answered, on its way out — is no return: a
  // second answer to it would be a double approval. The #648 rule stands, and a still page waits out.
  expect(await holdStill(asking('command : sort'), asking('command : sort'))).toEqual({
    changed: false,
    waitedMs: 10_000,
  })
  // With nothing known from before the move (the agent read the page since), the #648 rule stands too.
  expect(await holdStill(asking('command : node *'), undefined)).toEqual({ changed: false, waitedMs: 10_000 })

  // The baseline keeps what the agent saw before each move: its read, then the page each move left.
  let page = asking('command : sort')
  const lastSeen = createChangeBaseline(() => Promise.resolve(page))
  lastSeen.saw(page)
  page = asking('command : node *')
  await lastSeen.moved()
  expect(questionOf(lastSeen.before() ?? '')).toContain('command : sort')
  expect(questionOf(await lastSeen.baseline())).toContain('command : node *')
  lastSeen.saw(page)
  expect(lastSeen.before()).toBeUndefined()
})

test('what the agent typed reaches the timeline redacted', () => {
  const secret = 'sk-live-notarealsecret-0123456789'
  const parsed = parseArenaAction({ action: 'fill', target: { label: 'Prompt' }, text: `use API_KEY=${secret} please` })
  if (!parsed.ok) throw new Error(parsed.error)
  const line = describeArenaAction(parsed.action, [secret])
  expect(line).toStartWith('fill label "Prompt" with ')
  expect(line).not.toContain(secret)
  // A refused `select` is recorded by this line too (PR #562 review): its option is redacted the same way.
  const selected = parseArenaAction({ action: 'select', target: { label: 'Key' }, option: secret })
  if (!selected.ok) throw new Error(selected.error)
  expect(describeArenaAction(selected.action, [secret])).not.toContain(secret)
})

test('text that looks like a credential is never typed into the page', () => {
  const secret = 'notarealsecret-known-value-0123'
  const action = (request: unknown): ArenaAction => {
    const parsed = parseArenaAction(request)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.action
  }
  const target = { label: 'Prompt' }
  expect(typedSecretRefusal(action({ action: 'fill', target, text: `here: ${secret}` }), [secret])).toStartWith(
    'refused',
  )
  expect(
    typedSecretRefusal(action({ action: 'fill', target, text: 'Authorization: Bearer abc.def.ghi' }), []),
  ).toStartWith('refused')
  expect(typedSecretRefusal(action({ action: 'select', target, option: secret }), [secret])).toStartWith('refused')
  expect(typedSecretRefusal(action({ action: 'fill', target, text: 'build a snake game' }), [secret])).toBeUndefined()
  expect(typedSecretRefusal(action({ action: 'click', target }), [secret])).toBeUndefined()
})

test('the page place names the thread its URL names, and only a real thread id', () => {
  expect(pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`)).toEqual({
    url: `http://127.0.0.1:5178/?thread=${THREAD}`,
    threadId: THREAD,
  })
  expect(pagePlace('http://127.0.0.1:5178/?thread=../../etc')).toEqual({
    url: 'http://127.0.0.1:5178/?thread=../../etc',
  })
  expect(pagePlace('about:blank')).toEqual({ url: 'about:blank' })
  expect(pagePlace('not a url')).toEqual({ url: 'not a url' })
})

test('the timeline is stamped, on disk at once, and survives a torn last line', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-timeline-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  timeline.record({ kind: 'run-start', scenario: 'snake', project: '/p' })
  expect(readTimeline(path)).toHaveLength(1)
  timeline.record({ kind: 'navigation' }, pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`))
  appendFileSync(path, '{"kind":"screensh')
  const events = readTimeline(path)
  expect(events.map((event) => event.kind)).toEqual(['run-start', 'navigation'])
  expect(events[1]).toMatchObject({ at: '2026-10-01T12:00:02.000Z', elapsedMs: 2000, page: { threadId: THREAD } })
  expect(readTimeline(join(tmpdir(), 'no-such-timeline.jsonl'))).toEqual([])
})

test('the manifest joins screenshots to threads and keeps the agent’s notes apart from what was observed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-manifest-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`)
  timeline.record({
    kind: 'run-start',
    scenario: 'snake',
    project: '/p',
    ensoBuild: { commit: 'abc123', dirty: true, diffHash: 'f00d' },
  })
  timeline.record({ kind: 'screenshot', cause: 'sample', path: '/s/0.png' }, pagePlace('http://127.0.0.1:5178/'))
  timeline.record(
    { kind: 'action', via: 'control', action: 'click', detail: 'click button "x"', outcome: 'ok', durationMs: 5 },
    inThread,
  )
  timeline.record(
    {
      kind: 'action',
      via: 'control',
      action: 'click',
      detail: 'click button "y"',
      outcome: 'failed',
      error: 'timeout',
      durationMs: 9,
    },
    inThread,
  )
  timeline.record({ kind: 'screenshot', cause: 'action-failed', path: '/s/1.png' }, inThread)
  timeline.record({ kind: 'console-error', text: 'boom' }, inThread)
  timeline.record({ kind: 'enso-exit', exit: '1' })
  timeline.record({ kind: 'trace-chunk', path: '/t/trace-000.zip' })
  timeline.record({ kind: 'recorder-error', during: 'trace chunk', error: 'Must start tracing before stopping' })
  timeline.record(
    { kind: 'note', via: 'control', note: 'wish', trying: 'see the diff', happened: 'no button', wanted: 'a diff tab' },
    inThread,
  )
  timeline.record({
    kind: 'workspace-sample',
    workspaces: [{ path: 'project', files: 1, bytes: 4, fingerprint: 'aa' }],
  })
  timeline.record({ kind: 'run-stop', reason: 'budget: 1 minutes' })

  const manifest = foldArenaManifest({
    runId: 'snake-1',
    events: readTimeline(path),
    evidence: [{ kind: 'stats', status: 'missing', reason: 'down' }],
  })
  expect(manifest).toMatchObject({
    runId: 'snake-1',
    scenario: 'snake',
    project: '/p',
    ensoBuild: { commit: 'abc123', dirty: true, diffHash: 'f00d' },
    filesystem: [
      {
        at: expect.any(String),
        elapsedMs: expect.any(Number),
        workspaces: [{ path: 'project', files: 1, bytes: 4, fingerprint: 'aa' }],
      },
    ],
    stopReason: 'budget: 1 minutes',
    traceChunks: ['/t/trace-000.zip'],
    actions: { total: 2, failed: 1 },
    observed: { consoleErrors: 1, ensoExits: 1, pageErrors: 0 },
    // No agent runner: whoever sent these had a shell, and the manifest says the boundary did not hold.
    driver: { kind: 'control' },
    boundary: { held: false, actionsBy: { agent: 0, control: 3 } },
  })
  expect(manifest.screenshots.map((shot) => [shot.cause, shot.threadId])).toEqual([
    ['sample', undefined],
    ['action-failed', THREAD],
  ])
  expect(manifest.threads).toEqual([
    {
      threadId: THREAD,
      firstSeenAt: '2026-10-01T12:00:03.000Z',
      lastSeenAt: '2026-10-01T12:00:10.000Z',
      screenshots: 1,
      actions: 2,
    },
  ])
  expect(manifest.agentNotes.wish).toEqual([
    {
      at: '2026-10-01T12:00:10.000Z',
      elapsedMs: 10_000,
      trying: 'see the diff',
      happened: 'no button',
      wanted: 'a diff tab',
      threadId: THREAD,
    },
  ])
  expect(manifest.agentNotes.friction).toEqual([])
  // A chunk the recorder failed to write is named, not only absent from `traceChunks`.
  expect(manifest.recorderErrors).toEqual([
    {
      at: '2026-10-01T12:00:09.000Z',
      elapsedMs: 9000,
      during: 'trace chunk',
      error: 'Must start tracing before stopping',
    },
  ])
})

test('every observed signal is counted by its own kind', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'arena-observed-')), 'timeline.jsonl')
  const timeline = openTimeline(path, steppingClock())
  timeline.record({ kind: 'request-failed', request: 'GET /x', failure: 'net::ERR_ABORTED' })
  timeline.record({ kind: 'request-failed', request: 'GET /y', failure: 'net::ERR_FAILED' })
  timeline.record({ kind: 'response-error', request: 'GET /z', status: 404 })
  timeline.record({ kind: 'dialog', dialog: 'confirm', message: 'leave?' })
  timeline.record({ kind: 'page-crash' })
  timeline.record({ kind: 'page-error', text: 'TypeError' })
  timeline.record({ kind: 'console-error', text: 'boom' })
  timeline.record({ kind: 'enso-exit', exit: '1' })
  timeline.record({ kind: 'enso-exit', exit: 'SIGKILL' })
  expect(foldArenaManifest({ runId: 'r', events: readTimeline(path), evidence: [] }).observed).toEqual({
    consoleErrors: 1,
    pageErrors: 1,
    failedRequests: 2,
    httpErrors: 1,
    dialogs: 1,
    pageCrashes: 1,
    ensoExits: 2,
  })
})

test('a run whose recorder died says so', () => {
  expect(foldArenaManifest({ runId: 'r', events: [], evidence: [] })).toMatchObject({
    scenario: 'unknown',
    stopReason: 'not stopped',
  })
})

test('Enso evidence: collected bodies are redacted, everything else is a missing row naming why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-evidence-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const secret = 'sk-live-notarealsecret-0123456789'
  const rows = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence'),
    threadIds: [THREAD],
    home,
    project,
    secretValues: [secret],
    fetchText: (url) => {
      if (url.endsWith('/api/about')) return Promise.reject(new Error('refused'))
      if (url.includes('/events')) return Promise.resolve({ status: 404, text: 'no such thread' })
      return Promise.resolve({ status: 200, text: `{"said":"${secret}"}` })
    },
  })
  const byKind = new Map(rows.map((row) => [row.kind, row]))
  const threads = byKind.get('live threads')
  if (threads?.status !== 'collected') throw new Error('live threads not collected')
  expect(readFileSync(threads.path, 'utf8')).not.toContain(secret)
  expect(byKind.get('about')).toMatchObject({ status: 'missing', reason: expect.stringContaining('refused') })
  expect(byKind.get(`thread ${THREAD} events`)).toMatchObject({
    status: 'missing',
    reason: expect.stringContaining('404'),
  })
  expect(byKind.get('snapshot store')).toMatchObject({ status: 'missing' })
  expect(byKind.get('diff viewer')).toMatchObject({ status: 'missing' })

  // With a thread in the project's snapshot store (#551), the store is collected — as the run's
  // own copy (#607): the row names the copy, never the home.
  const store = projectSnapshotsDir(ensoProjectsDir(home), projectIdOf(realpathOrSelf(project)))
  mkdirSync(join(store, THREAD), { recursive: true })
  const again = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence-2'),
    threadIds: [],
    home,
    project,
    secretValues: [],
    fetchText: () => Promise.resolve({ status: 200, text: '[]' }),
  })
  const copy = join(root, 'evidence-2', 'snapshot-store')
  expect(again.find((row) => row.kind === 'snapshot store')).toEqual({
    kind: 'snapshot store',
    status: 'collected',
    path: copy,
  })
  expect(existsSync(join(copy, THREAD))).toBe(true)
  expect(again.find((row) => row.kind === 'threads')).toMatchObject({ status: 'missing' })
  expect(existsSync(join(root, 'evidence-2', 'stats.json'))).toBe(true)
})

// ⚠ PR #678: the store is copied without cpSync (whose chmod fails on Docker Desktop for git's
// read-only objects). The copy must still be the run's own (#607): a link inside it stays relative,
// where cpSync pointed it at the home's store, and anything that is not a snapshot fails the row.
test('⚠ the snapshot store copy keeps read-only files and relative links, and outlives the home’s store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-store-copy-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const store = projectSnapshotsDir(ensoProjectsDir(home), projectIdOf(realpathOrSelf(project)))
  const objects = join(store, '.objects', 'objects', '19')
  mkdirSync(objects, { recursive: true })
  writeFileSync(join(objects, 'b7ea51'), 'blob')
  chmodSync(join(objects, 'b7ea51'), 0o444)
  mkdirSync(join(store, THREAD), { recursive: true })
  symlinkSync('../.objects/objects/19/b7ea51', join(store, THREAD, 'head'))
  const collect = (directory: string): Promise<ArenaEvidence[]> =>
    collectEnsoEvidence({
      serverOrigin: 'http://enso',
      directory,
      threadIds: [],
      home,
      project,
      secretValues: [],
      serverDown: 'down',
    })

  const copy = join(root, 'evidence', 'snapshot-store')
  expect((await collect(join(root, 'evidence'))).find((row) => row.kind === 'snapshot store')).toMatchObject({
    status: 'collected',
  })
  expect(statSync(join(copy, '.objects', 'objects', '19', 'b7ea51')).mode & 0o777).toBe(0o444)
  expect(readlinkSync(join(copy, THREAD, 'head'))).toBe('../.objects/objects/19/b7ea51')
  chmodSync(join(objects, 'b7ea51'), 0o644)
  rmSync(store, { recursive: true })
  expect(readFileSync(join(copy, THREAD, 'head'), 'utf8')).toBe('blob')

  // Something that is not a snapshot: the copy fails, and the row says so rather than leave a gap.
  mkdirSync(join(store, THREAD), { recursive: true })
  expect(spawnSync('mkfifo', [join(store, THREAD, 'pipe')]).status).toBe(0)
  expect((await collect(join(root, 'evidence-2'))).find((row) => row.kind === 'snapshot store')).toMatchObject({
    status: 'missing',
    reason: expect.stringContaining('is not a file, directory or symlink'),
  })
})

// ⚠ #671, from an arena run: a deleted thread and the fresh thread Enso opens after it filled the
// score with 11 'not collected' rows that said nothing about Enso. Each is now one skipped row — and
// a thread that ran and exists keeps every failing route as a warning row.
test('⚠ a deleted thread and a never-run one are each one skipped row; a stored thread whose routes fail stays missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-evidence-skip-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const deleted = '11111111-1111-4111-8111-111111111111'
  const neverRan = '22222222-2222-4222-8222-222222222222'
  const ranAndBroken = '33333333-3333-4333-8333-333333333333'
  const projectId = projectIdOf(realpathOrSelf(project))
  const asked: string[] = []
  const rows = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence'),
    threadIds: [deleted, neverRan, ranAndBroken],
    home: join(root, 'home'),
    project,
    secretValues: [],
    fetchText: (url) => {
      asked.push(url)
      if (url.endsWith('/api/stored-threads')) {
        return Promise.resolve({
          status: 200,
          text: JSON.stringify([{ threadId: ranAndBroken, projectId, messageCount: 4 }]),
        })
      }
      if (url.includes(deleted)) return Promise.resolve({ status: url.endsWith('/history') ? 410 : 404, text: 'gone' })
      if (url.includes(neverRan) || url.includes(ranAndBroken))
        return Promise.resolve({ status: 404, text: 'no session' })
      return Promise.resolve({ status: 200, text: '{}' })
    },
  })
  const about = (threadId: string): ArenaEvidence[] => rows.filter((row) => row.kind.includes(threadId))
  expect(about(deleted)).toEqual([
    { kind: `thread ${deleted}`, status: 'skipped', reason: expect.stringContaining('deleted during the run') },
  ])
  expect(about(neverRan)).toEqual([
    { kind: `thread ${neverRan}`, status: 'skipped', reason: expect.stringContaining('never ran') },
  ])
  // Stored, so it ran: every route that fails is its own missing row, as before.
  expect(about(ranAndBroken).length).toBeGreaterThan(1)
  expect(about(ranAndBroken).every((row) => row.status === 'missing')).toBe(true)
  // PR #673 review: the probe's answer is the thread's history read — each route is asked once.
  expect(asked.length).toBe(new Set(asked).size)
})

test('the brief carries the assignment verbatim and no internals', () => {
  for (const channel of ['tool', 'command'] as const) {
    const brief = arenaBrief(SNAKE_SCENARIO, channel)
    expect(brief).toContain(SNAKE_SCENARIO.assignment)
    expect(brief).not.toContain('/api')
    expect(brief).not.toContain('5179')
  }
  // The agent runner's brief names its one tool and no command: it has no shell to run one in.
  expect(arenaBrief(SNAKE_SCENARIO, 'tool')).not.toContain('bun run')
  expect(arenaBrief(SNAKE_SCENARIO, 'tool')).toContain('only tool you have')
  expect(arenaBrief(SNAKE_SCENARIO, 'command')).toContain('bun run arena act')
})

test('the boundary holds only when the agent had the one UI tool and every action came through it', () => {
  const fold = (bodies: readonly ArenaEventBody[]): ReturnType<typeof foldArenaManifest> => {
    const path = join(mkdtempSync(join(tmpdir(), 'arena-boundary-')), 'timeline.jsonl')
    const timeline = openTimeline(path, steppingClock())
    for (const body of bodies) timeline.record(body)
    return foldArenaManifest({ runId: 'r', events: readTimeline(path), evidence: [] })
  }
  const agentStart = (tools: readonly string[]): ArenaEventBody => ({
    kind: 'agent-start',
    provider: 'anthropic',
    model: 'm',
    thinking: 'medium',
    tools,
  })
  const read = (via: 'agent' | 'control'): ArenaEventBody => ({
    kind: 'action',
    via,
    action: 'read',
    detail: 'read',
    outcome: 'ok',
    durationMs: 1,
  })

  const held = fold([
    agentStart(['act']),
    read('agent'),
    { kind: 'agent-tool-refused', tool: 'bash' },
    { kind: 'note', via: 'agent', note: 'friction', trying: 'a', happened: 'b' },
    { kind: 'agent-end', reason: 'it stopped the run' },
  ])
  expect(held.boundary).toMatchObject({ held: true, actionsBy: { agent: 2, control: 0 } })
  expect(held.driver).toEqual({
    kind: 'agent',
    provider: 'anthropic',
    model: 'm',
    thinking: 'medium',
    tools: ['act'],
    refusedToolCalls: ['bash'],
    endReason: 'it stopped the run',
  })
  // A tool beyond the UI, an action that came in another way, or no UI tool at all: not held, and why.
  expect(fold([agentStart(['act', 'bash']), read('agent')]).boundary).toMatchObject({
    held: false,
    why: expect.stringContaining('bash'),
  })
  expect(fold([agentStart(['act']), read('agent'), read('control')]).boundary).toMatchObject({
    held: false,
    why: expect.stringContaining('control endpoint'),
  })
  expect(fold([agentStart([])]).boundary).toMatchObject({ held: false })
  // A line written before `via` existed counts as the control endpoint's, never as the agent's.
  const legacy = JSON.parse(JSON.stringify(read('agent'))) as Record<string, unknown>
  delete legacy.via
  expect(fold([agentStart(['act']), legacy as unknown as ArenaEventBody]).boundary.held).toBe(false)
})

test('over the act command the brief runs in three phases, naming the run, its evidence and where bugs go', () => {
  const run = '/runs/snake-2026-10-03T14-00-00Z'
  const brief = arenaBrief(SNAKE_SCENARIO, 'command', {
    act: arenaActCommand('/runs'),
    runDirectory: run,
    repository: 'owner/enso',
  })
  const phases = ['# Phase 1: the assignment', '# Phase 2: review the experience', '# Phase 3: file the bugs']
  const at = phases.map((phase) => brief.indexOf(phase))
  expect(at.every((index) => index >= 0)).toBe(true)
  expect(at).toEqual(at.toSorted((left, right) => left - right))
  expect(brief).toContain(`bun run arena act --out '/runs' '<json>'`)
  expect(brief).toContain(`${run}/manifest.json`)
  expect(brief).toContain(`${run}/review.md`)
  expect(brief).toContain('Your memory of the run is not the evidence')
  // Duplicates are searched before anything is filed, and what is filed says it is unverified (#556).
  expect(brief).toContain('gh issue list --repo owner/enso --state all')
  expect(brief).toContain('not yet verified by a person')
  expect(brief.indexOf('Search first')).toBeLessThan(brief.indexOf('Otherwise open one'))
})

test('the runner gets the assignment alone, and its review is a prompt of its own for afterwards', () => {
  // The runner's agent has no files: a review or a `gh` command in its brief could not be done.
  const tool = arenaBrief(SNAKE_SCENARIO, 'tool', { repository: 'owner/enso' })
  expect(tool).not.toContain('Phase 2')
  expect(tool).not.toContain('gh issue')
  const review = arenaReviewBrief({ runDirectory: '/runs/r', repository: 'owner/enso' }, 'other')
  expect(review).toStartWith('You are reviewing a Dogfood Arena run')
  expect(review).toContain('`/runs/r/brief.md`')
  expect(review).toContain("The agent's notes are its account, not the evidence")
  // On its own the review has no assignment before it, so it numbers its own phases from 1.
  expect(review).toContain('# Phase 1: review the experience')
  expect(review).toContain('# Phase 2: file the bugs')
  expect(review).not.toContain('Phase 3')
})

test('without a run or a repository the review asks for them instead of guessing', () => {
  const review = arenaReviewBrief({}, 'other')
  expect(review).toContain('`<run directory>/review.md`')
  expect(review).toContain('<the Enso repository, owner/name>')
})

test('the repository is read from a GitHub remote, and only from one', () => {
  expect(githubRepositoryOf('https://github.com/dopamine911/zen-harness-foundation\n')).toBe(
    'dopamine911/zen-harness-foundation',
  )
  expect(githubRepositoryOf('https://github.com/o/n.git')).toBe('o/n')
  expect(githubRepositoryOf('git@github.com:o/n.git')).toBe('o/n')
  expect(githubRepositoryOf('https://gitlab.com/o/n.git')).toBeUndefined()
  expect(githubRepositoryOf('/local/path')).toBeUndefined()
})

test('the act command carries a non-default --out, quoted', () => {
  expect(arenaActCommand()).toBe('bun run arena act')
  expect(arenaActCommand('/my runs')).toBe("bun run arena act --out '/my runs'")
  expect(arenaActCommand("/it's")).toBe("bun run arena act --out '/it'\\''s'")
})
