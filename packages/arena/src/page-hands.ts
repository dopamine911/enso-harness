import type { Page } from '@playwright/test'
import {
  ARENA_VIEW,
  type ArenaAction,
  type ArenaPoint,
  type ArenaStatusLog,
  type ArenaTarget,
  type ArenaTimer,
  waitForAttention,
  waitForChange,
} from './actions.ts'
import type { ArenaActOutcome } from './perform.ts'
import {
  ARENA_WEB_ORIGIN,
  type ArenaActionSource,
  type ArenaEventBody,
  type ArenaPagePlace,
  type ArenaPerception,
  type ArenaShotCause,
} from './timeline.ts'

/**
 * The page's hands (#556, #838): what each kind of agent action does to the tab in front, over as
 * much of Playwright's page as it uses. `perform.ts` decides which hand performs an action; the
 * recorder hands these the live tab, its dialogs and its camera. Only the browser's own semantics —
 * what a click on a locator does to Enso — is left to a live run.
 */

/** A single action's own timeout: a control that never appears fails the action, not the run. */
export const ACTION_TIMEOUT_MS = 15_000
/** How often a wait until change looks at the page (#637): a card is seen within about a second. */
export const CHANGE_POLL_MS = 1000

/** The timeout an action on the page is given. */
interface ArenaTimeout {
  readonly timeout: number
}

/** A control a target names: as much of Playwright's `Locator` as the hands use. */
export interface ArenaLocator {
  and(locator: ArenaLocator): ArenaLocator
  nth(index: number): ArenaLocator
  click(options: ArenaTimeout): Promise<void>
  hover(options: ArenaTimeout): Promise<void>
  fill(value: string, options: ArenaTimeout): Promise<void>
  selectOption(value: string, options: ArenaTimeout): Promise<unknown>
  press(key: string, options: ArenaTimeout): Promise<void>
}

type ArenaRole = Parameters<Page['getByRole']>[0]

/** What finds a control the way a reader names it: Playwright's `Page`, or a test's stand-in. */
export interface ArenaLocating {
  getByRole(role: ArenaRole, options: { readonly name?: string; readonly exact: boolean }): ArenaLocator
  getByText(text: string, options: { readonly exact: boolean }): ArenaLocator
  getByLabel(text: string, options: { readonly exact: boolean }): ArenaLocator
  getByPlaceholder(text: string, options: { readonly exact: boolean }): ArenaLocator
  locator(selector: string): ArenaLocator
}

/** The mouse, in the window's pixels: as much of Playwright's `Mouse` as a visual agent's hands use. */
export interface ArenaMouse {
  click(
    left: number,
    top: number,
    options: { readonly button: 'left' | 'right' | 'middle'; readonly clickCount: number },
  ): Promise<void>
  move(left: number, top: number, options?: { readonly steps: number }): Promise<void>
  down(): Promise<void>
  up(): Promise<void>
  wheel(deltaX: number, deltaY: number): Promise<void>
}

/** The tab in front, as much of Playwright's `Page` as the hands use. */
export interface ArenaHandPage extends ArenaLocating {
  readonly keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> }
  readonly mouse: ArenaMouse
  goto(url: string, options: ArenaTimeout): Promise<unknown>
  goBack(options: ArenaTimeout): Promise<unknown>
  reload(options: ArenaTimeout): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
}

/** A native dialog left open over a tab (#609): as much of Playwright's `Dialog` as the hands use. */
export interface ArenaDialog {
  type(): string
  message(): string
  accept(promptText?: string): Promise<void>
  dismiss(): Promise<void>
}

/** A wait for a native dialog over one tab: `opened` settles when one opens; `release` stops waiting. */
export interface ArenaDialogWatch {
  readonly opened: Promise<'dialog'>
  readonly release: () => void
}

/** Who waits for a tab's next native dialog (#691): an action in flight, a wait until attention. */
export interface ArenaDialogWaiters {
  readonly next: (tab: number) => ArenaDialogWatch
  /** A native dialog opened over `tab`: every wait on that tab is told, and no other. */
  readonly opened: (tab: number) => void
}

export function createDialogWaiters(): ArenaDialogWaiters {
  const waiters = new Set<(tab: number) => void>()
  return {
    next: (tab) => {
      let waiter: ((opened: number) => void) | undefined
      const opened = new Promise<'dialog'>((resolve) => {
        waiter = (openedOver) => {
          if (openedOver === tab) resolve('dialog')
        }
        waiters.add(waiter)
      })
      return {
        opened,
        release: () => {
          if (waiter !== undefined) waiters.delete(waiter)
        },
      }
    },
    opened: (tab) => {
      for (const waiter of waiters) waiter(tab)
    },
  }
}

