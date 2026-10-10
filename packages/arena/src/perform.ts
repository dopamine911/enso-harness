import type { ArenaAction, ArenaPoint } from './actions.ts'
import type { ArenaActionSource, ArenaEventBody, ArenaShotCause } from './timeline.ts'

/**
 * One agent action in the recorder (#556, #832): which of the page's hands performs it, and what
 * the run records and answers around it — the refusals, the trace group, the timeline line, the
 * view after. The hands themselves work on Playwright's page (`recorder.ts#runArena`); here they are
 * parameters, so what the run does with an action is the same over a test's stand-ins.
 */

/**
 * What one action came to: its result, or why it failed or was refused — and, while the run lasts,
 * where it is: `running` with the budget left, or `grace` with the time left for the retrospective.
 */
export interface ArenaActOutcome {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
  readonly phase?: 'running' | 'grace'
  readonly remainingMs?: number
  /** A visual run's view after the action (#680): the screenshot the agent is shown. */
  readonly view?: string
  /** A native dialog open over the page (#680): a page capture never shows one, so the answer says it. */
  readonly dialog?: { readonly type: string; readonly message: string }
}

/** The actions that do not move the page: after any other, the wait's baseline is the page it left (#637). */
const LEAVES_THE_PAGE: ReadonlySet<ArenaAction['action']> = new Set([
  'read',
  'screenshot',
  'wait',
  'note',
  'stop',
  'tabs',
])
/**
 * The actions after which what the agent knows of the page is unchanged (#737): a wait tells it
 * what it waited for, a note and a stop touch no page. Any other action marks the status log — the
 * agent moved the page or was shown it — so the next wait reads what came after.
 */
const KEEPS_WHAT_IT_KNOWS: ReadonlySet<ArenaAction['action']> = new Set(['wait', 'note', 'stop'])

/** An error's first line, redacted: what a timeline line or an answer says of a failure. */
export function errorLine(error: unknown, redact: (text: string) => string): string {
  return redact(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error))
}

/** The page's hands, one per kind of action: the recorder's performers, each over the tab in front. */
export interface ArenaHands {
  /** A pointer action at a point of the view (#680): a visual agent's hands. */
  readonly withPointer: (action: Extract<ArenaAction, { readonly at: ArenaPoint }>) => Promise<unknown>
  /** An action on a control named the way a reader names it: a tree agent's hands. */
  readonly onControl: (
    action: Extract<ArenaAction, { readonly action: 'click' | 'hover' | 'fill' | 'select' | 'press' }>,
  ) => Promise<unknown>
  readonly read: (action: Extract<ArenaAction, { readonly action: 'read' }>) => Promise<unknown>
  readonly wait: (action: Extract<ArenaAction, { readonly action: 'wait' }>) => Promise<unknown>
  readonly onTabs: (
    action: Extract<ArenaAction, { readonly action: 'tabs' | 'switch-tab' | 'close-tab' }>,
  ) => Promise<unknown>
  /** A note, a restart, a stop: the run rather than the page, so who sent it goes along. */
  readonly onRun: (
    action: Extract<ArenaAction, { readonly action: 'note' | 'restart-enso' | 'stop' }>,
    via: ArenaActionSource,
  ) => Promise<unknown>
  readonly onPage: (
    action: Extract<
      ArenaAction,
      { readonly action: 'goto' | 'type' | 'screenshot' | 'back' | 'reload' | 'accept-dialog' | 'dismiss-dialog' }
    >,
  ) => Promise<unknown>
}

/** The hand that performs `action`. ⚠ A `click` is the pointer's when it names a point, else a control's. */
export function performArenaAction(action: ArenaAction, via: ArenaActionSource, hands: ArenaHands): Promise<unknown> {
  switch (action.action) {
    case 'click':
      return 'at' in action ? hands.withPointer(action) : hands.onControl(action)
    case 'move':
    case 'scroll':
    case 'drag':
      return hands.withPointer(action)
    case 'hover':
    case 'fill':
    case 'select':
    case 'press':
      return hands.onControl(action)
    case 'read':
      return hands.read(action)
    case 'wait':
      return hands.wait(action)
    case 'tabs':
    case 'switch-tab':
    case 'close-tab':
      return hands.onTabs(action)
    case 'note':
    case 'restart-enso':
    case 'stop':
      return hands.onRun(action, via)
    default:
      return hands.onPage(action)
  }
}

