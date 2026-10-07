import { THREAD_STATUS_WORDS } from '@enso/core'
import { redactJudgeText } from '@enso/core/judge'
import type { ArenaNoteKind } from './timeline.ts'

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

export type ArenaAction =
  | { readonly action: 'goto'; readonly path: string }
  | { readonly action: 'click'; readonly target: ArenaTarget }
  | { readonly action: 'fill'; readonly target: ArenaTarget; readonly text: string }
  | { readonly action: 'press'; readonly key: string; readonly target?: ArenaTarget }
  | { readonly action: 'hover'; readonly target: ArenaTarget }
  | { readonly action: 'select'; readonly target: ArenaTarget; readonly option: string }
  | { readonly action: 'read' }
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

/** The longest single `wait`: a run that needs longer waits again, and the timeline shows it waited. */
export const LONGEST_WAIT_MS = 60_000

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
const RELATIVE_AGE = / (?:now|\d+[smhd])"/g
/** The rail's line in a page read; every line indented under it is the rail's. */
const RAIL_LINE = '- navigation "threads"'

/**
 * A page read as a wait until change compares it: the rail's ages aside, so the clock is no change.
 * ⚠ IN THE RAIL ONLY (PR #646 review): the ages were measured there, and the same shape elsewhere —
 * a control named "Snooze 1h" — is the page's words, whose change is a change.
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

/**
 * What on the page needs the agent, read off the status bar in Enso's own words (core's
 * `THREAD_STATUS_WORDS`, which the bar renders): a question waiting, or the run at rest —
 * `idle` after a reply or a failure, `disconnected` once the follow ended. Undefined while Enso works.
 */
export function attentionOf(page: string): ArenaAttention | undefined {
  if (page.startsWith(DIALOG_PAGE)) return 'dialog'
  const bar = linesUnder(page, `"${THREAD_STATUS_WORDS.region}":`)
  if (bar.includes(`- status: ${THREAD_STATUS_WORDS.questionWaiting}`)) return 'question'
  if (bar.includes(`- text: ${THREAD_STATUS_WORDS.idle}`)) return 'idle'
  if (bar.includes(`- text: ${THREAD_STATUS_WORDS.disconnected}`)) return 'disconnected'
  return undefined
}

/** The lines indented under the first line ending with `header`, trimmed: one region of a page read. */
function linesUnder(page: string, header: string): string[] {
  const lines = page.split('\n')
  const start = lines.findIndex((line) => line.trimEnd().endsWith(header))
  if (start === -1) return []
  const indentOf = (line: string): number => line.length - line.trimStart().length
  const headerIndent = indentOf(lines[start] ?? '')
  const end = lines.findIndex((line, index) => index > start && indentOf(line) <= headerIndent)
  return lines.slice(start + 1, end === -1 ? undefined : end).map((line) => line.trim())
}

/** What a wait on the page came to: whether the page changed, after `waitedMs`, and — for attention — why it returned. */
export interface ArenaPageWait {
  readonly changed: boolean
  readonly waitedMs: number
  readonly attention?: ArenaAttention
}

/**
 * Look every `pollMs` until the page answers `until`, or `ms` runs out. `look` is the page as
 * `pageForChange` words it (or `dialogForChange`); `sleep` and `now` are the page's clock, injected
 * so the outcomes can be tested without a browser.
 *
 * `change` (#637): the first look that differs from `baseline`.
 *
 * `attention` (#648): a look that differs and needs the agent. ⚠ Not every such look does — measured,
 * a wait sent with its own click returned on Enso merely starting, and the agent gave up on it:
 * - an attention state the baseline did not have returns at once;
 * - `idle` again returns only after the wait has seen Enso work. After Start the baseline is often
 *   already `idle` — the run not begun — and the page changes while still idle as the dialog
 *   closes; the run's end is `idle` again;
 * - a `question` again returns on any change. A question stands until answered and the page holds
 *   still while it waits (measured, #637), so a page that changed and still asks is the NEXT
 *   question: after an approval, a quick tool runs and the next card arrives inside one look —
 *   live, the wait had sat out its minute behind that card.
 * A run begun and ended between two looks is missed: the wait then runs to its limit.
 */