/** The tab in front as the hands reach it: its page, where it is, the dialog over it, the camera. */
export interface ArenaFront {
  readonly page: () => ArenaHandPage
  readonly here: () => ArenaPagePlace
  /** The number of the tab in front (#675). */
  readonly tab: () => number
  readonly dialog: () => ArenaDialog | undefined
  /** The front tab's dialog is answered: it has none open any more. */
  readonly forgetDialog: () => void
  readonly nextDialog: (tab: number) => ArenaDialogWatch
  readonly shoot: (cause: ArenaShotCause) => Promise<string | undefined>
  readonly redact: (text: string) => string
}

/**
 * What a page read can show: no element a modal dialog hid (`aria-hidden`, which Radix sets on
 * everything beside an open dialog) or made `inert`. `getByRole` leaves those out by itself; the
 * text, label and placeholder locators do not.
 */
export const READABLE = ':not([aria-hidden="true"], [aria-hidden="true"] *, [inert], [inert] *)'

/**
 * The control a target names, among what the agent can read (found live): with the Start dialog
 * open, `placeholder: "ask pi something"` matched both the dialog's prompt and the composer behind
 * it, so the agent's first fill failed on a box its read never showed — and after a fork, it sent
 * the fork's prompt unchanged.
 */
function locate(page: ArenaLocating, target: ArenaTarget): ArenaLocator {
  const exact = target.exact === true
  let found: ArenaLocator
  if ('role' in target) {
    found = page.getByRole(target.role as ArenaRole, {
      ...(target.name === undefined ? {} : { name: target.name }),
      exact,
    })
  } else if ('text' in target) found = page.getByText(target.text, { exact }).and(page.locator(READABLE))
  else if ('label' in target) found = page.getByLabel(target.label, { exact }).and(page.locator(READABLE))
  else found = page.getByPlaceholder(target.placeholder, { exact }).and(page.locator(READABLE))
  return target.nth === undefined ? found : found.nth(target.nth)
}

/** The actions on a control named the way a reader names it (`ArenaTarget`): a tree agent's hands. */
export async function performOnControl(
  action: Extract<ArenaAction, { readonly action: 'click' | 'hover' | 'fill' | 'select' | 'press' }>,
  front: Pick<ArenaFront, 'page' | 'here'>,
): Promise<unknown> {
  const timeout = ACTION_TIMEOUT_MS
  if (action.action === 'press' && action.target === undefined) {
    await front.page().keyboard.press(action.key)
    return front.here()
  }
  if (!('target' in action) || action.target === undefined) throw new Error(`${action.action} needs a target`)
  const control = locate(front.page(), action.target)
  if (action.action === 'click') await control.click({ timeout })
  else if (action.action === 'hover') await control.hover({ timeout })
  else if (action.action === 'fill') await control.fill(action.text, { timeout })
  else if (action.action === 'select') await control.selectOption(action.option, { timeout })
  else await control.press(action.key, { timeout })
  return front.here()
}

/** A point of the view the agent saw (#680), in the window's pixels. */
function toWindow(point: ArenaPoint): ArenaPoint {
  return { left: point.left * ARENA_VIEW.scale, top: point.top * ARENA_VIEW.scale }
}

/** What a pointer action learns of its point, for the record only: the agent is never told. */
export interface ArenaPointer {
  /** What is at a window point, as the accessibility tree names it (`pointedRoleOf`). */
  readonly under: (point: ArenaPoint) => Promise<string>
  /** What the action pointed at, kept for its timeline line — a failed action's too. */
  readonly pointed: (under: string) => void
}

/**
 * The pointer actions (#680): a point of the view the agent saw, mapped to the window. ⚠ What is
 * under the point is read before the mouse moves, so a failed action's line still names it.
 */
export async function performWithPointer(
  action: Extract<ArenaAction, { readonly at: ArenaPoint }>,
  front: Pick<ArenaFront, 'page' | 'here'>,
  pointer: ArenaPointer,
): Promise<unknown> {
  const mouse = front.page().mouse
  const from = toWindow(action.at)
  pointer.pointed(await pointer.under(from))
  if (action.action === 'click') {
    await mouse.click(from.left, from.top, {
      button: action.button ?? 'left',
      clickCount: action.double === true ? 2 : 1,
    })
  } else if (action.action === 'drag') {
    const to = toWindow(action.to)
    await mouse.move(from.left, from.top)
    await mouse.down()
    await mouse.move(to.left, to.top, { steps: 12 })
    await mouse.up()
  } else {
    await mouse.move(from.left, from.top)
    if (action.action === 'scroll') await mouse.wheel(action.dx * ARENA_VIEW.scale, action.dy * ARENA_VIEW.scale)
  }
  return front.here()
}

