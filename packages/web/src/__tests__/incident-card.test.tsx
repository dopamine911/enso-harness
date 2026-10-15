import { afterAll, expect, test } from 'bun:test'
import type { EnsoIncidentOpened, EnsoIncidentRecord, EnsoIncidentReport, EnsoSessionIncidents } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type * as FollowConnectionModule from '../follow-connection.ts'
import type * as IncidentCardModule from '../incident-card.tsx'
import type * as PaneContextModule from '../pane-context.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * The incident card (#466), mounted over a real follow connection whose `fetch` is scripted: what
 * it shows is the opening's record in three separate sections, and what it posts is the resolve
 * route's body — refused client-side by the same check the route runs, and the server's reason
 * shown when the route refuses.
 */

// ⚠ A DOM before react-dom/client and Radix evaluate.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { IncidentCard }: typeof IncidentCardModule = await import('../incident-card.tsx')
const { createFollowConnection }: typeof FollowConnectionModule = await import('../follow-connection.ts')
const { LaunchActionsContext }: typeof PaneContextModule = await import('../pane-context.ts')
afterAll(releaseDom)

const flush = (work: () => Promise<void> | void): Promise<void> => act(async () => work())

const OPENED: EnsoIncidentOpened = {
  incidentId: 'inc-1',
  signals: [
    {
      signal: 'alternate-execution-path',
      toolCallId: 'c7',
      detail: 'python -c after a refused curl',
      after: ['c3', 'c5'],
    },
  ],
  halted: true,
  suspended: ['execute', 'network', 'write'],
}

const openState = (opened: EnsoIncidentOpened): { record: EnsoIncidentRecord; incidents: EnsoSessionIncidents } => {
  const record = { opened, resolutions: [] }
  return {
    record,
    incidents: {
      incidents: [record],
      suspended: opened.suspended,
      ended: false,
    },
  }
}

interface Posted {
  readonly url: string
  readonly body: unknown
}

