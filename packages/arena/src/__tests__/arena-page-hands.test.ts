import { expect, test } from 'bun:test'
import { EnsoThreadStatusEvent } from '@enso/core'
import { ARENA_VIEW, type ArenaAction, type ArenaStatusLog, createStatusLog } from '../actions.ts'
import {
  type ArenaDialog,
  type ArenaEyes,
  type ArenaFront,
  type ArenaHandPage,
  type ArenaLocator,
  type ArenaRunHands,
  type ArenaTab,
  type ArenaWaiting,
  createDialogWaiters,
  forTheEyes,
  performOnControl,
  performOnPage,
  performOnRun,
  performOnTabs,
  performWait,
  performWithPointer,
  READABLE,
  shownAfter,
} from '../page-hands.ts'
import type { ArenaEventBody, ArenaPagePlace } from '../timeline.ts'

/**
 * The page's hands (#838): what each kind of action does to the tab in front — which control it
 * finds, which Playwright call it makes with which options and timeout, what it answers, and what
 * it refuses. The page, its dialog and the camera are stand-ins that write every call to one log,
 * so the order is what is checked. What a click does to Enso is proven by a live run.
 */

const SECRET = 'sk-live-notarealsecret-0123456789'
const redact = (text: string): string => text.replaceAll(SECRET, '[redacted]')
const PLACE: ArenaPagePlace = { url: 'http://127.0.0.1:5178/?thread=t1', threadId: 't1' }
/** The view's scale (#680): a view pixel is this many window pixels. */
const SCALE = ARENA_VIEW.scale

const json = (value: unknown): string => JSON.stringify(value)

/** A page whose every call is a line in `calls`; a locator's line names how it was found. */
function fakePage(calls: string[], fail: ReadonlySet<string> = new Set()): ArenaHandPage {
  const act = (line: string): Promise<void> => {
    calls.push(line)
    return fail.has(line) ? Promise.reject(new Error(`${line} timed out`)) : Promise.resolve()
  }
  const names = new WeakMap<ArenaLocator, string>()
  const locator = (name: string): ArenaLocator => {
    const found: ArenaLocator = {
      and: (other) => locator(`${name}.and(${names.get(other) ?? '?'})`),
      nth: (index) => locator(`${name}.nth(${index})`),
      click: (options) => act(`${name}.click(${json(options)})`),
      hover: (options) => act(`${name}.hover(${json(options)})`),
      fill: (value, options) => act(`${name}.fill(${value}, ${json(options)})`),
      selectOption: (value, options) => act(`${name}.selectOption(${value}, ${json(options)})`),
      press: (key, options) => act(`${name}.press(${key}, ${json(options)})`),
    }
    names.set(found, name)
    return found
  }
  return {
    getByRole: (role, options) => locator(`role ${role} ${json(options)}`),
    getByText: (text, options) => locator(`text ${text} ${json(options)}`),
    getByLabel: (text, options) => locator(`label ${text} ${json(options)}`),
    getByPlaceholder: (text, options) => locator(`placeholder ${text} ${json(options)}`),
    locator: (selector) => locator(selector === READABLE ? 'readable' : `locator ${selector}`),
    keyboard: {
      press: (key) => act(`keyboard.press ${key}`),
      type: (text) => act(`keyboard.type ${text}`),
    },
    mouse: {
      click: (left, top, options) => act(`mouse.click ${left},${top} ${json(options)}`),
      move: (left, top, options) => act(`mouse.move ${left},${top}${options === undefined ? '' : ` ${json(options)}`}`),
      down: () => act('mouse.down'),
      up: () => act('mouse.up'),
      wheel: (deltaX, deltaY) => act(`mouse.wheel ${deltaX},${deltaY}`),
    },
    goto: (url, options) => act(`goto ${url} ${json(options)}`),
    goBack: (options) => act(`goBack ${json(options)}`),
    reload: (options) => act(`reload ${json(options)}`),
    waitForTimeout: (ms) => act(`waitForTimeout ${ms}`),
  }
}

/** A native dialog whose answers are lines in `calls`. */
function fakeDialog(calls: string[], message = 'Leave the page?'): ArenaDialog {
  return {
    type: () => 'confirm',
    message: () => message,
    accept: (promptText) => {
      calls.push(`dialog.accept ${promptText ?? '(no text)'}`)
      return Promise.resolve()
    },
    dismiss: () => {
      calls.push('dialog.dismiss')
      return Promise.resolve()
    },
  }
}

