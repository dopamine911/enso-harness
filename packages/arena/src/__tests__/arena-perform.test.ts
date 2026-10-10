import { expect, test } from 'bun:test'
import type { ArenaAction } from '../actions.ts'
import {
  type ArenaActionRun,
  type ArenaAXNode,
  type ArenaHands,
  actOnArena,
  performArenaAction,
  pointedRoleOf,
} from '../perform.ts'
import type { ArenaEventBody } from '../timeline.ts'

/**
 * What the recorder does with one agent action (#832): which hand performs it, and what the run
 * records and answers around it — over stand-ins for the page, the trace and the timeline, each
 * step written to one log so the order is what is checked. The hands over Playwright's page are
 * proven by a live run.
 */

const SECRET = 'sk-live-notarealsecret-0123456789'

/** A run over stand-ins: every step it takes, in order, and every timeline line it writes. */
interface FakeRun {
  readonly run: ArenaActionRun
  readonly steps: string[]
  readonly lines: ArenaEventBody[]
}

function fakeRun(overrides: Partial<ArenaActionRun> = {}): FakeRun {
  const steps: string[] = []
  const lines: ArenaEventBody[] = []
  let clock = 0
  const run: ArenaActionRun = {
    stopReason: () => undefined,
    describe: (action) => `described ${action.action}`,
    refusal: () => undefined,
    record: (body) => {
      steps.push(`record ${body.kind}`)
      lines.push(body)
    },
    tracing: {
      group: (name) => {
        steps.push(`group ${name}`)
        return Promise.resolve()
      },
      groupEnd: () => {
        steps.push('group end')
        return Promise.resolve()
      },
    },
    markStatus: () => steps.push('mark status'),
    perform: (action) => {
      steps.push(`perform ${action.action}`)
      return Promise.resolve({ url: 'http://127.0.0.1:5178/' })
    },
    pointedAt: () => undefined,
    moved: () => {
      steps.push('moved')
      return Promise.resolve()
    },
    shownAfter: (_action, moved) => {
      steps.push(`shown ${moved ? 'after a move' : 'without a move'}`)
      return Promise.resolve({ view: '/run/screenshots/00001-view.jpg' })
    },
    shoot: (cause) => {
      steps.push(`shoot ${cause}`)
      return Promise.resolve(undefined)
    },
    redact: (text) => text.replaceAll(SECRET, '[redacted]'),
    // Seven milliseconds a look: an action's duration is the span from before its group to its outcome.
    now: () => (clock += 7),
    ...overrides,
  }
  return { run, steps, lines }
}

const CLICK_SEND: ArenaAction = { action: 'click', target: { role: 'button', name: 'Send' } }

test('a performed action is one trace group: the status log marked, the move, its line, the new baseline, the view, the group ended (#637, #737)', async () => {
  const { run, steps, lines } = fakeRun()
  const outcome = await actOnArena(CLICK_SEND, 'agent', run)

  expect(steps).toEqual([
    'group described click',
    'mark status',
    'perform click',
    'record action',
    'moved',
    'shown after a move',
    'group end',
  ])
  expect(lines).toEqual([
    { kind: 'action', via: 'agent', action: 'click', detail: 'described click', outcome: 'ok', durationMs: 7 },
  ])
  expect(outcome).toEqual({
    ok: true,
    result: { url: 'http://127.0.0.1:5178/' },
    view: '/run/screenshots/00001-view.jpg',
  })
})

test('a pointer action’s line says what was under the point; the agent’s answer never does (#680)', async () => {
  const { run, lines } = fakeRun({ pointedAt: () => 'button "Start session"' })
  const outcome = await actOnArena({ action: 'click', at: { left: 10, top: 20 } }, 'agent', run)

  expect(lines).toEqual([
    {
      kind: 'action',
      via: 'agent',
      action: 'click',
      detail: 'described click',
      outcome: 'ok',
      durationMs: 7,
      under: 'button "Start session"',
    },
  ])
  expect(JSON.stringify(outcome)).not.toContain('Start session')
})

test('⚠ a note is its own line, not an action line, and like a wait or a stop it leaves the status log unmarked (#737)', async () => {
  const note = fakeRun()
  await actOnArena(
    { action: 'note', note: 'friction', trying: 'start a session', happened: 'nothing' },
    'control',
    note.run,
  )
  expect(note.steps).toEqual(['group described note', 'perform note', 'shown without a move', 'group end'])
  expect(note.lines).toEqual([])

  for (const action of [{ action: 'wait', ms: 1000 }, { action: 'stop' }] as const) {
    const { run, steps } = fakeRun()
    await actOnArena(action, 'agent', run)
    expect(steps).toEqual([
      `group described ${action.action}`,
      `perform ${action.action}`,
      'record action',
      'shown without a move',
      'group end',
    ])
  }
})