export async function waitForPage(options: {
  readonly until: ArenaWaitUntil
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
  const startedIn = attentionOf(options.baseline)
  let changed = false
  let sawWork = startedIn === undefined
  while (waited() < options.ms) {
    await options.sleep(Math.min(options.pollMs, options.ms - waited()))
    const page = await options.look()
    if (page === options.baseline) continue
    changed = true
    if (options.until === 'change') return { changed, waitedMs: waited() }
    const attention = attentionOf(page)
    if (attention === undefined) sawWork = true
    else if (sawWork || attention !== startedIn || attention === 'question') {
      return { changed, waitedMs: waited(), attention }
    }
  }
  return { changed, waitedMs: waited() }
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
 * ⚠ TAKEN AT THE MOVE, NOT AT THE WAIT (PR #646 review, twice proposed otherwise). Between the
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
 * ⚠ CHECKED AS THE BROWSER WILL READ IT, not as typed (PR #562 review). The first version
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
  click: (request) => withTarget(request, (target) => ({ action: 'click', target })),
  hover: (request) => withTarget(request, (target) => ({ action: 'hover', target })),
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
    return accept({ action: 'wait', ms: Math.min(ms, LONGEST_WAIT_MS), ...(until === undefined ? {} : { until }) })
  },
  note: parseNote,
  stop: (request) => {
    const reason = text(request, 'reason')
    return accept({ action: 'stop', ...(reason === undefined ? {} : { reason }) })
  },
  read: () => accept({ action: 'read' }),
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
  if (action.action === 'fill' || action.action === 'accept-dialog') typed = action.text
  if (action.action === 'select') typed = action.option
  if (typed === undefined || redactJudgeText(typed, secretValues) === typed) return undefined
  return 'refused: the text looks like a credential, and anything typed into the page is kept in the trace and screenshots'
}

/** A target as one line: `button "send message"`, `text "New thread"`. */
function describeTarget(target: ArenaTarget): string {
  const nth = target.nth === undefined ? '' : ` #${target.nth}`
  if ('role' in target) return `${target.role}${target.name === undefined ? '' : ` "${target.name}"`}${nth}`
  if ('text' in target) return `text "${target.text}"${nth}`
  if ('label' in target) return `label "${target.label}"${nth}`
  return `placeholder "${target.placeholder}"${nth}`
}

/**
 * An action as the timeline records it: one line, with what the agent TYPED put through the
 * judge's redactor and the run's known secret values. A prompt that quotes a key must not put
 * the key in the evidence a findings report links to.
 */
export function describeArenaAction(action: ArenaAction, secretValues: readonly string[]): string {
  const redact = (typed: string): string => redactJudgeText(typed, secretValues)
  switch (action.action) {
    case 'goto':
      return `goto ${action.path}`
    case 'click':
    case 'hover':
      return `${action.action} ${describeTarget(action.target)}`
    case 'fill':
      return `fill ${describeTarget(action.target)} with ${JSON.stringify(redact(action.text))}`
    case 'select':
      return `select ${JSON.stringify(redact(action.option))} in ${describeTarget(action.target)}`
    case 'press':
      return `press ${action.key}${action.target === undefined ? '' : ` in ${describeTarget(action.target)}`}`
    case 'wait':
      return action.until === undefined ? `wait ${action.ms} ms` : `${PAGE_WAIT} ${action.until}, up to ${action.ms} ms`
    case 'note':
      return `note ${action.note}`
    case 'stop':
      return `stop${action.reason === undefined ? '' : `: ${redact(action.reason)}`}`
    case 'accept-dialog':
      return `accept-dialog${action.text === undefined ? '' : ` with ${JSON.stringify(redact(action.text))}`}`
    case 'switch-tab':
      return `switch-tab ${action.tab}`
    case 'close-tab':
      return action.tab === undefined ? 'close-tab' : `close-tab ${action.tab}`
    default:
      return action.action
  }
}