interface FakeFront {
  readonly front: ArenaFront
  readonly calls: string[]
}

/** The tab in front over stand-ins: tab 0, no dialog, a camera that answers with a file. */
function fakeFront(
  options: {
    readonly dialog?: ArenaDialog
    readonly tab?: number
    readonly shot?: string
    readonly fail?: ReadonlySet<string>
    readonly calls?: string[]
  } = {},
): FakeFront {
  const calls = options.calls ?? []
  const page = fakePage(calls, options.fail)
  let dialog = options.dialog
  const front: ArenaFront = {
    page: () => page,
    here: () => PLACE,
    tab: () => options.tab ?? 0,
    dialog: () => dialog,
    forgetDialog: () => {
      calls.push('forget dialog')
      dialog = undefined
    },
    nextDialog: (tab) => {
      calls.push(`wait for a dialog over tab ${tab}`)
      return {
        opened: Promise.withResolvers<'dialog'>().promise,
        release: () => calls.push(`stop waiting over tab ${tab}`),
      }
    },
    shoot: (cause) => {
      calls.push(`shoot ${cause}`)
      return Promise.resolve(options.shot)
    },
    redact,
  }
  return { front, calls }
}

// ── A tree agent's hands: a control named the way a reader names it ──────────────────────────────

test('a control is found the way the agent named it and acted on with the action’s own timeout', async () => {
  const cases: ReadonlyArray<readonly [ArenaAction & Parameters<typeof performOnControl>[0], string]> = [
    [
      { action: 'click', target: { role: 'button', name: 'Send' } },
      'role button {"name":"Send","exact":false}.click({"timeout":15000})',
    ],
    [{ action: 'hover', target: { role: 'link' } }, 'role link {"exact":false}.hover({"timeout":15000})'],
    [
      { action: 'fill', target: { placeholder: 'ask pi something', exact: true, nth: 1 }, text: 'hello' },
      'placeholder ask pi something {"exact":true}.and(readable).nth(1).fill(hello, {"timeout":15000})',
    ],
    [
      { action: 'select', target: { label: 'Model' }, option: 'opus' },
      'label Model {"exact":false}.and(readable).selectOption(opus, {"timeout":15000})',
    ],
    [
      { action: 'press', target: { text: 'Send' }, key: 'Enter' },
      'text Send {"exact":false}.and(readable).press(Enter, {"timeout":15000})',
    ],
  ]
  for (const [action, line] of cases) {
    const { front, calls } = fakeFront()
    expect(await performOnControl(action, front)).toEqual(PLACE)
    expect(calls).toEqual([line])
  }
})

test('a text, label or placeholder target is only what the agent can read; a role leaves the hidden out by itself', async () => {
  const { front, calls } = fakeFront()
  await performOnControl({ action: 'click', target: { text: 'Start', nth: 0 } }, front)
  await performOnControl({ action: 'click', target: { role: 'button', name: 'Start', exact: true, nth: 2 } }, front)
  expect(calls).toEqual([
    'text Start {"exact":false}.and(readable).nth(0).click({"timeout":15000})',
    'role button {"name":"Start","exact":true}.nth(2).click({"timeout":15000})',
  ])
})

test('a press with no target is the keyboard on whatever has focus', async () => {
  const { front, calls } = fakeFront()
  expect(await performOnControl({ action: 'press', key: 'Escape' }, front)).toEqual(PLACE)
  expect(calls).toEqual(['keyboard.press Escape'])
})

test('a control action that came without a target is refused before the page is touched', async () => {
  const { front, calls } = fakeFront()
  const untargeted = JSON.parse('{"action":"hover"}') as Parameters<typeof performOnControl>[0]
  await expect(performOnControl(untargeted, front)).rejects.toThrow('hover needs a target')
  expect(calls).toEqual([])
})

test('a control that never answers fails the action with Playwright’s error', async () => {
  const line = 'role button {"name":"Gone","exact":false}.click({"timeout":15000})'
  const { front } = fakeFront({ fail: new Set([line]) })
  await expect(performOnControl({ action: 'click', target: { role: 'button', name: 'Gone' } }, front)).rejects.toThrow(
    `${line} timed out`,
  )
})

