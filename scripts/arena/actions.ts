import { redactJudgeText } from '../../packages/core/src/judge.ts'
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
 * this does NOT hold: the agent's own shell. An agent that can run `curl` can reach the API on
 * loopback; that boundary is the agent runner's (its tools), not the recorder's.
 */

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
  | { readonly action: 'wait'; readonly ms: number }
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
  | { readonly action: 'stop'; readonly reason?: string }

/** The longest single `wait`: a run that needs longer waits again, and the timeline shows it waited. */
export const LONGEST_WAIT_MS = 60_000

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
    return accept({ action: 'wait', ms: Math.min(ms, LONGEST_WAIT_MS) })
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
  if (action.action === 'fill') typed = action.text
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
      return `wait ${action.ms} ms`
    case 'note':
      return `note ${action.note}`
    case 'stop':
      return `stop${action.reason === undefined ? '' : `: ${redact(action.reason)}`}`
    default:
      return action.action
  }
}