/** What an answer shows the agent (#680, #693): its perception, the page now, and what it last saw. */
export interface ArenaEyes extends Pick<ArenaFront, 'dialog' | 'shoot' | 'redact'> {
  readonly perception: ArenaPerception
  /** The page looked at now — the dialog over it first — as a wait's baseline words it. */
  readonly pageNow: () => Promise<string>
  /** The agent has seen `page`: the next wait until change compares with it. */
  readonly saw: (page: string) => void
}

/**
 * What a visual agent is shown with every answer (#680): the view after the action, and a native
 * dialog over the front tab, which a page capture never shows. ⚠ No capture while one is open: it
 * blocks the page's rendering.
 */
export async function forTheEyes(
  action: ArenaAction,
  eyes: Omit<ArenaEyes, 'pageNow' | 'saw'>,
): Promise<Pick<ArenaActOutcome, 'view' | 'dialog'>> {
  if (eyes.perception !== 'visual' || action.action === 'note' || action.action === 'stop') return {}
  const dialog = eyes.dialog()
  if (dialog !== undefined) return { dialog: { type: dialog.type(), message: eyes.redact(dialog.message()) } }
  const view = await eyes.shoot('view')
  return view === undefined ? {} : { view }
}

/**
 * What the answer shows the agent, and — when the action moved nothing — what it now acts from
 * (#693, found live). A visual agent sees the page in every answer: a wait that returned on a
 * card hands it the card, so the card it answers next is one it has SEEN. Left uncounted, the page
 * before its click was the one its last move left, older than the card, and the card on its way
 * out read as a new question: the wait returned at once on a stale one, inviting a second answer.
 * A move's view is not counted: the page before the move stays what the agent acted from.
 */
export async function shownAfter(
  action: ArenaAction,
  moved: boolean,
  eyes: ArenaEyes,
): Promise<Pick<ArenaActOutcome, 'view' | 'dialog'>> {
  const shown = await forTheEyes(action, eyes)
  if (moved || (shown.view === undefined && shown.dialog === undefined)) return shown
  const page = await eyes.pageNow().catch(() => undefined)
  if (page !== undefined) eyes.saw(page)
  return shown
}

/** What a wait on the page reads (#637, #648, #737) besides the tab in front. */
export interface ArenaWaiting {
  /** What the agent last saw: a wait until change returns once the page differs from it. */
  readonly baseline: () => Promise<string>
  /** The page now, the dialog over it first, as the baseline words it. */
  readonly look: () => Promise<string>
  /** What the page announced (#737): a wait until attention reads it. */
  readonly log: ArenaStatusLog
  /** The longest a wait until attention runs: under the idle bound (#609). */
  readonly capMs: number
  /** The run stopping: a wait until attention ends there. */
  readonly stopped: Promise<unknown>
  /** The clock a wait reads and the timer that ends it: a test's; absent, the real ones. */
  readonly clock?: { readonly timer?: ArenaTimer; readonly now?: () => number }
}

/**
 * `wait`: a fixed sleep; a wait on the page until it changes (#637), looked for when the page's
 * change count moved (#740); or until it needs the agent (#648), read off what the page announced
 * (#737) — the log since the agent's move, then each announcement as it comes — ended early by the
 * run stopping or a native dialog opening over the tab. A wait that returned with attention marks
 * the log: the agent has been told.
 */
export async function performWait(
  action: Extract<ArenaAction, { readonly action: 'wait' }>,
  front: Pick<ArenaFront, 'page' | 'here' | 'tab' | 'dialog' | 'nextDialog'>,
  waiting: ArenaWaiting,
): Promise<unknown> {
  if (action.until === undefined) {
    await front.page().waitForTimeout(action.ms)
    return front.here()
  }
  if (action.until === 'change') {
    const waited = await waitForChange({
      ...waiting.clock,
      baseline: await waiting.baseline(),
      look: waiting.look,
      sleep: (ms) => front.page().waitForTimeout(ms),
      ms: action.ms,
      pollMs: CHANGE_POLL_MS,
    })
    return { ...front.here(), ...waited }
  }
  if (front.dialog() !== undefined) return { ...front.here(), changed: true, waitedMs: 0, attention: 'dialog' }
  const tabNumber = front.tab()
  const dialog = front.nextDialog(tabNumber)
  try {
    const waited = await waitForAttention({
      ...waiting.clock,
      log: waiting.log,
      tab: tabNumber,
      ms: Math.min(action.ms, waiting.capMs),
      stopped: waiting.stopped,
      dialog: dialog.opened,
    })
    if (waited.attention !== undefined) waiting.log.mark()
    return { ...front.here(), ...waited }
  } finally {
    dialog.release()
  }
}

/** Answer the front tab's native dialog (#609); refused when none is open. */
async function answerDialog(
  front: Pick<ArenaFront, 'dialog' | 'forgetDialog' | 'here'>,
  answer: (dialog: ArenaDialog) => Promise<void>,
): Promise<ArenaPagePlace> {
  const dialog = front.dialog()
  if (dialog === undefined) throw new Error('no dialog is open')
  front.forgetDialog()
  await answer(dialog)
  return front.here()
}

