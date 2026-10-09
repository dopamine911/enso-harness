import type { EnsoThreadStatusEvent } from '@enso/core'
import { redactJudgeText } from '@enso/core/judge'
import type { ArenaNoteKind, ArenaPerception } from './timeline.ts'

/**
 * What the agent under test may do to Enso (#556): the moves a person makes in a browser, and
 * nothing else. The recorder performs each one on ITS page, so every action is in the Playwright
 * trace and on the timeline — the agent has no browser of its own to act through.
 *
 * ⚠ USER-LEVEL BY CONSTRUCTION. A target is found the way a reader finds it — a role and an
 * accessible name, visible text, a label, a placeholder — never a CSS selector or a test id, and
 * there is no `evaluate`: the agent may not reach into the page's code. `goto` stays on the web
 * origin and off `/api`, so the server's routes are reached through the UI or not at all. What
 * this does NOT hold: the agent's own shell. Under `--agent` the runner gives it none (`agent.ts`);
 * under `--manual`, an agent that can run `curl` can reach the API on loopback, which its prompt
 * (`arenaBrief`) forbids and nothing here enforces.
 */

/** The one tool the agent runner gives the model (`agent.ts`): every move it makes on Enso is a call to it. */
export const ARENA_UI_TOOL = 'act'

/** The timeline `detail` of an action refused before it reached the page: a selector, `goto /api`, an unknown move. */
export const ARENA_REFUSED_DETAIL = 'refused before it reached the page'

/** How an `agent-end` the recorder wrote for a runner that outlived the stop begins: the score reads it. */
export const ARENA_RUNNER_STILL_RUNNING = 'still running'

/** How the agent names an element: what a person reading the page would see. */
export type ArenaTarget =
  | { readonly role: string; readonly name?: string; readonly exact?: boolean; readonly nth?: number }
  | { readonly text: string; readonly exact?: boolean; readonly nth?: number }
  | { readonly label: string; readonly exact?: boolean; readonly nth?: number }
  | { readonly placeholder: string; readonly exact?: boolean; readonly nth?: number }

/**
 * The picture a visual agent sees (#680): the tab in front, scaled from the 1440×900 window to this
 * size, and the space its x,y are in. ⚠ Not the window's size: GPT's image pipeline scales a
 * 1440×900 image to 1229×768, and coordinates read off that picture would land about 15% short.
 * At 1024×640 no provider rescales (Claude's limit is 1568 px), so a point the model names is a
 * point in the picture it saw. The recorder maps it to the window by `ARENA_VIEW.scale`.
 */
export const ARENA_VIEW = { width: 1024, height: 640, scale: 1440 / 1024 } as const

/** A point on the view (#680): pixels from the left and from the top of the screenshot the agent was shown. */
export interface ArenaPoint {
  readonly left: number
  readonly top: number
}

/**
 * What a point's two numbers are called on the wire (#680): the fields the agent writes, and the
 * DevTools Protocol's own. `x` and `y` are every model's and the protocol's convention, so they stay
 * there; this codebase spells its own names out (`left`, `top`), and names the wire's here, once.
 */
export const POINT_FIELDS = { horizontal: 'x', vertical: 'y' } as const