test('a read, a screenshot and a tab list mark the status log but move nothing: the next wait compares with the page before (#637)', async () => {
  for (const action of [{ action: 'read' }, { action: 'screenshot' }, { action: 'tabs' }] as const) {
    const { run, steps } = fakeRun()
    await actOnArena(action, 'agent', run)
    expect(steps).toEqual([
      `group described ${action.action}`,
      'mark status',
      `perform ${action.action}`,
      'record action',
      'shown without a move',
      'group end',
    ])
  }
})

test('a refused action is a failed line of no duration: nothing is traced, marked or performed (#609)', async () => {
  const refusal = 'the budget is spent: only a note (your retrospective) and stop are taken now'
  const { run, steps, lines } = fakeRun({ refusal: () => refusal })
  const outcome = await actOnArena(CLICK_SEND, 'agent', run)

  expect(outcome).toEqual({ ok: false, error: refusal })
  expect(steps).toEqual(['record action'])
  expect(lines).toEqual([
    {
      kind: 'action',
      via: 'agent',
      action: 'click',
      detail: 'described click',
      outcome: 'failed',
      error: refusal,
      durationMs: 0,
    },
  ])
})

test('after the stop an action is refused with the stop’s reason, and nothing about it is recorded', async () => {
  let described = 0
  const { run, steps } = fakeRun({
    stopReason: () => 'the agent stopped the run',
    describe: () => {
      described += 1
      return 'described'
    },
  })
  expect(await actOnArena(CLICK_SEND, 'agent', run)).toEqual({
    ok: false,
    error: 'the run has stopped (the agent stopped the run)',
  })
  expect(steps).toEqual([])
  expect(described).toBe(0)
})

test('⚠ a failed action: its first line, redacted, on the timeline and in the answer, a picture of it, and the group still ends', async () => {
  const { run, steps, lines } = fakeRun({
    perform: (action) =>
      Promise.reject(
        new Error(`Timeout 15000ms exceeded clicking ${SECRET}\nCall log:\n  - waiting for ${action.action}`),
      ),
    pointedAt: () => 'textbox "Ask"',
  })
  const outcome = await actOnArena({ action: 'click', at: { left: 1, top: 2 } }, 'agent', run)

  const message = 'Timeout 15000ms exceeded clicking [redacted]'
  expect(outcome).toEqual({ ok: false, error: message, view: '/run/screenshots/00001-view.jpg' })
  expect(steps).toEqual([
    'group described click',
    'mark status',
    'record action',
    'shoot action-failed',
    'shown without a move',
    'group end',
  ])
  expect(lines).toEqual([
    {
      kind: 'action',
      via: 'agent',
      action: 'click',
      detail: 'described click',
      outcome: 'failed',
      error: message,
      durationMs: 7,
      under: 'textbox "Ask"',
    },
  ])
})

test('⚠ each action goes to its own hand: a click at a point is the pointer’s, a click on a named control the control’s (#680)', async () => {
  const handed: string[] = []
  const hand =
    (name: string) =>
    (action: ArenaAction, via?: string): Promise<unknown> => {
      handed.push(`${action.action} → ${name}${via === undefined ? '' : ` (${via})`}`)
      return Promise.resolve(name)
    }
  const hands: ArenaHands = {
    withPointer: hand('pointer'),
    onControl: hand('control'),
    read: hand('read'),
    wait: hand('wait'),
    onTabs: hand('tabs'),
    onRun: hand('run'),
    onPage: hand('page'),
  }
  const at = { left: 5, top: 5 }
  const target = { role: 'button', name: 'Send' }
  const actions: readonly ArenaAction[] = [
    { action: 'click', at },
    { action: 'click', target },
    { action: 'move', at },
    { action: 'scroll', at, dx: 0, dy: 100 },
    { action: 'drag', at, to: { left: 9, top: 9 } },
    { action: 'hover', target },
    { action: 'fill', target, text: 'hello' },
    { action: 'select', target, option: 'Opus' },
    { action: 'press', key: 'Enter' },
    { action: 'read' },
    { action: 'wait', ms: 500, until: 'change' },
    { action: 'tabs' },
    { action: 'switch-tab', tab: 1 },
    { action: 'close-tab' },
    { action: 'note', note: 'wish', trying: 'a', happened: 'b' },
    { action: 'restart-enso' },
    { action: 'stop' },
    { action: 'goto', path: '/' },
    { action: 'type', text: 'hi' },
    { action: 'screenshot' },
    { action: 'back' },
    { action: 'reload' },
    { action: 'accept-dialog' },
    { action: 'dismiss-dialog' },
  ]
  const results = await Promise.all(actions.map((action) => performArenaAction(action, 'agent', hands)))

  expect(handed).toEqual([
    'click → pointer',
    'click → control',
    'move → pointer',
    'scroll → pointer',
    'drag → pointer',
    'hover → control',
    'fill → control',
    'select → control',
    'press → control',
    'read → read',
    'wait → wait',
    'tabs → tabs',
    'switch-tab → tabs',
    'close-tab → tabs',
    'note → run (agent)',
    'restart-enso → run (agent)',
    'stop → run (agent)',
    'goto → page',
    'type → page',
    'screenshot → page',
    'back → page',
    'reload → page',
    'accept-dialog → page',
    'dismiss-dialog → page',
  ])
  // Each answer is its hand's own.
  expect(results[0]).toBe('pointer')
  expect(results[1]).toBe('control')
})