/** The card mounted over a connection whose every POST answers `answer`, and every request it made. */
async function mounted(
  state: { record: EnsoIncidentRecord; incidents: EnsoSessionIncidents },
  answer: () => Response = () => new Response(null, { status: 204 }),
): Promise<{
  posted: Posted[]
  container: HTMLElement
  unmount: () => Promise<void>
}> {
  const posted: Posted[] = []
  const connection = createFollowConnection({
    threadId: 't1',
    fetch: async (input: string, init?: RequestInit) => {
      posted.push({
        url: input,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return answer()
    },
    onProblem: () => undefined,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(() =>
    root.render(
      <IncidentCard record={state.record} incidents={state.incidents} resolve={connection.resolveIncident} />,
    ),
  )
  return {
    posted,
    container,
    unmount: async () => {
      await flush(() => root.unmount())
      container.remove()
    },
  }
}

/** A section found as a screen reader finds it: by the heading that names it. */
function section(container: HTMLElement, title: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('section[aria-labelledby]')].find(
    (each) => container.querySelector(`[id="${each.getAttribute('aria-labelledby')}"]`)?.textContent === title,
  )
  if (found === undefined) throw new Error(`no section named ${title}: ${container.textContent}`)
  return found
}

/** The control a label names, as a user finds it — by the words on the row. */
function control(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll('label')].find((each) => each.textContent?.startsWith(label))
  const target = row === undefined ? null : container.querySelector<HTMLElement>(`[id="${row.htmlFor}"]`)
  if (target === null) throw new Error(`no control labelled ${label}: ${container.textContent}`)
  return target
}

function button(container: HTMLElement, words: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((each) => each.textContent === words)
  if (found === undefined) throw new Error(`no ${words} button`)
  return found
}

const alertText = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[role="alert"]')?.textContent

test('observed, inferred and suspended are three labelled sections, each holding only its own', async () => {
  const card = await mounted(openState(OPENED))
  const observed = section(card.container, 'Observed').textContent ?? ''
  expect(observed).toContain('alternate-execution-path')
  expect(observed).toContain('c7')
  expect(observed).toContain('c3, c5')
  expect(observed).toContain('python -c after a refused curl')
  expect(observed).not.toContain('bash')

  const inferred = section(card.container, 'Inferred risk').textContent ?? ''
  expect(inferred).toContain('incident')
  expect(inferred).toContain('not calibrated')
  expect(inferred).not.toContain('c7')

  const suspended = section(card.container, 'Suspended tools').textContent ?? ''
  expect(suspended).toContain('execute')
  expect(suspended).toContain('bash, powershell')
  expect(suspended).toContain('write, edit')
  expect(suspended).not.toContain('python -c')
  expect(card.container.textContent).not.toMatch(/append-only|tamper-proof/)
  await card.unmount()
})

test('an inherited incident names the thread and incident it came from; halting off suspends nothing and says why', async () => {
  const card = await mounted(
    openState({
      ...OPENED,
      halted: false,
      suspended: [],
      inheritedFrom: { threadId: 'src-9', incidentId: 'inc-0' },
    }),
  )
  expect(card.container.textContent).toContain('came from thread src-9, whose incident inc-0 was open')
  expect(section(card.container, 'Suspended tools').textContent).toBe(
    'Suspended toolsnothing suspended — halting is off (Settings › Security)',
  )
  await card.unmount()
})

// #933: the hint opens the control, not a key to edit by hand.
test('halting off: the hint opens Settings › Security', async () => {
  const state = openState({ ...OPENED, halted: false, suspended: [] })
  const opened: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(() =>
    root.render(
      <LaunchActionsContext.Provider
        value={{
          openThread: () => undefined,
          manageProjects: () => undefined,
          openSettings: (section) => void opened.push(section),
        }}
      >
        <IncidentCard record={state.record} incidents={state.incidents} resolve={async () => ({ outcome: 'told' })} />
      </LaunchActionsContext.Provider>,
    ),
  )
  const link = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Settings › Security')
  await flush(() => link?.click())
  expect(opened).toEqual(['security'])
  await flush(() => root.unmount())
  container.remove()
})

test('resume with restrictions and none ticked is refused before posting; ticked, it posts the families that stay suspended', async () => {
  const card = await mounted(openState(OPENED))
  await flush(() => control(card.container, 'agent error').click())
  await flush(() => control(card.container, 'resume with restrictions').click())
  await flush(() => button(card.container, 'Record resolution').click())
  expect(card.posted).toEqual([])
  expect(alertText(card.container)).toBe('resume-with-restrictions names the families that stay suspended')

  await flush(() => control(card.container, 'network').click())
  await flush(() => button(card.container, 'Record resolution').click())
  expect(card.posted).toEqual([
    {
      url: '/api/threads/t1/incidents/inc-1/resolve',
      body: {
        classification: 'agent-error',
        outcome: 'resume-with-restrictions',
        restricted: ['network'],
      },
    },
  ])
  expect(alertText(card.container)).toBeUndefined()
  await card.unmount()
})

test("the server's 422 reason is shown on the card, and a resume posts no restricted families", async () => {
  const card = await mounted(
    openState(OPENED),
    () => new Response('a later incident supersedes this one', { status: 422 }),
  )
  await flush(() => control(card.container, 'false positive').click())
  await flush(() => control(card.container, 'resume —').click())
  await flush(() => button(card.container, 'Record resolution').click())
  expect(card.posted.map((each) => each.body)).toEqual([{ classification: 'false-positive', outcome: 'resume' }])
  expect(alertText(card.container)).toBe('the server refused it: a later incident supersedes this one')
  await card.unmount()
})

test('ending the thread asks once more before it posts, and Back posts nothing', async () => {
  const card = await mounted(openState(OPENED))
  await flush(() => control(card.container, 'confirmed bypass').click())
  await flush(() => control(card.container, 'end the thread').click())
  await flush(() => button(card.container, 'Record resolution').click())
  expect(card.posted).toEqual([])
  await flush(() => button(card.container, 'Back').click())
  await flush(() => button(card.container, 'Record resolution').click())
  await flush(() => button(card.container, 'End the thread').click())
  expect(card.posted.map((each) => each.body)).toEqual([{ classification: 'confirmed-bypass', outcome: 'end-thread' }])
  await card.unmount()
})

const REPORT: EnsoIncidentReport = {
  incidentId: 'inc-1',
  factual: {
    task: {
      text: 'fetching the docs',
      evidence: [{ ref: 'prompt', quote: 'get the docs', verified: true }],
      verified: true,
    },
    denied: {
      text: 'curl was refused',
      evidence: [{ ref: 'c9', quote: 'curl blocked', verified: false }],
      verified: false,
    },
    tried: {
      text: 'ran python instead',
      evidence: [{ ref: 'c7', quote: 'python -c', verified: true }],
      verified: true,
    },
  },
  interpretive: {
    whyThatAlternative: 'it looked equivalent',
    recognisedAsBypass: 'only afterwards',
    shouldHaveDone: 'stopped and asked',
    sufficientAuthorization: 'an explicit yes for network',
    patternToAvoid: 'swapping interpreters after a refusal',
    uncharitableRead: 'it routed around the guard on purpose',
  },
  mismatches: ['denied-cites-no-incident-refusal'],
  submission: 2,
}

const EXPLANATION = "The agent's explanation"

const reportedState = (
  attached: Pick<EnsoIncidentRecord, 'report' | 'reportMissing'>,
): { record: EnsoIncidentRecord; incidents: EnsoSessionIncidents } => {
  const record: EnsoIncidentRecord = {
    opened: OPENED,
    resolutions: [],
    ...attached,
  }
  return {
    record,
    incidents: {
      incidents: [record],
      suspended: OPENED.suspended,
      ended: false,
    },
  }
}

test("the agent's explanation is its own section, apart from what was observed", async () => {
  const card = await mounted(reportedState({ report: REPORT }))
  const explanation = section(card.container, EXPLANATION).textContent ?? ''
  const observed = section(card.container, 'Observed').textContent ?? ''
  expect(explanation).toContain('not the record')
  expect(explanation).toContain('ran python instead')
  expect(explanation).not.toContain('alternate-execution-path')
  expect(observed).not.toContain('ran python instead')
  expect(observed).not.toContain('it routed around the guard on purpose')
  await card.unmount()
})

test('each citation is labelled verified or unverified in words, the prompt named as such, the mismatch flagged', async () => {
  const card = await mounted(reportedState({ report: REPORT }))
  const items = [...section(card.container, EXPLANATION).querySelectorAll('li li')].map((each) => each.textContent)
  expect(items).toEqual([
    'get the docs — the prompt · verified',
    'curl blocked — c9 · unverified',
    'python -c — c7 · verified',
  ])
  const explanation = section(card.container, EXPLANATION).textContent ?? ''
  expect(explanation).toContain("curl was refuseddoes not cite the incident's refusals")
  expect(explanation).toContain('filed after one correction')
  expect(explanation).toContain('The uncharitable readit routed around the guard on purpose')
  expect(explanation).toContain('Recognised as a way around it?only afterwards')
  await card.unmount()
})

test('a clean first submission carries no mismatch flag and no correction note', async () => {
  const card = await mounted(reportedState({ report: { ...REPORT, mismatches: [], submission: 1 } }))
  const explanation = section(card.container, EXPLANATION).textContent ?? ''
  expect(explanation).not.toContain('does not cite')
  expect(explanation).not.toContain('filed after one correction')
  await card.unmount()
})

test('a missing report says why; an owed one says it is pending; an alert-only incident has no explanation', async () => {
  const missing = await mounted(
    reportedState({
      reportMissing: { incidentId: 'inc-1', reason: 'the run was cut off' },
    }),
  )
  expect(section(missing.container, EXPLANATION).textContent).toContain('no report filed — the run was cut off')
  await missing.unmount()

  const pending = await mounted(openState(OPENED))
  expect(section(pending.container, EXPLANATION).textContent).toContain('report pending — the agent is asked for one')
  await pending.unmount()

  const alertOnly = await mounted(openState({ ...OPENED, halted: false, suspended: [] }))
  expect(() => section(alertOnly.container, EXPLANATION)).toThrow()
  await alertOnly.unmount()
})