/** What one parsed action needs of its run: its state, its records, and its page's hands. */
export interface ArenaActionRun {
  /** Why the run stopped, once it has: an action after the first stop is refused, not performed on a closing page. */
  readonly stopReason: () => string | undefined
  /** The action as the timeline says it, typed text redacted. */
  readonly describe: (action: ArenaAction) => string
  /** Why the run refuses the action now — the other perception's move, the grace window (#609), a typed secret — or undefined. */
  readonly refusal: (action: ArenaAction) => string | undefined
  /** A line on the timeline, placed where the tab in front is when it is written. */
  readonly record: (body: ArenaEventBody) => void
  /** The trace's named group: every performed action is one in the trace. */
  readonly tracing: { group(name: string): Promise<unknown>; groupEnd(): Promise<void> }
  /** Mark the status log (#737): what the page announces from here on is what this action caused. */
  readonly markStatus: () => void
  /** Perform the action on the page: its result, or the native dialog it opened (#691). */
  readonly perform: (action: ArenaAction, via: ArenaActionSource) => Promise<unknown>
  /** What a pointer action pointed at (#680), read during `perform`; undefined for any other. */
  readonly pointedAt: () => string | undefined
  /** The page after a move: what the agent's next wait until change compares with (#637). */
  readonly moved: () => Promise<void>
  /** What the answer shows the agent (#680, #693), and whether the action moved the page. */
  readonly shownAfter: (action: ArenaAction, moved: boolean) => Promise<Pick<ArenaActOutcome, 'view' | 'dialog'>>
  readonly shoot: (cause: ArenaShotCause) => Promise<unknown>
  readonly redact: (text: string) => string
  /** Milliseconds on a monotonic clock, for the line's `durationMs`; `performance.now` by default. */
  readonly now?: () => number
}

/**
 * Act on one parsed action, as the recorder does for each it is sent, one at a time: refused after
 * the stop and by the run's refusals — a refusal is a `failed` line with no trace group — else
 * performed inside a trace group, and its outcome a line on the timeline with what a pointer
 * pointed at. ⚠ A note is not an `action` line: the note is its own line. A failure is a picture
 * too (`action-failed`), and the trace group ends whatever happened.
 */
export async function actOnArena(
  action: ArenaAction,
  via: ArenaActionSource,
  run: ArenaActionRun,
): Promise<ArenaActOutcome> {
  const stopReason = run.stopReason()
  if (stopReason !== undefined) return { ok: false, error: `the run has stopped (${stopReason})` }
  const detail = run.describe(action)
  const refusal = run.refusal(action)
  if (refusal !== undefined) {
    run.record({ kind: 'action', via, action: action.action, detail, outcome: 'failed', error: refusal, durationMs: 0 })
    return { ok: false, error: refusal }
  }
  const now = run.now ?? ((): number => performance.now())
  const began = now()
  await run.tracing.group(detail)
  try {
    // Before the move (#737): everything the page announces from here on is what the move caused.
    if (!KEEPS_WHAT_IT_KNOWS.has(action.action)) run.markStatus()
    const result = await run.perform(action, via)
    const under = run.pointedAt()
    if (action.action !== 'note') {
      run.record({
        kind: 'action',
        via,
        action: action.action,
        detail,
        outcome: 'ok',
        durationMs: Math.round(now() - began),
        ...(under === undefined ? {} : { under }),
      })
    }
    const moved = !LEAVES_THE_PAGE.has(action.action)
    if (moved) await run.moved()
    return { ok: true, result, ...(await run.shownAfter(action, moved)) }
  } catch (error) {
    const message = errorLine(error, run.redact)
    const under = run.pointedAt()
    run.record({
      kind: 'action',
      via,
      action: action.action,
      detail,
      outcome: 'failed',
      error: message,
      durationMs: Math.round(now() - began),
      ...(under === undefined ? {} : { under }),
    })
    await run.shoot('action-failed')
    return { ok: false, error: message, ...(await run.shownAfter(action, false)) }
  } finally {
    await run.tracing.groupEnd()
  }
}

/**
 * Accessibility roles that name nothing a person would point at (#680): text runs and wrappers. What
 * was under a click is the nearest node with any other role — the button, not the text inside it.
 */
const ROLELESS: ReadonlySet<string> = new Set([
  'generic',
  'none',
  'presentation',
  'StaticText',
  'InlineTextBox',
  'LineBreak',
])

/** As much of Chromium's `Accessibility.AXNode` as naming a pointed-at node reads. */
export interface ArenaAXNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value?: string | number | boolean }
  readonly name?: { readonly value?: string | number | boolean }
  readonly parentId?: string
  readonly backendDOMNodeId?: number
}

/** The longest accessible name a pointer's record keeps whole. */
const POINTED_NAME_LIMIT = 60

/**
 * What the node at `backendNodeId` is, as the accessibility tree names it (#680): the nearest node,
 * itself or an ancestor, that is not ignored and has a meaningful role — `button "Start session"`,
 * the same words a tree agent reads. Its name is on one line and cut at `POINTED_NAME_LIMIT`.
 */
export function pointedRoleOf(nodes: readonly ArenaAXNode[], backendNodeId: number): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  let node = nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId)
  while (node !== undefined && (node.ignored || ROLELESS.has(String(node.role?.value ?? '')))) {
    node = node.parentId === undefined ? undefined : byId.get(node.parentId)
  }
  if (node === undefined) return 'nothing with a role'
  const name = String(node.name?.value ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim()
  const role = String(node.role?.value ?? 'unknown')
  if (name.length === 0) return role
  return `${role} "${name.length > POINTED_NAME_LIMIT ? `${name.slice(0, POINTED_NAME_LIMIT - 1)}…` : name}"`
}