// ── A visual agent's hands: a point of the view it saw (#680) ────────────────────────────────────

/** A pointer that names every point `button "Send"`, and the record of what was pointed at. */
function fakePointer(calls: string[]): Parameters<typeof performWithPointer>[2] {
  return {
    under: (point) => {
      calls.push(`under ${point.left},${point.top}`)
      return Promise.resolve('button "Send"')
    },
    pointed: (under) => calls.push(`pointed at ${under}`),
  }
}

test('a click at a view point is the mouse at the window point it maps to, named before it clicks (#680)', async () => {
  const { front, calls } = fakeFront()
  expect(await performWithPointer({ action: 'click', at: { left: 512, top: 320 } }, front, fakePointer(calls))).toEqual(
    PLACE,
  )
  await performWithPointer(
    { action: 'click', at: { left: 10, top: 20 }, button: 'right', double: true },
    front,
    fakePointer(calls),
  )
  expect(calls).toEqual([
    `under ${512 * SCALE},${320 * SCALE}`,
    'pointed at button "Send"',
    `mouse.click ${512 * SCALE},${320 * SCALE} {"button":"left","clickCount":1}`,
    `under ${10 * SCALE},${20 * SCALE}`,
    'pointed at button "Send"',
    `mouse.click ${10 * SCALE},${20 * SCALE} {"button":"right","clickCount":2}`,
  ])
})

test('a drag presses at one point and releases at the other, moving there in steps; a scroll is the wheel in window pixels', async () => {
  const { front, calls } = fakeFront()
  await performWithPointer(
    { action: 'drag', at: { left: 100, top: 100 }, to: { left: 200, top: 50 } },
    front,
    fakePointer(calls),
  )
  await performWithPointer({ action: 'scroll', at: { left: 0, top: 0 }, dx: 0, dy: 100 }, front, fakePointer(calls))
  await performWithPointer({ action: 'move', at: { left: 8, top: 8 } }, front, fakePointer(calls))
  expect(calls.filter((line) => line.startsWith('mouse'))).toEqual([
    `mouse.move ${100 * SCALE},${100 * SCALE}`,
    'mouse.down',
    `mouse.move ${200 * SCALE},${50 * SCALE} {"steps":12}`,
    'mouse.up',
    'mouse.move 0,0',
    `mouse.wheel 0,${100 * SCALE}`,
    `mouse.move ${8 * SCALE},${8 * SCALE}`,
  ])
})

test('⚠ a pointer action that fails has still named what it pointed at, for its failed line (#680)', async () => {
  const click = `mouse.click ${512 * SCALE},${320 * SCALE} {"button":"left","clickCount":1}`
  const { front, calls } = fakeFront({ fail: new Set([click]) })
  await expect(
    performWithPointer({ action: 'click', at: { left: 512, top: 320 } }, front, fakePointer(calls)),
  ).rejects.toThrow('timed out')
  expect(calls).toEqual([`under ${512 * SCALE},${320 * SCALE}`, 'pointed at button "Send"', click])
})

// ── The front page itself ────────────────────────────────────────────────────────────────────────

test('goto, back and reload move the front page with the action timeout; goto stays on the web origin', async () => {
  const { front, calls } = fakeFront()
  expect(await performOnPage({ action: 'goto', path: '/settings?tab=models' }, front)).toEqual(PLACE)
  await performOnPage({ action: 'back' }, front)
  await performOnPage({ action: 'reload' }, front)
  await performOnPage({ action: 'type', text: 'hello' }, front)
  expect(calls).toEqual([
    'goto http://127.0.0.1:5178/settings?tab=models {"timeout":15000}',
    'goBack {"timeout":15000}',
    'reload {"timeout":15000}',
    'keyboard.type hello',
  ])
})

test('a requested screenshot answers with its file and where the page is', async () => {
  const { front, calls } = fakeFront({ shot: '/run/screenshots/00003-requested.jpg' })
  expect(await performOnPage({ action: 'screenshot' }, front)).toEqual({
    ...PLACE,
    screenshot: '/run/screenshots/00003-requested.jpg',
  })
  expect(calls).toEqual(['shoot requested'])
})