/** An accessibility node: its id, its role and name, and where it hangs. */
function axNode(
  nodeId: string,
  role: string | undefined,
  more: {
    readonly name?: string
    readonly parentId?: string
    readonly backend?: number
    readonly ignored?: boolean
  } = {},
): ArenaAXNode {
  return {
    nodeId,
    ignored: more.ignored ?? false,
    ...(role === undefined ? {} : { role: { value: role } }),
    ...(more.name === undefined ? {} : { name: { value: more.name } }),
    ...(more.parentId === undefined ? {} : { parentId: more.parentId }),
    ...(more.backend === undefined ? {} : { backendDOMNodeId: more.backend }),
  }
}

test('⚠ what was under a click is the nearest node with a meaningful role: the button, not its text or wrapper (#680)', () => {
  const nodes = [
    axNode('1', 'RootWebArea', { name: 'Enso' }),
    axNode('2', 'button', { name: 'Start session', parentId: '1', backend: 10 }),
    axNode('3', 'generic', { parentId: '2', backend: 11 }),
    axNode('4', 'StaticText', { name: 'Start session', parentId: '3', backend: 12 }),
    axNode('5', 'InlineTextBox', { name: 'Start', parentId: '4', backend: 13 }),
  ]
  expect(pointedRoleOf(nodes, 13)).toBe('button "Start session"')
  expect(pointedRoleOf(nodes, 10)).toBe('button "Start session"')

  // An ignored node is passed over like a wrapper, whatever its role.
  const ignored = [
    axNode('1', 'dialog', { name: 'Start' }),
    axNode('2', 'button', { name: 'hidden', parentId: '1', backend: 20, ignored: true }),
  ]
  expect(pointedRoleOf(ignored, 20)).toBe('dialog "Start"')
})

test('the pointed name is on one line and cut at sixty characters; with no name it is the role alone', () => {
  const long = 'x'.repeat(61)
  const exact = 'y'.repeat(60)
  const nodes = [
    axNode('1', 'textbox', { name: '  Ask pi\n   something  ', backend: 1 }),
    axNode('2', 'link', { name: long, backend: 2 }),
    axNode('3', 'link', { name: exact, backend: 3 }),
    axNode('4', 'separator', { name: ' \n ', backend: 4 }),
    axNode('5', undefined, { name: 'no role', backend: 5 }),
  ]
  expect(pointedRoleOf(nodes, 1)).toBe('textbox "Ask pi something"')
  expect(pointedRoleOf(nodes, 2)).toBe(`link "${'x'.repeat(59)}…"`)
  expect(pointedRoleOf(nodes, 3)).toBe(`link "${exact}"`)
  expect(pointedRoleOf(nodes, 4)).toBe('separator')
  // A node the tree gives no role at all still stops the walk: it is said as unknown, not skipped.
  expect(pointedRoleOf(nodes, 5)).toBe('unknown "no role"')
})

test('a point over nothing with a role — or over a node the tree left out — says so', () => {
  const wrappers = [axNode('1', 'none'), axNode('2', 'generic', { parentId: '1', backend: 7 })]
  expect(pointedRoleOf(wrappers, 7)).toBe('nothing with a role')
  expect(pointedRoleOf(wrappers, 99)).toBe('nothing with a role')
  // A parent the partial tree did not include ends the walk too.
  expect(pointedRoleOf([axNode('2', 'StaticText', { parentId: 'gone', backend: 8 })], 8)).toBe('nothing with a role')
})