/** The actions on the front page itself: navigate, type, shoot, answer its dialog. */
export async function performOnPage(
  action: Extract<
    ArenaAction,
    { readonly action: 'goto' | 'type' | 'screenshot' | 'back' | 'reload' | 'accept-dialog' | 'dismiss-dialog' }
  >,
  front: Pick<ArenaFront, 'page' | 'here' | 'dialog' | 'forgetDialog' | 'shoot'>,
): Promise<unknown> {
  const timeout = ACTION_TIMEOUT_MS
  switch (action.action) {
    case 'goto':
      await front.page().goto(new URL(action.path, ARENA_WEB_ORIGIN).toString(), { timeout })
      return front.here()
    case 'type':
      await front.page().keyboard.type(action.text)
      return front.here()
    case 'screenshot':
      return { ...front.here(), screenshot: await front.shoot('requested') }
    case 'back':
      await front.page().goBack({ timeout })
      return front.here()
    case 'reload':
      await front.page().reload({ timeout })
      return front.here()
    case 'accept-dialog':
      return answerDialog(front, (dialog) => dialog.accept(action.text))
    case 'dismiss-dialog':
      return answerDialog(front, (dialog) => dialog.dismiss())
  }
}

/** One open tab (#675): as much of Playwright's `Page` as the tab actions use. */
export interface ArenaTab {
  url(): string
  title(): Promise<string>
  close(): Promise<void>
}

/** The browser's tabs (#675) as the tab actions see them. */
export interface ArenaTabs {
  /** Every open tab by its number; a number is never reused. */
  readonly open: ReadonlyMap<number, ArenaTab>
  readonly front: () => number
  readonly bringToFront: (tab: number) => Promise<void>
  readonly here: () => ArenaPagePlace
}

/** The tab actions (#675): list the tabs, bring one to the front, close one but never the last. */
export async function performOnTabs(
  action: Extract<ArenaAction, { action: 'tabs' | 'switch-tab' | 'close-tab' }>,
  tabs: ArenaTabs,
): Promise<unknown> {
  if (action.action === 'tabs') {
    return {
      tabs: await Promise.all(
        [...tabs.open].map(async ([tabNumber, tabPage]) => ({
          tab: tabNumber,
          url: tabPage.url(),
          title: await tabPage.title().catch(() => ''),
          ...(tabNumber === tabs.front() ? { front: true } : {}),
        })),
      ),
    }
  }
  const tabNumber = action.tab ?? tabs.front()
  const tabPage = tabs.open.get(tabNumber)
  if (tabPage === undefined) throw new Error(`no tab ${tabNumber} — \`tabs\` lists them`)
  if (action.action === 'switch-tab') {
    await tabs.bringToFront(tabNumber)
    return tabs.here()
  }
  if (tabs.open.size === 1) throw new Error('the last tab stays open: there would be no page to act on')
  // Its `close` listener forgets it and brings the newest tab left to the front.
  await tabPage.close()
  return tabs.here()
}

/** The run, as its actions on the run reach it: the timeline, the bounds' restart count, Enso, the stop. */
export interface ArenaRunHands {
  /** A line on the timeline, placed where the tab in front is. */
  readonly record: (body: ArenaEventBody) => void
  readonly redact: (text: string) => string
  /** Why the run refuses a restart now (#609), or undefined — the restart then counted. */
  readonly restart: () => string | undefined
  readonly stopEnso: () => Promise<void>
  /** Start Enso again: whether it answered. */
  readonly startEnso: () => Promise<boolean>
  /** Stop the run with `reason`. */
  readonly stop: (reason: string) => void
}

/** The actions on the run rather than the page: a note on the timeline, a restart, a stop. */
export async function performOnRun(
  action: Extract<ArenaAction, { readonly action: 'note' | 'restart-enso' | 'stop' }>,
  via: ArenaActionSource,
  run: ArenaRunHands,
): Promise<unknown> {
  switch (action.action) {
    case 'note':
      run.record({
        kind: 'note',
        via,
        note: action.note,
        trying: run.redact(action.trying),
        happened: run.redact(action.happened),
        ...(action.wanted === undefined ? {} : { wanted: run.redact(action.wanted) }),
      })
      return { recorded: action.note }
    case 'restart-enso': {
      const refused = run.restart()
      if (refused !== undefined) throw new Error(refused)
      await run.stopEnso()
      return { restarted: await run.startEnso() }
    }
    case 'stop':
      run.stop(`the agent stopped the run${action.reason === undefined ? '' : `: ${run.redact(action.reason)}`}`)
      return { stopping: true }
  }
}