test('the front tab’s dialog is forgotten, then answered — a prompt with its text — and the answer is where the page is (#609)', async () => {
  const acceptCalls: string[] = []
  const prompted = fakeFront({ dialog: fakeDialog(acceptCalls), calls: acceptCalls })
  expect(await performOnPage({ action: 'accept-dialog', text: 'my answer' }, prompted.front)).toEqual(PLACE)
  const dismissCalls: string[] = []
  const dismissed = fakeFront({ dialog: fakeDialog(dismissCalls), calls: dismissCalls })
  await performOnPage({ action: 'dismiss-dialog' }, dismissed.front)
  expect(acceptCalls).toEqual(['forget dialog', 'dialog.accept my answer'])
  expect(dismissCalls).toEqual(['forget dialog', 'dialog.dismiss'])
  expect(prompted.front.dialog()).toBeUndefined()
})

test('answering a dialog when none is open is refused, and nothing is answered', async () => {
  const { front, calls } = fakeFront()
  await expect(performOnPage({ action: 'accept-dialog' }, front)).rejects.toThrow('no dialog is open')
  await expect(performOnPage({ action: 'dismiss-dialog' }, front)).rejects.toThrow('no dialog is open')
  expect(calls).toEqual([])
})

// ── Waits (#637, #648, #737) ─────────────────────────────────────────────────────────────────────

const RUNNING: EnsoThreadStatusEvent = { threadId: 't1', shown: true, status: 'running' }
const ASKED: EnsoThreadStatusEvent = {
  threadId: 't1',
  shown: true,
  status: 'question',
  question: { id: 'q1', title: 'Allow?' },
}

/** A status log that counts its marks. */
function countedLog(): { readonly log: ArenaStatusLog; readonly marks: () => number } {
  const log = createStatusLog()
  let marks = 0
  return {
    log: {
      ...log,
      mark: () => {
        marks += 1
        log.mark()
      },
    },
    marks: () => marks,
  }
}

/** A wait's inputs over a still clock and a timer that never fires: a wait ends only on what the test hands it. */
function waiting(overrides: Partial<ArenaWaiting> = {}): ArenaWaiting {
  return {
    baseline: () => Promise.resolve('the page before'),
    look: () => Promise.resolve('the page after'),
    log: createStatusLog(),
    capMs: Number.POSITIVE_INFINITY,
    stopped: Promise.withResolvers<string>().promise,
    clock: { now: () => 0, timer: () => () => undefined },
    ...overrides,
  }
}

test('a fixed wait sleeps on the front page and answers where it is', async () => {
  const { front, calls } = fakeFront()
  expect(await performWait({ action: 'wait', ms: 2500 }, front, waiting())).toEqual(PLACE)
  expect(calls).toEqual(['waitForTimeout 2500'])
})

test('a wait until change sleeps a poll on the front page, then returns on a page unlike the baseline (#637)', async () => {
  const { front, calls } = fakeFront()
  const answer = await performWait({ action: 'wait', ms: 30_000, until: 'change' }, front, waiting())
  expect(answer).toEqual({ ...PLACE, changed: true, waitedMs: 0 })
  expect(calls).toEqual(['waitForTimeout 1000'])
})

test('a wait until attention with a dialog already open returns at once on it, waiting on nothing (#648)', async () => {
  const { front, calls } = fakeFront({ dialog: fakeDialog([]) })
  expect(await performWait({ action: 'wait', ms: 60_000, until: 'attention' }, front, waiting())).toEqual({
    ...PLACE,
    changed: true,
    waitedMs: 0,
    attention: 'dialog',
  })
  expect(calls).toEqual([])
})

test('a wait until attention reads the front tab’s announcements, marks the log once it returns on one, and stops waiting for a dialog (#737)', async () => {
  const { log, marks } = countedLog()
  log.record(0, RUNNING)
  log.record(2, ASKED)
  const { front, calls } = fakeFront({ tab: 2 })
  const answer = await performWait({ action: 'wait', ms: 60_000, until: 'attention' }, front, waiting({ log }))
  expect(answer).toMatchObject({ ...PLACE, changed: true, attention: 'question' })
  expect(marks()).toBe(1)
  expect(log.sinceMark(2)).toEqual([])
  expect(calls).toEqual(['wait for a dialog over tab 2', 'stop waiting over tab 2'])
})