export type ArenaAction =
  | { readonly action: 'goto'; readonly path: string }
  | { readonly action: 'click'; readonly target: ArenaTarget }
  /** A mouse click at a point of the view (#680): left by default; `double` for a double click. */
  | {
      readonly action: 'click'
      readonly at: ArenaPoint
      readonly button?: 'right' | 'middle'
      readonly double?: boolean
    }
  /** The mouse moved to a point: what a hover shows, by position (#680). */
  | { readonly action: 'move'; readonly at: ArenaPoint }
  /** The wheel turned over a point, by `dx`,`dy` view pixels (#680). */
  | { readonly action: 'scroll'; readonly at: ArenaPoint; readonly dx: number; readonly dy: number }
  /** Press at one point, move to another, release (#680). */
  | { readonly action: 'drag'; readonly at: ArenaPoint; readonly to: ArenaPoint }
  /** Text typed with the keyboard into whatever has focus (#680): a sighted user clicks a field, then types. */
  | { readonly action: 'type'; readonly text: string }
  | { readonly action: 'fill'; readonly target: ArenaTarget; readonly text: string }
  | { readonly action: 'press'; readonly key: string; readonly target?: ArenaTarget }
  | { readonly action: 'hover'; readonly target: ArenaTarget }
  | { readonly action: 'select'; readonly target: ArenaTarget; readonly option: string }
  /**
   * One region of the page's accessibility tree (#740, `read-regions.ts`): whole the first time, then
   * what changed since the last read of it; `full` has it whole. Any name is taken here: the recorder
   * answers a region not on the page with the ones that are.
   */
  | { readonly action: 'read'; readonly region?: string; readonly full?: boolean }
  | { readonly action: 'screenshot' }
  /**
   * A fixed sleep; or with `until` a wait on the page, `ms` its limit: `'change'` (#637) returns as
   * soon as the page differs from what the agent last saw, `'attention'` (#648) once Enso needs the
   * agent or is done. Either says `changed`, `waitedMs`, and for attention which (`attention`).
   */
  | { readonly action: 'wait'; readonly ms: number; readonly until?: ArenaWaitUntil }
  | { readonly action: 'back' }
  | { readonly action: 'reload' }
  | {
      readonly action: 'note'
      readonly note: ArenaNoteKind
      readonly trying: string
      readonly happened: string
      readonly wanted?: string
    }
  | { readonly action: 'restart-enso' }
  /**
   * A native browser dialog (`alert`, `confirm`, `prompt`, `beforeunload`) blocks the page until it
   * is answered (#609): the recorder leaves it open for the agent, as a person would face it, and
   * `read` reports it. `text` is a `prompt`'s answer.
   */
  | { readonly action: 'accept-dialog'; readonly text?: string }
  | { readonly action: 'dismiss-dialog' }
  /**
   * The browser's tabs (#675). A tab the page opens — Preview's, a link's — comes to the front as a
   * browser shows it, and every action goes to the tab in front. `tabs` lists them; `switch-tab`
   * brings one to the front; `close-tab` closes one (the one in front by default), never the last.
   */
  | { readonly action: 'tabs' }
  | { readonly action: 'switch-tab'; readonly tab: number }
  | { readonly action: 'close-tab'; readonly tab?: number }
  | { readonly action: 'stop'; readonly reason?: string }

/**
 * The longest blind `wait` (a fixed sleep): the agent sleeps through nothing longer than a minute,
 * and a run that needs longer waits again, so the timeline shows it waited.
 */
export const LONGEST_WAIT_MS = 60_000
/**
 * The longest wait on the page (`until`): it returns the moment the page needs the agent (#737), so
 * the limit is a backstop, not a cadence — the recorder cuts it under the run's idle bound (#609),
 * which a wait in progress must not trip.
 */
export const LONGEST_PAGE_WAIT_MS = 10 * 60_000

/** What a wait on the page waits for: any change (#637), or Enso needing the agent (#648). */
export type ArenaWaitUntil = 'change' | 'attention'
const WAIT_UNTIL: readonly ArenaWaitUntil[] = ['change', 'attention']
const isWaitUntil = (value: unknown): value is ArenaWaitUntil => WAIT_UNTIL.some((kind) => kind === value)

/** How a wait on the page is worded on the timeline — and how the friction tells it from a fixed sleep. */
const PAGE_WAIT = 'wait until'

/** True for a timeline detail of a wait on the page (either kind), never a fixed sleep's. */
export function isPageWait(detail: string): boolean {
  return detail.startsWith(`${PAGE_WAIT} `)
}

/**
 * The rail's relative ages: the last word of a thread's button, `now`, `6s`, `1m`, `3h`, `2d`.
 * Measured (#637): while a permission card waits, they are the ONLY thing on the page that moves —
 * every five seconds or so — and while Enso works, the page changes only at real events.
 */
export const RELATIVE_AGE_WORD = String.raw`(?:now|\d+[smhd])`
const RELATIVE_AGE = new RegExp(` ${RELATIVE_AGE_WORD}"`, 'g')
/** The rail's accessible name: Enso's `<nav aria-label="threads">`. */
export const RAIL_NAME = 'threads'
/** The rail's line in a page read; every line indented under it is the rail's. */
const RAIL_LINE = `- navigation "${RAIL_NAME}"`

/**
 * A page read as a wait until change compares it: the rail's ages aside, so the clock is no change.
 * ⚠ IN THE RAIL ONLY: the ages were measured there, and the same shape elsewhere —
 * a control named "Snooze 1h" — is the page's words, whose change is a change.
 * Its twin in the page, `PAGE_CHANGES_SCRIPT` (#740), counts every mutation but the rail's ages.
 */
