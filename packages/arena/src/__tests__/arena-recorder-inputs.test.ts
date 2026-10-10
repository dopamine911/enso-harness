import { expect, test } from 'bun:test'
import { ENSO_UI_EVENTS, type EnsoThreadStatusEvent } from '@enso/core'
import { createStatusLog } from '../actions.ts'
import { refusedActionName } from '../recorder.ts'
import type { ArenaEventBody } from '../timeline.ts'
import { type ArenaUiEvent, hearUiEvent } from '../ui-status.ts'

/**
 * What reaches the recorder from outside its own hands (#838): an event a page forwards through
 * its binding (#737), and a request refused before it was parsed (#584). Neither is trusted: only
 * what checks out is kept, and only redacted.
 */

const SECRET = 'sk-live-notarealsecret-0123456789'
const redact = (text: string): string => text.replaceAll(SECRET, '[redacted]')

const ASKED: EnsoThreadStatusEvent = {
  threadId: 't1',
  shown: true,
  status: 'question',
  question: { id: 'q1', title: `Paste ${SECRET}?` },
}

/** Hear one event over a real status log; what reached the log and the timeline. */
function hear(event: ArenaUiEvent): {
  readonly logged: readonly EnsoThreadStatusEvent[]
  readonly lines: ReadonlyArray<readonly [ArenaEventBody, number]>
} {
  const log = createStatusLog()
  const lines: Array<readonly [ArenaEventBody, number]> = []
  hearUiEvent(event, { log, record: (body, tab) => lines.push([body, tab]), redact })
  return { logged: event.tab === undefined ? [] : log.sinceMark(event.tab), lines }
}

test('a shown pane’s thread status goes to the log at its tab and to the timeline there, its question’s title redacted (#737)', () => {
  const { logged, lines } = hear({ name: ENSO_UI_EVENTS.threadStatus, detail: ASKED, tab: 2 })
  expect(logged).toEqual([ASKED])
  expect(lines).toEqual([[{ kind: 'thread-status', status: 'question', question: 'Paste [redacted]?' }, 2]])

  const running = hear({
    name: ENSO_UI_EVENTS.threadStatus,
    detail: { threadId: 't1', shown: true, status: 'running' },
    tab: 0,
  })
  expect(running.lines).toEqual([[{ kind: 'thread-status', status: 'running' }, 0]])
})

test('⚠ another event, a detail that does not check, a hidden pane, or a page that is not a run tab is heard as nothing (#713)', () => {
  const ignored: readonly ArenaUiEvent[] = [
    { name: 'enso:other', detail: ASKED, tab: 0 },
    { name: ENSO_UI_EVENTS.threadStatus, detail: { ...ASKED, status: 'thinking' }, tab: 0 },
    { name: ENSO_UI_EVENTS.threadStatus, detail: { ...ASKED, injected: true }, tab: 0 },
    { name: ENSO_UI_EVENTS.threadStatus, detail: { ...ASKED, shown: false }, tab: 0 },
    { name: ENSO_UI_EVENTS.threadStatus, detail: ASKED, tab: undefined },
  ]
  for (const event of ignored) {
    const { logged, lines } = hear(event)
    expect(logged).toEqual([])
    expect(lines).toEqual([])
  }
})

test('a refused request is recorded by the name it gave its action, redacted and cut to 40 characters (#584)', () => {
  expect(refusedActionName({ action: 'goto', path: '/api/threads' }, redact)).toBe('goto')
  expect(refusedActionName({ action: `run ${SECRET} ${'x'.repeat(40)}` }, redact)).toBe(
    `run [redacted] ${'x'.repeat(40)}`.slice(0, 40),
  )
})

test('a request that names no action, or not as text, is recorded as `(none)`', () => {
  for (const request of [undefined, null, 'click', 42, {}, { action: 7 }, { selector: '#send' }]) {
    expect(refusedActionName(request, redact)).toBe('(none)')
  }
})