test('a wait until attention ends on a dialog opening over the front tab, and on the run stopping without marking the log', async () => {
  const opened = countedLog()
  const dialogFront = fakeFront()
  const overDialog: ArenaFront = {
    ...dialogFront.front,
    nextDialog: () => ({ opened: Promise.resolve('dialog'), release: () => dialogFront.calls.push('released') }),
  }
  expect(
    await performWait({ action: 'wait', ms: 60_000, until: 'attention' }, overDialog, waiting({ log: opened.log })),
  ).toMatchObject({ changed: true, attention: 'dialog' })
  expect(opened.marks()).toBe(1)
  expect(dialogFront.calls).toEqual(['released'])

  const stopping = countedLog()
  const { front, calls } = fakeFront()
  const answer = await performWait(
    { action: 'wait', ms: 60_000, until: 'attention' },
    front,
    waiting({ log: stopping.log, stopped: Promise.resolve('the agent stopped the run') }),
  )
  expect(answer).toMatchObject({ ...PLACE, changed: false })
  expect(answer).not.toHaveProperty('attention')
  expect(stopping.marks()).toBe(0)
  expect(calls).toEqual(['wait for a dialog over tab 0', 'stop waiting over tab 0'])
})

test('⚠ a wait until attention is cut at the cap under the idle bound, however long it asked for (#609)', async () => {
  const asked: number[] = []
  // A timer that fires at once: the wait runs out at whatever length it was given.
  const clock = {
    now: (): number => 0,
    timer: (ms: number, fire: () => void): (() => void) => {
      asked.push(ms)
      fire()
      return () => undefined
    },
  }
  const { front } = fakeFront()
  const capped = await performWait(
    { action: 'wait', ms: 600_000, until: 'attention' },
    front,
    waiting({ capMs: 55_000, clock }),
  )
  await performWait({ action: 'wait', ms: 3000, until: 'attention' }, front, waiting({ capMs: 55_000, clock }))
  expect(capped).toEqual({ ...PLACE, changed: false, waitedMs: 0 })
  expect(asked).toEqual([55_000, 3000])
})

test('a dialog wait hears only its own tab, and a released one hears nothing (#691)', async () => {
  const waiters = createDialogWaiters()
  const pending = Symbol('pending')
  // Raced against a promise already settled: one already settled wins, being first in the race.
  const settled = (promise: Promise<unknown>): Promise<unknown> => Promise.race([promise, Promise.resolve(pending)])
  const overOne = waiters.next(1)
  const overTwo = waiters.next(2)
  const released = waiters.next(1)
  released.release()
  waiters.opened(1)
  expect(await settled(overOne.opened)).toBe('dialog')
  expect(await settled(overTwo.opened)).toBe(pending)
  expect(await settled(released.opened)).toBe(pending)
})

// ── What an answer shows the agent (#680, #693) ──────────────────────────────────────────────────

interface FakeEyes {
  readonly eyes: ArenaEyes
  readonly calls: string[]
}

function fakeEyes(overrides: Partial<ArenaEyes> = {}): FakeEyes {
  const calls: string[] = []
  const eyes: ArenaEyes = {
    perception: 'visual',
    dialog: () => undefined,
    shoot: (cause) => {
      calls.push(`shoot ${cause}`)
      return Promise.resolve('/run/screenshots/00007-view.jpg')
    },
    redact,
    pageNow: () => {
      calls.push('look at the page')
      return Promise.resolve('the page now')
    },
    saw: (page) => calls.push(`saw ${page}`),
    ...overrides,
  }
  return { eyes, calls }
}

test('a tree agent is shown nothing beside its answer, and a visual agent nothing after a note or a stop', async () => {
  const tree = fakeEyes({ perception: 'tree' })
  expect(await forTheEyes({ action: 'click', target: { role: 'button' } }, tree.eyes)).toEqual({})
  const visual = fakeEyes()
  expect(await forTheEyes({ action: 'stop' }, visual.eyes)).toEqual({})
  expect(await forTheEyes({ action: 'note', note: 'wish', trying: 'a', happened: 'b' }, visual.eyes)).toEqual({})
  expect([...tree.calls, ...visual.calls]).toEqual([])
})