export function pageForChange(page: string): string {
  let railIndent: number | undefined
  return page
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length
      if (railIndent !== undefined && indent <= railIndent) railIndent = undefined
      if (railIndent !== undefined) return line.replaceAll(RELATIVE_AGE, ' ·"')
      if (line.trimStart().startsWith(RAIL_LINE)) railIndent = indent
      return line
    })
    .join('\n')
}

/** A native dialog as a wait sees the page: it blocks the page, so it is the page. */
export function dialogForChange(type: string, message: string): string {
  return `${DIALOG_PAGE}${type}: ${message}`
}
const DIALOG_PAGE = 'dialog '

/** Why Enso needs the agent (#648): pi asks, the run ended (done or failed), the server went, a browser dialog. */
export type ArenaAttention = 'question' | 'idle' | 'disconnected' | 'dialog'

/** What a wait on the page came to: whether the page changed, after `waitedMs`, and — for attention — why it returned. */
export interface ArenaPageWait {
  readonly changed: boolean
  readonly waitedMs: number
  readonly attention?: ArenaAttention
}

/**
 * Look every `pollMs` until the page differs from `baseline` (#637), or `ms` runs out. `look` is
 * the page as `pageForChange` words it (or `dialogForChange`); `sleep` and `now` are the page's
 * clock, injected so the outcomes can be tested without a browser.
 */
export async function waitForChange(options: {
  readonly baseline: string
  readonly look: () => Promise<string>
  readonly sleep: (ms: number) => Promise<void>
  readonly ms: number
  readonly pollMs: number
  readonly now?: () => number
}): Promise<ArenaPageWait> {
  const now = options.now ?? Date.now
  const started = now()
  const waited = (): number => now() - started
  while (waited() < options.ms) {
    await options.sleep(Math.min(options.pollMs, options.ms - waited()))
    if ((await options.look()) !== options.baseline) return { changed: true, waitedMs: waited() }
  }
  return { changed: false, waitedMs: waited() }
}

/**
 * What the page announced about its thread's status (#737, core's `enso:thread-status`), kept as
 * the agent acts: the recorder records every announcement from a shown pane with the tab it came
 * from, and `mark` is the agent's move — what came before it is what the agent acted from, what
 * comes after is what its move caused. A wait until attention reads the log instead of the page.
 */
export interface ArenaStatusLog {
  /** The page in `tab` announced `event`; a wait listening on that tab is told. */
  readonly record: (tab: number, event: EnsoThreadStatusEvent) => void
  /** The agent acts on, or has just been shown, the page: the announcements so far are what it knows. */
  readonly mark: () => void
  /** The last announcement from `tab` before the mark: the status the agent acted from. */
  readonly beforeMark: (tab: number) => EnsoThreadStatusEvent | undefined
  /** The announcements from `tab` since the mark, oldest first. */
  readonly sinceMark: (tab: number) => readonly EnsoThreadStatusEvent[]
  /** Hear each announcement from `tab` as it is recorded; returns the function that stops listening. */
  readonly subscribe: (tab: number, listener: (event: EnsoThreadStatusEvent) => void) => () => void
}

export function createStatusLog(): ArenaStatusLog {
  const before = new Map<number, EnsoThreadStatusEvent>()
  let since: Array<{ readonly tab: number; readonly event: EnsoThreadStatusEvent }> = []
  const listeners = new Set<{ readonly tab: number; readonly listener: (event: EnsoThreadStatusEvent) => void }>()
  return {
    record: (tab, event) => {
      since.push({ tab, event })
      for (const subscriber of listeners) if (subscriber.tab === tab) subscriber.listener(event)
    },
    mark: () => {
      for (const { tab, event } of since) before.set(tab, event)
      since = []
    },
    beforeMark: (tab) => before.get(tab),
    sinceMark: (tab) => since.filter((announced) => announced.tab === tab).map((announced) => announced.event),
    subscribe: (tab, listener) => {
      const subscriber = { tab, listener }
      listeners.add(subscriber)
      return () => {
        listeners.delete(subscriber)
      }
    },
  }
}

/** A timer that can be cancelled: `fire` after `ms`, unless the returned function is called first. */
export type ArenaTimer = (ms: number, fire: () => void) => () => void