test('a visual agent is shown the view after its action, or — with a dialog open — the dialog, redacted, and no capture (#680)', async () => {
  const viewing = fakeEyes()
  expect(await forTheEyes({ action: 'move', at: { left: 1, top: 1 } }, viewing.eyes)).toEqual({
    view: '/run/screenshots/00007-view.jpg',
  })
  expect(viewing.calls).toEqual(['shoot view'])

  const blocked = fakeEyes({ dialog: () => fakeDialog([], `Paste ${SECRET}?`) })
  expect(await forTheEyes({ action: 'move', at: { left: 1, top: 1 } }, blocked.eyes)).toEqual({
    dialog: { type: 'confirm', message: 'Paste [redacted]?' },
  })
  expect(blocked.calls).toEqual([])

  const failed = fakeEyes({ shoot: () => Promise.resolve(undefined) })
  expect(await forTheEyes({ action: 'move', at: { left: 1, top: 1 } }, failed.eyes)).toEqual({})
})

test('what a visual agent was shown without a move is what it now acts from; after a move it is not (#693)', async () => {
  const still = fakeEyes()
  expect(await shownAfter({ action: 'wait', ms: 1000, until: 'attention' }, false, still.eyes)).toEqual({
    view: '/run/screenshots/00007-view.jpg',
  })
  expect(still.calls).toEqual(['shoot view', 'look at the page', 'saw the page now'])

  const moved = fakeEyes()
  await shownAfter({ action: 'move', at: { left: 1, top: 1 } }, true, moved.eyes)
  expect(moved.calls).toEqual(['shoot view'])

  const tree = fakeEyes({ perception: 'tree' })
  expect(await shownAfter({ action: 'read' }, false, tree.eyes)).toEqual({})
  expect(tree.calls).toEqual([])
})

test('a page that cannot be looked at after it was shown leaves the baseline as it was, and the answer stands', async () => {
  const { eyes, calls } = fakeEyes({ pageNow: () => Promise.reject(new Error('page closed')) })
  expect(await shownAfter({ action: 'wait', ms: 1000 }, false, eyes)).toEqual({
    view: '/run/screenshots/00007-view.jpg',
  })
  expect(calls).toEqual(['shoot view'])
})

// ── Tabs (#675) ──────────────────────────────────────────────────────────────────────────────────

function fakeTab(calls: string[], url: string, title: string | Error): ArenaTab {
  return {
    url: () => url,
    title: () => (title instanceof Error ? Promise.reject(title) : Promise.resolve(title)),
    close: () => {
      calls.push(`close ${url}`)
      return Promise.resolve()
    },
  }
}

function fakeTabs(
  calls: string[],
  open: ReadonlyMap<number, ArenaTab>,
  front = 0,
): Parameters<typeof performOnTabs>[1] {
  return {
    open,
    front: () => front,
    bringToFront: (tab) => {
      calls.push(`bring tab ${tab} to the front`)
      return Promise.resolve()
    },
    here: () => PLACE,
  }
}

test('`tabs` lists every open tab with its URL and title, the front one marked; a title that fails is empty', async () => {
  const calls: string[] = []
  const open = new Map([
    [0, fakeTab(calls, 'http://127.0.0.1:5178/', 'Enso')],
    [3, fakeTab(calls, 'http://127.0.0.1:4321/', new Error('navigating'))],
  ])
  expect(await performOnTabs({ action: 'tabs' }, fakeTabs(calls, open, 3))).toEqual({
    tabs: [
      { tab: 0, url: 'http://127.0.0.1:5178/', title: 'Enso' },
      { tab: 3, url: 'http://127.0.0.1:4321/', title: '', front: true },
    ],
  })
  expect(calls).toEqual([])
})

test('`switch-tab` brings an open tab to the front; a tab that is not open is refused, naming `tabs`', async () => {
  const calls: string[] = []
  const open = new Map([
    [0, fakeTab(calls, 'http://127.0.0.1:5178/', 'Enso')],
    [1, fakeTab(calls, 'http://127.0.0.1:4321/', 'Preview')],
  ])
  expect(await performOnTabs({ action: 'switch-tab', tab: 1 }, fakeTabs(calls, open))).toEqual(PLACE)
  await expect(performOnTabs({ action: 'switch-tab', tab: 7 }, fakeTabs(calls, open))).rejects.toThrow(
    'no tab 7 — `tabs` lists them',
  )
  expect(calls).toEqual(['bring tab 1 to the front'])
})