const realTimer: ArenaTimer = (ms, fire) => {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

/**
 * Wait until the page in `tab` needs the agent (#648), read off what it announced (#737) rather
 * than looked for: the announcements since the agent's move first, then each one as it comes, until
 * `ms` runs out or an interrupt ends the wait. Every transition is seen, so a run begun and ended
 * while the agent was thinking is its `idle`, never missed.
 *
 * ⚠ Not every announcement needs the agent — measured (#648), a wait that returned on Enso merely
 * starting was given up on:
 * - `disconnected` returns at once;
 * - a `question` returns when it is not the one the agent acted from (#693): the card it just
 *   answered, on its way out, is no return — a second answer to it would be a double approval;
 * - `running` is Enso working: no return, but work seen;
 * - `idle` returns after work was seen, or when the agent did not start from idle (it answered a
 *   question, or the follow was gone). From idle with no work seen — Start just clicked, the dialog
 *   closing — it is not the run's end.
 * An interrupt (the run stopping, a native dialog opening) ends the wait where it is.
 */
export function waitForAttention(options: {
  readonly log: ArenaStatusLog
  readonly tab: number
  readonly ms: number
  /** The run stopping: the wait ends with what it has. */
  readonly stopped: Promise<unknown>
  /** A native dialog opening over the tab: `attention: 'dialog'`. */
  readonly dialog: Promise<unknown>
  readonly timer?: ArenaTimer
  readonly now?: () => number
}): Promise<ArenaPageWait> {
  const now = options.now ?? Date.now
  const started = now()
  const waited = (): number => now() - started
  const before = options.log.beforeMark(options.tab)
  let sawWork = before === undefined || before.status === 'running'
  let changed = false
  const decide = (event: EnsoThreadStatusEvent): ArenaAttention | undefined => {
    changed = true
    if (event.status === 'disconnected') return 'disconnected'
    if (event.status === 'question') {
      const asked = event.question?.id
      return asked !== undefined && asked === before?.question?.id ? undefined : 'question'
    }
    if (event.status === 'running') {
      sawWork = true
      return undefined
    }
    return sawWork || before?.status !== 'idle' ? 'idle' : undefined
  }
  for (const event of options.log.sinceMark(options.tab)) {
    const attention = decide(event)
    if (attention !== undefined) return Promise.resolve({ changed, waitedMs: waited(), attention })
  }
  const { promise, resolve } = Promise.withResolvers<ArenaPageWait>()
  let settled = false
  let stopListening = (): void => undefined
  let cancelTimer = (): void => undefined
  const finish = (attention?: ArenaAttention): void => {
    if (settled) return
    settled = true
    stopListening()
    cancelTimer()
    resolve({ changed, waitedMs: waited(), ...(attention === undefined ? {} : { attention }) })
  }
  stopListening = options.log.subscribe(options.tab, (event) => {
    const attention = decide(event)
    if (attention !== undefined) finish(attention)
  })
  cancelTimer = (options.timer ?? realTimer)(options.ms, () => finish())
  void options.stopped.then(() => finish())
  void options.dialog.then(() => {
    changed = true
    finish('dialog')
  })
  return promise
}

/** What a wait until change compares with, kept as the agent acts (#637). */
export interface ArenaChangeBaseline {
  /** The agent read the page: this is what it saw. */
  readonly saw: (page: string) => void
  /** The agent moved the page (a click, a fill, a key): what it left is what it knows. */
  readonly moved: () => Promise<void>
  /** The page a wait starts from: the last seen, or — with none — the page as the wait finds it. */
  readonly baseline: () => Promise<string>
}

/**
 * The page as the agent last saw it: its last read, or the page right after its last move.
 *
 * ⚠ TAKEN AT THE MOVE, NOT AT THE WAIT. Between the
 * agent's click and its wait lies its own model call — a median 2.1 s in the Sonnet run. Forgetting
 * the page at the move and looking at the wait's start would fold a card that appeared in that gap
 * into the baseline: the page then holds still, and the wait sits out its whole limit — the bug
 * #637 fixes. The look costs a median 7 ms (121 reads, measured). A look that fails leaves nothing,
 * and the wait starts from the page it finds.
 */
export function createChangeBaseline(look: () => Promise<string>): ArenaChangeBaseline {
  let seen: string | undefined
  return {
    saw: (page) => {
      seen = page
    },
    moved: async () => {
      seen = await look().catch(() => undefined)
    },
    baseline: async () => seen ?? (await look()),
  }
}

const NOTE_KINDS: readonly ArenaNoteKind[] = ['wish', 'friction', 'retrospective']

/** The parsed action, or why the request is not one. */
export type ArenaActionParse =
  | { readonly ok: true; readonly action: ArenaAction }
  | { readonly ok: false; readonly error: string }

type Fields = Readonly<Record<string, unknown>>

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (fields: Fields, key: string): string | undefined =>
  typeof fields[key] === 'string' && fields[key].length > 0 ? fields[key] : undefined

function parseTarget(value: unknown): ArenaTarget | string {
  if (!isFields(value)) return 'a target is an object: {role, name?} | {text} | {label} | {placeholder}'
  const exact = value.exact === true ? { exact: true } : {}
  const nth = typeof value.nth === 'number' && Number.isInteger(value.nth) && value.nth >= 0 ? { nth: value.nth } : {}
  const role = text(value, 'role')
  if (role !== undefined) {
    const name = text(value, 'name')
    return { role, ...(name === undefined ? {} : { name }), ...exact, ...nth }
  }
  for (const key of ['text', 'label', 'placeholder'] as const) {
    const named = text(value, key)
    if (named !== undefined) return { [key]: named, ...exact, ...nth } as ArenaTarget
  }
  return 'a target names a role, text, label or placeholder — what a reader of the page sees'
}

/** An origin no request is ever sent to: the base `parseGotoPath` resolves a path against. */
const RESOLVING_ORIGIN = 'http://arena.invalid'

/** A pathname decoded until it stops changing, so `%2561` is read as `a` too; undefined when it does not decode. */
function fullyDecoded(pathname: string): string | undefined {
  let current = pathname
  for (let round = 0; round < 5; round += 1) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      return undefined
    }
    if (next === current) return current
    current = next
  }
  return undefined
}

/**
 * A `goto` path on the web origin: a path and query, never another origin, never `/api`.
 *
 * ⚠ CHECKED AS THE BROWSER WILL READ IT, not as typed. The first version
 * compared the raw text, so `/%61pi/threads`, `/x/../api/threads` and `/./api` passed it and
 * reached the API, and `/\evil.com/` passed it and left the origin — the URL parser treats `\`
 * as `/`. The path is resolved against a fixed origin first (dot segments collapse, a `\` that
 * names a host shows as another origin), then decoded until stable and compared without case.
 * Still not the hard boundary: an agent with a shell can reach the API directly (module header).
 */
function parseGotoPath(path: string): string | undefined {
  if (!path.startsWith('/') || path.startsWith('//')) return undefined
  let resolved: URL
  try {
    resolved = new URL(path, RESOLVING_ORIGIN)
  } catch {
    return undefined
  }
  if (resolved.origin !== RESOLVING_ORIGIN) return undefined
  const decoded = fullyDecoded(resolved.pathname)
  if (decoded === undefined) return undefined
  // Resolved again: an encoded `..` (`%252e%252e`) is a dot segment only once decoded.
  const pathname = new URL(decoded, RESOLVING_ORIGIN).pathname.toLowerCase()
  if (pathname === '/api' || pathname.startsWith('/api/')) return undefined
  return path
}

const fail = (error: string): ArenaActionParse => ({ ok: false, error })
const accept = (action: ArenaAction): ArenaActionParse => ({ ok: true, action })

/** A tab number as `tabs` lists it: a whole number, 0 or more; undefined when it is not one. */
const tabNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

/** The request's target, handed to `build`, or why it is not one. */
function withTarget(request: Fields, build: (target: ArenaTarget) => ArenaAction): ArenaActionParse {
  const target = parseTarget(request.target)
  return typeof target === 'string' ? fail(target) : accept(build(target))
}

/** Where a point must be: on the view the agent was shown (#680). */
const ON_THE_VIEW = `pixels on the ${ARENA_VIEW.width}×${ARENA_VIEW.height} screenshot, from its top left`

/** A point on the view from two wire fields (`x`/`y`, or `toX`/`toY`), or undefined when it is not one. */
function pointOf(request: Fields, horizontalField: string, verticalField: string): ArenaPoint | undefined {
  const left = request[horizontalField]
  const top = request[verticalField]
  if (typeof left !== 'number' || typeof top !== 'number' || !Number.isFinite(left) || !Number.isFinite(top)) {
    return undefined
  }
  if (left < 0 || top < 0 || left > ARENA_VIEW.width || top > ARENA_VIEW.height) return undefined
  return { left, top }
}

/** A click's mouse button, when it is not the left one. */
function buttonOf(request: Fields): 'right' | 'middle' | undefined {
  if (request.button === 'right') return 'right'
  if (request.button === 'middle') return 'middle'
  return undefined
}