test('`close-tab` closes the front tab by default or the one named, and never the last', async () => {
  const calls: string[] = []
  const open = new Map([
    [0, fakeTab(calls, 'http://127.0.0.1:5178/', 'Enso')],
    [1, fakeTab(calls, 'http://127.0.0.1:4321/', 'Preview')],
  ])
  expect(await performOnTabs({ action: 'close-tab' }, fakeTabs(calls, open, 1))).toEqual(PLACE)
  await performOnTabs({ action: 'close-tab', tab: 0 }, fakeTabs(calls, open, 1))
  const last = new Map([[0, fakeTab(calls, 'http://127.0.0.1:5178/', 'Enso')]])
  await expect(performOnTabs({ action: 'close-tab' }, fakeTabs(calls, last))).rejects.toThrow(
    'the last tab stays open: there would be no page to act on',
  )
  expect(calls).toEqual(['close http://127.0.0.1:4321/', 'close http://127.0.0.1:5178/'])
})

// ── The run itself: a note, a restart, a stop ────────────────────────────────────────────────────

interface FakeRunHands {
  readonly run: ArenaRunHands
  readonly calls: string[]
  readonly lines: ArenaEventBody[]
}

function fakeRunHands(overrides: Partial<ArenaRunHands> = {}): FakeRunHands {
  const calls: string[] = []
  const lines: ArenaEventBody[] = []
  const run: ArenaRunHands = {
    record: (body) => {
      lines.push(body)
    },
    redact,
    restart: () => {
      calls.push('restart counted')
      return undefined
    },
    stopEnso: () => {
      calls.push('stop Enso')
      return Promise.resolve()
    },
    startEnso: () => {
      calls.push('start Enso')
      return Promise.resolve(true)
    },
    stop: (reason) => calls.push(`stop: ${reason}`),
    ...overrides,
  }
  return { run, calls, lines }
}

test('a note is its own line, from whoever sent it, every free-text field redacted and `wanted` only when given', async () => {
  const { run, lines } = fakeRunHands()
  expect(
    await performOnRun(
      { action: 'note', note: 'friction', trying: `paste ${SECRET}`, happened: 'nothing', wanted: SECRET },
      'agent',
      run,
    ),
  ).toEqual({ recorded: 'friction' })
  await performOnRun({ action: 'note', note: 'wish', trying: 'a', happened: 'b' }, 'control', run)
  expect(lines).toEqual([
    {
      kind: 'note',
      via: 'agent',
      note: 'friction',
      trying: 'paste [redacted]',
      happened: 'nothing',
      wanted: '[redacted]',
    },
    { kind: 'note', via: 'control', note: 'wish', trying: 'a', happened: 'b' },
  ])
})

test('a restart stops Enso, then starts it, and answers whether it came back; a refused one touches nothing (#609)', async () => {
  const cameBack = fakeRunHands()
  expect(await performOnRun({ action: 'restart-enso' }, 'agent', cameBack.run)).toEqual({ restarted: true })
  expect(cameBack.calls).toEqual(['restart counted', 'stop Enso', 'start Enso'])

  const stayedDown = fakeRunHands({ startEnso: () => Promise.resolve(false) })
  expect(await performOnRun({ action: 'restart-enso' }, 'agent', stayedDown.run)).toEqual({ restarted: false })

  const refused = fakeRunHands({ restart: () => 'the run has used its 2 restarts' })
  await expect(performOnRun({ action: 'restart-enso' }, 'agent', refused.run)).rejects.toThrow(
    'the run has used its 2 restarts',
  )
  expect(refused.calls).toEqual([])
})

test('the agent’s stop stops the run with its reason, redacted, or with none', async () => {
  const { run, calls } = fakeRunHands()
  expect(await performOnRun({ action: 'stop', reason: `done with ${SECRET}` }, 'agent', run)).toEqual({
    stopping: true,
  })
  await performOnRun({ action: 'stop' }, 'agent', run)
  expect(calls).toEqual(['stop: the agent stopped the run: done with [redacted]', 'stop: the agent stopped the run'])
})