/** A click: on a control by name (`target`), or at a point of the view (`x`, `y`). */
function parseClick(request: Fields): ArenaActionParse {
  if (request.target !== undefined) return withTarget(request, (target) => ({ action: 'click', target }))
  const at = pointOf(request, POINT_FIELDS.horizontal, POINT_FIELDS.vertical)
  if (at === undefined) return fail(`click takes a "target", or "x" and "y": ${ON_THE_VIEW}`)
  const button = buttonOf(request)
  return accept({
    action: 'click',
    at,
    ...(button === undefined ? {} : { button }),
    ...(request.double === true ? { double: true } : {}),
  })
}

function parseScroll(request: Fields): ArenaActionParse {
  const at = pointOf(request, POINT_FIELDS.horizontal, POINT_FIELDS.vertical)
  const dx = typeof request.dx === 'number' && Number.isFinite(request.dx) ? request.dx : 0
  const dy = typeof request.dy === 'number' && Number.isFinite(request.dy) ? request.dy : 0
  if (at === undefined || (dx === 0 && dy === 0)) {
    return fail(`scroll takes "x" and "y" (${ON_THE_VIEW}) and "dy" (down is positive) or "dx"`)
  }
  return accept({ action: 'scroll', at, dx, dy })
}

function parseNote(request: Fields): ArenaActionParse {
  const note = NOTE_KINDS.find((kind) => kind === request.note)
  const trying = text(request, 'trying')
  const happened = text(request, 'happened')
  if (note === undefined || trying === undefined || happened === undefined) {
    return fail(
      `note takes "note" (${NOTE_KINDS.join(' | ')}), "trying" and "happened", and "wanted" if you can say it`,
    )
  }
  const wanted = text(request, 'wanted')
  return accept({ action: 'note', note, trying, happened, ...(wanted === undefined ? {} : { wanted }) })
}

/** One parser per action name: each checks its own fields. */
const ACTION_PARSERS: Readonly<Record<string, (request: Fields) => ArenaActionParse>> = {
  goto: (request) => {
    const path = parseGotoPath(text(request, 'path') ?? '')
    return path === undefined
      ? fail('goto takes a path on the web origin ("/?thread=…"), not a URL and not /api')
      : accept({ action: 'goto', path })
  },
  click: parseClick,
  hover: (request) => withTarget(request, (target) => ({ action: 'hover', target })),
  move: (request) => {
    const at = pointOf(request, POINT_FIELDS.horizontal, POINT_FIELDS.vertical)
    return at === undefined ? fail(`move takes "x" and "y": ${ON_THE_VIEW}`) : accept({ action: 'move', at })
  },
  scroll: parseScroll,
  drag: (request) => {
    const at = pointOf(request, POINT_FIELDS.horizontal, POINT_FIELDS.vertical)
    const to = pointOf(request, 'toX', 'toY')
    return at === undefined || to === undefined
      ? fail(`drag takes "x", "y" and "toX", "toY": ${ON_THE_VIEW}`)
      : accept({ action: 'drag', at, to })
  },
  type: (request) => {
    const typed = text(request, 'text')
    return typed === undefined
      ? fail('type takes "text": it goes to whatever has focus')
      : accept({ action: 'type', text: typed })
  },
  fill: (request) => {
    const typed = request.text
    if (typeof typed !== 'string') return fail('fill takes "text"')
    return withTarget(request, (target) => ({ action: 'fill', target, text: typed }))
  },
  select: (request) => {
    const option = text(request, 'option')
    if (option === undefined) return fail('select takes "option"')
    return withTarget(request, (target) => ({ action: 'select', target, option }))
  },
  press: (request) => {
    const key = text(request, 'key')
    if (key === undefined) return fail('press takes "key" (Enter, Escape, Control+K, …)')
    if (request.target === undefined) return accept({ action: 'press', key })
    return withTarget(request, (target) => ({ action: 'press', key, target }))
  },
  wait: (request) => {
    const ms = request.ms
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return fail('wait takes "ms"')
    const until = request.until
    if (until !== undefined && !isWaitUntil(until)) {
      return fail(`wait "until" takes ${WAIT_UNTIL.map((kind) => `"${kind}"`).join(' or ')}`)
    }
    if (until === undefined) return accept({ action: 'wait', ms: Math.min(ms, LONGEST_WAIT_MS) })
    return accept({ action: 'wait', ms: Math.min(ms, LONGEST_PAGE_WAIT_MS), until })
  },
  note: parseNote,
  stop: (request) => {
    const reason = text(request, 'reason')
    return accept({ action: 'stop', ...(reason === undefined ? {} : { reason }) })
  },
  read: (request) => {
    const { region, full } = request
    if (region !== undefined && (typeof region !== 'string' || region.length === 0)) {
      return fail('read takes "region" as the name of one, like "transcript"; a read answers with the ones on the page')
    }
    if (full !== undefined && typeof full !== 'boolean') return fail('read takes "full" as true or false')
    return accept({
      action: 'read',
      ...(region === undefined ? {} : { region }),
      ...(full === true ? { full } : {}),
    })
  },
  screenshot: () => accept({ action: 'screenshot' }),
  back: () => accept({ action: 'back' }),
  reload: () => accept({ action: 'reload' }),
  'restart-enso': () => accept({ action: 'restart-enso' }),
  'accept-dialog': (request) => {
    const typed = request.text
    if (typed !== undefined && typeof typed !== 'string') return fail('accept-dialog takes "text" only as a string')
    return accept({ action: 'accept-dialog', ...(typed === undefined ? {} : { text: typed }) })
  },
  'dismiss-dialog': () => accept({ action: 'dismiss-dialog' }),
  tabs: () => accept({ action: 'tabs' }),
  'switch-tab': (request) => {
    const tab = tabNumber(request.tab)
    return tab === undefined
      ? fail('switch-tab takes "tab": a number from `tabs`')
      : accept({ action: 'switch-tab', tab })
  },
  'close-tab': (request) => {
    if (request.tab === undefined) return accept({ action: 'close-tab' })
    const tab = tabNumber(request.tab)
    return tab === undefined
      ? fail('close-tab takes "tab" (a number from `tabs`), or nothing for the tab in front')
      : accept({ action: 'close-tab', tab })
  },
}

/** The ARENA action a request names, checked field by field. Unknown fields are ignored. */
export function parseArenaAction(request: unknown): ArenaActionParse {
  if (!isFields(request)) return fail('an action is a JSON object with an "action" field')
  const parser = typeof request.action === 'string' ? ACTION_PARSERS[request.action] : undefined
  return parser === undefined ? fail(`unknown action: ${Object.keys(ACTION_PARSERS).join(', ')}`) : parser(request)
}

/**
 * Why the recorder will not type this action's text into the page, or undefined when it may.
 *
 * ⚠ REFUSED, NOT REDACTED. Whatever is typed into the page is in the trace's DOM snapshots and
 * on every screenshot that shows the field — measured on the first live run: a key filled into
 * the prompt box was in `trace.trace` five times. A PNG cannot be scrubbed afterwards, so text
 * the redactor would change (a known secret value, or a key-shaped token) never reaches the page.
 * The assignment needs no credential; an agent that tries to type one is refused, and the
 * refusal is on the timeline.
 */
export function typedSecretRefusal(action: ArenaAction, secretValues: readonly string[]): string | undefined {
  let typed: string | undefined
  if (action.action === 'fill' || action.action === 'accept-dialog' || action.action === 'type') typed = action.text
  if (action.action === 'select') typed = action.option
  if (typed === undefined || redactJudgeText(typed, secretValues) === typed) return undefined
  return 'refused: the text looks like a credential, and anything typed into the page is kept in the trace and screenshots'
}

/** A point as the timeline writes it: `512,300`, in view pixels. */
const describePoint = (point: ArenaPoint): string => `${Math.round(point.left)},${Math.round(point.top)}`

/** A pointer click as one word: `click`, `double-click`, `right-click`, `double-right-click`. */
function clickWord(action: { readonly button?: 'right' | 'middle'; readonly double?: boolean }): string {
  const button = action.button === undefined ? '' : `${action.button}-`
  return `${action.double === true ? 'double-' : ''}${button}click`
}

/**
 * Why this action is not one this run's perception allows (#680), or undefined when it is. A visual
 * agent sees only the screenshot: no accessibility tree, and no control named for it. A tree agent
 * acts on controls by name: a point on a picture it never sees would be a guess, and it would blur
 * what the two kinds of run can be compared on.
 */
export function perceptionRefusal(action: ArenaAction, perception: ArenaPerception): string | undefined {
  const atAPoint = 'at' in action
  if (perception === 'tree') {
    return atAPoint
      ? 'this run reads the page as an accessibility tree: act on a control by name ("target"), not at x,y'
      : undefined
  }
  if (action.action === 'read') {
    return 'this run sees the page only as the screenshot each action returns: there is no accessibility tree'
  }
  if ('target' in action && action.target !== undefined) {
    return 'this run sees the page only as a screenshot: act at x,y on it, and with the keyboard, not on a control by name'
  }
  return undefined
}

/** A target as one line: `button "send message"`, `text "New thread"`. */
function describeTarget(target: ArenaTarget): string {
  const nth = target.nth === undefined ? '' : ` #${target.nth}`
  if ('role' in target) return `${target.role}${target.name === undefined ? '' : ` "${target.name}"`}${nth}`
  if ('text' in target) return `text "${target.text}"${nth}`
  if ('label' in target) return `label "${target.label}"${nth}`
  return `placeholder "${target.placeholder}"${nth}`
}

/** A read as the timeline records it (#740): `read`, `read threads`, `read transcript, full`. */
function describeRead(
  action: Extract<ArenaAction, { readonly action: 'read' }>,
  redact: (typed: string) => string,
): string {
  const region = action.region === undefined ? '' : ` ${redact(action.region)}`
  return `read${region}${action.full === true ? ', full' : ''}`
}

/**
 * An action as the timeline records it: one line, with what the agent TYPED put through the
 * judge's redactor and the run's known secret values. A prompt that quotes a key must not put
 * the key in the evidence a findings report links to.
 */
export function describeArenaAction(action: ArenaAction, secretValues: readonly string[]): string {
  const redact = (typed: string): string => redactJudgeText(typed, secretValues)
  switch (action.action) {
    case 'type':
    case 'fill':
    case 'select':
    case 'stop':
    case 'accept-dialog':
    case 'read':
      return describeTypedAction(action, redact)
    case 'click':
    case 'hover':
    case 'move':
    case 'scroll':
    case 'drag':
      return describePointerAction(action)
    default:
      return describePlainAction(action)
  }
}

/** The actions that carry what the agent typed: each typed string goes through `redact`. */
function describeTypedAction(
  action: Extract<ArenaAction, { readonly action: 'type' | 'fill' | 'select' | 'stop' | 'accept-dialog' | 'read' }>,
  redact: (typed: string) => string,
): string {
  switch (action.action) {
    case 'type':
      return `type ${JSON.stringify(redact(action.text))}`
    case 'fill':
      return `fill ${describeTarget(action.target)} with ${JSON.stringify(redact(action.text))}`
    case 'select':
      return `select ${JSON.stringify(redact(action.option))} in ${describeTarget(action.target)}`
    case 'stop':
      return `stop${action.reason === undefined ? '' : `: ${redact(action.reason)}`}`
    case 'accept-dialog':
      return `accept-dialog${action.text === undefined ? '' : ` with ${JSON.stringify(redact(action.text))}`}`
    case 'read':
      return describeRead(action, redact)
  }
}

/** The pointer actions: a point of the view, or for `click`/`hover` a named control. */
function describePointerAction(
  action: Extract<ArenaAction, { readonly action: 'click' | 'hover' | 'move' | 'scroll' | 'drag' }>,
): string {
  switch (action.action) {
    case 'click':
      if ('at' in action) {
        const how = clickWord(action)
        return `${how} at ${describePoint(action.at)}`
      }
      return `click ${describeTarget(action.target)}`
    case 'hover':
      return `hover ${describeTarget(action.target)}`
    case 'move':
      return `move to ${describePoint(action.at)}`
    case 'scroll':
      return `scroll ${Math.round(action.dx)},${Math.round(action.dy)} at ${describePoint(action.at)}`
    case 'drag':
      return `drag ${describePoint(action.at)} to ${describePoint(action.to)}`
  }
}

/** The actions whose line carries nothing the agent typed: no redaction applies. */
function describePlainAction(
  action: Exclude<
    ArenaAction,
    {
      readonly action:
        | 'type'
        | 'fill'
        | 'select'
        | 'stop'
        | 'accept-dialog'
        | 'read'
        | 'click'
        | 'hover'
        | 'move'
        | 'scroll'
        | 'drag'
    }
  >,
): string {
  switch (action.action) {
    case 'goto':
      return `goto ${action.path}`
    case 'press':
      return `press ${action.key}${action.target === undefined ? '' : ` in ${describeTarget(action.target)}`}`
    case 'wait':
      return action.until === undefined ? `wait ${action.ms} ms` : `${PAGE_WAIT} ${action.until}, up to ${action.ms} ms`
    case 'note':
      return `note ${action.note}`
    case 'switch-tab':
      return `switch-tab ${action.tab}`
    case 'close-tab':
      return action.tab === undefined ? 'close-tab' : `close-tab ${action.tab}`
    default:
      return action.action
  }
}
